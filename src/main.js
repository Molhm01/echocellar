'use strict';
// Echocellar main process: window, media:// protocol, IPC, watchers, media keys.

const { app, BrowserWindow, ipcMain, dialog, protocol, globalShortcut, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { spawn } = require('child_process');

const { DB } = require('./lib/db');
const library = require('./library');
const spotify = require('./lib/spotify');
const recs = require('./lib/recs');
const stats = require('./stats');
const catalog = require('./catalog');
const { parseLrc } = require('./lib/lyrics');
const { extOf } = require('./lib/util');

const TEST_MODE = process.env.ECHOCELLAR_TEST === '1';
const HOME_DIR = process.env.ECHOCELLAR_HOME || app.getPath('userData');
const DB_PATH = path.join(HOME_DIR, 'library.db');
const ART_DIR = path.join(HOME_DIR, 'art');
const MANAGED_DIR = path.join(HOME_DIR, 'library');
const DOWNLOADS_DIR = path.join(HOME_DIR, 'downloads');
const TRANSCODE_DIR = path.join(HOME_DIR, 'transcode');
const PLAYBACK_STATE_PATH = path.join(HOME_DIR, 'playback-state.json');

const db = new DB();
let win = null;
let watcher = null;
let simulatedOffline = false; // test hook: the app makes no network calls in everyday use regardless

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(p)) return p;
  }
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
}

const MIME = {
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};

function serveFile(filePath, req) {
  if (!filePath || !fs.existsSync(filePath)) return new Response('not found', { status: 404 });
  const size = fs.statSync(filePath).size;
  const type = MIME[extOf(filePath)] || 'application/octet-stream';
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
  }
  const stream = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
  });
}

// ALAC (and anything Chromium cannot decode) plays through a lossless PCM
// transcode cache: ffmpeg decodes to WAV once, then it serves like any file.
async function playablePath(track) {
  const codec = (track.codec || '').toUpperCase();
  const needsTranscode = codec === 'ALAC' || codec === 'WMA' || codec === 'APE' || codec === 'AIFF';
  if (!needsTranscode) return track.path;
  const out = path.join(TRANSCODE_DIR, `${track.sha1 || track.id}.wav`);
  if (fs.existsSync(out) && fs.statSync(out).size > 44) return out;
  fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-y', '-i', track.path, '-vn', '-f', 'wav', '-acodec', 'pcm_s16le', out]);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    p.on('error', reject);
  });
  return out;
}

function trackById(id) {
  return db.get('SELECT * FROM tracks WHERE id = ?', [Number(id)]);
}

function registerProtocol() {
  protocol.handle('media', async (req) => {
    try {
      const u = new URL(req.url);
      const parts = u.pathname.split('/').filter(Boolean);
      const kind = u.hostname || parts.shift();
      const id = parts[0] || u.pathname.replace(/^\//, '');
      if (kind === 'track') {
        const track = trackById(id);
        if (!track) return new Response('not found', { status: 404 });
        const p = await playablePath(track);
        return serveFile(p, req);
      }
      if (kind === 'video') {
        const track = trackById(id);
        if (!track || !track.video_path) return new Response('no video', { status: 404 });
        return serveFile(track.video_path, req);
      }
      if (kind === 'art') {
        const track = trackById(id);
        if (!track || !track.art_path) return new Response('no art', { status: 404 });
        return serveFile(track.art_path, req);
      }
      if (kind === 'file') {
        return serveFile(decodeURIComponent(u.searchParams.get('path') || ''), req);
      }
      return new Response('bad request', { status: 400 });
    } catch (err) {
      return new Response(String(err && err.message || err), { status: 500 });
    }
  });
}

// ---- watchers ---------------------------------------------------------------

function rebuildWatcher() {
  if (watcher) { watcher.close(); watcher = null; }
  const folders = db.all('SELECT path FROM watch_folders').map((r) => r.path);
  if (!folders.length) return;
  const chokidar = require('chokidar');
  watcher = chokidar.watch(folders, { ignoreInitial: true, depth: 20 });
  const opts = () => ({ mode: getSetting('import_mode', 'reference'), managedDir: MANAGED_DIR, artDir: ART_DIR });
  watcher.on('add', async (p) => {
    if (library.isAudioFile(p)) {
      await library.importOne(db, p, opts());
      spotify.relinkUnmatchedEntries(db);
      db.save();
      notifyLibraryChanged();
    }
  });
  watcher.on('change', async (p) => {
    if (library.isAudioFile(p)) {
      await library.importOne(db, p, opts());
      db.save();
      notifyLibraryChanged();
    }
  });
  watcher.on('unlink', (p) => {
    db.exec('UPDATE tracks SET missing = 1 WHERE path = ?', [p]);
    db.save();
    notifyLibraryChanged();
  });
}

function notifyLibraryChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('library-changed');
}

