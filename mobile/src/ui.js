'use strict';
// Mobile UI: bottom-tab shell (Home / Library / Search / Queue / Settings),
// now-playing bar with an expanded player sheet. Dark cellar theme, amber
// accents, same visual language as the desktop app.

const Player = require('./player');

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMs = (ms) => {
  if (!ms) return '--:--';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

let tab = 'home';
let libView = 'artists';
let openArtist = null;
let openAlbum = null;
let openPlaylist = null;

const artCache = new Map();
async function artOf(id) {
  if (!id) return null;
  if (artCache.has(id)) return artCache.get(id);
  const p = window.ec.artSrc(id).catch(() => null);
  artCache.set(id, p);
  return p;
}

function trackRow(t, queueIds, idx) {
  return `<div class="row track-row" data-play-at="${idx}" data-queue='${JSON.stringify(queueIds)}'>
    <img class="row-art" data-art="${t.id}" src="assets/logo.svg" alt="">
    <div class="row-main"><div class="row-title">${esc(t.title)}</div>
    <div class="row-sub">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</div></div>
    <div class="row-dur">${fmtMs(t.duration_ms)}</div>
  </div>`;
}

function card(t, queueIds, idx) {
  return `<div class="card" data-play-at="${idx}" data-queue='${JSON.stringify(queueIds)}'>
    <img data-art="${t.id}" src="assets/logo.svg" alt="">
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-sub">${esc(t.artist)}</div>
  </div>`;
}

async function hydrateArt(root) {
  const imgs = root.querySelectorAll('img[data-art]');
  await Promise.all(Array.from(imgs).map(async (img) => {
    const url = await artOf(Number(img.dataset.art));
    if (url) img.src = url;
  }));
}

// ---------- views ----------
async function renderHome(view) {
  const home = window.ec.recsHome(0.7);
  const recent = window.ec.recentTracks(8);
  const favs = window.ec.favorites().slice(0, 8);
  let html = '';
  if (recent.length) {
    const ids = recent.map((t) => t.id);
    html += `<h3>Jump back in</h3><div class="card-row">${recent.map((t, i) => card(t, ids, i)).join('')}</div>`;
  }
  if (home.cold_start) {
    html += `<h3>Welcome to your cellar</h3>
      <p class="dim">${home.artists.length ? 'Play an artist radio to get started; mixes build themselves as you listen.' : 'Import your music in Settings to get started.'}</p>`;
    if (home.artists.length) {
      html += `<div class="pill-row">${home.artists.map((a) =>
        `<button class="pill" data-radio-artist="${esc(a.artist)}">${esc(a.artist)}</button>`).join('')}</div>`;
    }
  } else {
    for (const mix of home.mixes) {
      const ids = mix.tracks.map((t) => t.id);
      html += `<div class="section-head"><h3>${esc(mix.title)}</h3>
        <button class="pill" data-play-queue='${JSON.stringify(ids)}'>Play</button></div>
        <div class="card-row">${mix.tracks.slice(0, 8).map((t, i) => card(t, ids, i)).join('')}</div>`;
    }
  }
  if (favs.length) {
    const ids = favs.map((t) => t.id);
    html += `<div class="section-head"><h3>Favorites</h3>
      <button class="pill" data-play-queue='${JSON.stringify(ids)}'>Play</button></div>
      <div class="card-row">${favs.map((t, i) => card(t, ids, i)).join('')}</div>`;
  }
  view.innerHTML = html || '<p class="dim pad">Your library is empty. Import music from Settings.</p>';
  hydrateArt(view);
}

function renderLibrary(view) {
  let html = `<div class="seg">
    <button class="seg-btn ${libView === 'artists' && !openArtist && !openAlbum ? 'on' : ''}" data-lib="artists">Artists</button>
    <button class="seg-btn ${libView === 'albums' && !openArtist && !openAlbum ? 'on' : ''}" data-lib="albums">Albums</button>
    <button class="seg-btn ${libView === 'songs' ? 'on' : ''}" data-lib="songs">Songs</button>
    <button class="seg-btn ${libView === 'playlists' && openPlaylist == null ? 'on' : ''}" data-lib="playlists">Playlists</button>
  </div>`;
  if (openPlaylist != null) {
    const pl = window.ec.playlists().find((x) => x.id === openPlaylist);
    const entries = window.ec.playlistEntries(openPlaylist);
    const playableIds = entries.filter((e) => e.id != null).map((e) => e.id);
    html += `<div class="section-head"><button class="pill" data-back-lib>‹ Playlists</button>
      <h3>${esc(pl ? pl.name : 'Playlist')}</h3>${playableIds.length ? `<button class="pill" data-play-queue='${JSON.stringify(playableIds)}'>Play</button>` : ''}</div>` +
      (entries.map((e) => {
        if (e.id != null) {
          const t = { id: e.id, title: e.title, artist: e.artist, album: e.album, duration_ms: e.duration_ms };
          const qi = playableIds.indexOf(e.id);
          return trackRow(t, playableIds, qi);
        }
        return `<div class="row dim">
          <div class="row-main"><div class="row-title">${esc(e.req_title)}</div>
          <div class="row-sub">${esc(e.req_artist)}${e.req_album ? ' · ' + esc(e.req_album) : ''} · add the audio file and it links up</div></div>
          <div class="row-dur">${fmtMs(e.req_duration_ms)}</div></div>`;
      }).join('') || '<p class="dim pad">Empty playlist.</p>');
  } else if (openArtist) {
    const tracks = window.ec.artistTracks(openArtist);
    const ids = tracks.map((t) => t.id);
    html += `<div class="section-head"><button class="pill" data-back-lib>‹ Artists</button>
      <h3>${esc(openArtist)}</h3><button class="pill" data-play-queue='${JSON.stringify(ids)}'>Play</button>
      <button class="pill" data-radio-artist="${esc(openArtist)}">Radio</button></div>
      ${tracks.map((t, i) => trackRow(t, ids, i)).join('')}`;
  } else if (openAlbum) {
    const tracks = window.ec.albumTracks(openAlbum);
    const ids = tracks.map((t) => t.id);
    html += `<div class="section-head"><button class="pill" data-back-lib>‹ Albums</button>
      <h3>${esc(openAlbum)}</h3><button class="pill" data-play-queue='${JSON.stringify(ids)}'>Play</button></div>
      ${tracks.map((t, i) => trackRow(t, ids, i)).join('')}`;
  } else if (libView === 'artists') {
    html += window.ec.artists().map((a) =>
      `<div class="row" data-open-artist="${esc(a.name)}">
        <div class="row-main"><div class="row-title">${esc(a.name)}</div>
        <div class="row-sub">${a.tracks} song${a.tracks === 1 ? '' : 's'}</div></div>
      </div>`).join('') || '<p class="dim pad">No artists yet.</p>';
  } else if (libView === 'albums') {
    html += window.ec.albums().map((a) =>
      `<div class="row" data-open-album="${esc(a.name)}">
        <img class="row-art" data-art="${a.art_track_id}" src="assets/logo.svg" alt="">
        <div class="row-main"><div class="row-title">${esc(a.name)}</div>
        <div class="row-sub">${esc(a.artist)} · ${a.tracks} song${a.tracks === 1 ? '' : 's'}</div></div>
      </div>`).join('') || '<p class="dim pad">No albums yet.</p>';
  } else if (libView === 'playlists') {
    html += window.ec.playlists().map((p) =>
      `<div class="row" data-open-playlist="${p.id}">
        <div class="row-main"><div class="row-title">${esc(p.name)}</div>
        <div class="row-sub">${p.matched || 0}/${p.entries || 0} playable${p.source === 'spotify' ? ' · from Spotify' : ''}</div></div>
      </div>`).join('') || '<p class="dim pad">No playlists yet. Import your Spotify export in Settings.</p>';
  } else {
    const tracks = window.ec.tracks({ limit: 500 });
    const ids = tracks.map((t) => t.id);
    html += `<div class="section-head"><button class="pill" data-play-queue='${JSON.stringify(ids)}'>Play all</button>
      <button class="pill" data-shuffle-queue='${JSON.stringify(ids)}'>Shuffle</button></div>` +
      tracks.map((t, i) => trackRow(t, ids, i)).join('');
  }
  view.innerHTML = html;
  hydrateArt(view);
}

function renderSearch(view) {
  view.innerHTML = `<input id="search-box" type="search" placeholder="Songs, artists, albums" autocomplete="off">
    <div id="search-results"><p class="dim pad">Type to search your library. Works fully offline.</p></div>`;
  const box = $('#search-box');
  box.addEventListener('input', () => {
    const q = box.value.trim();
    const out = $('#search-results');
    if (!q) { out.innerHTML = '<p class="dim pad">Type to search your library. Works fully offline.</p>'; return; }
    const results = window.ec.search(q);
    const ids = results.map((t) => t.id);
    out.innerHTML = results.length
      ? results.map((t, i) => trackRow(t, ids, i)).join('')
      : '<p class="dim pad">No matches.</p>';
    hydrateArt(out);
  });
}

function renderQueue(view) {
  const q = Player.queue;
  const cur = q.currentId();
  view.innerHTML = `<h3>Queue${q.shuffle ? ' · shuffle' : ''}</h3>` + (q.trackIds.length ?
    q.trackIds.map((id, i) => {
      const t = window.ec.track(id);
      if (!t) return '';
      return `<div class="row track-row ${id === cur ? 'playing' : ''}" data-play-at="${i}" data-queue='${JSON.stringify(q.trackIds)}'>
        <div class="row-main"><div class="row-title">${esc(t.title)}</div>
        <div class="row-sub">${esc(t.artist)}</div></div>
        <div class="row-dur">${fmtMs(t.duration_ms)}</div></div>`;
    }).join('') : '<p class="dim pad">Nothing queued. Play something from your library.</p>');
}

function renderSettings(view) {
  const c = window.ec.counts();
  const totals = window.ec.totals({ range: 'all' });
  const hrs = Math.floor((totals.ms_listened || 0) / 3600000);
  const mins = Math.round(((totals.ms_listened || 0) % 3600000) / 60000);
  view.innerHTML = `
    <h3>Settings</h3>
    <div class="card-block">
      <div class="row-title">Your library</div>
      <div class="row-sub">${c.tracks} songs · ${c.artists} artists · ${hrs}h ${mins}m listened</div>
    </div>
    <div class="card-block">
      <div class="row-title">Import music</div>
      <div class="row-sub">Files are copied into the app, so playback never depends on the originals. Everything stays on this phone.</div>
      <button class="btn" id="import-btn">Choose audio files</button>
      <div id="import-status" class="dim small"></div>
    </div>
    <div class="card-block">
      <div class="row-title">Import from Spotify</div>
      <div class="row-sub">Bring your playlists and listening history. On spotify.com: Profile › Account › Privacy settings › Download your data. When the email arrives, open the zip in Files, then pick the Playlist and YourLibrary JSON files here. Songs you don't have as audio stay in their playlist spots and link up when you add them.</div>
      <button class="btn" id="spotify-btn">Choose Spotify files</button>
      <div id="spotify-status" class="dim small"></div>
    </div>
    <div class="card-block">
      <div class="row-title">About</div>
      <div class="row-sub">Echocellar 0.1.0 · open source (MIT) · works fully offline. No account, no ads, no tracking.</div>
      <div class="row-sub dim small">ALAC files are not playable on this version and are skipped on import.</div>
    </div>`;
  $('#import-btn').addEventListener('click', () => $('#file-input').click());
  $('#spotify-btn').addEventListener('click', () => $('#spotify-input').click());
}

// ---------- shell ----------
function render() {
  const view = $('#view');
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'home') renderHome(view);
  else if (tab === 'library') renderLibrary(view);
  else if (tab === 'search') renderSearch(view);
  else if (tab === 'queue') renderQueue(view);
  else renderSettings(view);
  renderNowPlaying();
}

