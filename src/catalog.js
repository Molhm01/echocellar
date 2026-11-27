'use strict';
// Offline artist/release catalog. Datasets are JSONL files with one typed
// record per line: {"type":"artist"|"release"|"track", ...}. A small starter
// catalog ships inside the installer; full datasets (e.g. a MusicBrainz
// conversion, see tools/build-catalog-from-musicbrainz.py) can be imported
// from a file (USB transfer) or a URL. Imports are transactional: a failed or
// interrupted import leaves the previous catalog fully usable. User edits
// (catalog_edits) are stored separately and survive every update.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalize } = require('./lib/util');

function meta(db, key) {
  const r = db.get('SELECT value FROM catalog_meta WHERE key = ?', [key]);
  return r ? r.value : null;
}
function setMeta(db, key, value) {
  db.exec('INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)', [key, String(value)]);
}

function estimateFileSize(filePath) {
  const st = fs.statSync(filePath);
  // Rule of thumb: parsed rows in SQLite take ~2.5x the JSONL size.
  return { download_bytes: st.size, disk_estimate_bytes: Math.round(st.size * 2.5) };
}

async function importDatasetFile(db, filePath, sourceLabel, onProgress) {
  const counts = { artists: 0, releases: 0, tracks: 0 };
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    db.execRaw('BEGIN IMMEDIATE');
    // Full replace of dataset content; user edits live in catalog_edits.
    db.execRaw('DELETE FROM catalog_tracks');
    db.execRaw('DELETE FROM catalog_releases');
    db.execRaw('DELETE FROM catalog_artists');
    for await (const line of rl) {
      lineNo += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (rec.type === 'artist' && rec.id && rec.name) {
        db.exec('INSERT OR REPLACE INTO catalog_artists (id, name, sort_name, data) VALUES (?, ?, ?, ?)',
          [rec.id, rec.name, rec.sort_name || rec.name, JSON.stringify(rec)]);
        counts.artists += 1;
      } else if (rec.type === 'release' && rec.id && rec.title) {
        db.exec('INSERT OR REPLACE INTO catalog_releases (id, artist_id, title, year, type, data) VALUES (?, ?, ?, ?, ?, ?)',
          [rec.id, rec.artist_id || null, rec.title, rec.year || null, rec.release_type || null, JSON.stringify(rec)]);
        counts.releases += 1;
      } else if (rec.type === 'track' && rec.id && rec.title) {
        db.exec('INSERT OR REPLACE INTO catalog_tracks (id, release_id, title, duration_ms, position, media_url, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [rec.id, rec.release_id || null, rec.title, rec.duration_ms || null, rec.position || null, rec.media_url || null, JSON.stringify(rec)]);
        counts.tracks += 1;
      }
      if (onProgress && lineNo % 5000 === 0) onProgress({ lines: lineNo, ...counts });
    }
    setMeta(db, 'source', sourceLabel || path.basename(filePath));
    setMeta(db, 'last_successful_update', Date.now());
    setMeta(db, 'counts', JSON.stringify(counts));
    db.execRaw('COMMIT');
  } catch (err) {
    try { db.execRaw('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  db.save();
  return counts;
}

// Resume-capable download to a .part file, then atomic dataset import.
async function downloadDataset(url, destPath, onProgress) {
  const partPath = destPath + '.part';
  let resumeFrom = 0;
  if (fs.existsSync(partPath)) resumeFrom = fs.statSync(partPath).size;
  const headers = {};
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0) + (res.status === 206 ? resumeFrom : 0);
  const file = fs.createWriteStream(partPath, { flags: resumeFrom > 0 && res.status === 206 ? 'a' : 'w' });
  const reader = res.body.getReader();
  let received = resumeFrom;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(Buffer.from(value));
    received += value.length;
    if (onProgress && total) onProgress({ received, total });
  }
  await new Promise((resolve, reject) => file.end((e) => e ? reject(e) : resolve()));
  fs.renameSync(partPath, destPath);
  return { path: destPath, bytes: received };
}

async function updateFromUrl(db, url, downloadsDir, onProgress) {
  // HEAD first so the UI can show the size before committing.
  const head = await fetch(url, { method: 'HEAD' });
  const size = Number(head.headers.get('content-length') || 0);
  const dest = path.join(downloadsDir, 'catalog-dataset.jsonl');
  fs.mkdirSync(downloadsDir, { recursive: true });
  await downloadDataset(url, dest, onProgress);
  return importDatasetFile(db, dest, url, onProgress);
}

function coverage(db) {
  const counts = JSON.parse(meta(db, 'counts') || '{"artists":0,"releases":0,"tracks":0}');
  const owned = db.get(
    `SELECT COUNT(*) AS c FROM catalog_tracks ct
     WHERE EXISTS (
       SELECT 1 FROM catalog_releases cr JOIN catalog_artists ca ON ca.id = cr.artist_id
       JOIN tracks t ON t.missing = 0
       WHERE cr.id = ct.release_id
         AND LOWER(ca.name) = LOWER(t.artist) AND LOWER(ct.title) = LOWER(t.title))`
  );
  return {
    source: meta(db, 'source'),
    last_successful_update: Number(meta(db, 'last_successful_update') || 0) || null,
    counts,
    owned_tracks: owned ? owned.c : 0,
  };
}

function searchCatalog(db, query, limit = 50) {
  const q = `%${(query || '').toLowerCase()}%`;
  const artists = db.all(
    `SELECT a.id, a.name,
       (SELECT COUNT(*) FROM catalog_releases r WHERE r.artist_id = a.id) AS releases
     FROM catalog_artists a WHERE LOWER(a.name) LIKE ? ORDER BY a.name LIMIT ?`, [q, limit]);
  const releases = db.all(
    `SELECT r.id, r.title, r.year, r.type, a.name AS artist
     FROM catalog_releases r LEFT JOIN catalog_artists a ON a.id = r.artist_id
     WHERE LOWER(r.title) LIKE ? ORDER BY r.year DESC LIMIT ?`, [q, limit]);
  const tracks = db.all(
    `SELECT ct.id, ct.title, ct.duration_ms, ct.media_url, cr.title AS release, ca.name AS artist,
       EXISTS (SELECT 1 FROM tracks t WHERE t.missing = 0
               AND LOWER(t.title) = LOWER(ct.title) AND LOWER(t.artist) = LOWER(ca.name)) AS owned
     FROM catalog_tracks ct
     LEFT JOIN catalog_releases cr ON cr.id = ct.release_id
     LEFT JOIN catalog_artists ca ON ca.id = cr.artist_id
     WHERE LOWER(ct.title) LIKE ? ORDER BY ct.title LIMIT ?`, [q, limit]);
  return { artists, releases, tracks };
}

function browseArtist(db, artistId) {
  const artist = db.get('SELECT * FROM catalog_artists WHERE id = ?', [artistId]);
  if (!artist) return null;
  const releases = db.all(
    'SELECT id, title, year, type FROM catalog_releases WHERE artist_id = ? ORDER BY year', [artistId]);
  for (const r of releases) {
    r.tracks = db.all(
      `SELECT ct.id, ct.title, ct.duration_ms, ct.position, ct.media_url,
         EXISTS (SELECT 1 FROM tracks t WHERE t.missing = 0 AND LOWER(t.title) = LOWER(ct.title)
                 AND LOWER(t.artist) = LOWER(?)) AS owned
       FROM catalog_tracks ct WHERE ct.release_id = ? ORDER BY ct.position`, [artist.name, r.id]);
  }
  return { artist, releases };
}

function saveEdit(db, entity, entityId, patch) {
  db.exec('INSERT OR REPLACE INTO catalog_edits (entity, entity_id, patch, updated_at) VALUES (?, ?, ?, ?)',
    [entity, entityId, JSON.stringify(patch), Date.now()]);
  db.save();
}

// Scheduled updates: weekly | monthly | manual. usb = import from file only.
function scheduleDue(db, now) {
  now = now || Date.now();
  const mode = meta(db, 'update_mode') || 'manual';
  if (mode === 'manual' || mode === 'usb') return false;
  const last = Number(meta(db, 'last_attempt') || 0);
  const interval = mode === 'weekly' ? 7 * 86400000 : 30 * 86400000;
  return now - last >= interval;
}
function markAttempt(db, now) { setMeta(db, 'last_attempt', now || Date.now()); db.save(); }

module.exports = {
  meta, setMeta, estimateFileSize, importDatasetFile, downloadDataset,
  updateFromUrl, coverage, searchCatalog, browseArtist, saveEdit,
  scheduleDue, markAttempt,
};