// ---- settings ---------------------------------------------------------------

function getSetting(key, fallback) {
  const r = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return r.value; }
}
function setSetting(key, value) {
  db.exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  db.save();
}

// ---- IPC --------------------------------------------------------------------

function readClipboardPaths() {
  // Windows Explorer copy: FileNameW buffer (UTF-16LE, double-null list).
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (buf && buf.length > 20) {
      const offset = buf.readUInt32LE(0);
      if (offset > 0 && offset < buf.length) {
        const text = buf.slice(offset).toString('utf16le');
        const paths = text.split('').filter(Boolean);
        if (paths.length) return paths;
      }
    }
  } catch { /* not on windows or no files on clipboard */ }
  const text = clipboard.readText() || '';
  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^"|"$/g, '')).filter((l) => l && fs.existsSync(l));
  return lines;
}

function registerIpc() {
  const opts = (mode) => ({
    mode: mode || getSetting('import_mode', 'reference'),
    managedDir: MANAGED_DIR,
    artDir: ART_DIR,
  });

  ipcMain.handle('library:importPaths', async (_e, paths, mode) => {
    const json = paths.filter((p) => extOf(p) === '.json');
    const m3u = paths.filter((p) => ['.m3u', '.m3u8', '.pls'].includes(extOf(p)));
    const rest = paths.filter((p) => !json.includes(p) && !m3u.includes(p));
    const out = { import: null, spotify: null, playlists: [] };
    if (rest.length) {
      out.import = await library.importPaths(db, rest, opts(mode), (prog) => {
        if (win && !win.isDestroyed()) win.webContents.send('import-progress', prog);
      });
      library.refreshDuplicates(db);
    }
    for (const f of m3u) out.playlists.push(library.importM3U(db, f));
    if (json.length) {
      const files = json.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
      out.spotify = spotify.importSpotifyExport(db, files);
      db.save();
    }
    notifyLibraryChanged();
    return out;
  });

  ipcMain.handle('library:chooseImport', async (_e, mode, kind) => {
    let result;
    if (kind === 'folder') {
      result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
    } else {
      result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Audio', extensions: ['flac', 'm4a', 'wav', 'mp3', 'aac', 'ogg', 'oga'] },
          { name: 'Playlists & exports', extensions: ['m3u', 'm3u8', 'pls', 'json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
    }
    if (result.canceled || !result.filePaths.length) return null;
    return library.importPaths(db, result.filePaths, opts(mode));
  });

  ipcMain.handle('library:tracks', (_e, q) => {
    let sql = `SELECT id, title, artist, album, duration_ms, codec, sample_rate, bit_depth, art_path, video_path, missing
               FROM tracks`;
    const params = [];
    if (q) {
      sql += ' WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?';
      const like = `%${q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    sql += ' ORDER BY artist, album, disc_no, track_no, title LIMIT 2000';
    return db.all(sql, params);
  });
  ipcMain.handle('library:track', (_e, id) => trackById(id));
  ipcMain.handle('library:artists', () => db.all(
    `SELECT artist, COUNT(*) AS tracks, SUM(duration_ms) AS ms FROM tracks
     WHERE missing = 0 GROUP BY artist ORDER BY artist`));
  ipcMain.handle('library:albums', () => db.all(
    `SELECT album, COALESCE(album_artist, artist) AS artist, COUNT(*) AS tracks,
            MIN(year) AS year, (SELECT art_path FROM tracks t2 WHERE t2.album = tracks.album AND t2.art_path IS NOT NULL LIMIT 1) AS art_path
     FROM tracks WHERE missing = 0 AND album IS NOT NULL GROUP BY album, artist ORDER BY album`));
  ipcMain.handle('library:albumTracks', (_e, album, artist) => db.all(
    `SELECT id, title, artist, album, duration_ms, track_no, disc_no FROM tracks
     WHERE album = ? AND COALESCE(album_artist, artist) = ? AND missing = 0
     ORDER BY disc_no, track_no, title`, [album, artist]));
  ipcMain.handle('library:artistTracks', (_e, artist) => db.all(
    `SELECT id, title, artist, album, duration_ms, year FROM tracks
     WHERE artist = ? AND missing = 0 ORDER BY album, disc_no, track_no`, [artist]));
  ipcMain.handle('library:duplicates', () => {
    library.refreshDuplicates(db);
    return db.all(
      `SELECT d.group_key, t.id, t.title, t.artist, t.album, t.path, t.size, t.codec
       FROM duplicates d JOIN tracks t ON t.id = d.track_id ORDER BY d.group_key, t.id`);
  });
  ipcMain.handle('library:refreshMissing', () => {
    const folders = db.all('SELECT path FROM watch_folders').map((r) => r.path);
    return library.refreshMissing(db, [MANAGED_DIR, ...folders]);
  });
  ipcMain.handle('library:relinkFolder', (_e, oldRoot, newRoot) => library.relinkFolder(db, oldRoot, newRoot));
  ipcMain.handle('library:watchFolders', () => db.all('SELECT path, added_at FROM watch_folders'));
  ipcMain.handle('library:addWatchFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    db.exec('INSERT OR IGNORE INTO watch_folders (path, added_at) VALUES (?, ?)', [r.filePaths[0], Date.now()]);
    db.save();
    rebuildWatcher();
    const res = await library.importPaths(db, [r.filePaths[0]], opts());
    notifyLibraryChanged();
    return { folder: r.filePaths[0], ...res };
  });
  ipcMain.handle('library:removeWatchFolder', (_e, p) => {
    db.exec('DELETE FROM watch_folders WHERE path = ?', [p]);
    db.save();
    rebuildWatcher();
    return true;
  });
  ipcMain.handle('library:attachVideo', async (_e, trackId, offsetMs) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'webm', 'mkv', 'mov'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return library.attachVideo(db, trackId, r.filePaths[0], offsetMs || 0);
  });
  ipcMain.handle('library:setVideoOffset', (_e, trackId, offsetMs) =>
    library.attachVideo(db, trackId, trackById(trackId).video_path, offsetMs));
  ipcMain.handle('library:toggleFavorite', (_e, trackId) => {
    const has = db.get('SELECT track_id FROM favorites WHERE track_id = ?', [trackId]);
    if (has) db.exec('DELETE FROM favorites WHERE track_id = ?', [trackId]);
    else db.exec('INSERT INTO favorites (track_id, created_at) VALUES (?, ?)', [trackId, Date.now()]);
    db.save();
    return !has;
  });
  ipcMain.handle('library:favorites', () => db.all(
    `SELECT t.id, t.title, t.artist, t.album, t.duration_ms FROM favorites f
     JOIN tracks t ON t.id = f.track_id ORDER BY f.created_at DESC`));

  ipcMain.handle('spotify:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Spotify export JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const files = r.filePaths.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
    const out = spotify.importSpotifyExport(db, files);
    db.save();
    notifyLibraryChanged();
    return out;
  });
  ipcMain.handle('spotify:reviewList', () => db.all(
    `SELECT pe.id, pe.req_artist, pe.req_title, pe.req_album, pe.req_duration_ms, pe.candidates, p.name AS playlist
     FROM playlist_entries pe JOIN playlists p ON p.id = pe.playlist_id
     WHERE pe.status = 'review' ORDER BY p.name, pe.position`));
  ipcMain.handle('spotify:resolve', (_e, entryId, trackId) => {
    if (trackId) {
      db.exec('UPDATE playlist_entries SET track_id = ?, status = ?, candidates = NULL WHERE id = ?',
        [trackId, 'matched', entryId]);
    } else {
      db.exec('UPDATE playlist_entries SET status = ?, candidates = NULL WHERE id = ?', ['missing', entryId]);
    }
    db.save();
    notifyLibraryChanged();
    return true;
  });

  ipcMain.handle('playlists:list', () => db.all(
    `SELECT p.id, p.name, p.source, p.updated_at,
            COUNT(pe.id) AS entries,
            SUM(CASE WHEN pe.status = 'matched' THEN 1 ELSE 0 END) AS matched
     FROM playlists p LEFT JOIN playlist_entries pe ON pe.playlist_id = p.id
     GROUP BY p.id ORDER BY p.name`));
  ipcMain.handle('playlists:entries', (_e, id) => db.all(
    `SELECT pe.id, pe.position, pe.status, pe.req_artist, pe.req_title, pe.req_album,
            t.id AS track_id, t.title, t.artist, t.album, t.duration_ms, t.art_path, t.codec
     FROM playlist_entries pe LEFT JOIN tracks t ON t.id = pe.track_id
     WHERE pe.playlist_id = ? ORDER BY pe.position`, [id]));
  ipcMain.handle('playlists:create', (_e, name) => {
    const id = db.exec('INSERT INTO playlists (name, source, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [name, 'local', Date.now(), Date.now()]);
    db.save();
    return id;
  });
  ipcMain.handle('playlists:rename', (_e, id, name) => {
    db.exec('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [name, Date.now(), id]);
    db.save();
    return true;
  });
  ipcMain.handle('playlists:delete', (_e, id) => {
    db.exec('DELETE FROM playlist_entries WHERE playlist_id = ?', [id]);
    db.exec('DELETE FROM playlists WHERE id = ?', [id]);
    db.save();
    return true;
  });
  ipcMain.handle('playlists:add', (_e, id, trackIds) => {
    const max = db.get('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_entries WHERE playlist_id = ?', [id]).m;
    trackIds.forEach((tid, i) => {
      db.exec('INSERT INTO playlist_entries (playlist_id, position, track_id, status) VALUES (?, ?, ?, ?)',
        [id, max + 1 + i, tid, 'matched']);
    });
    db.save();
    return true;
  });
  ipcMain.handle('playlists:removeEntry', (_e, entryId) => {
    const row = db.get('SELECT playlist_id, position FROM playlist_entries WHERE id = ?', [entryId]);
    if (!row) return false;
    db.transaction(() => {
      db.exec('DELETE FROM playlist_entries WHERE id = ?', [entryId]);
      db.exec('UPDATE playlist_entries SET position = position - 1 WHERE playlist_id = ? AND position > ?',
        [row.playlist_id, row.position]);
    });
    db.save();
    return true;
  });
  ipcMain.handle('playlists:moveEntry', (_e, entryId, newPosition) => {
    const row = db.get('SELECT playlist_id, position FROM playlist_entries WHERE id = ?', [entryId]);
    if (!row) return false;
    const from = row.position, to = newPosition;
    if (from === to) return true;
    db.transaction(() => {
      if (to > from) {
        db.exec('UPDATE playlist_entries SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?',
          [row.playlist_id, from, to]);
      } else {
        db.exec('UPDATE playlist_entries SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?',
          [row.playlist_id, to, from]);
      }
      db.exec('UPDATE playlist_entries SET position = ? WHERE id = ?', [to, entryId]);
    });
    db.save();
    return true;
  });

  ipcMain.handle('playback:recordSession', (_e, s) => stats.recordSession(db, s));
  ipcMain.handle('playback:saveState', (_e, state) => {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(PLAYBACK_STATE_PATH, JSON.stringify(state));
    return true;
  });
  ipcMain.handle('playback:restoreState', () => {
    try { return JSON.parse(fs.readFileSync(PLAYBACK_STATE_PATH, 'utf8')); } catch { return null; }
  });

  ipcMain.handle('lyrics:get', async (_e, trackId) => {
    const track = trackById(trackId);
    if (!track) return null;
    if (track.lyrics_path && fs.existsSync(track.lyrics_path)) {
      const text = fs.readFileSync(track.lyrics_path, 'utf8');
      const timed = extOf(track.lyrics_path) === '.lrc' ? parseLrc(text) : null;
      return { kind: timed && timed.length ? 'timed' : 'plain', lines: timed, text: timed && timed.length ? null : text, source: track.lyrics_path };
    }
    if (track.lyrics_embedded) {
      try {
        const mm = require('music-metadata');
        const meta = await mm.parseFile(track.path);
        const lyric = (meta.common.lyrics || [])[0];
        const text = typeof lyric === 'string' ? lyric : lyric && (lyric.text || '');
        const synced = lyric && lyric.syncText && lyric.syncText.length
          ? lyric.syncText.map((l) => ({ time_ms: Math.round((l.timestamp || 0) * 1000), text: l.text }))
          : null;
        if (synced) return { kind: 'timed', lines: synced, source: 'embedded' };
        if (text) return { kind: 'plain', text, source: 'embedded' };
      } catch { /* fall through */ }
    }
    return null;
  });

  ipcMain.handle('search:instant', (_e, q) => {
    const like = `%${(q || '').toLowerCase()}%`;
    return {
      tracks: db.all(
        `SELECT id, title, artist, album, duration_ms, codec FROM tracks
         WHERE missing = 0 AND (LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?)
         ORDER BY title LIMIT 30`, [like, like, like]),
      artists: db.all(
        `SELECT artist, COUNT(*) AS tracks FROM tracks
         WHERE missing = 0 AND LOWER(artist) LIKE ? GROUP BY artist LIMIT 10`, [like]),
      albums: db.all(
        `SELECT album, COALESCE(album_artist, artist) AS artist, COUNT(*) AS tracks FROM tracks
         WHERE missing = 0 AND album IS NOT NULL AND LOWER(album) LIKE ? GROUP BY album, artist LIMIT 10`, [like]),
      playlists: db.all('SELECT id, name FROM playlists WHERE LOWER(name) LIKE ? LIMIT 10', [like]),
    };
  });

  ipcMain.handle('recs:home', (_e, familiarity) => recs.homeMixes(db, familiarity ?? getSetting('familiarity', 0.7)));
  ipcMain.handle('recs:trackRadio', (_e, id, familiarity) =>
    recs.trackRadio(db, id, 25, familiarity ?? getSetting('familiarity', 0.7)));
  ipcMain.handle('recs:artistRadio', (_e, name, familiarity) =>
    recs.artistRadio(db, name, 25, familiarity ?? getSetting('familiarity', 0.7)));
  ipcMain.handle('recs:similarArtists', (_e, name) => recs.similarArtists(db, name));
  ipcMain.handle('recs:discovery', () => recs.discoveryList(db));
  ipcMain.handle('recs:getFamiliarity', () => getSetting('familiarity', 0.7));
  ipcMain.handle('recs:setFamiliarity', (_e, v) => { setSetting('familiarity', v); return true; });

  ipcMain.handle('catalog:coverage', () => catalog.coverage(db));
  ipcMain.handle('catalog:search', (_e, q) => catalog.searchCatalog(db, q));
  ipcMain.handle('catalog:artist', (_e, id) => catalog.browseArtist(db, id));
  ipcMain.handle('catalog:importFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Catalog dataset', extensions: ['jsonl', 'json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const counts = await catalog.importDatasetFile(db, r.filePaths[0], path.basename(r.filePaths[0]));
    return counts;
  });
  ipcMain.handle('catalog:updateFromUrl', async (_e, url) => {
    if (simulatedOffline) return { error: 'offline' };
    catalog.markAttempt(db);
    return catalog.updateFromUrl(db, url, DOWNLOADS_DIR);
  });
  ipcMain.handle('catalog:setMode', (_e, mode) => { catalog.setMeta(db, 'update_mode', mode); db.save(); return true; });
  ipcMain.handle('catalog:getMode', () => catalog.meta(db, 'update_mode') || 'manual');
  ipcMain.handle('catalog:saveMedia', async (_e, catalogTrackId) => {
    const ct = db.get('SELECT * FROM catalog_tracks WHERE id = ?', [catalogTrackId]);
    if (!ct || !ct.media_url) return { error: 'no authorized media for this entry' };
    if (simulatedOffline) return { error: 'offline' };
    const destDir = path.join(MANAGED_DIR, 'Catalog Downloads');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${ct.id}${extOf(new URL(ct.media_url).pathname) || '.bin'}`);
    await catalog.downloadDataset(ct.media_url, dest);
    const res = await library.importPaths(db, [dest], opts('reference'));
    return { downloaded: dest, ...res };
  });
  ipcMain.handle('catalog:edit', (_e, entity, id, patch) => { catalog.saveEdit(db, entity, id, patch); return true; });

  ipcMain.handle('library:recentTracks', (_e, limit) => db.all(
    `SELECT t.id, t.title, t.artist, t.album, t.duration_ms, MAX(h.played_at) AS last_played
     FROM history h JOIN tracks t ON t.id = h.track_id
     WHERE t.missing = 0 GROUP BY t.id ORDER BY last_played DESC LIMIT ?`, [limit || 12]));
  ipcMain.handle('stats:timeline', (_e, opts) => stats.timeline(db, opts || {}));
  ipcMain.handle('stats:totals', (_e, opts) => stats.totals(db, opts || {}));
  ipcMain.handle('stats:top', (_e, opts) => ({
    tracks: stats.topTracks(db, opts || {}),
    artists: stats.topArtists(db, opts || {}),
    albums: stats.topAlbums(db, opts || {}),
  }));
  ipcMain.handle('stats:export', async (_e, format) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `echocellar-history.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return null;
    return stats.exportHistory(db, format, r.filePath);
  });

  ipcMain.handle('app:settings', () => ({
    import_mode: getSetting('import_mode', 'reference'),
    familiarity: getSetting('familiarity', 0.7),
    catalog_mode: catalog.meta(db, 'update_mode') || 'manual',
    catalog_url: catalog.meta(db, 'update_url') || '',
  }));
  ipcMain.handle('app:setSetting', (_e, k, v) => {
    if (k === 'catalog_mode') { catalog.setMeta(db, 'update_mode', v); db.save(); return true; }
    if (k === 'catalog_url') { catalog.setMeta(db, 'update_url', v); db.save(); return true; }
    setSetting(k, v);
    return true;
  });
  ipcMain.handle('app:backup', async () => {
    db.save();
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `echocellar-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'Echocellar database', extensions: ['db'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(DB_PATH, r.filePath);
    return { path: r.filePath };
  });
  ipcMain.handle('app:restore', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'], filters: [{ name: 'Echocellar database', extensions: ['db'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    db.save();
    fs.copyFileSync(r.filePaths[0], DB_PATH);
    return { restored: true, restartRequired: true };
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    home: HOME_DIR,
    db: DB_PATH,
    managed: MANAGED_DIR,
    packaged: app.isPackaged,
    platform: process.platform,
  }));

  ipcMain.handle('clipboard:paths', () => readClipboardPaths());

  // Test hooks
  if (TEST_MODE) {
    ipcMain.handle('test:state', () => ({
      tracks: db.get('SELECT COUNT(*) c FROM tracks').c,
      playlists: db.get('SELECT COUNT(*) c FROM playlists').c,
      entries: db.get('SELECT COUNT(*) c FROM playlist_entries').c,
      history: db.get('SELECT COUNT(*) c FROM history').c,
      offline: simulatedOffline,
    }));
    ipcMain.handle('test:importPathsSync', async (_e, paths, mode) => {
      const out = await library.importPaths(db, paths, opts(mode || 'reference'));
      library.refreshDuplicates(db);
      notifyLibraryChanged();
      return out;
    });
    ipcMain.handle('test:spotifyImportPaths', (_e, paths) => {
      const files = paths.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
      const out = spotify.importSpotifyExport(db, files);
      db.save();
      notifyLibraryChanged();
      return out;
    });
    ipcMain.handle('test:setOnline', (_e, v) => { simulatedOffline = !v; return simulatedOffline; });
    ipcMain.handle('test:attachVideo', (_e, trackId, videoPath, offsetMs) =>
      library.attachVideo(db, trackId, videoPath, offsetMs || 0));
  }
}