async function renderNowPlaying() {
  const bar = $('#np-bar');
  const t = Player.current;
  const a = document.getElementById('ec-audio');
  if (!t) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#np-title').textContent = t.title;
  $('#np-artist').textContent = t.artist || '';
  $('#np-play').textContent = a.paused ? '▶' : '⏸';
  $('#np-fav').textContent = window.ec.isFavorite(t.id) ? '♥' : '♡';
  const url = await artOf(t.id);
  $('#np-art').src = url || 'assets/logo.svg';
  // expanded sheet
  $('#sheet-title').textContent = t.title;
  $('#sheet-artist').textContent = (t.artist || '') + (t.album ? ' · ' + t.album : '');
  $('#sheet-art').src = url || 'assets/logo.svg';
  $('#sheet-play').textContent = a.paused ? '▶' : '⏸';
  $('#sheet-fav').textContent = window.ec.isFavorite(t.id) ? '♥' : '♡';
  $('#sheet-shuffle').classList.toggle('on', Player.queue.shuffle);
  $('#sheet-repeat').textContent = Player.queue.repeat === 'one' ? '🔂' : '🔁';
  $('#sheet-repeat').classList.toggle('on', Player.queue.repeat !== 'off');
  const codec = [t.codec, t.sample_rate ? (t.sample_rate / 1000).toFixed(1).replace(/\.0$/, '') + ' kHz' : null,
    t.bit_depth ? t.bit_depth + '-bit' : null].filter(Boolean).join(' · ');
  $('#sheet-codec').textContent = codec;
}

