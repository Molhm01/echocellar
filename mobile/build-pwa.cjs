// Publish the web app as a static PWA into ../docs (GitHub Pages source).
const fs = require('fs');
const path = require('path');
const root = __dirname;
const out = path.join(root, '..', 'docs');

function cp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function cpdir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpdir(s, d); else cp(s, d);
  }
}
fs.rmSync(out, { recursive: true, force: true });
cpdir(path.join(root, 'www'), out);
cp(path.join(root, 'pwa-assets', 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
cp(path.join(root, 'pwa-assets', 'sw.js'), path.join(out, 'sw.js'));
cpdir(path.join(root, 'pwa-assets', 'icons'), path.join(out, 'icons'));
console.log('PWA published to docs/');
