// PWA smoke test: serve ../docs over HTTP (service workers need a real
// origin), load in Chromium (Electron), verify boot, import, blob-URL
// playback path (audio element actually loads the track), persistence across
// reload, and service worker registration.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const DOCS = path.join(__dirname, '..', 'docs');
const FIX = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(DOCS, p);
      if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const srv = await serve();
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/`;
  await app.whenReady();
  const win = new BrowserWindow({
    width: 420, height: 800, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2 && !/Deprecation|CSP|Security/.test(msg)) console.log('[page]', msg);
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 3500));

  const boot = await win.webContents.executeJavaScript(
    `({ hasEc: !!window.ec, platform: window.Capacitor ? window.Capacitor.getPlatform() : 'none',
        swControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) })`);
  console.log('BOOT', JSON.stringify(boot));
  if (!boot.hasEc) { console.log('PWA SMOKE FAIL (boot)'); app.exit(1); return; }

  const audioFiles = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(mp3|flac)$/i.test(f.name)) audioFiles.push(p);
    }
  })(FIX);
  const payload = audioFiles.slice(0, 2).map((p) => ({ name: path.basename(p), b64: fs.readFileSync(p).toString('base64') }));

  const imp = await win.webContents.executeJavaScript(`(async () => {
    const files = ${JSON.stringify(payload)}.map((p) => {
      const bin = atob(p.b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], p.name);
    });
    const res = await window.ec.importFiles(files);
    const t = window.ec.tracks()[0];
    let playback = null;
    if (t) {
      const src = await window.ec.playSrc(t.id);
      if (src.url) {
        const a = document.getElementById('ec-audio');
        a.src = src.url;
        playback = await new Promise((resolve) => {
          const to = setTimeout(() => resolve({ error: 'timeout waiting for audio metadata' }), 8000);
          a.onloadedmetadata = () => { clearTimeout(to); resolve({ urlKind: src.url.slice(0, 5), duration: a.duration }); };
          a.onerror = () => { clearTimeout(to); resolve({ error: 'audio element error', code: a.error && a.error.code }); };
        });
      } else playback = { error: src.error };
    }
    const art = t && t.art_path ? await window.ec.artSrc(t.id) : null;
    return { imported: res.imported, errors: res.errors, playback, artKind: art ? art.slice(0, 5) : null };
  })()`);
  console.log('IMPORT_PLAY', JSON.stringify(imp));

  // Persistence across reload (IndexedDB-backed Filesystem + DB).
  await new Promise((r) => setTimeout(r, 1500));
  await win.reload();
  await new Promise((r) => setTimeout(r, 3000));
  const persist = await win.webContents.executeJavaScript(
    `({ tracks: window.ec ? window.ec.counts().tracks : -1 })`);
  console.log('PERSIST', JSON.stringify(persist));

  const sw = await win.webContents.executeJavaScript(
    `navigator.serviceWorker.getRegistration().then((r) => ({ registered: !!r, controlled: !!(navigator.serviceWorker.controller) }))`);
  console.log('SW', JSON.stringify(sw));

  const okPlayback = imp.playback && !imp.playback.error && imp.playback.duration > 0;
  const pass = boot.hasEc && imp.imported === 2 && okPlayback && persist.tracks === 2 && sw.registered;
  console.log(pass ? 'PWA SMOKE PASS' : 'PWA SMOKE FAIL');
  srv.close();
  app.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); app.exit(1); });
