'use strict';
// Spotify account-export parsing and import. Pure logic + db access; the caller
// supplies already-read file contents so this stays testable without electron.

const { normalize, sha1String } = require('./util');
const { decide } = require('./match');

// ---- Parsing ---------------------------------------------------------------

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Classify a Spotify export file by name and content shape.
// Returns { kind: 'playlists'|'library'|'history'|'unknown', data } or null.
function parseSpotifyFile(name, text) {
  const data = safeParse(text);
  if (data == null) return null;
  const base = (name || '').toLowerCase();

  // Playlist exports. Older exports: array of playlists with items[].track.
  // Some exports wrap in { playlists: [...] }.
  const playlistsArr = Array.isArray(data) ? data
    : Array.isArray(data.playlists) ? data.playlists
    : null;
  if (playlistsArr && playlistsArr.length && playlistsArr[0] &&
      (playlistsArr[0].items || playlistsArr[0].tracks) &&
      (base.includes('playlist') || playlistsArr[0].name != null)) {
    const playlists = playlistsArr.map((p) => {
      const items = (p.items || p.tracks || []).map((it) => {
        const t = it.track || it;
        return {
          uri: t.trackUri || t.track_uri || t.uri || null,
          title: t.trackName || t.track_name || t.name || null,
          artist: t.artistName || t.artist_name || (t.artists && t.artists[0] && t.artists[0].name) || null,
          album: t.albumName || t.album_name || (t.album && t.album.name) || null,
          duration_ms: t.durationMs || t.duration_ms || null,
        };
      }).filter((x) => x.title && x.artist);
      return {
        name: p.name || 'Spotify playlist',
        description: p.description || '',
        lastModified: p.lastModifiedDate || p.last_modified_date || null,
        items,
      };
    }).filter((p) => p.items.length);
    if (playlists.length) return { kind: 'playlists', data: playlists };
  }

  // Saved library: YourLibrary.json -> { tracks: [{artist, album, track, uri}] }
  if (data && Array.isArray(data.tracks) && (data.tracks.length === 0 || data.tracks[0].track)) {
    const tracks = data.tracks.map((t) => ({
      uri: t.uri || null,
      title: t.track || null,
      artist: t.artist || null,
      album: t.album || null,
    })).filter((x) => x.title && x.artist);
    return { kind: 'library', data: tracks };
  }

  // Extended streaming history: array with master_metadata_* fields.
  if (Array.isArray(data) && data.length && (data[0].master_metadata_track_name !== undefined || data[0].spotify_track_uri !== undefined)) {
    const entries = data.map((e) => ({
      ts: e.ts ? Date.parse(e.ts) : null,
      title: e.master_metadata_track_name || null,
      artist: e.master_metadata_album_artist_name || null,
      album: e.master_metadata_album_album_name || null,
      uri: e.spotify_track_uri || null,
      ms_played: e.ms_played || 0,
    })).filter((x) => x.ts && x.title && x.artist);
    return { kind: 'history', data: entries };
  }

  // Simple streaming history: [{endTime, artistName, trackName, msPlayed}]
  if (Array.isArray(data) && data.length && data[0].endTime && data[0].trackName) {
    const entries = data.map((e) => ({
      ts: Date.parse(String(e.endTime).replace(' ', 'T') + (String(e.endTime).includes('Z') ? '' : 'Z')),
      title: e.trackName,
      artist: e.artistName,
      album: null,
      uri: null,
      ms_played: e.msPlayed || 0,
    })).filter((x) => x.ts && x.title && x.artist);
    return { kind: 'history', data: entries };
  }

  return { kind: 'unknown', data: null };
}

// ---- Import ----------------------------------------------------------------

function playlistContentHash(playlist) {
  const canonical = playlist.name + '\n' + playlist.items
    .map((i) => i.uri || `${normalize(i.artist)}|${normalize(i.title)}|${normalize(i.album)}`)
    .join('\n');
  return sha1String(canonical);
}

function libraryCandidates(db) {
  return db.all(
    'SELECT id, title, artist, album, duration_ms, isrc FROM tracks WHERE missing = 0'
  );
}

// Match one requested entry against the local library.
function matchEntry(db, candidates, req) {
  return decide(
    { title: req.title, artist: req.artist, album: req.album, duration_ms: req.duration_ms, isrc: req.isrc },
    candidates
  );
}

