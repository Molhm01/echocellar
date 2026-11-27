'use strict';
// Minimal posix path shim for the browser bundle (only what src/lib uses).
function join(...parts) {
  const joined = parts.filter(Boolean).join('/');
  return joined.replace(/\/{2,}/g, '/');
}
function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function basename(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}
module.exports = { join, dirname, basename, extname, sep: '/' };
