'use strict';
// crypto shim: only createHash('sha1') as used by src/lib/util.js.
const jsSha1 = require('js-sha1');
function createHash(algo) {
  if (algo !== 'sha1') throw new Error('unsupported hash: ' + algo);
  const h = jsSha1.create();
  return {
    update(d) { h.update(d); return this; },
    digest(enc) { return enc === 'hex' ? h.hex() : h.arrayBuffer(); },
  };
}
function randomUUID() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxx-4xxx-yxxx'.replace(/[xy]/g, (c) => (Math.random() * 16 | 0).toString(16));
}
module.exports = { createHash, randomUUID };
