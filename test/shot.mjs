import { createRequire } from 'module';
import fs from 'fs'; import os from 'os'; import path from 'path';
const require = createRequire(process.cwd() + '/package.json');
const { _electron: electron } = require('playwright-core');
const ROOT = process.cwd();
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-shot-'));
const app = await electron.launch({
  args: ['.', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-gpu'],
  cwd: ROOT,
  env: { ...process.env, ECHOCELLAR_TEST: '1', ECHOCELLAR_HOME: HOME, FFMPEG_PATH: require('ffmpeg-static') },
});
const page = await app.firstWindow();
await page.waitForSelector('#nav');
const FIX = path.join(ROOT, 'test', 'fixtures');
await page.evaluate(`window.ec.test.importPathsSync([${JSON.stringify(path.join(FIX, 'music'))}], 'reference')`);
await page.evaluate(`window.ec.test.spotifyImportPaths([${JSON.stringify(path.join(FIX, 'spotify', 'Playlist1.json'))}, ${JSON.stringify(path.join(FIX, 'spotify', 'StreamingHistory_music_0.json'))}])`);
const t = await page.evaluate(`(async () => (await window.ec.search('Emberline')).tracks[0])()`);
await page.evaluate(`window.Player.playQueue([${t.id}], 0)`);
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/shot-home.png' });
await page.evaluate(`document.querySelector('[data-view="library"]').click()`);
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/shot-library.png' });
await page.evaluate(`document.querySelector('[data-view="playlists"]').click()`);
await page.waitForTimeout(400);
await page.evaluate(`document.querySelector('[data-open-playlist]') && document.querySelector('[data-open-playlist]').click()`);
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/shot-playlist.png' });
await app.close();
console.log('screenshots saved');