function insertEntry(db, playlistId, position, item, outcome) {
  db.exec(
    `INSERT INTO playlist_entries
       (playlist_id, position, track_id, status, req_artist, req_title, req_album, req_duration_ms, spotify_uri, candidates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      playlistId, position,
      outcome.status === 'matched' ? outcome.trackId : null,
      outcome.status,
      item.artist, item.title, item.album, item.duration_ms || null, item.uri || null,
      outcome.candidates ? JSON.stringify(outcome.candidates) : null,
    ]
  );
}

function importPlaylists(db, playlists, now) {
  const summary = [];
  for (const pl of playlists) {
    const hash = playlistContentHash(pl);
    const existing = db.get('SELECT id, content_hash FROM playlists WHERE name = ? AND source = ?', [pl.name, 'spotify']);
    if (existing && existing.content_hash === hash) {
      // Same export reimported: leave playlist and entries untouched.
      summary.push({ name: pl.name, matched: null, review: null, missing: null, skipped: 'identical' });
      continue;
    }
    const candidates = libraryCandidates(db);
    let counts = { matched: 0, review: 0, missing: 0 };
    db.transaction(() => {
      let playlistId;
      if (existing) {
        playlistId = existing.id;
        db.exec('DELETE FROM playlist_entries WHERE playlist_id = ?', [playlistId]);
        db.exec('UPDATE playlists SET content_hash = ?, updated_at = ? WHERE id = ?', [hash, now, playlistId]);
      } else {
        playlistId = db.exec(
          'INSERT INTO playlists (name, source, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [pl.name, 'spotify', hash, now, now]
        );
      }
      pl.items.forEach((item, idx) => {
        const outcome = matchEntry(db, candidates, item);
        counts[outcome.status] += 1;
        insertEntry(db, playlistId, idx, item, outcome);
      });
    });
    summary.push({ name: pl.name, ...counts, skipped: null });
  }
  return summary;
}

function importSavedTracks(db, tracks, now) {
  const hash = sha1String('your-library\n' + tracks.map((t) => t.uri || `${normalize(t.artist)}|${normalize(t.title)}`).join('\n'));
  const existing = db.get('SELECT id, content_hash FROM playlists WHERE name = ? AND source = ?', ['Liked Songs (Spotify)', 'spotify']);
  if (existing && existing.content_hash === hash) {
    return { matched: null, review: null, missing: null, skipped: 'identical' };
  }
  const candidates = libraryCandidates(db);
  const counts = { matched: 0, review: 0, missing: 0 };
  db.transaction(() => {
    let playlistId;
    if (existing) {
      playlistId = existing.id;
      db.exec('DELETE FROM playlist_entries WHERE playlist_id = ?', [playlistId]);
      db.exec('UPDATE playlists SET content_hash = ?, updated_at = ? WHERE id = ?', [hash, now, playlistId]);
    } else {
      playlistId = db.exec(
        'INSERT INTO playlists (name, source, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['Liked Songs (Spotify)', 'spotify', hash, now, now]
      );
    }
    tracks.forEach((item, idx) => {
      const outcome = matchEntry(db, candidates, item);
      counts[outcome.status] += 1;
      insertEntry(db, playlistId, idx, item, outcome);
    });
  });
  return { ...counts, skipped: null };
}

function importHistory(db, entries) {
  let imported = 0, duplicates = 0;
  db.transaction(() => {
    for (const e of entries) {
      const key = `sp:${e.uri || normalize(e.artist) + '|' + normalize(e.title)}:${e.ts}`;
      const dup = db.get('SELECT id FROM history WHERE dedupe_key = ?', [key]);
      if (dup) { duplicates += 1; continue; }
      // Link to a local track when we can, but always record the event.
      const candidates = libraryCandidates(db);
      const outcome = matchEntry(db, candidates, {
        title: e.title, artist: e.artist, album: e.album, duration_ms: null,
      });
      const trackId = outcome.status === 'matched' ? outcome.trackId : null;
      db.exec(
        `INSERT INTO history (track_id, spotify_uri, artist, title, played_at, ms_listened, duration_ms, skipped, source, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'spotify', ?)`,
        [trackId, e.uri, e.artist, e.title, e.ts, e.ms_played, null, 0, key]
      );
      imported += 1;
    }
  });
  return { imported, duplicates };
}

// After new audio lands in the library, link previously unmatched entries.
function relinkUnmatchedEntries(db) {
  const rows = db.all(
    `SELECT id, req_artist, req_title, req_album, req_duration_ms FROM playlist_entries
     WHERE status IN ('missing') AND track_id IS NULL`
  );
  if (!rows.length) return { linked: 0 };
  const candidates = libraryCandidates(db);
  let linked = 0;
  db.transaction(() => {
    for (const row of rows) {
      const outcome = decide(
        { title: row.req_title, artist: row.req_artist, album: row.req_album, duration_ms: row.req_duration_ms },
        candidates
      );
      if (outcome.status === 'matched') {
        db.exec('UPDATE playlist_entries SET track_id = ?, status = ? WHERE id = ?', [outcome.trackId, 'matched', row.id]);
        linked += 1;
      } else if (outcome.status === 'review') {
        db.exec('UPDATE playlist_entries SET status = ?, candidates = ? WHERE id = ?',
          ['review', JSON.stringify(outcome.candidates), row.id]);
      }
    }
  });
  return { linked };
}

// Import a set of export files: [{name, text}]. Order-independent.
function importSpotifyExport(db, files, now) {
  now = now || Date.now();
  const result = { playlists: [], library: null, history: { imported: 0, duplicates: 0 }, files: [] };
  for (const f of files) {
    const parsed = parseSpotifyFile(f.name, f.text);
    result.files.push({ name: f.name, kind: parsed ? parsed.kind : 'unknown' });
    if (!parsed || parsed.kind === 'unknown') continue;
    if (parsed.kind === 'playlists') {
      result.playlists.push(...importPlaylists(db, parsed.data, now));
    } else if (parsed.kind === 'library') {
      result.library = importSavedTracks(db, parsed.data, now);
    } else if (parsed.kind === 'history') {
      const h = importHistory(db, parsed.data);
      result.history.imported += h.imported;
      result.history.duplicates += h.duplicates;
    }
  }
  return result;
}

module.exports = {
  parseSpotifyFile,
  importSpotifyExport,
  importPlaylists,
  importHistory,
  relinkUnmatchedEntries,
  playlistContentHash,
};