// ---- starter catalog ---------------------------------------------------------

async function ensureStarterCatalog() {
  if (catalog.meta(db, 'seeded')) return;
  const candidates = [
    path.join(process.resourcesPath || '', 'catalog', 'starter-catalog.jsonl'),
    path.join(__dirname, '..', 'assets', 'catalog', 'starter-catalog.jsonl'),
  ];
  const starter = candidates.find((p) => p && fs.existsSync(p));
  if (!starter) { catalog.setMeta(db, 'seeded', 'no-starter'); db.save(); return; }
  await catalog.importDatasetFile(db, starter, 'Echocellar starter catalog');
  catalog.setMeta(db, 'seeded', '1');
  db.save();
}

// ---- app lifecycle -----------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true, standard: true, secure: true } },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.mkdirSync(ART_DIR, { recursive: true });
    await db.load(DB_PATH);
    await ensureStarterCatalog();
    registerProtocol();
    registerIpc();
    rebuildWatcher();

    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 940,
      minHeight: 600,
      backgroundColor: '#100d0b',
      title: 'Echocellar',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    for (const [accel, key] of [
      ['MediaPlayPause', 'play'],
      ['MediaNextTrack', 'next'],
      ['MediaPreviousTrack', 'previous'],
    ]) {
      try { globalShortcut.register(accel, () => win && win.webContents.send('media-key', key)); } catch { /* unsupported platform */ }
    }

    // Scheduled catalog updates (weekly/monthly) when a URL is configured.
    setInterval(async () => {
      try {
        const url = catalog.meta(db, 'update_url');
        if (url && !simulatedOffline && catalog.scheduleDue(db)) {
          catalog.markAttempt(db);
          await catalog.updateFromUrl(db, url, DOWNLOADS_DIR);
          notifyLibraryChanged();
        }
      } catch { /* offline or interrupted: existing catalog stays usable */ }
    }, 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    if (watcher) watcher.close();
    db.close();
    app.quit();
  });
}
