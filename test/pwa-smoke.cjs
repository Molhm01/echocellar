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

  // Spotify export import first, on an empty library: every entry becomes a
  // placeholder; the audio import below must auto-link them (relink path).
  const spotFiles = fs.readdirSync(path.join(FIX, 'spotify'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, b64: fs.readFileSync(path.join(FIX, 'spotify', f)).toString('base64') }));
  const spot = await win.webContents.executeJavaScript(`(async () => {
    const files = ${JSON.stringify(spotFiles)}.map((p) =>
      new File([atob(p.b64)], p.name, { type: 'application/json' }));
    const r = await window.ec.importSpotify(files);
    const pls = window.ec.playlists();
    const entries = pls.length ? window.ec.playlistEntries(pls[0].id) : [];
    return { result: r, playlists: pls, firstEntries: entries.map((e) => ({ status: e.status, title: e.title || e.req_title })) };
  })()`);
  console.log('SPOTIFY', JSON.stringify(spot));
  const spotOk = spot.playlists.length >= 1
    && spot.result.history.imported === 3
    && spot.firstEntries.length === 3
    && spot.firstEntries.every((e) => e.status === 'missing');

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

  // After audio import, the Spotify placeholders must have linked up.
  const relink = await win.webContents.executeJavaScript(`(() => {
    const pls = window.ec.playlists();
    const entries = pls.length ? window.ec.playlistEntries(pls[0].id) : [];
    return { playlists: pls, entries: entries.map((e) => ({ status: e.status, title: e.title || e.req_title })) };
  })()`);
  console.log('RELINK', JSON.stringify(relink));
  const relinkOk = relink.entries.length === 3 && relink.entries.every((e) => e.status === 'matched');

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
  const pass = boot.hasEc && imp.imported === 2 && okPlayback && persist.tracks === 2 && sw.registered && spotOk && relinkOk;
  console.log(pass ? 'PWA SMOKE PASS' : 'PWA SMOKE FAIL');
  srv.close();
  app.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); app.exit(1); });
