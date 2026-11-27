'use strict';
// Listening history recording, statistics queries, export.
//
// What qualifies as a play or a skip (documented for the user):
// - The player accumulates ACTUAL listening time: the playback clock while the
//   track is audible. Pauses and the regions jumped over by seeking never
//   count. Audio and video playback of the same song in one sitting share a
//   single session, so switching modes never double-counts.
// - A history entry is written once per session, when the track ends or you
//   move on.
// - skipped = 1 when you advance to another track yourself before listening
//   for at least 30 seconds (and under half the track). Letting it end, or
//   moving on after that point, is a play.

const fs = require('fs');

const SKIP_THRESHOLD_MS = 30000;

function recordSession(db, s) {
  // s: {session_id, track_id, played_at, ms_listened, duration_ms, user_ended, mode}
  const dedupe = `loc:${s.session_id}`;
  const existing = db.get('SELECT id FROM history WHERE dedupe_key = ?', [dedupe]);
  const skipped = s.user_ended && (s.ms_listened < SKIP_THRESHOLD_MS) &&
    (!s.duration_ms || s.ms_listened < 0.5 * s.duration_ms) ? 1 : 0;
  const track = s.track_id ? db.get('SELECT title, artist FROM tracks WHERE id = ?', [s.track_id]) : null;
  if (existing) {
    db.exec('UPDATE history SET ms_listened = ?, skipped = ?, mode = ? WHERE id = ?',
      [s.ms_listened, skipped, s.mode || 'audio', existing.id]);
    return { id: existing.id, skipped, updated: true };
  }
  const id = db.exec(
    `INSERT INTO history (track_id, artist, title, played_at, ms_listened, duration_ms, skipped, source, session_id, mode, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'local', ?, ?, ?)`,
    [s.track_id, track ? track.artist : null, track ? track.title : null,
     s.played_at, s.ms_listened, s.duration_ms || null, skipped, s.session_id, s.mode || 'audio', dedupe]
  );
  db.saveSoon();
  return { id, skipped, updated: false };
}

function rangeToBounds(range, custom) {
  const now = Date.now();
  switch (range) {
    case 'week': return { from: now - 7 * 86400000, to: now };
    case 'month': return { from: now - 30 * 86400000, to: now };
    case 'year': return { from: now - 365 * 86400000, to: now };
    case 'all': return { from: 0, to: now };
    case 'custom': return { from: custom && custom.from || 0, to: custom && custom.to || now };
    default: return { from: 0, to: now };
  }
}

function timeline(db, opts) {
  const { from, to } = rangeToBounds(opts.range, opts.custom);
  const q = (opts.query || '').trim();
  let sql = `SELECT h.id, h.played_at, h.ms_listened, h.skipped, h.source, h.mode,
                    COALESCE(h.title, t.title) AS title, COALESCE(h.artist, t.artist) AS artist
             FROM history h LEFT JOIN tracks t ON t.id = h.track_id
             WHERE h.played_at BETWEEN ? AND ?`;
  const params = [from, to];
  if (q) {
    sql += ` AND (LOWER(COALESCE(h.title, t.title)) LIKE ? OR LOWER(COALESCE(h.artist, t.artist)) LIKE ?)`;
    params.push(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`);
  }
  sql += ' ORDER BY h.played_at DESC LIMIT ?';
  params.push(opts.limit || 500);
  return db.all(sql, params);
}

function totals(db, opts) {
  const { from, to } = rangeToBounds(opts.range, opts.custom);
  return db.get(
    `SELECT COUNT(*) AS events,
            SUM(CASE WHEN skipped = 0 THEN 1 ELSE 0 END) AS plays,
            SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) AS skips,
            COALESCE(SUM(ms_listened), 0) AS ms_listened
     FROM history WHERE played_at BETWEEN ? AND ?`, [from, to]);
}

function topTracks(db, opts) {
  const { from, to } = rangeToBounds(opts.range, opts.custom);
  return db.all(
    `SELECT COALESCE(h.title, t.title) AS title, COALESCE(h.artist, t.artist) AS artist,
            COUNT(*) AS plays, SUM(h.ms_listened) AS ms
     FROM history h LEFT JOIN tracks t ON t.id = h.track_id
     WHERE h.played_at BETWEEN ? AND ? AND h.skipped = 0
     GROUP BY title, artist ORDER BY ms DESC LIMIT ?`, [from, to, opts.limit || 20]);
}

function topArtists(db, opts) {
  const { from, to } = rangeToBounds(opts.range, opts.custom);
  return db.all(
    `SELECT COALESCE(h.artist, t.artist) AS artist, COUNT(*) AS plays, SUM(h.ms_listened) AS ms
     FROM history h LEFT JOIN tracks t ON t.id = h.track_id
     WHERE h.played_at BETWEEN ? AND ? AND h.skipped = 0 AND COALESCE(h.artist, t.artist) IS NOT NULL
     GROUP BY artist ORDER BY ms DESC LIMIT ?`, [from, to, opts.limit || 20]);
}

function topAlbums(db, opts) {
  const { from, to } = rangeToBounds(opts.range, opts.custom);
  return db.all(
    `SELECT t.album, t.album_artist AS artist, COUNT(*) AS plays, SUM(h.ms_listened) AS ms
     FROM history h JOIN tracks t ON t.id = h.track_id
     WHERE h.played_at BETWEEN ? AND ? AND h.skipped = 0 AND t.album IS NOT NULL
     GROUP BY t.album, t.album_artist ORDER BY ms DESC LIMIT ?`, [from, to, opts.limit || 20]);
}

function exportHistory(db, format, outPath) {
  const rows = db.all(
    `SELECT h.played_at, COALESCE(h.title, t.title) AS title, COALESCE(h.artist, t.artist) AS artist,
            t.album, h.ms_listened, h.skipped, h.source, h.mode, h.spotify_uri
     FROM history h LEFT JOIN tracks t ON t.id = h.track_id ORDER BY h.played_at`);
  if (format === 'json') {
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  } else {
    const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const header = 'played_at,title,artist,album,ms_listened,skipped,source,mode,spotify_uri';
    const body = rows.map((r) => [
      new Date(r.played_at).toISOString(), esc(r.title), esc(r.artist), esc(r.album),
      r.ms_listened, r.skipped, r.source, r.mode, esc(r.spotify_uri),
    ].join(',')).join('\n');
    fs.writeFileSync(outPath, header + '\n' + body + '\n');
  }
  return { path: outPath, rows: rows.length };
}

module.exports = { recordSession, timeline, totals, topTracks, topArtists, topAlbums, exportHistory, rangeToBounds, SKIP_THRESHOLD_MS };
