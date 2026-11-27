'use strict';
// window.ec bridge: library queries, favorites, history, radios, import.
// Reuses the desktop app's pure lib modules (match/util/recs/queue/stats).

const recs = require('../../src/lib/recs');
const stats = require('../../src/stats');
const importer = require('./import');

let db = null;
const changeListeners = [];

function install(database) {
  db = database;
  window.ec = api;
}

function emitChange() {
  db.saveSoon();
  changeListeners.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } });
}

const api = {
  onLibraryChanged(cb) { changeListeners.push(cb); },

  appInfo() { return { name: 'Echocellar', version: '0.1.0', platform: 'android' }; },

  // ---- library queries ----
  tracks({ limit = 500, offset = 0 } = {}) {
    return db.all(
      `SELECT * FROM tracks WHERE missing = 0 ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no, title
       LIMIT ? OFFSET ?`, [limit, offset]);
  },
  track(id) { return db.get('SELECT * FROM tracks WHERE id = ?', [id]); },
  artists() {
    return db.all(`SELECT artist AS name, COUNT(*) AS tracks, SUM(duration_ms) AS ms
                   FROM tracks WHERE missing = 0 AND artist IS NOT NULL AND artist != ''
                   GROUP BY artist COLLATE NOCASE ORDER BY artist COLLATE NOCASE`);
  },
  albums() {
    return db.all(`SELECT album AS name, COALESCE(NULLIF(album_artist,''), artist) AS artist,
                          COUNT(*) AS tracks, MIN(id) AS art_track_id
                   FROM tracks WHERE missing = 0 AND album IS NOT NULL AND album != ''
                   GROUP BY album COLLATE NOCASE, artist ORDER BY album COLLATE NOCASE`);
  },
  artistTracks(artist) {
    return db.all(`SELECT * FROM tracks WHERE missing = 0 AND artist = ? COLLATE NOCASE
                   ORDER BY album COLLATE NOCASE, disc_no, track_no, title`, [artist]);
  },
  albumTracks(album) {
    return db.all(`SELECT * FROM tracks WHERE missing = 0 AND album = ? COLLATE NOCASE
                   ORDER BY disc_no, track_no, title`, [album]);
  },
  search(q) {
    const like = '%' + String(q).replace(/[%_]/g, '') + '%';
    return db.all(`SELECT * FROM tracks WHERE missing = 0 AND
                   (title LIKE ? OR artist LIKE ? OR album LIKE ?)
                   ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no LIMIT 100`,
      [like, like, like]);
  },
  counts() {
    const t = db.get('SELECT COUNT(*) AS n FROM tracks WHERE missing = 0');
    const a = db.get(`SELECT COUNT(DISTINCT artist) AS n FROM tracks WHERE missing = 0 AND artist IS NOT NULL AND artist != ''`);
    return { tracks: t.n, artists: a.n };
  },

  // ---- favorites / history ----
  favorites() {
    return db.all(`SELECT t.* FROM favorites f JOIN tracks t ON t.id = f.track_id
                   WHERE t.missing = 0 ORDER BY f.created_at DESC`);
  },
  isFavorite(id) { return !!db.get('SELECT track_id FROM favorites WHERE track_id = ?', [id]); },
  toggleFavorite(id) {
    if (api.isFavorite(id)) db.exec('DELETE FROM favorites WHERE track_id = ?', [id]);
    else db.exec('INSERT OR IGNORE INTO favorites (track_id, created_at) VALUES (?, ?)', [id, Date.now()]);
    emitChange();
    return api.isFavorite(id);
  },
  recordSession(s) { return stats.recordSession(db, s); },
  recentTracks(limit = 20) {
    return db.all(`SELECT t.*, MAX(h.played_at) AS played_at FROM history h
                   JOIN tracks t ON t.id = h.track_id
                   WHERE h.source = 'local' AND t.missing = 0
                   GROUP BY t.id ORDER BY played_at DESC LIMIT ?`, [limit]);
  },
  totals() { return stats.totals(db, 'all'); },

  // ---- recommendations (same engines as desktop) ----
  recsHome(familiarity = 0.7) {
    const hasHistory = !!db.get('SELECT id FROM history LIMIT 1');
    if (!hasHistory) {
      const artists = db.all(`SELECT artist, COUNT(*) AS tracks FROM tracks
                              WHERE missing = 0 AND artist IS NOT NULL AND artist != ''
                              GROUP BY artist COLLATE NOCASE ORDER BY tracks DESC LIMIT 12`);
      return { cold_start: true, artists, mixes: [] };
    }
    const mixes = [];
    const weekly = recs.weeklyMix(db, 30, familiarity);
    if (weekly.length) mixes.push({ id: 'weekly', title: 'Your weekly mix', tracks: weekly });
    const recent = api.recentTracks(1);
    if (recent.length) {
      const radio = recs.trackRadio(db, recent[0].id, 25, familiarity);
      if (radio.length) mixes.push({ id: 'radio', title: 'Because you played ' + recent[0].title, tracks: radio });
    }
    return { cold_start: false, mixes };
  },
  trackRadio(id, limit = 25) { return recs.trackRadio(db, id, limit); },
  artistRadio(artist, limit = 25) { return recs.artistRadio(db, artist, limit); },

  // ---- playback sources ----
  // Native (Android): stream from app storage through Capacitor's local
  // server. Web (the installable iOS PWA): read the file and hand out a blob
  // URL, cached per path so repeated plays don't re-decode.
  _urlCache: new Map(),
  async _fileUrl(relPath, mime) {
    const { Capacitor } = require('@capacitor/core');
    const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
    if (Capacitor.getPlatform() !== 'web') {
      const r = await Filesystem.getUri({ path: relPath, directory: Directory.Data });
      return Capacitor.convertFileSrc(r.uri);
    }
    const key = relPath;
    if (api._urlCache.has(key)) return api._urlCache.get(key);
    const r = await Filesystem.readFile({ path: relPath, directory: Directory.Data, encoding: Encoding.Base64 });
    const { base64ToBytes } = require('./b64');
    const blob = new Blob([base64ToBytes(r.data)], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    api._urlCache.set(key, url);
    return url;
  },
  async playSrc(id) {
    const t = api.track(id);
    if (!t) return { error: 'missing' };
    if (t.codec && /alac/i.test(t.codec)) return { error: 'unsupported', codec: 'ALAC' };
    try {
      const mime = ({ mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
        opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
        webm: 'audio/webm' })[(t.path.split('.').pop() || '').toLowerCase()] || 'audio/*';
      const url = await api._fileUrl(t.path, mime);
      return { url, track: t };
    } catch (e) {
      return { error: 'io', message: String(e && e.message || e) };
    }
  },
  async artSrc(id) {
    const t = api.track(id);
    if (!t || !t.art_path) return null;
    try {
      const mime = t.art_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return await api._fileUrl(t.art_path, mime);
    } catch (e) { return null; }
  },

  // ---- import ----
  async importFiles(fileList, onProgress) {
    const out = await importer.importFiles(db, fileList, onProgress);
    if (out.imported) { db.save(); emitChange(); } else db.saveSoon();
    return out;
  },
};

module.exports = { install };
