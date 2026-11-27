'use strict';
// Library import: scan/probe audio files, copy-to-managed or reference,
// dedupe, relink, sidecar lyrics, cover art extraction, M3U playlists.
// Pure node (fs + music-metadata); electron only supplies directory paths.

const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');
const {
  AUDIO_EXTS, VIDEO_EXTS, extOf, sha1File, sha1String,
  sanitizePathComponent, normalize,
} = require('./lib/util');
const { relinkUnmatchedEntries } = require('./lib/spotify');

function isAudioFile(p) {
  const ext = extOf(p);
  // .mp4 is both: treat as audio only when in a music import context; here we
  // exclude it (videos attach explicitly). m4a covers AAC/ALAC.
  return AUDIO_EXTS.filter((e) => e !== '.mp4').includes(ext);
}
function isVideoFile(p) { return VIDEO_EXTS.includes(extOf(p)); }

function walkFiles(inputPaths) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const e of entries) walk(path.join(p, e));
    } else if (st.isFile()) out.push(p);
  };
  for (const p of inputPaths) walk(p);
  return out;
}

function sidecarLyrics(audioPath) {
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  for (const ext of ['.lrc', '.LRC', '.txt', '.TXT']) {
    const cand = path.join(dir, base + ext);
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

async function probe(filePath) {
  const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
  const c = meta.common, f = meta.format;
  let embeddedLyrics = false;
  if (Array.isArray(c.lyrics) && c.lyrics.length) {
    embeddedLyrics = c.lyrics.some((l) => (typeof l === 'string' ? l : l && (l.text || l.syncText)).toString().length > 0);
  }
  let picture = null;
  if (Array.isArray(c.picture) && c.picture.length) picture = c.picture[0];
  return {
    title: c.title || path.basename(filePath, path.extname(filePath)),
    artist: c.artist || (c.artists && c.artists[0]) || 'Unknown Artist',
    album: c.album || null,
    album_artist: c.albumartist || null,
    genre: (c.genre && c.genre[0]) || null,
    year: c.year || (c.date ? parseInt(c.date, 10) : null) || null,
    track_no: c.track && c.track.no ? c.track.no : null,
    disc_no: c.disk && c.disk.no ? c.disk.no : null,
    duration_ms: f.duration ? Math.round(f.duration * 1000) : null,
    codec: (f.codec || extOf(filePath).slice(1).toUpperCase()),
    sample_rate: f.sampleRate || null,
    bit_depth: f.bitsPerSample || null,
    bitrate: f.bitrate ? Math.round(f.bitrate) : null,
    isrc: c.isrc && c.isrc[0] ? c.isrc[0] : null,
    embeddedLyrics,
    picture,
  };
}

function storeCoverArt(picture, artDir) {
  if (!picture || !picture.data) return null;
  const hash = sha1String(Buffer.from(picture.data).toString('base64').slice(0, 4096));
  const ext = picture.format && picture.format.includes('png') ? '.png' : '.jpg';
  const out = path.join(artDir, hash + ext);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(out, Buffer.from(picture.data));
  }
  return out;
}

function managedTarget(probeResult, srcPath, managedDir, sha) {
  const artist = sanitizePathComponent(probeResult.album_artist || probeResult.artist);
  const album = sanitizePathComponent(probeResult.album || 'Singles');
  const name = sanitizePathComponent(path.basename(srcPath, path.extname(srcPath)));
  const ext = path.extname(srcPath).toLowerCase();
  let target = path.join(managedDir, artist, album, name + ext);
  if (fs.existsSync(target) && target !== srcPath) {
    target = path.join(managedDir, artist, album, `${name}-${String(sha).slice(0, 8)}${ext}`);
  }
  return target;
}

async function importOne(db, filePath, opts) {
  const { mode, managedDir, artDir } = opts;
  const st = fs.statSync(filePath);
  const sha = await sha1File(filePath, fs);

  const existingByHash = db.get('SELECT id, path FROM tracks WHERE sha1 = ?', [sha]);
  if (existingByHash && fs.existsSync(existingByHash.path)) {
    return { status: 'duplicate', path: filePath, track_id: existingByHash.id };
  }

  let meta;
  try {
    meta = await probe(filePath);
  } catch (err) {
    return { status: 'error', path: filePath, error: String(err && err.message || err) };
  }

  let finalPath = filePath;
  let managed = 0;
  if (mode === 'copy') {
    finalPath = managedTarget(meta, filePath, managedDir, sha);
    if (finalPath !== filePath) {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.copyFileSync(filePath, finalPath); // originals preserved
      managed = 1;
    }
  }

  const artPath = storeCoverArt(meta.picture, artDir);
  const lrc = sidecarLyrics(filePath) || (mode === 'copy' ? sidecarLyrics(finalPath) : null);
  const now = Date.now();

  const existing = db.get('SELECT id FROM tracks WHERE path = ?', [finalPath]);
  if (existing) {
    db.exec(
      `UPDATE tracks SET title=?, artist=?, album=?, album_artist=?, genre=?, year=?, track_no=?, disc_no=?,
        duration_ms=?, codec=?, sample_rate=?, bit_depth=?, bitrate=?, size=?, mtime=?, sha1=?, isrc=?,
        art_path=COALESCE(?, art_path), lyrics_embedded=?, lyrics_path=COALESCE(?, lyrics_path), missing=0, updated_at=?
       WHERE id=?`,
      [meta.title, meta.artist, meta.album, meta.album_artist, meta.genre, meta.year, meta.track_no, meta.disc_no,
       meta.duration_ms, meta.codec, meta.sample_rate, meta.bit_depth, meta.bitrate, st.size, Math.round(st.mtimeMs), sha, meta.isrc,
       artPath, meta.embeddedLyrics ? 1 : 0, lrc, now, existing.id]
    );
    return { status: 'updated', path: finalPath, track_id: existing.id };
  }

  const id = db.exec(
    `INSERT INTO tracks
      (path, managed, title, artist, album, album_artist, genre, year, track_no, disc_no,
       duration_ms, codec, sample_rate, bit_depth, bitrate, size, mtime, sha1, isrc,
       art_path, lyrics_embedded, lyrics_path, missing, added_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [finalPath, managed, meta.title, meta.artist, meta.album, meta.album_artist, meta.genre,
     meta.year, meta.track_no, meta.disc_no, meta.duration_ms, meta.codec, meta.sample_rate,
     meta.bit_depth, meta.bitrate, st.size, Math.round(st.mtimeMs), sha, meta.isrc,
     artPath, meta.embeddedLyrics ? 1 : 0, lrc, now, now]
  );
  return { status: 'added', path: finalPath, track_id: id };
}

// Import files/folders. Returns counts and any spotify auto-link results.
async function importPaths(db, inputPaths, opts, onProgress) {
  const files = walkFiles(inputPaths);
  const audio = files.filter(isAudioFile);
  const ignored = files.length - audio.length;
  const counts = { added: 0, updated: 0, duplicate: 0, error: 0, ignored, errors: [] };
  for (let i = 0; i < audio.length; i++) {
    const r = await importOne(db, audio[i], opts);
    counts[r.status === 'added' ? 'added' : r.status === 'updated' ? 'updated'
      : r.status === 'duplicate' ? 'duplicate' : 'error'] += 1;
    if (r.status === 'error') counts.errors.push({ path: audio[i], error: r.error });
    if (onProgress) onProgress({ current: i + 1, total: audio.length, path: audio[i], result: r.status });
  }
  db.save();
  // New audio may satisfy missing Spotify playlist entries.
  const relink = relinkUnmatchedEntries(db);
  db.save();
  return { ...counts, linked_missing: relink.linked };
}

// Flag tracks whose files vanished; relink when a same-named file exists.
function refreshMissing(db, searchRoots) {
  const rows = db.all('SELECT id, path, missing FROM tracks');
  const roots = searchRoots && searchRoots.length ? searchRoots : [];
  const fileIndex = new Map();
  for (const root of roots) {
    for (const f of walkFiles([root])) {
      if (isAudioFile(f)) {
        const base = path.basename(f).toLowerCase();
        if (!fileIndex.has(base)) fileIndex.set(base, f);
      }
    }
  }
  let relinked = 0, missing = 0;
  db.transaction(() => {
    for (const r of rows) {
      const exists = fs.existsSync(r.path);
      if (!exists && !r.missing) {
        const base = path.basename(r.path).toLowerCase();
        const found = fileIndex.get(base);
        db.exec('UPDATE tracks SET missing = 1, path = ? WHERE id = ?', [found || r.path, r.id]);
        if (found) { db.exec('UPDATE tracks SET missing = 0 WHERE id = ?', [r.id]); relinked += 1; }
        else missing += 1;
      } else if (exists && r.missing) {
        db.exec('UPDATE tracks SET missing = 0 WHERE id = ?', [r.id]);
      }
    }
  });
  db.save();
  return { relinked, missing };
}

// Relink after the user moved a whole folder: remap by path suffix.
function relinkFolder(db, oldRoot, newRoot) {
  const rows = db.all('SELECT id, path FROM tracks WHERE path LIKE ?', [oldRoot + '%']);
  let relinked = 0;
  db.transaction(() => {
    for (const r of rows) {
      const suffix = r.path.slice(oldRoot.length).replace(/^[\\/]/, '');
      const candidate = path.join(newRoot, suffix);
      if (fs.existsSync(candidate)) {
        db.exec('UPDATE tracks SET path = ?, missing = 0 WHERE id = ?', [candidate, r.id]);
        relinked += 1;
      }
    }
  });
  db.save();
  return { relinked, total: rows.length };
}

function refreshDuplicates(db) {
  db.execRaw('DELETE FROM duplicates');
  const rows = db.all(
    `SELECT id, title, artist, duration_ms FROM tracks WHERE missing = 0 ORDER BY artist, title`
  );
  const groups = new Map();
  for (const r of rows) {
    const durBucket = r.duration_ms ? Math.round(r.duration_ms / 2000) : 0;
    const key = `${normalize(r.artist)}|${normalize(r.title)}|${durBucket}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.id);
  }
  let n = 0;
  db.transaction(() => {
    for (const [key, ids] of groups) {
      if (ids.length > 1) {
        for (const id of ids) db.exec('INSERT INTO duplicates (track_id, group_key) VALUES (?, ?)', [id, key]);
        n += ids.length;
      }
    }
  });
  db.save();
  return n;
}

