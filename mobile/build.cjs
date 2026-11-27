// Build the browser bundle for the Capacitor webview.
// esbuild aliases swap node builtins for browser shims so the desktop app's
// pure lib modules (db/queue/recs/stats/util/match) run unchanged.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = __dirname;

async function main() {
  // static assets
  fs.copyFileSync(path.join(root, '..', 'assets', 'logo.svg'), path.join(root, 'www', 'assets', 'logo.svg'));
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
  const b64 = fs.readFileSync(wasm).toString('base64');
  fs.writeFileSync(path.join(root, 'src', 'generated', 'wasm-bytes.js'),
    'module.exports = ' + JSON.stringify(b64) + ';');

  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'main.js')],
    bundle: true,
    outfile: path.join(root, 'www', 'js', 'bundle.js'),
    platform: 'browser',
    format: 'iife',
    target: ['chrome110'],
    alias: {
      fs: path.join(root, 'shims', 'fs.js'),
      path: path.join(root, 'shims', 'path.js'),
      crypto: path.join(root, 'shims', 'crypto.js'),
      'sql.js': path.join(root, 'node_modules', 'sql.js'),
      'node:fs': path.join(root, 'shims', 'fs.js'),
      'node:path': path.join(root, 'shims', 'path.js'),
      'node:crypto': path.join(root, 'shims', 'crypto.js'),
    },
    inject: [path.join(root, 'shims', 'buffer-global.js')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'info',
  });
  console.log('mobile bundle built');
}

main().catch((e) => { console.error(e); process.exit(1); });
