'use strict';
// Offline recommendation engine. Runs entirely over the local database:
// listening history, favorites, skips, playlist co-occurrence and tag/genre
// relationships. No network, no external service.

const { normalize } = require('./util');

function artistAffinity(db) {
  const rows = db.all(`
    SELECT artist,
           SUM(ms_listened) AS ms,
           COUNT(*) AS plays,
           SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) AS skips
    FROM history WHERE artist IS NOT NULL GROUP BY artist
  `);
  const map = new Map();
  for (const r of rows) {
    map.set(normalize(r.artist), {
      artist: r.artist,
      ms: r.ms || 0,
      plays: r.plays || 0,
      skips: r.skips || 0,
      score: (r.ms || 0) / 60000 + (r.plays || 0) * 2 - (r.skips || 0) * 3,
    });
  }
  return map;
}

function artistCooccurrence(db) {
  const rows = db.all(`
    SELECT pe.playlist_id, t.artist FROM playlist_entries pe
    JOIN tracks t ON t.id = pe.track_id
    WHERE t.artist IS NOT NULL
  `);
  const byPlaylist = new Map();
  for (const r of rows) {
    if (!byPlaylist.has(r.playlist_id)) byPlaylist.set(r.playlist_id, new Set());
    byPlaylist.get(r.playlist_id).add(normalize(r.artist));
  }
  const pairs = new Map();
  const display = new Map();
  for (const r of rows) display.set(normalize(r.artist), r.artist);
  for (const artists of byPlaylist.values()) {
    const list = [...artists];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = [list[i], list[j]].sort().join('::');
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  return { pairs, display };
}

function genreMap(db) {
  const rows = db.all('SELECT DISTINCT artist, genre FROM tracks WHERE genre IS NOT NULL AND genre != \'\'');
  const map = new Map();
  for (const r of rows) {
    if (!map.has(normalize(r.artist))) map.set(normalize(r.artist), new Set());
    map.get(normalize(r.artist)).add(normalize(r.genre));
  }
  return map;
}

function similarArtists(db, artist, limit = 10) {
  const target = normalize(artist);
  const { pairs, display } = artistCooccurrence(db);
  const genres = genreMap(db);
  const scores = new Map();
  for (const [key, count] of pairs) {
    const [a, b] = key.split('::');
    if (a === target) scores.set(b, (scores.get(b) || 0) + count * 2);
    else if (b === target) scores.set(a, (scores.get(a) || 0) + count * 2);
  }
  const targetGenres = genres.get(target) || new Set();
  for (const [other, gs] of genres) {
    if (other === target) continue;
    const shared = [...gs].filter((g) => targetGenres.has(g)).length;
    if (shared) scores.set(other, (scores.get(other) || 0) + shared);
  }
  return [...scores.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([normArtist, score]) => ({
      artist: display.get(normArtist) || normArtist,
      score,
      reason: pairs.has([target, normArtist].sort().join('::'))
        ? 'You keep these artists in the same playlists.'
        : 'They share genres with artists in your library.',
    }));
}

function pickFromPool(pool, limit, familiarity, rng) {
  // familiarity 0..1: 1 = most-played first, 0 = least-explored first.
  const rand = rng || Math.random;
  const sorted = pool.slice().sort((a, b) => b.affinity - a.affinity);
  const out = [];
  const used = new Set();
  while (out.length < limit && used.size < sorted.length) {
    const spread = sorted.length;
    const center = Math.round((1 - familiarity) * (spread - 1));
    let idx = Math.min(spread - 1, Math.max(0, center + Math.floor((rand() - 0.5) * spread * 0.6)));
    if (used.has(idx)) { idx = (idx + 1) % spread; }
    if (used.has(idx)) break;
    used.add(idx);
    out.push(sorted[idx]);
  }
  return out;
}

function buildTrackPool(db, opts) {
  const { seedArtist, seedGenre, excludeTrackIds } = opts || {};
  const affinity = artistAffinity(db);
  let sql = 'SELECT id, title, artist, album, duration_ms FROM tracks WHERE missing = 0';
  const params = [];
  if (seedArtist) { sql += ' AND artist = ?'; params.push(seedArtist); }
  const rows = db.all(sql, params);
  const exclude = new Set(excludeTrackIds || []);
  return rows
    .filter((r) => !exclude.has(r.id))
    .map((r) => ({
      track: r,
      affinity: (affinity.get(normalize(r.artist)) || { score: 0 }).score,
    }));
}

function trackRadio(db, trackId, limit = 25, familiarity = 0.7) {
  const seed = db.get('SELECT id, title, artist, genre FROM tracks WHERE id = ?', [trackId]);
  if (!seed) return [];
  const similars = similarArtists(db, seed.artist, 8);
  const similarNames = new Set(similars.map((s) => normalize(s.artist)));
  const pool = buildTrackPool(db, { excludeTrackIds: [trackId] });
  const ranked = pool.map((p) => {
    let boost = 0, reason = null;
    if (normalize(p.track.artist) === normalize(seed.artist)) {
      boost = 5; reason = `More from ${seed.artist}.`;
    } else if (similarNames.has(normalize(p.track.artist))) {
      boost = 3; reason = `You often play ${p.track.artist} alongside ${seed.artist}.`;
    } else if (seed.genre && p.track.genre &&
               normalize(p.track.genre) === normalize(seed.genre)) {
      boost = 1; reason = `Same ${seed.genre} sound as ${seed.title}.`;
    }
    return { ...p, score: p.affinity + boost, reason };
  }).filter((p) => p.reason);
  ranked.sort((a, b) => b.score - a.score);
  return pickFromPool(ranked, limit, familiarity)
    .map((p) => ({ ...p.track, reason: p.reason }));
}

function artistRadio(db, artist, limit = 25, familiarity = 0.7) {
  const similars = similarArtists(db, artist, 10);
  const names = new Set([normalize(artist), ...similars.map((s) => normalize(s.artist))]);
  const pool = buildTrackPool(db, {});
  const ranked = pool
    .filter((p) => names.has(normalize(p.track.artist)))
    .map((p) => ({
      ...p,
      reason: normalize(p.track.artist) === normalize(artist)
        ? `From ${artist}.`
        : `You often play ${p.track.artist} in the same playlists as ${artist}.`,
    }));
  return pickFromPool(ranked, limit, familiarity).map((p) => ({ ...p.track, reason: p.reason }));
}

function weeklyMix(db, limit = 30, familiarity = 0.7, now) {
  now = now || Date.now();
  const weekKey = `${new Date(now).getUTCFullYear()}-w${Math.ceil(((now - new Date(Date.UTC(new Date(now).getUTCFullYear(), 0, 1)).getTime()) / 86400000 + 1) / 7)}`;
  const cached = db.get('SELECT value FROM settings WHERE key = ?', ['weekly_mix']);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.value);
      if (parsed.weekKey === weekKey) return parsed.tracks;
    } catch { /* regenerate */ }
  }
  const eightWeeks = now - 8 * 7 * 86400000;
  const recent = db.all(
    `SELECT artist, SUM(ms_listened) AS ms FROM history
     WHERE played_at >= ? AND skipped = 0 AND artist IS NOT NULL
     GROUP BY artist ORDER BY ms DESC LIMIT 8`, [eightWeeks]);
  const artistSet = new Set(recent.map((r) => normalize(r.artist)));
  for (const r of recent) {
    for (const s of similarArtists(db, r.artist, 3)) artistSet.add(normalize(s.artist));
  }
  const pool = buildTrackPool(db, {}).filter((p) => artistSet.has(normalize(p.track.artist)));
  const tracks = pickFromPool(pool, limit, familiarity).map((p) => ({
    ...p.track,
    reason: recent.some((r) => normalize(r.artist) === normalize(p.track.artist))
      ? `You have had ${p.track.artist} on heavy rotation lately.`
      : `Goes with the artists you have been playing this month.`,
  }));
  db.exec('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['weekly_mix', JSON.stringify({ weekKey, tracks })]);
  return tracks;
}

