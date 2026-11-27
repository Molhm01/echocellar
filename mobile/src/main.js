'use strict';
// Boot: load persisted state into the in-memory fs, open the sql.js database,
// install window.ec, then start the UI.

const memfs = require('fs'); // aliased to shims/fs.js by esbuild
const { bytesToBase64, base64ToBytes } = require('./b64');
const { DB } = require('../../src/lib/db');
const bridge = require('./bridge');
const ui = require('./ui');

const DB_VIRTUAL_PATH = '/state/echocellar.db';

async function boot() {
  const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');

  // Persist hook: every DB save (and any future state file) is flushed to
  // device storage as base64. Flushes are fire-and-forget but serialized.
  let flushChain = Promise.resolve();
  memfs.__setPersistHook((path, bytes) => {
    flushChain = flushChain.then(async () => {
      try {
        const rel = path.replace(/^\//, '');
        const base64 = bytesToBase64(bytes);
        const slash = rel.lastIndexOf('/');
        if (slash > 0) {
          await Filesystem.mkdir({ path: rel.slice(0, slash), directory: Directory.Data, recursive: true }).catch(() => {});
        }
        await Filesystem.writeFile({ path: rel, directory: Directory.Data, data: base64, encoding: Encoding.Base64 });
      } catch (e) { console.error('persist failed', e); }
    });
  });

  // Preload persisted DB bytes before DB.load runs (its fs reads are sync).
  try {
    const r = await Filesystem.readFile({ path: 'state/echocellar.db', directory: Directory.Data, encoding: Encoding.Base64 });
    const b64 = typeof r.data === 'string' ? r.data : await blobToBase64(r.data);
    memfs.__preload(DB_VIRTUAL_PATH, base64ToBytes(b64));
  } catch (e) { /* first launch: no db yet */ }

  const initSqlJs = require('sql.js');
  const wasmB64 = require('./generated/wasm-bytes');
  const SQL = await initSqlJs({ wasmBinary: base64ToBytes(wasmB64) });
  const db = await new DB().load(DB_VIRTUAL_PATH, SQL);

  bridge.install(db);
  ui.start();

  // Flush pending writes when the app goes away.
  document.addEventListener('visibilitychange', () => { if (document.hidden) db.save(); });
  window.addEventListener('pagehide', () => db.save());
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(buf);
}

boot().catch((e) => {
  document.body.innerHTML = '<div style="padding:24px;color:#f66">Echocellar failed to start: ' +
    String(e && e.message || e) + '</div>';
  console.error(e);
});
