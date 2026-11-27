'use strict';
// Synchronous in-memory fs shim backed by Capacitor Filesystem persistence.
// Boot preloads persisted files into memory; writes update memory and flush
// to device storage asynchronously. Only the calls src/lib/db.js makes exist.
const mem = new Map(); // normalized path -> Uint8Array
let onPersist = null;  // (path, bytes) => void, async flush hook

function norm(p) { return p.replace(/\/{2,}/g, '/'); }

function existsSync(p) { return mem.has(norm(p)); }
function readFileSync(p) {
  const v = mem.get(norm(p));
  if (!v) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
  return v;
}
function mkdirSync() { /* memory fs has implicit dirs */ }
function writeFileSync(p, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const k = norm(p);
  mem.set(k, bytes);
  if (onPersist && !k.endsWith('.tmp')) onPersist(k, bytes);
}
function renameSync(from, to) {
  const f = norm(from), t = norm(to);
  if (mem.has(f)) {
    const v = mem.get(f);
    mem.delete(f);
    mem.set(t, v);
    if (onPersist) onPersist(t, v);
  }
}
function unlinkSync(p) { mem.delete(norm(p)); }

// Boot/flush plumbing (not part of node fs; used by src/main.js).
function __preload(p, bytes) { mem.set(norm(p), bytes); }
function __setPersistHook(fn) { onPersist = fn; }
function __has(p) { return mem.has(norm(p)); }

module.exports = { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, __preload, __setPersistHook, __has };
