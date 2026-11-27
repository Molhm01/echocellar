'use strict';
// Lyrics: embedded (via music-metadata), plain .txt sidecars, timestamped .lrc.

function parseLrc(text) {
  const lines = [];
  const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const raw of String(text).split(/\r?\n/)) {
    let m; const times = [];
    re.lastIndex = 0;
    while ((m = re.exec(raw)) !== null) {
      times.push(Math.round((parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000));
    }
    const textPart = raw.replace(re, '').trim();
    if (times.length && textPart) {
      for (const t of times) lines.push({ time_ms: t, text: textPart });
    }
  }
  lines.sort((a, b) => a.time_ms - b.time_ms);
  return lines;
}

function currentLineIndex(lines, positionMs) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time_ms <= positionMs) idx = i; else break;
  }
  return idx;
}

module.exports = { parseLrc, currentLineIndex };
