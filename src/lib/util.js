'use strict';
// Pure utilities shared by main process, library logic and tests. No electron imports.

const crypto = require('crypto');

const VERSION_TOKENS = [
  'live', 'remaster', 'remastered', 'clean', 'explicit', 'acoustic', 'remix',
  'edit', 'version', 'single', 'deluxe', 'mono', 'stereo', 'demo', 'instrumental',
  'radio', 'extended', 'unplugged', 'cover', 'reissue', 'anniversary', 'mix',
];

// Normalize a string for comparison: lowercase, strip diacritics, drop
// featuring-clauses and parenthetical/bracketed suffixes, collapse punctuation.
function normalize(str) {
  if (!str) return '';
  let s = String(str).toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/\((?:feat|ft|featuring|with)\.?\s[^)]*\)/g, ' ');
  s = s.replace(/\[(?:feat|ft|featuring|with)\.?\s[^\]]*\]/g, ' ');
  s = s.replace(/\s+(?:feat|ft|featuring)\.?\s+.*$/g, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[''’]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Extract the version markers from a title, e.g. "Song (Live)" -> ['live'].
function versionTokensOf(str) {
  if (!str) return [];
  const lower = String(str).toLowerCase();
  const found = new Set();
  for (const tok of VERSION_TOKENS) {
    if (new RegExp(`\\b${tok}\\b`).test(lower)) found.add(tok === 'remastered' ? 'remaster' : tok);
  }
  return [...found].sort();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    let cur = [i];
    for (let j = 1; j <= bl; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[bl];
}

// Similarity 0..1 tolerant to typos on short strings.
function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return Math.max(0, 1 - dist / Math.max(na.length, nb.length));
}

function sha1File(fsPath, fs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(fsPath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sha1String(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// Fisher-Yates with an injectable RNG so shuffle is reproducible in tests.
function shuffled(indices, rng) {
  const rand = rng || Math.random;
  const arr = indices.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function formatMs(ms) {
  const totalSec = Math.round((ms || 0) / 1000);
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function sanitizePathComponent(name) {
  return String(name || 'Unknown')
    .replace(/[<>:\"/\\\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Unknown';
}

const AUDIO_EXTS = ['.flac', '.m4a', '.wav', '.mp3', '.aac', '.ogg', '.oga', '.mp4'];
const VIDEO_EXTS = ['.mp4', '.m4v', '.webm', '.mkv', '.mov'];
const PLAYLIST_EXTS = ['.m3u', '.m3u8', '.pls', '.json'];

function extOf(p) {
  const m = /\.([^.]+)$/.exec(p || '');
  return m ? '.' + m[1].toLowerCase() : '';
}

module.exports = {
  VERSION_TOKENS,
  normalize,
  versionTokensOf,
  similarity,
  levenshtein,
  sha1File,
  sha1String,
  shuffled,
  clamp,
  formatMs,
  sanitizePathComponent,
  AUDIO_EXTS,
  VIDEO_EXTS,
  PLAYLIST_EXTS,
  extOf,
};