function importM3U(db, filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  let name = path.basename(filePath, path.extname(filePath));
  const entries = [];
  let pendingTitle = null;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#PLAYLIST:')) { name = l.slice(10).trim() || name; continue; }
    if (l.startsWith('#EXTINF:')) { pendingTitle = l.split(',', 2)[1] || null; continue; }
    if (l.startsWith('#')) continue;
    entries.push({ ref: l, title: pendingTitle });
    pendingTitle = null;
  }
  const baseDir = path.dirname(filePath);
  const now = Date.now();
  const playlistId = db.exec(
    'INSERT OR REPLACE INTO playlists (name, source, created_at, updated_at) VALUES (?, ?, COALESCE((SELECT created_at FROM playlists WHERE name=? AND source=?), ?), ?)',
    [name, 'local', name, 'local', now, now]
  );
  const pid = db.get('SELECT id FROM playlists WHERE name = ? AND source = ?', [name, 'local']).id || playlistId;
  db.exec('DELETE FROM playlist_entries WHERE playlist_id = ?', [pid]);
  let matched = 0, missing = 0;
  entries.forEach((e, idx) => {
    let trackPath = e.ref;
    if (!path.isAbsolute(trackPath)) trackPath = path.resolve(baseDir, trackPath);
    const track = db.get('SELECT id FROM tracks WHERE path = ?', [trackPath])
      || db.get('SELECT id FROM tracks WHERE path = ?', [decodeURIComponent(trackPath.replace(/^file:\/\//, ''))]);
    if (track) {
      db.exec('INSERT INTO playlist_entries (playlist_id, position, track_id, status) VALUES (?, ?, ?, ?)',
        [pid, idx, track.id, 'matched']);
      matched += 1;
    } else {
      db.exec(
        'INSERT INTO playlist_entries (playlist_id, position, track_id, status, req_title, req_artist) VALUES (?, ?, NULL, ?, ?, ?)',
        [pid, idx, 'missing', e.title || path.basename(e.ref), null]);
      missing += 1;
    }
  });
  db.save();
  return { name, matched, missing, playlist_id: pid };
}

function attachVideo(db, trackId, videoPath, offsetMs) {
  db.exec('UPDATE tracks SET video_path = ?, video_offset_ms = ?, updated_at = ? WHERE id = ?',
    [videoPath, offsetMs || 0, Date.now(), trackId]);
  db.save();
  return db.get('SELECT id, video_path, video_offset_ms FROM tracks WHERE id = ?', [trackId]);
}

module.exports = {
  isAudioFile, isVideoFile, walkFiles, probe, importPaths, importOne,
  refreshMissing, relinkFolder, refreshDuplicates, importM3U, attachVideo,
  sidecarLyrics,
};
