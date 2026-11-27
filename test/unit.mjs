// Unit tests for pure logic: matching, spotify import, queue, recommendations.
// Run: node test/unit.mjs
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const { DB } = require('../src/lib/db.js');
const { normalize, versionTokensOf, shuffled } = require('../src/lib/util.js');
const { decide } = require('../src/lib/match.js');
const spotify = require('../src/lib/spotify.js');
const { QueueState } = require('../src/lib/queue.js');
const recs = require('../src/lib/recs.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}\n  ${e.stack}`); }
}

const db = await new DB().load(null);
// ^ load(null) writes nowhere on save(); use in-memory only.
db.save = () => {}; // never touch disk in unit tests

function addTrack(o) {
  return db.exec(
    `INSERT INTO tracks (path, title, artist, album, duration_ms, codec, isrc, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.path || `/music/${o.artist}-${o.title}.flac`, o.title, o.artist, o.album || null,
     o.duration_ms || 200000, o.codec || 'flac', o.isrc || null, Date.now()]
  );
}

// ---- util ----
t('normalize strips features and punctuation', () => {
  assert.equal(normalize('Glass Roads (feat. Someone)'), 'glass roads');
  assert.equal(normalize("Don't Stop!"), 'dont stop');
  assert.equal(normalize('Beyoncé'), 'beyonce');
});
t('version tokens detected', () => {
  assert.deepEqual(versionTokensOf('Harbor Lights (Live)'), ['live']);
  assert.deepEqual(versionTokensOf('Blue Static (Remastered 2020)'), ['remaster']);
  assert.deepEqual(versionTokensOf('Plain Song'), []);
});
t('shuffled is a permutation', () => {
  const out = shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(out.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

// ---- matching ----
t('match: exact artist+title+duration auto-matches', () => {
  const id = addTrack({ artist: 'Aurora Fields', title: 'Emberline', album: 'Night Lines', duration_ms: 201000 });
  const r = decide({ artist: 'Aurora Fields', title: 'Emberline', album: 'Night Lines', duration_ms: 200000 },
    db.all('SELECT id, title, artist, album, duration_ms, isrc FROM tracks'));
  assert.equal(r.status, 'matched');
  assert.equal(r.trackId, id);
});
t('match: unknown song is missing', () => {
  const r = decide({ artist: 'Nobody', title: 'Nothing Song', duration_ms: 100000 },
    db.all('SELECT id, title, artist, album, duration_ms, isrc FROM tracks'));
  assert.equal(r.status, 'missing');
});
t('match: live version of a studio track goes to review, not auto-match', () => {
  addTrack({ artist: 'Aurora Fields', title: 'Harbor Lights', duration_ms: 210000 });
  const r = decide({ artist: 'Aurora Fields', title: 'Harbor Lights (Live)', duration_ms: 210000 },
    db.all('SELECT id, title, artist, album, duration_ms, isrc FROM tracks'));
  assert.equal(r.status, 'review');
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.candidates[0].version_conflict);
});
t('match: two close candidates go to review', () => {
  addTrack({ artist: 'Copper Veins', title: 'Iron Rain', duration_ms: 180000 });
  addTrack({ artist: 'Copper Veins', title: 'Iron Rain', duration_ms: 182000, path: '/music/ironrain2.flac' });
  const r = decide({ artist: 'Copper Veins', title: 'Iron Rain', duration_ms: 181000 },
    db.all('SELECT id, title, artist, album, duration_ms, isrc FROM tracks'));
  assert.equal(r.status, 'review');
  assert.equal(r.candidates.length, 2);
});

// ---- spotify parsing ----
const PLAYLIST_JSON = JSON.stringify([
  { name: 'Late Drive', items: [
    { track: { trackName: 'Emberline', artistName: 'Aurora Fields', albumName: 'Night Lines', trackUri: 'spotify:track:AAA', durationMs: 200000 } },
    { track: { trackName: 'Midnight Sun', artistName: 'Polar Coast', albumName: 'Cold Front', trackUri: 'spotify:track:BBB', durationMs: 190000 } },
    { track: { trackName: 'Emberline', artistName: 'Aurora Fields', albumName: 'Night Lines', trackUri: 'spotify:track:AAA', durationMs: 200000 } },
  ] },
]);
const HISTORY_JSON = JSON.stringify([
  { ts: '2026-10-01T20:00:00Z', master_metadata_track_name: 'Emberline', master_metadata_album_artist_name: 'Aurora Fields', master_metadata_album_album_name: 'Night Lines', spotify_track_uri: 'spotify:track:AAA', ms_played: 120000 },
  { ts: '2026-10-02T21:00:00Z', master_metadata_track_name: 'Midnight Sun', master_metadata_album_artist_name: 'Polar Coast', master_metadata_album_album_name: 'Cold Front', spotify_track_uri: 'spotify:track:BBB', ms_played: 60000 },
]);

t('spotify: playlist file detected', () => {
  const p = spotify.parseSpotifyFile('Playlist1.json', PLAYLIST_JSON);
  assert.equal(p.kind, 'playlists');
  assert.equal(p.data[0].items.length, 3);
});
t('spotify: extended history detected', () => {
  const p = spotify.parseSpotifyFile('StreamingHistory_music_0.json', HISTORY_JSON);
  assert.equal(p.kind, 'history');
  assert.equal(p.data.length, 2);
});

t('spotify: import matches known track, keeps missing, preserves repeats and order', () => {
  const res = spotify.importSpotifyExport(db, [
    { name: 'Playlist1.json', text: PLAYLIST_JSON },
    { name: 'StreamingHistory_music_0.json', text: HISTORY_JSON },
  ]);
  assert.equal(res.playlists[0].matched, 2);
  assert.equal(res.playlists[0].missing, 1);
  const rows = db.all(
    `SELECT pe.position, pe.status, t.title FROM playlist_entries pe
     JOIN playlists p ON p.id = pe.playlist_id LEFT JOIN tracks t ON t.id = pe.track_id
     WHERE p.name = 'Late Drive' ORDER BY pe.position`);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Emberline');
  assert.equal(rows[1].status, 'missing');
  assert.equal(rows[2].title, 'Emberline'); // intentional repeat preserved
});

t('spotify: reimport is idempotent for playlists and history', () => {
  const histBefore = db.get('SELECT COUNT(*) c FROM history').c;
  const entriesBefore = db.get('SELECT COUNT(*) c FROM playlist_entries').c;
  const res = spotify.importSpotifyExport(db, [
    { name: 'Playlist1.json', text: PLAYLIST_JSON },
    { name: 'StreamingHistory_music_0.json', text: HISTORY_JSON },
  ]);
  assert.equal(res.playlists[0].skipped, 'identical');
  assert.equal(res.history.imported, 0);
  assert.equal(res.history.duplicates, 2);
  assert.equal(db.get('SELECT COUNT(*) c FROM history').c, histBefore);
  assert.equal(db.get('SELECT COUNT(*) c FROM playlist_entries').c, entriesBefore);
});

t('spotify: missing entry auto-links when matching audio arrives', () => {
  addTrack({ artist: 'Polar Coast', title: 'Midnight Sun', album: 'Cold Front', duration_ms: 190000 });
  const r = spotify.relinkUnmatchedEntries(db);
  assert.equal(r.linked, 1);
  const row = db.get(
    `SELECT pe.status, t.title FROM playlist_entries pe
     JOIN playlists p ON p.id = pe.playlist_id LEFT JOIN tracks t ON t.id = pe.track_id
     WHERE p.name = 'Late Drive' AND pe.position = 1`);
  assert.equal(row.status, 'matched');
  assert.equal(row.title, 'Midnight Sun');
});

// ---- queue ----
t('queue: shuffle plays every entry once before reshuffle', () => {
  const q = new QueueState();
  q.setQueue([10, 11, 12, 13, 14], 0);
  q.setShuffle(true);
  const heard = new Set([q.currentId()]);
  let next;
  while ((next = q.next()) != null) heard.add(next);
  assert.deepEqual([...heard].sort((a, b) => a - b), [10, 11, 12, 13, 14]);
});
t('queue: previous retraces heard order', () => {
  const q = new QueueState();
  q.setQueue([1, 2, 3, 4], 0);
  const a = q.next(); // 2
  const b = q.next(); // 3
  assert.equal(a, 2); assert.equal(b, 3);
  assert.equal(q.previous(), 2);
  assert.equal(q.previous(), 1);
});
t('queue: shuffle state survives serialize/restore', () => {
  const q = new QueueState();
  q.setQueue([5, 6, 7, 8, 9], 2);
  q.setShuffle(true);
  q.next();
  const snap = JSON.parse(JSON.stringify(q.serialize()));
  const r = QueueState.restore(snap);
  assert.deepEqual(r.shuffleOrder, q.shuffleOrder);
  assert.equal(r.shuffleCursor, q.shuffleCursor);
  assert.deepEqual([...r.playedThisCycle], [...q.playedThisCycle]);
});
t('queue: repeat one holds current track', () => {
  const q = new QueueState();
  q.setQueue([1, 2], 0);
  q.repeat = 'one';
  assert.equal(q.next(), 1);
});

// ---- recs ----
t('recs: cold start until enough plays, then mixes', () => {
  const tid = addTrack({ artist: 'Aurora Fields', title: 'Glass Roads', duration_ms: 220000 });
  // Only 2 imported plays so far -> cold start with artist picking.
  assert.equal(recs.homeMixes(db).cold_start, true);
  // Seed a real listening history.
  for (let i = 0; i < 12; i++) {
    db.exec(`INSERT INTO history (track_id, artist, title, played_at, ms_listened, skipped, source, dedupe_key)
             VALUES (?, ?, ?, ?, ?, 0, 'local', ?)`,
      [tid, 'Aurora Fields', 'Glass Roads', Date.now() - i * 3600000, 200000, 'seed-' + i]);
  }
  const mix = recs.homeMixes(db);
  assert.equal(mix.cold_start, false);
  assert.ok(mix.mixes.length >= 1);
  const radio = recs.trackRadio(db, tid, 10);
  assert.ok(Array.isArray(radio));
  const weekly = recs.weeklyMix(db, 10);
  assert.ok(weekly.length > 0);
  // discovery list is empty now (the one missing entry got linked above)
  const disc = recs.discoveryList(db);
  assert.equal(disc.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
