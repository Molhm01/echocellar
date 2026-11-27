'use strict';
// Matching between a requested track (from a Spotify export or playlist
// placeholder) and local library tracks. Pure logic, no IO.

const { normalize, similarity, versionTokensOf } = require('./util');

const DURATION_TOLERANCE_MS = 3000;
const AUTO_THRESHOLD = 0.9;
const REVIEW_THRESHOLD = 0.68;
const UNIQUE_GAP = 0.08;

function durationScore(reqMs, trackMs) {
  if (!reqMs || !trackMs) return 0.5; // unknown duration is neutral
  const diff = Math.abs(reqMs - trackMs);
  if (diff <= DURATION_TOLERANCE_MS) return 1;
  if (diff >= 30000) return 0;
  return 1 - (diff - DURATION_TOLERANCE_MS) / (30000 - DURATION_TOLERANCE_MS);
}

// A version conflict: one side names live/remaster/clean/explicit/etc. and the
// other side names a different set. These get flagged for human review.
function versionConflict(reqTitle, trackTitle) {
  const a = versionTokensOf(reqTitle);
  const b = versionTokensOf(trackTitle);
  const sa = new Set(a), sb = new Set(b);
  const diff = a.filter((t) => !sb.has(t)).concat(b.filter((t) => !sa.has(t)));
  return diff.length > 0 ? diff : null;
}

function scoreCandidate(request, track) {
  if (request.isrc && track.isrc && request.isrc.toUpperCase() === track.isrc.toUpperCase()) {
    return { score: 1, reason: 'isrc' };
  }
  const titleSim = similarity(request.title, track.title);
  const artistSim = similarity(request.artist, track.artist);
  const albumSim = request.album && track.album ? similarity(request.album, track.album) : 0.5;
  const dur = durationScore(request.duration_ms, track.duration_ms);
  let score = 0.4 * titleSim + 0.3 * artistSim + 0.1 * albumSim + 0.2 * dur;
  const conflict = versionConflict(request.title || '', track.title || '');
  if (conflict) score = Math.min(score, 0.85);
  return { score, versionConflict: conflict || undefined };
}

// candidates: array of library tracks (plain objects with id, title, artist,
// album, duration_ms, isrc). Returns {status, trackId?, candidates?}.
function decide(request, candidates) {
  if (!candidates.length) return { status: 'missing' };

  const scored = candidates
    .map((t) => ({ track: t, ...scoreCandidate(request, t) }))
    .sort((a, b) => b.score - a.score);

  // Hard auto-match: identical normalized artist + title and close duration.
  const reqArtist = normalize(request.artist);
  const reqTitle = normalize(request.title);
  const exact = scored.filter(
    ({ track }) => normalize(track.artist) === reqArtist && normalize(track.title) === reqTitle
  );
  if (exact.length) {
    const durOk = exact.filter(
      ({ track }) => !request.duration_ms || !track.duration_ms ||
        Math.abs(request.duration_ms - track.duration_ms) <= DURATION_TOLERANCE_MS
    );
    if (exact.length === 1 && (durOk.length === 1 || !request.duration_ms)) {
      if (!exact[0].versionConflict) return { status: 'matched', trackId: exact[0].track.id };
    }
  }

  const top = scored[0];
  if (!top || top.score < REVIEW_THRESHOLD) return { status: 'missing' };

  const runnerUp = scored[1];
  const clear = !runnerUp || top.score - runnerUp.score >= UNIQUE_GAP;

  if (top.score >= AUTO_THRESHOLD && clear && !top.versionConflict) {
    return { status: 'matched', trackId: top.track.id };
  }

  // Ambiguous: close scores or version conflict -> human review. Only real
  // contenders belong in the review list.
  return {
    status: 'review',
    candidates: scored.filter((s) => s.score >= REVIEW_THRESHOLD).slice(0, 5).map(({ track, score, versionConflict: vc }) => ({
      track_id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration_ms: track.duration_ms,
      score: Math.round(score * 1000) / 1000,
      version_conflict: vc || null,
    })),
  };
}

module.exports = { decide, scoreCandidate, durationScore, versionConflict, AUTO_THRESHOLD, REVIEW_THRESHOLD };
