// Echocellar acceptance test (spec section 8), driven against the real app.
// Run under xvfb: xvfb-run -a node test/e2e.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'echocellar-e2e-'));

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function launch() {
  const app = await electron.launch({
    args: ['.', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-gpu'],
    cwd: ROOT,
    env: {
      ...process.env,
      ECHOCELLAR_TEST: '1',
      ECHOCELLAR_HOME: HOME,
      FFMPEG_PATH: require('ffmpeg-static'),
    },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  return { app, page };
}

async function evalEc(page, js) {
  return page.evaluate(js);
}

(async () => {
  let { app, page } = await launch();
  await page.waitForSelector('#nav', { timeout: 15000 });

  // 1. Import the music folder (reference mode)
  const imp = await evalEc(page, `window.ec.test.importPathsSync([${JSON.stringify(path.join(FIX, 'music'))}], 'reference')`);
  report('import music folder', imp && imp.added === 5, JSON.stringify(imp));

  // 2. Import the Spotify export (playlist: 1 matching FLAC + 1 missing + repeat)
  const sp = await evalEc(page, `window.ec.test.spotifyImportPaths([
    ${JSON.stringify(path.join(FIX, 'spotify', 'Playlist1.json'))},
    ${JSON.stringify(path.join(FIX, 'spotify', 'StreamingHistory_music_0.json'))}
  ])`);
  const pl = sp && sp.playlists && sp.playlists[0];
  report('spotify import: 2 matched + 1 missing, 3 history entries',
    pl && pl.matched === 2 && pl.missing === 1 && sp.history.imported === 3, JSON.stringify(sp));

  const playlists = await evalEc(page, 'window.ec.playlists()');
  const lateDrive = playlists.find((p) => p.name === 'Late Drive');
  report('playlist "Late Drive" exists', !!lateDrive);

  // 3. Go offline and restart the app
  await evalEc(page, 'window.ec.test.setOnline(false)');
  await app.close();
  ({ app, page } = await launch());
  await page.waitForSelector('#nav', { timeout: 15000 });

  // 4. Play the FLAC (Emberline). Speed up: seek near the end.
  const emberline = await evalEc(page, `(async () => {
    const r = await window.ec.search('Emberline');
    return r.tracks[0];
  })()`);
  report('search finds Emberline', !!emberline, emberline && `${emberline.codec} ${emberline.duration_ms}ms`);

  await evalEc(page, `window.Player.playQueue([${emberline.id}], 0)`);
  await page.waitForFunction(() => {
    const a = document.getElementById('audio-el');
    return a && !a.paused && a.currentTime > 0.2;
  }, null, { timeout: 10000 }).catch(() => null);
  let playing = await evalEc(page, `!document.getElementById('audio-el').paused`);
  report('FLAC plays', playing);

  // codec badge shows real source info
  const codecText = await evalEc(page, `document.getElementById('np-codec').textContent`);
  report('codec details shown', /FLAC/.test(codecText) && /kHz/.test(codecText), codecText);

  // 5. Synced lyrics: open panel, count lines, click a line to seek
  await evalEc(page, `document.getElementById('btn-lyrics').click()`);
  await page.waitForSelector('.lrc-line', { timeout: 5000 }).catch(() => null);
  const lrcCount = await evalEc(page, `document.querySelectorAll('.lrc-line').length`);
  report('synced lyrics shown', lrcCount >= 6, `${lrcCount} lines`);
  await evalEc(page, `document.querySelectorAll('.lrc-line')[5].click()`);
  await page.waitForTimeout(400);
  const seekedTo = await evalEc(page, `document.getElementById('audio-el').currentTime`);
  report('click lyric line seeks', seekedTo > 13 && seekedTo < 18, `t=${seekedTo.toFixed(1)}`);

  // close lyrics overlay, then listen a little longer so the session has real time
  await evalEc(page, `document.getElementById('stage-close').click()`);
  await page.waitForTimeout(2000);

  // 6. Attach the video and switch audio -> video; playback position preserved
  await evalEc(page, `window.ec.test.attachVideo(${emberline.id}, ${JSON.stringify(path.join(FIX, 'Emberline (video).mp4'))}, 5000)`);
  const histBefore = (await evalEc(page, 'window.ec.test.state()')).history;
  await evalEc(page, `window.Player.toggleAV()`);
  await page.waitForFunction(() => {
    const v = document.getElementById('stage-video');
    return v && !v.paused && v.currentTime > 0;
  }, null, { timeout: 10000 }).catch(() => null);
  const vidState = await evalEc(page, `({ paused: document.getElementById('stage-video').paused, t: document.getElementById('stage-video').currentTime, src: document.getElementById('stage-video').currentSrc })`);
  report('video mode plays', !vidState.paused, JSON.stringify(vidState));
  const audioPos = await evalEc(page, `document.getElementById('audio-el').currentTime`);
  report('video offset applied (position + 5s intro)', Math.abs(vidState.t - (audioPos + 5)) < 1.5,
    `audio=${audioPos.toFixed(1)} video=${vidState.t.toFixed(1)}`);

  // Let it finish -> one session in History for the whole audio+video sitting
  await page.waitForTimeout(1500);
  await evalEc(page, `document.getElementById('stage-video').currentTime = document.getElementById('stage-video').duration - 0.3`);
  await page.waitForTimeout(3000);
  const histRows = await evalEc(page, `window.ec.timeline({ range: 'all', query: 'Emberline' })`);
  const emberSessions = histRows.filter((r) => r.source === 'local');
  report('audio+video switch = one history session', emberSessions.length === 1,
    `${emberSessions.length} session(s), ms=${emberSessions[0] && emberSessions[0].ms_listened}`);

  // 7. Paste in the missing song -> playable in its original playlist position
  const paste = await evalEc(page, `window.ec.test.importPathsSync([${JSON.stringify(path.join(FIX, 'extra', 'Polar Coast - Midnight Sun.flac'))}], 'copy')`);
  const entries = await evalEc(page, `window.ec.playlistEntries(${lateDrive.id})`);
  const pos1 = entries.find((e) => e.position === 1);
  report('missing song auto-links in original position',
    paste.linked_missing === 1 && pos1.status === 'matched' && pos1.title === 'Midnight Sun',
    JSON.stringify({ linked: paste.linked_missing, status: pos1.status, title: pos1.title }));
  report('playlist order and repeat preserved',
    entries.length === 3 && entries[0].title === 'Emberline' && entries[2].title === 'Emberline');

  // 8. Reimport the same Spotify export -> nothing changes
  const before = await evalEc(page, 'window.ec.test.state()');
  const re = await evalEc(page, `window.ec.test.spotifyImportPaths([
    ${JSON.stringify(path.join(FIX, 'spotify', 'Playlist1.json'))},
    ${JSON.stringify(path.join(FIX, 'spotify', 'StreamingHistory_music_0.json'))}
  ])`);
  const after = await evalEc(page, 'window.ec.test.state()');
  report('reimport is a no-op',
    re.playlists[0].skipped === 'identical' && re.history.imported === 0 &&
    before.playlists === after.playlists && before.entries === after.entries && before.history === after.history,
    JSON.stringify(re.playlists[0]));

  // 9. Offline still works: search, shuffle, recommendations, statistics
  const srch = await evalEc(page, `window.ec.search('glass')`);
  report('search works offline', srch.tracks.length === 1 && srch.tracks[0].title === 'Glass Roads');

  const shuffleOk = await evalEc(page, `(async () => {
    const ids = [1, 2, 3, 4, 5, 6].filter((id) => true);
    const q = new window.QueueState();
    q.setQueue(ids, 0);
    q.setShuffle(true);
    const heard = new Set([q.currentId()]);
    let n; while ((n = q.next()) != null) heard.add(n);
    return heard.size === ids.length;
  })()`);
  report('shuffle covers every entry once', shuffleOk);

  const recHome = await evalEc(page, 'window.ec.recsHome(0.7)');
  report('recommendations work offline', !!(recHome && (recHome.cold_start || recHome.mixes.length)),
    recHome.cold_start ? 'cold-start artist picker' : `${recHome.mixes.length} mixes`);

  const totals = await evalEc(page, `window.ec.totals({ range: 'all' })`);
  report('statistics work offline', totals.events >= 4 && totals.ms_listened > 0, JSON.stringify(totals));

  // 10. Restart persistence: queue + position restore
  await evalEc(page, `window.Player.playQueue([${emberline.id}], 0)`);
  await page.waitForTimeout(600);
  await evalEc(page, `document.getElementById('audio-el').currentTime = 4`);
  await page.waitForTimeout(5500); // let the 5s state saver fire
  await app.close();
  ({ app, page } = await launch());
  await page.waitForSelector('#nav', { timeout: 15000 });
  const restored = await evalEc(page, `({ n: window.Player.queue.trackIds.length, t: window.Player.el().currentTime })`);
  report('queue and position restore on reopen', restored.n === 1 && restored.t > 2, JSON.stringify(restored));

  // 11. ALAC plays through the lossless transcode path
  const alac = await evalEc(page, `(async () => {
    const r = await window.ec.search('Blue Static');
    return r.tracks[0];
  })()`);
  await evalEc(page, `window.Player.playQueue([${alac.id}], 0)`);
  const alacPlayed = await page.waitForFunction(() => {
    const a = document.getElementById('audio-el');
    return a && !a.paused && a.currentTime > 0.5;
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  const alacCodec = await evalEc(page, `document.getElementById('np-codec').textContent`);
  report('ALAC (24-bit/48kHz) plays losslessly via ffmpeg', alacPlayed, alacCodec);
  report('ALAC codec details shown', /ALAC/.test(alacCodec) && /48/.test(alacCodec) && /24/.test(alacCodec), alacCodec);

  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed`);
  fs.writeFileSync(path.join(ROOT, 'test', 'acceptance-report.json'), JSON.stringify({ home: HOME, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(1); });