function start() {
  const root = document.getElementById('app');
  root.innerHTML = `
    <header><img src="assets/logo.svg" class="logo" alt=""><span>echocellar</span></header>
    <main id="view"></main>
    <div id="np-bar" class="hidden">
      <img id="np-art" src="assets/logo.svg" alt="">
      <div class="np-main"><div id="np-title"></div><div id="np-artist" class="dim"></div></div>
      <button id="np-fav" class="np-btn">♡</button>
      <button id="np-play" class="np-btn">▶</button>
    </div>
    <nav id="tabs">
      <button class="tab-btn on" data-tab="home">Home</button>
      <button class="tab-btn" data-tab="library">Library</button>
      <button class="tab-btn" data-tab="search">Search</button>
      <button class="tab-btn" data-tab="queue">Queue</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
    </nav>
    <div id="sheet" class="hidden">
      <div class="sheet-handle" id="sheet-close"></div>
      <img id="sheet-art" src="assets/logo.svg" alt="">
      <div id="sheet-title" class="sheet-title"></div>
      <div id="sheet-artist" class="dim"></div>
      <div id="sheet-codec" class="dim small"></div>
      <input id="seek" type="range" min="0" max="1000" value="0">
      <div class="sheet-times"><span id="t-cur">0:00</span><span id="t-dur">0:00</span></div>
      <div class="sheet-controls">
        <button id="sheet-shuffle" class="ctl">🔀</button>
        <button id="sheet-prev" class="ctl">⏮</button>
        <button id="sheet-play" class="ctl big">▶</button>
        <button id="sheet-next" class="ctl">⏭</button>
        <button id="sheet-repeat" class="ctl">🔁</button>
      </div>
      <button id="sheet-fav" class="np-btn sheet-fav">♡</button>
    </div>`;

  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
  $('#np-play').addEventListener('click', (e) => { e.stopPropagation(); Player.toggle(); });
  $('#np-bar').addEventListener('click', () => { $('#sheet').classList.remove('hidden'); });
  $('#np-fav').addEventListener('click', (e) => {
    e.stopPropagation();
    if (Player.current) window.ec.toggleFavorite(Player.current.id);
    renderNowPlaying();
  });
  $('#sheet-close').addEventListener('click', () => $('#sheet').classList.add('hidden'));
  $('#sheet-play').addEventListener('click', () => Player.toggle());
  $('#sheet-next').addEventListener('click', () => Player.next());
  $('#sheet-prev').addEventListener('click', () => Player.previous());
  $('#sheet-shuffle').addEventListener('click', () => Player.setShuffle(!Player.queue.shuffle));
  $('#sheet-repeat').addEventListener('click', () => Player.cycleRepeat());
  $('#sheet-fav').addEventListener('click', () => {
    if (Player.current) window.ec.toggleFavorite(Player.current.id);
    renderNowPlaying();
  });

  const a = document.getElementById('ec-audio');
  const seek = $('#seek');
  a.addEventListener('timeupdate', () => {
    if (!a.duration || !isFinite(a.duration)) return;
    seek.value = Math.round((a.currentTime / a.duration) * 1000);
    $('#t-cur').textContent = fmtMs(a.currentTime * 1000);
    $('#t-dur').textContent = fmtMs(a.duration * 1000);
  });
  seek.addEventListener('input', () => {
    if (a.duration && isFinite(a.duration)) a.currentTime = (seek.value / 1000) * a.duration;
  });
  a.addEventListener('play', renderNowPlaying);
  a.addEventListener('pause', renderNowPlaying);

  $('#file-input').addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const status = $('#import-status');
    try {
      const res = await window.ec.importFiles(files, (done, total, name) => {
        if (status) status.textContent = `Importing ${done}/${total}: ${name}`;
      });
      if (status) {
        const parts = [`Imported ${res.imported} song${res.imported === 1 ? '' : 's'}.`];
        if (res.duplicates.length) parts.push(`${res.duplicates.length} already in library.`);
        if (res.skippedUnsupported.length) parts.push(`Skipped: ${res.skippedUnsupported.join('; ')}`);
        if (res.errors.length) parts.push(`Failed: ${res.errors.join('; ')}`);
        status.textContent = parts.join(' ');
      }
    } finally {
      e.target.value = '';
    }
  });

  $('#spotify-input').addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const status = $('#spotify-status');
    try {
      if (status) status.textContent = 'Reading Spotify export…';
      const r = await window.ec.importSpotify(files);
      const parts = [];
      for (const p of r.playlists) {
        if (p.skipped === 'identical') parts.push(`"${p.name}" already imported.`);
        else parts.push(`Playlist "${p.name}": ${p.matched}/${p.matched + p.review + p.missing} playable.`);
      }
      if (r.library && r.library.skipped !== 'identical' && r.library.matched != null)
        parts.push(`Liked Songs: ${r.library.matched}/${r.library.matched + r.library.review + r.library.missing} playable.`);
      if (r.history.imported)
        parts.push(`${r.history.imported} history entries imported (${r.history.duplicates} duplicates skipped).`);
      const unknown = r.files.filter((f) => f.kind === 'unknown');
      if (unknown.length) parts.push(`Not recognized: ${unknown.map((f) => f.name).join(', ')}.`);
      if (status) status.textContent = parts.join(' ') || 'Nothing new found in those files.';
    } catch (err) {
      if (status) status.textContent = 'Import failed: ' + String(err && err.message || err);
    } finally {
      e.target.value = '';
    }
  });

  // Global delegation for play actions.
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-play-at], [data-play-queue], [data-shuffle-queue], [data-radio-artist], [data-open-artist], [data-open-album], [data-open-playlist], [data-back-lib], [data-lib]');
    if (!el) return;
    if (el.dataset.playQueue) {
      Player.playQueue(JSON.parse(el.dataset.playQueue), 0);
    } else if (el.dataset.shuffleQueue) {
      Player.queue.setShuffle(true);
      Player.playQueue(JSON.parse(el.dataset.shuffleQueue), 0);
    } else if (el.dataset.playAt != null && el.dataset.queue) {
      Player.playQueue(JSON.parse(el.dataset.queue), Number(el.dataset.playAt));
    } else if (el.dataset.radioArtist) {
      const radio = window.ec.artistRadio(el.dataset.radioArtist, 25);
      if (radio.length) Player.playQueue(radio.map((t) => t.id), 0);
    } else if (el.dataset.openArtist) {
      openArtist = el.dataset.openArtist; openAlbum = null; render();
    } else if (el.dataset.openAlbum) {
      openAlbum = el.dataset.openAlbum; openArtist = null; render();
    } else if (el.dataset.openPlaylist) {
      openPlaylist = Number(el.dataset.openPlaylist); libView = 'playlists'; openArtist = null; openAlbum = null; render();
    } else if (el.dataset.backLib != null) {
      openArtist = null; openAlbum = null; openPlaylist = null; render();
    } else if (el.dataset.lib) {
      libView = el.dataset.lib; openArtist = null; openAlbum = null; openPlaylist = null; render();
    }
  });

  window.ec.onLibraryChanged(() => { artCache.clear(); render(); });
  Player.onChange(renderNowPlaying);
  Player.init();
  render();
}

module.exports = { start };