// Music you have references to but no playable files for (from Spotify import).
function discoveryList(db, limit = 100) {
  return db.all(
    `SELECT req_artist AS artist, req_title AS title, req_album AS album,
            COUNT(*) AS appearances, GROUP_CONCAT(DISTINCT p.name) AS in_playlists
     FROM playlist_entries pe JOIN playlists p ON p.id = pe.playlist_id
     WHERE pe.status != 'matched'
     GROUP BY req_artist, req_title, req_album
     ORDER BY appearances DESC LIMIT ?`, [limit]);
}

function coldStartArtists(db, limit = 24) {
  return db.all(
    `SELECT artist, COUNT(*) AS tracks FROM tracks
     WHERE artist IS NOT NULL GROUP BY artist ORDER BY tracks DESC LIMIT ?`, [limit]);
}

function homeMixes(db, familiarity = 0.7) {
  const plays = db.get('SELECT COUNT(*) AS c FROM history WHERE skipped = 0').c;
  if (plays < 10) {
    return { cold_start: true, artists: coldStartArtists(db) };
  }
  const topArtistRow = db.get(
    `SELECT artist, SUM(ms_listened) AS ms FROM history
     WHERE skipped = 0 AND artist IS NOT NULL GROUP BY artist ORDER BY ms DESC LIMIT 1`);
  const out = { cold_start: false, mixes: [] };
  if (topArtistRow) {
    out.mixes.push({
      kind: 'artist_radio', title: `${topArtistRow.artist} Radio`,
      tracks: artistRadio(db, topArtistRow.artist, 25, familiarity),
    });
  }
  out.mixes.push({ kind: 'weekly', title: 'Your Weekly Cellar Mix', tracks: weeklyMix(db, 30, familiarity) });
  return out;
}

module.exports = {
  artistAffinity,
  artistCooccurrence,
  similarArtists,
  trackRadio,
  artistRadio,
  weeklyMix,
  discoveryList,
  coldStartArtists,
  homeMixes,
};
