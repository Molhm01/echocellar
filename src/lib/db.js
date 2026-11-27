'use strict';
// sql.js backed database. Pure node (sql.js is WASM); no electron imports so
// unit tests can use it directly. The owning process calls load() once, then
// save() after mutations (debounced by callers that batch writes).

const path = require('path');
const fs = require('fs');

const SCHEMA = `
PRAGMA journal_mode=MEMORY;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0,
  title TEXT, artist TEXT, album TEXT, album_artist TEXT, genre TEXT,
  year INTEGER, track_no INTEGER, disc_no INTEGER,
  duration_ms INTEGER, codec TEXT, sample_rate INTEGER, bit_depth INTEGER, bitrate INTEGER,
  size INTEGER, mtime INTEGER, sha1 TEXT, isrc TEXT,
  art_path TEXT, lyrics_embedded INTEGER DEFAULT 0, lyrics_path TEXT,
  video_path TEXT, video_offset_ms INTEGER DEFAULT 0,
  missing INTEGER DEFAULT 0,
  added_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_sha1 ON tracks(sha1);

CREATE TABLE IF NOT EXISTS duplicates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL,
  group_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dup_group ON duplicates(group_key);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',       -- local | spotify
  content_hash TEXT,                          -- spotify snapshot identity
  created_at INTEGER, updated_at INTEGER,
  UNIQUE(name, source)
);
CREATE TABLE IF NOT EXISTS playlist_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'matched',     -- matched | review | missing
  req_artist TEXT, req_title TEXT, req_album TEXT, req_duration_ms INTEGER,
  spotify_uri TEXT,
  candidates TEXT,                            -- JSON array for review items
  UNIQUE(playlist_id, position)
);
CREATE INDEX IF NOT EXISTS idx_entries_track ON playlist_entries(track_id);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  spotify_uri TEXT,
  artist TEXT, title TEXT,
  played_at INTEGER NOT NULL,                 -- ms epoch when listening started
  ms_listened INTEGER NOT NULL DEFAULT 0,     -- actual listening time
  duration_ms INTEGER,
  skipped INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'local',       -- local | spotify
  session_id TEXT,
  mode TEXT NOT NULL DEFAULT 'audio',         -- audio | video (both share one session)
  dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_history_played_at ON history(played_at);
CREATE INDEX IF NOT EXISTS idx_history_track ON history(track_id);

CREATE TABLE IF NOT EXISTS favorites (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS catalog_artists (
  id TEXT PRIMARY KEY, name TEXT, sort_name TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS catalog_releases (
  id TEXT PRIMARY KEY, artist_id TEXT, title TEXT, year INTEGER, type TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS catalog_tracks (
  id TEXT PRIMARY KEY, release_id TEXT, title TEXT, duration_ms INTEGER, position INTEGER,
  media_url TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS catalog_edits (
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, patch TEXT NOT NULL,
  updated_at INTEGER, PRIMARY KEY(entity, entity_id)
);

CREATE TABLE IF NOT EXISTS watch_folders (path TEXT PRIMARY KEY, added_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

class DB {
  constructor() {
    this.db = null;
    this.filePath = null;
    this._dirty = false;
    this._saveTimer = null;
  }

  async load(filePath, initSqlJs) {
    const SQL = initSqlJs ? await initSqlJs : await require('sql.js')({
      locateFile: (f) => path.join(require.resolve('sql.js'), '..', f),
    });
    this.filePath = filePath;
    let data = null;
    if (fs.existsSync(filePath)) {
      data = fs.readFileSync(filePath);
    }
    this.db = data && data.length ? new SQL.Database(data) : new SQL.Database();
    this.db.exec(SCHEMA);
    this.save();
    return this;
  }

  exec(sql, params) {
    // parameterized write returning last insert rowid
    const stmt = this.db.prepare(sql);
    try {
      if (params) stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    this._dirty = true;
    const idRow = this.db.exec('SELECT last_insert_rowid() AS id');
    return idRow[0] && idRow[0].values[0] ? idRow[0].values[0][0] : null;
  }

  execRaw(sql) {
    this.db.exec(sql);
    this._dirty = true;
  }

  all(sql, params) {
    const stmt = this.db.prepare(sql);
    const rows = [];
    try {
      if (params) stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  get(sql, params) {
    const rows = this.all(sql, params);
    return rows[0] || null;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      this._dirty = true;
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  save() {
    if (!this.filePath) return;
    const data = this.db.export();
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.filePath);
    this._dirty = false;
  }

  saveSoon(delayMs = 800) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.save();
    }, delayMs);
  }

  close() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._dirty) this.save();
    if (this.db) this.db.close();
    this.db = null;
  }
}

module.exports = { DB, SCHEMA };
