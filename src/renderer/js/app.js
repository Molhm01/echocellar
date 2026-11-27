'use strict';
/* global Player, QueueState, fmtTime */
// Echocellar UI: views, import flows, drag-drop/paste, keyboard, lyrics, queue.

(function () {
  const $ = (sel) => document.querySelector(sel);
  const view = $('#view');
  const state = { view: 'home', familiarity: 0.7, playlistId: null, artist: null, album: null, historyRange: 'month' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtDur(ms) {
    if (!ms) return '--:--';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms || 3500);
  }

  // ---------- navigation ----------
  function show(name) {
    state.view = name;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    render();
  }
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  async function render() {
    const fn = {
      home: renderHome, search: renderSearch, library: renderLibrary,
      playlists: state.playlistId ? renderPlaylistDetail : renderPlaylists,
      discover: renderDiscover, history: renderHistory,
      catalog: renderCatalog, settings: renderSettings,
    }[state.view];
    if (fn) await fn();
  }

  // ---------- shared bits ----------
  function trackRows(tracks, opts) {
    const o = opts || {};
    if (!tracks.length) return '<p class="dim">Nothing here yet. Import your music to get started.</p>';
    const ids = tracks.map((t) => t.id || t.track_id);
    return `<table class="tracklist"><thead><tr>
      <th></th><th>Title</th><th>Artist</th><th>Album</th><th></th><th style="text-align:right">Time</th></tr></thead>
      <tbody>${tracks.map((t, i) => {
        const id = t.id || t.track_id;
        const missing = t.status && t.status !== 'matched';
        return `<tr class="track-row ${Player.currentTrack && Player.currentTrack.id === id ? 'playing' : ''}"
            data-queue-ids='${JSON.stringify(ids)}' data-queue-index="${i}" data-track-id="${id || ''}" ${missing ? 'data-missing="1"' : ''}>
          <td>${i + 1}</td>
          <td>${esc(t.title || t.req_title)}${t.status === 'missing' ? '<span class="missing-pill">not in library</span>' : ''}${t.status === 'review' ? '<span class="review-pill">needs review</span>' : ''}${t.video_path ? ' &#127909;' : ''}</td>
          <td class="dim">${esc(t.artist || t.req_artist)}</td>
          <td class="dim">${esc(t.album || t.req_album || '')}</td>
          <td>${t.codec ? `<span class="codec-badge">${esc(t.codec)}</span>` : ''}</td>
          <td style="text-align:right" class="dim">${fmtDur(t.duration_ms || t.req_duration_ms)}</td>
        </tr>`;
      }).join('')}</tbody></table>
      ${o.showPlayAll ? `<div class="pill-row"><button class="pill" data-playall='${JSON.stringify(ids)}'>Play all</button>
      <button class="pill" data-shuffleall='${JSON.stringify(ids)}'>Shuffle</button></div>` : ''}`;
  }

  function albumCards(albums) {
    return `<div class="card-row">${albums.map((a) => `
      <div class="card" data-album="${esc(a.album)}" data-artist="${esc(a.artist)}">
        <img src="${a.art_path ? 'media://file/?path=' + encodeURIComponent(a.art_path) : '../assets/logo.svg'}" alt="">
        <div class="card-title">${esc(a.album)}</div>
        <div class="card-sub">${esc(a.artist)}${a.year ? ' · ' + a.year : ''}</div>
      </div>`).join('')}</div>`;
  }

  // ---------- views ----------
  function trackCard(t) {
    const id = t.id || t.track_id;
    return `<div class="card track-card" data-card-track="${id}" data-card-queue='${JSON.stringify([id])}'>
      <img src="media://art/${id}" alt="">
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-sub">${esc(t.artist)}</div>
    </div>`;
  }

  async function renderHome() {
    const home = await window.ec.recsHome(state.familiarity);
    const recent = await window.ec.recentTracks(12);
    const favs = await window.ec.favorites();
    let html = '<h2>Home</h2>';
    if (recent.length) {
      html += `<h3>Jump back in</h3><div class="card-row">${recent.slice(0, 8).map(trackCard).join('')}</div>`;
    }
    if (home.cold_start) {
      const artists = home.artists || [];
      const cards = await Promise.all(artists.slice(0, 8).map(async (a) => {
        const tracks = await window.ec.artistTracks(a.artist);
        const artId = tracks.length ? tracks[0].id : null;
        return `<div class="card track-card" data-fav-artist="${esc(a.artist)}">
          ${artId ? `<img src="media://art/${artId}" alt="">` : ''}
          <div class="card-title">${esc(a.artist)}</div>
          <div class="card-sub">${a.tracks} songs · tap to play radio</div>
        </div>`;
      }));
      html += `<h3>Welcome to your cellar</h3>
        <p class="dim">Pick a few favorite artists and Echocellar will start building your mixes. As you listen, recommendations adapt on their own.</p>
        <div class="card-row">${cards.join('')}</div>`;
    } else {
      for (const mix of home.mixes) {
        html += `<div class="section-head"><h3>${esc(mix.title)}</h3>
          <button class="pill" data-playall='${JSON.stringify(mix.tracks.map((t) => t.id))}'>Play</button></div>
          <div class="card-row">${mix.tracks.slice(0, 8).map(trackCard).join('')}</div>`;
      }
    }
    if (favs.length) {
      html += `<div class="section-head"><h3>Favorites</h3>
        <button class="pill" data-playall='${JSON.stringify(favs.map((t) => t.id))}'>Play</button></div>
        <div class="card-row">${favs.slice(0, 8).map(trackCard).join('')}</div>`;
    }
    if (!recent.length && home.cold_start && !favs.length) {
      html += `<h3>Get started</h3><p class="dim">Drag music files or folders anywhere into this window, or use the import buttons on the left.</p>`;
    }
    view.innerHTML = html;
  }

  async function renderSearch() {
    view.innerHTML = `<h2>Search</h2>
      <input type="text" id="search-input" placeholder="Songs, artists, albums, playlists" style="width:100%;max-width:560px">
      <div id="search-results"></div>`;
    const input = $('#search-input');
    input.focus();
    input.addEventListener('input', async () => {
      const q = input.value.trim();
      if (!q) { $('#search-results').innerHTML = ''; return; }
      const r = await window.ec.search(q);
      let html = '';
      if (r.tracks.length) html += `<h3>Songs</h3>${trackRows(r.tracks)}`;
      if (r.artists.length) html += `<h3>Artists</h3><div class="pill-row">${r.artists.map((a) =>
        `<button class="pill" data-open-artist="${esc(a.artist)}">${esc(a.artist)} (${a.tracks})</button>`).join('')}</div>`;
      if (r.albums.length) html += `<h3>Albums</h3>${albumCards(r.albums)}`;
      if (r.playlists.length) html += `<h3>Playlists</h3><div class="pill-row">${r.playlists.map((p) =>
        `<button class="pill" data-open-playlist="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
      if (!html) html = '<p class="dim">No matches in your library.</p>';
      $('#search-results').innerHTML = html;
    });
  }

  async function renderLibrary() {
    if (state.artist) return renderArtistPage(state.artist);
    if (state.album) return renderAlbumPage(state.album.album, state.album.artist);
    const tab = state.libraryTab || 'songs';
    let html = `<h2>Library</h2><div class="pill-row">
      <button class="pill ${tab === 'songs' ? 'active' : ''}" data-lib-tab="songs">Songs</button>
      <button class="pill ${tab === 'albums' ? 'active' : ''}" data-lib-tab="albums">Albums</button>
      <button class="pill ${tab === 'artists' ? 'active' : ''}" data-lib-tab="artists">Artists</button></div>`;
    if (tab === 'songs') {
      const tracks = await window.ec.tracks();
      html += trackRows(tracks.filter((t) => !t.missing), { showPlayAll: true });
    } else if (tab === 'albums') {
      html += albumCards(await window.ec.albums());
    } else {
      const artists = await window.ec.artists();
      html += `<div class="pill-row" style="flex-direction:column;align-items:flex-start">${artists.map((a) =>
        `<button class="pill" data-open-artist="${esc(a.artist)}">${esc(a.artist)} <span class="dim">${a.tracks} songs</span></button>`).join('')}</div>`;
    }
    view.innerHTML = html;
  }

  async function renderArtistPage(artist) {
    const tracks = await window.ec.artistTracks(artist);
    const similar = await window.ec.similarArtists(artist);
    view.innerHTML = `<div class="section-head"><button class="ghost" data-back>← Back</button><h2>${esc(artist)}</h2>
      <button class="pill" data-radio-artist="${esc(artist)}">Artist radio</button></div>
      ${trackRows(tracks, { showPlayAll: true })}
      ${similar.length ? `<h3>Similar artists</h3><div class="pill-row">${similar.map((s) =>
        `<button class="pill" data-open-artist="${esc(s.artist)}" title="${esc(s.reason)}">${esc(s.artist)}</button>`).join('')}</div>` : ''}`;
  }

  async function renderAlbumPage(album, artist) {
    const tracks = await window.ec.albumTracks(album, artist);
    view.innerHTML = `<div class="section-head"><button class="ghost" data-back>← Back</button><h2>${esc(album)}</h2><span class="dim">${esc(artist)}</span></div>
      ${trackRows(tracks, { showPlayAll: true })}`;
  }

  async function renderPlaylists() {
    const playlists = await window.ec.playlists();
    view.innerHTML = `<div class="section-head"><h2>Playlists</h2><button id="btn-new-playlist">New playlist</button></div>
      ${playlists.length ? `<div class="card-row">${playlists.map((p) => `
        <div class="card" data-open-playlist="${p.id}">
          <div class="card-title">${esc(p.name)}</div>
          <div class="card-sub">${p.matched || 0}/${p.entries || 0} playable${p.source === 'spotify' ? ' · from Spotify' : ''}</div>
        </div>`).join('')}</div>` : '<p class="dim">No playlists yet. Import a Spotify export or create one.</p>'}`;
  }

  async function renderPlaylistDetail() {
    const id = state.playlistId;
    const entries = await window.ec.playlistEntries(id);
    const playlists = await window.ec.playlists();
    const pl = playlists.find((p) => p.id === id);
    view.innerHTML = `<div class="section-head"><button class="ghost" data-back>← Back</button>
      <h2>${esc(pl ? pl.name : 'Playlist')}</h2>
      <button class="pill" data-playall='${JSON.stringify(entries.filter((e) => e.status === 'matched').map((e) => e.track_id))}'>Play</button>
      <button class="pill" data-shuffleall='${JSON.stringify(entries.filter((e) => e.status === 'matched').map((e) => e.track_id))}'>Shuffle</button>
      <button class="ghost" id="btn-del-playlist">Delete</button></div>
      <p class="dim small">Missing songs keep their place in the playlist and turn playable automatically once you add the matching audio.</p>
      <table class="tracklist"><thead><tr><th></th><th>Title</th><th>Artist</th><th>Album</th><th></th><th></th><th style="text-align:right">Time</th></tr></thead>
      <tbody>${entries.map((e, i) => `
        <tr class="track-row" data-entry-id="${e.id}" data-position="${e.position}" draggable="true"
            ${e.status === 'matched' ? `data-queue-ids='${JSON.stringify(entries.filter((x) => x.status === 'matched').map((x) => x.track_id))}' data-queue-index="${entries.filter((x) => x.status === 'matched').indexOf(e)}" data-track-id="${e.track_id}"` : 'data-missing="1"'}>
          <td>${i + 1}</td>
          <td>${esc(e.title || e.req_title)}${e.status === 'missing' ? '<span class="missing-pill">not in library</span>' : ''}${e.status === 'review' ? '<span class="review-pill">needs review</span>' : ''}</td>
          <td class="dim">${esc(e.artist || e.req_artist)}</td>
          <td class="dim">${esc(e.album || e.req_album || '')}</td>
          <td>${e.codec ? `<span class="codec-badge">${esc(e.codec)}</span>` : ''}</td>
          <td><button class="ghost small" data-remove-entry="${e.id}" title="Remove">&#10005;</button></td>
          <td style="text-align:right" class="dim">${fmtDur(e.duration_ms)}</td>
        </tr>`).join('')}</tbody></table>`;
    enableEntryDrag(id);
  }

  async function renderDiscover() {
    const fam = state.familiarity;
    const discovery = await window.ec.discovery();
    view.innerHTML = `<h2>Discover</h2>
      <div class="section-head"><span class="dim small">Familiar</span>
        <input type="range" class="slider" id="fam-slider" min="0" max="100" value="${Math.round(fam * 100)}" style="width:180px">
        <span class="dim small">Discovery</span></div>
      <h3>Track radio</h3>
      <p class="dim small">Pick any song from your library to build a radio around it.</p>
      <input type="text" id="radio-track-search" placeholder="Type a song title..." style="width:100%;max-width:420px">
      <div id="radio-results"></div>
      <div id="radio-output"></div>
      <h3>Not in your library yet</h3>
      <p class="dim small">Songs from your Spotify playlists that Echocellar could not match to local files. Add the audio and they link up automatically.</p>
      ${discovery.length ? `<table class="tracklist"><tbody>${discovery.map((d) => `
        <tr><td>${esc(d.title)}</td><td class="dim">${esc(d.artist)}</td><td class="dim">${esc(d.album || '')}</td>
        <td class="dim small">in ${esc(d.in_playlists)}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">Everything referenced by your playlists is already playable.</p>'}`;
    $('#fam-slider').addEventListener('change', async (e) => {
      state.familiarity = e.target.value / 100;
      await window.ec.setFamiliarity(state.familiarity);
    });
    $('#radio-track-search').addEventListener('input', async (e) => {
      const q = e.target.value.trim();
      if (!q) { $('#radio-results').innerHTML = ''; return; }
      const r = await window.ec.search(q);
      $('#radio-results').innerHTML = r.tracks.slice(0, 5).map((t) =>
        `<button class="pill" data-radio-track="${t.id}">${esc(t.title)} — ${esc(t.artist)}</button>`).join('') || '<p class="dim">No matches.</p>';
    });
    $('#radio-results').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-radio-track]');
      if (!btn) return;
      const tracks = await window.ec.trackRadio(Number(btn.dataset.radioTrack), state.familiarity);
      $('#radio-output').innerHTML = `<h3>Radio</h3>${trackRows(tracks, { showPlayAll: true })}`;
    });
  }

  async function renderHistory() {
    const range = state.historyRange;
    const totals = await window.ec.totals({ range });
    const top = await window.ec.top({ range, limit: 10 });
    const timeline = await window.ec.timeline({ range, query: state.historyQuery || '', limit: 300 });
    view.innerHTML = `<h2>History &amp; stats</h2>
      <div class="pill-row">${['week', 'month', 'year', 'all'].map((r) =>
        `<button class="pill ${range === r ? 'active' : ''}" data-hist-range="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
        <button id="btn-export-csv" class="pill">Export CSV</button>
        <button id="btn-export-json" class="pill">Export JSON</button></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${Math.round((totals.ms_listened || 0) / 60000)}</div><div class="stat-label">minutes listened</div></div>
        <div class="stat-card"><div class="stat-num">${totals.plays || 0}</div><div class="stat-label">plays</div></div>
        <div class="stat-card"><div class="stat-num">${totals.skips || 0}</div><div class="stat-label">skips</div></div>
      </div>
      <p class="dim small">Listening time counts only time you actually heard: pauses and seek jumps are excluded.
        A track you advance past before 30 seconds (and before its halfway point) counts as a skip; anything else is a play.
        Imported Spotify history is marked as such and reimporting the same export never double-counts.</p>
      <div class="card-row" style="align-items:flex-start">
        <div style="flex:1;min-width:260px"><h3>Top tracks</h3><table class="tracklist"><tbody>
          ${top.tracks.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.title)}</td><td class="dim">${esc(t.artist)}</td><td class="dim">${t.plays} plays</td></tr>`).join('') || '<tr><td class="dim">No plays in range</td></tr>'}</tbody></table></div>
        <div style="flex:1;min-width:260px"><h3>Top artists</h3><table class="tracklist"><tbody>
          ${top.artists.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.artist)}</td><td class="dim">${Math.round(t.ms / 60000)} min</td></tr>`).join('') || '<tr><td class="dim">No plays in range</td></tr>'}</tbody></table></div>
        <div style="flex:1;min-width:260px"><h3>Top albums</h3><table class="tracklist"><tbody>
          ${top.albums.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.album)}</td><td class="dim">${esc(t.artist)}</td><td class="dim">${Math.round(t.ms / 60000)} min</td></tr>`).join('') || '<tr><td class="dim">No plays in range</td></tr>'}</tbody></table></div>
      </div>
      <h3>Timeline</h3>
      <input type="text" id="hist-search" placeholder="Filter timeline..." value="${esc(state.historyQuery || '')}" style="width:100%;max-width:420px">
      <table class="tracklist"><thead><tr><th>When</th><th>Track</th><th>Artist</th><th>Listened</th><th></th><th>Source</th></tr></thead><tbody>
      ${timeline.map((r) => `<tr>
        <td class="dim small">${new Date(r.played_at).toLocaleString()}</td>
        <td>${esc(r.title)}</td><td class="dim">${esc(r.artist)}</td>
        <td class="dim">${Math.round(r.ms_listened / 1000)}s</td>
        <td>${r.skipped ? '<span class="dim small">skip</span>' : ''}${r.mode === 'video' ? ' &#127909;' : ''}</td>
        <td class="dim small">${r.source === 'spotify' ? 'Spotify import' : 'Echocellar'}</td>
      </tr>`).join('')}</tbody></table>`;
    $('#hist-search').addEventListener('input', (e) => {
      state.historyQuery = e.target.value;
      clearTimeout(renderHistory._t);
      renderHistory._t = setTimeout(renderHistory, 300);
    });
    $('#btn-export-csv').addEventListener('click', async () => {
      const r = await window.ec.exportHistory('csv');
      if (r) toast(`Exported ${r.rows} rows to ${r.path}`);
    });
    $('#btn-export-json').addEventListener('click', async () => {
      const r = await window.ec.exportHistory('json');
      if (r) toast(`Exported ${r.rows} rows to ${r.path}`);
    });
  }

  async function renderCatalog() {
    const cov = await window.ec.catalogCoverage();
    const mode = await window.ec.catalogGetMode();
    view.innerHTML = `<h2>Catalog</h2>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${cov.counts.artists || 0}</div><div class="stat-label">artists in catalog</div></div>
        <div class="stat-card"><div class="stat-num">${cov.counts.releases || 0}</div><div class="stat-label">releases</div></div>
        <div class="stat-card"><div class="stat-num">${cov.counts.tracks || 0}</div><div class="stat-label">tracks</div></div>
        <div class="stat-card"><div class="stat-num">${cov.owned_tracks || 0}</div><div class="stat-label">you have playable media</div></div>
      </div>
      <p class="dim small">Source: ${esc(cov.source || 'none')} · Last successful update: ${cov.last_successful_update ? new Date(cov.last_successful_update).toLocaleString() : 'never'}</p>
      <h3>Updates</h3>
      <div class="pill-row">${['weekly', 'monthly', 'manual', 'usb'].map((m) =>
        `<button class="pill ${mode === m ? 'active' : ''}" data-catalog-mode="${m}">${m === 'usb' ? 'USB / file' : m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
      <div class="pill-row">
        <button id="btn-catalog-import">Import dataset file</button>
        <input type="url" id="catalog-url" placeholder="Dataset URL (optional)" style="width:280px">
        <button id="btn-catalog-url">Update from URL</button>
      </div>
      <p class="dim small">Dataset imports are atomic: if a download or import is interrupted, your existing catalog stays exactly as it was. Your own edits are preserved across updates.</p>
      <h3>Browse</h3>
      <input type="text" id="catalog-search" placeholder="Search the catalog..." style="width:100%;max-width:420px">
      <div id="catalog-results"></div>`;
    document.querySelectorAll('[data-catalog-mode]').forEach((b) => b.addEventListener('click', async () => {
      await window.ec.catalogSetMode(b.dataset.catalogMode);
      toast(`Catalog updates: ${b.dataset.catalogMode}`);
      renderCatalog();
    }));
    $('#btn-catalog-import').addEventListener('click', async () => {
      const r = await window.ec.catalogImportFile();
      if (r) toast(`Catalog updated: ${r.artists} artists, ${r.releases} releases, ${r.tracks} tracks`);
      renderCatalog();
    });
    $('#btn-catalog-url').addEventListener('click', async () => {
      const url = $('#catalog-url').value.trim();
      if (!url) return toast('Enter a dataset URL first');
      toast('Downloading dataset...');
      const r = await window.ec.catalogUpdateFromUrl(url);
      if (r && r.error === 'offline') toast('You are offline. The existing catalog stays usable.');
      else if (r && r.error) toast('Update failed: ' + r.error);
      else if (r) toast(`Catalog updated: ${r.artists} artists, ${r.releases} releases, ${r.tracks} tracks`);
      renderCatalog();
    });
    $('#catalog-search').addEventListener('input', async (e) => {
      const q = e.target.value.trim();
      if (!q) { $('#catalog-results').innerHTML = ''; return; }
      const r = await window.ec.catalogSearch(q);
      let html = '';
      if (r.artists.length) html += `<h3>Artists</h3><div class="pill-row">${r.artists.map((a) =>
        `<button class="pill" data-catalog-artist="${esc(a.id)}">${esc(a.name)} (${a.releases})</button>`).join('')}</div>`;
      if (r.tracks.length) html += `<h3>Tracks</h3><table class="tracklist"><tbody>${r.tracks.map((t) => `
        <tr><td>${esc(t.title)}</td><td class="dim">${esc(t.artist || '')}</td><td class="dim">${esc(t.release || '')}</td>
        <td>${t.owned ? '<span class="codec-badge">in library</span>' : ''}</td>
        <td>${t.media_url ? `<button class="ghost small" data-save-media="${esc(t.id)}">Save locally</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
      if (!html) html = '<p class="dim">No catalog matches.</p>';
      $('#catalog-results').innerHTML = html;
    });
    $('#catalog-results').addEventListener('click', async (e) => {
      const a = e.target.closest('[data-catalog-artist]');
      const s = e.target.closest('[data-save-media]');
      if (a) {
        const data = await window.ec.catalogArtist(a.dataset.catalogArtist);
        if (!data) return;
        $('#catalog-results').innerHTML = `<h3>${esc(data.artist.name)}</h3>${data.releases.map((r) => `
          <h3>${esc(r.title)} <span class="dim small">${r.year || ''}</span></h3>
          <table class="tracklist"><tbody>${r.tracks.map((t) => `<tr>
            <td>${esc(t.title)}</td><td class="dim">${fmtDur(t.duration_ms)}</td>
            <td>${t.owned ? '<span class="codec-badge">in library</span>' : ''}</td>
            <td>${t.media_url ? `<button class="ghost small" data-save-media="${esc(t.id)}">Save locally</button>` : ''}</td>
          </tr>`).join('')}</tbody></table>`).join('')}`;
      } else if (s) {
        const r = await window.ec.catalogSaveMedia(s.dataset.saveMedia);
        if (r && r.error) toast(r.error === 'offline' ? 'You are offline.' : 'Could not save: ' + r.error);
        else toast('Saved to your library.');
      }
    });
  }

  async function renderSettings() {
    const s = await window.ec.settings();
    const info = await window.ec.appInfo();
    const watches = await window.ec.watchFolders();
    const review = await window.ec.spotifyReviewList();
    const dupes = await window.ec.duplicates();
    view.innerHTML = `<h2>Settings</h2>
      <h3>Import</h3>
      <div class="pill-row">
        <button class="pill ${s.import_mode === 'copy' ? 'active' : ''}" data-import-mode="copy">Copy into managed library</button>
        <button class="pill ${s.import_mode === 'reference' ? 'active' : ''}" data-import-mode="reference">Play from current location</button>
      </div>
      <p class="dim small">Copying never modifies or moves your original files.</p>
      <h3>Watched folders</h3>
      ${watches.length ? watches.map((w) => `<div class="pill-row"><span class="dim small">${esc(w.path)}</span>
        <button class="ghost small" data-unwatch="${esc(w.path)}">Remove</button></div>`).join('') : '<p class="dim small">None. Add one from the sidebar.</p>'}
      <h3>Library upkeep</h3>
      <div class="pill-row">
        <button id="btn-check-missing">Check for moved files</button>
        <button id="btn-relink">Relink a moved folder</button>
        <button id="btn-backup">Back up library database</button>
        <button id="btn-restore">Restore from backup</button>
      </div>
      <div id="dupe-section">${dupes.length ? `<h3>Possible duplicates (${dupes.length})</h3>
        <table class="tracklist"><tbody>${dupes.map((d) => `<tr>
          <td>${esc(d.title)}</td><td class="dim">${esc(d.artist)}</td><td class="dim small">${esc(d.path)}</td>
          <td><span class="codec-badge">${esc(d.codec)}</span></td></tr>`).join('')}</tbody></table>` : ''}</div>
      <h3>Match review ${review.length ? `(${review.length})` : ''}</h3>
      ${review.length ? review.map((r) => {
        const candidates = JSON.parse(r.candidates || '[]');
        return `<div class="review-item">
          <div><strong>${esc(r.req_title)}</strong> — ${esc(r.req_artist)} <span class="dim small">in ${esc(r.playlist)}</span></div>
          <div class="candidates">${candidates.map((c) => `
            <div class="candidate"><span>${esc(c.title)} — ${esc(c.artist)} <span class="dim small">${esc(c.album || '')} ${c.version_conflict ? '· differs: ' + c.version_conflict.join(', ') : ''}</span></span>
            <button class="small" data-resolve="${r.id}" data-track="${c.track_id}">Use this</button></div>`).join('')}
          <div class="candidate"><span class="dim">None of these</span><button class="small" data-resolve="${r.id}" data-track="">Keep missing</button></div></div>
        </div>`;
      }).join('') : '<p class="dim small">No ambiguous matches waiting.</p>'}
      <h3>About</h3>
      <p class="dim small">Echocellar ${info.version} · Library data: ${esc(info.home)}</p>`;
    document.querySelectorAll('[data-import-mode]').forEach((b) => b.addEventListener('click', async () => {
      await window.ec.setSetting('import_mode', b.dataset.importMode);
      renderSettings();
    }));
    $('#btn-check-missing').addEventListener('click', async () => {
      const r = await window.ec.refreshMissing();
      toast(r.relinked ? `Relinked ${r.relinked} moved files.` : r.missing ? `${r.missing} files are missing.` : 'All files found.');
    });
    $('#btn-relink').addEventListener('click', async () => {
      const oldRoot = prompt('Old folder path (as it was):');
      if (!oldRoot) return;
      const newRoot = prompt('New folder path:');
      if (!newRoot) return;
      const r = await window.ec.relinkFolder(oldRoot, newRoot);
      toast(`Relinked ${r.relinked} of ${r.total} tracks.`);
    });
    $('#btn-backup').addEventListener('click', async () => {
      const r = await window.ec.backup();
      if (r) toast('Backup saved to ' + r.path);
    });
    $('#btn-restore').addEventListener('click', async () => {
      const r = await window.ec.restore();
      if (r) toast('Backup restored. Restart Echocellar to load it.', 6000);
    });
    document.querySelectorAll('[data-unwatch]').forEach((b) => b.addEventListener('click', async () => {
      await window.ec.removeWatchFolder(b.dataset.unwatch);
      renderSettings();
    }));
    document.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
      await window.ec.spotifyResolve(Number(b.dataset.resolve), b.dataset.track ? Number(b.dataset.track) : null);
      toast('Match saved.');
      renderSettings();
    }));
  }

  async function renderReviewBadge() {
    const review = await window.ec.spotifyReviewList();
    const badge = $('#review-badge');
    if (review.length) {
      badge.textContent = `${review.length} match${review.length > 1 ? 'es' : ''} need your review`;
      badge.classList.remove('hidden');
    } else badge.classList.add('hidden');
  }
  $('#review-badge').addEventListener('click', () => show('settings'));

  // Broken cover art falls back to the logo (capture phase: img errors don't bubble).
  document.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' && !e.target.dataset.fbk) {
      e.target.dataset.fbk = '1';
      e.target.src = '../../assets/logo.svg';
    }
  }, true);

  // ---------- global click delegation ----------
  document.addEventListener('click', async (e) => {
    const trackCardEl = e.target.closest('[data-card-track]');
    if (trackCardEl && !trackCardEl.dataset.favArtist) {
      await Player.playQueue(JSON.parse(trackCardEl.dataset.cardQueue), 0);
      renderQueue();
      return;
    }
    const row = e.target.closest('tr.track-row');
    if (row && row.dataset.queueIds && !e.target.closest('button')) {
      if (row.dataset.missing) { toast('This song is not in your library yet.'); return; }
      const ids = JSON.parse(row.dataset.queueIds).filter(Boolean);
      await Player.playQueue(ids, Number(row.dataset.queueIndex));
      renderQueue();
      return;
    }
    const playAll = e.target.closest('[data-playall]');
    if (playAll) {
      const ids = JSON.parse(playAll.dataset.playall).filter(Boolean);
      if (ids.length) { await Player.playQueue(ids, 0); renderQueue(); }
      return;
    }
    const shuffleAll = e.target.closest('[data-shuffleall]');
    if (shuffleAll) {
      const ids = JSON.parse(shuffleAll.dataset.shuffleall).filter(Boolean);
      if (ids.length) { await Player.playQueue(ids, 0, { shuffle: true }); renderQueue(); }
      return;
    }
    const openArtist = e.target.closest('[data-open-artist]');
    if (openArtist) { state.artist = openArtist.dataset.openArtist; state.album = null; state.view = 'library'; await render(); return; }
    const card = e.target.closest('.card[data-album]');
    if (card) { state.album = { album: card.dataset.album, artist: card.dataset.artist }; state.artist = null; state.view = 'library'; await render(); return; }
    const openPlaylist = e.target.closest('[data-open-playlist]');
    if (openPlaylist) { state.playlistId = Number(openPlaylist.dataset.openPlaylist); state.view = 'playlists'; await render(); return; }
    const back = e.target.closest('[data-back]');
    if (back) { state.artist = null; state.album = null; state.playlistId = null; await render(); return; }
    const libTab = e.target.closest('[data-lib-tab]');
    if (libTab) { state.libraryTab = libTab.dataset.libTab; await render(); return; }
    const histRange = e.target.closest('[data-hist-range]');
    if (histRange) { state.historyRange = histRange.dataset.histRange; await render(); return; }
    const favArtist = e.target.closest('[data-fav-artist]');
    if (favArtist) {
      const tracks = await window.ec.artistRadio(favArtist.dataset.favArtist, state.familiarity);
      if (tracks.length) { await Player.playQueue(tracks.map((t) => t.id), 0, { shuffle: true }); toast(`Playing ${favArtist.dataset.favArtist} radio`); }
      return;
    }
    const removeEntry = e.target.closest('[data-remove-entry]');
    if (removeEntry) {
      await window.ec.removeEntry(Number(removeEntry.dataset.removeEntry));
      await render();
      return;
    }
    if (e.target.closest('#btn-del-playlist') && state.playlistId) {
      await window.ec.deletePlaylist(state.playlistId);
      state.playlistId = null;
      await render();
      return;
    }
    if (e.target.closest('#btn-new-playlist')) {
      const name = prompt('Playlist name:');
      if (name) { state.playlistId = await window.ec.createPlaylist(name); await render(); }
      return;
    }
    const radioArtist = e.target.closest('[data-radio-artist]');
    if (radioArtist) {
      const tracks = await window.ec.artistRadio(radioArtist.dataset.radioArtist, state.familiarity);
      if (tracks.length) { await Player.playQueue(tracks.map((t) => t.id), 0); renderQueue(); toast(`Playing ${radioArtist.dataset.radioArtist} radio`); }
      return;
    }
  });

  // ---------- playlist entry drag-reorder ----------
  function enableEntryDrag(playlistId) {
    let dragEntryId = null;
    view.querySelectorAll('tr[data-entry-id]').forEach((row) => {
      row.addEventListener('dragstart', () => { dragEntryId = Number(row.dataset.entryId); });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (dragEntryId == null) return;
        await window.ec.moveEntry(dragEntryId, Number(row.dataset.position));
        dragEntryId = null;
        await render();
      });
    });
  }

  // ---------- queue drawer ----------
  async function renderQueue() {
    const list = $('#queue-list');
    const ids = Player.queue.trackIds;
    const tracks = await Promise.all(ids.map((id) => window.ec.track(id)));
    list.innerHTML = tracks.map((t, i) => `
      <li class="${i === Player.queue.index ? 'current' : ''}" data-q-index="${i}" draggable="true">
        <span>${t ? esc(t.title) : '?'}</span><span class="q-artist">${t ? esc(t.artist) : ''}</span>
      </li>`).join('');
    list.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => { Player.jumpTo(Number(li.dataset.qIndex)); renderQueue(); });
      li.addEventListener('dragstart', () => { li.dataset.dragging = '1'; });
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = list.querySelector('[data-dragging="1"]');
        if (!from) return;
        Player.queue.move(Number(from.dataset.qIndex), Number(li.dataset.qIndex));
        delete from.dataset.dragging;
        Player._saveState();
        renderQueue();
      });
    });
  }

  // ---------- now playing bar ----------
  $('#btn-play').addEventListener('click', () => Player.togglePlay());
  $('#btn-next').addEventListener('click', () => { Player.next(true); renderQueue(); });
  $('#btn-prev').addEventListener('click', () => { Player.previous(); renderQueue(); });
  $('#btn-shuffle').addEventListener('click', () => Player.setShuffle(!Player.queue.shuffle));
  $('#btn-repeat').addEventListener('click', () => Player.cycleRepeat());
  $('#btn-av').addEventListener('click', () => Player.toggleAV());
  $('#btn-queue').addEventListener('click', () => { $('#queue-drawer').classList.toggle('hidden'); renderQueue(); });
  $('#queue-close').addEventListener('click', () => $('#queue-drawer').classList.add('hidden'));
  $('#np-progress').addEventListener('input', (e) => Player.seekTo(e.target.value / 1000));
  $('#np-volume').addEventListener('input', (e) => {
    document.getElementById('audio-el').volume = e.target.value / 100;
    document.getElementById('stage-video').volume = e.target.value / 100;
  });
  $('#btn-fav').addEventListener('click', async () => {
    if (!Player.currentTrack) return;
    const fav = await window.ec.toggleFavorite(Player.currentTrack.id);
    $('#btn-fav').innerHTML = fav ? '&#9829;' : '&#9825;';
  });
  $('#stage-close').addEventListener('click', () => {
    $('#stage').classList.add('hidden');
    if (Player.mode === 'video') Player.toggleAV(); // back to audio
  });
  $('#btn-lyrics').addEventListener('click', async () => {
    if (!Player.currentTrack) return;
    const stage = $('#stage');
    if (!stage.classList.contains('hidden') && Player.mode !== 'video') { stage.classList.add('hidden'); return; }
    const lyrics = await Player.loadLyrics();
    $('#stage-title').textContent = `${Player.currentTrack.title} — ${Player.currentTrack.artist}`;
    const box = $('#stage-lyrics');
    if (!lyrics) {
      box.innerHTML = '<p class="dim">No lyrics found for this track. Drop a .lrc or .txt file next to the audio file and reimport.</p>';
    } else if (lyrics.kind === 'timed') {
      box.innerHTML = lyrics.lines.map((l, i) =>
        `<div class="lrc-line" data-lrc-index="${i}" data-lrc-ms="${l.time_ms}">${esc(l.text)}</div>`).join('');
      box.querySelectorAll('.lrc-line').forEach((el) => el.addEventListener('click', () => {
        Player.el().currentTime = Number(el.dataset.lrcMs) / 1000;
      }));
      window.onLyricTick = (ms) => {
        const lines = Player.lyrics && Player.lyrics.lines;
        if (!lines) return;
        let idx = -1;
        for (let i = 0; i < lines.length; i++) { if (lines[i].time_ms <= ms) idx = i; else break; }
        box.querySelectorAll('.lrc-line').forEach((el, i) => el.classList.toggle('current', i === idx));
        const cur = box.querySelector('.lrc-line.current');
        if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
      };
    } else {
      box.innerHTML = `<div class="plain-lyrics">${esc(lyrics.text)}</div>`;
      window.onLyricTick = null;
    }
    stage.classList.remove('hidden');
  });

  Player.onTrackChange = async (track) => {
    renderQueue();
    if (track) {
      const favs = await window.ec.favorites();
      $('#btn-fav').innerHTML = favs.some((f) => f.id === track.id) ? '&#9829;' : '&#9825;';
      const stage = $('#stage');
      if (!stage.classList.contains('hidden') && Player.mode !== 'video') $('#btn-lyrics').click();
    }
  };

  // ---------- media keys + keyboard ----------
  window.ec.onMediaKey((key) => {
    if (key === 'play') Player.togglePlay();
    else if (key === 'next') Player.next(true);
    else if (key === 'previous') Player.previous();
    renderQueue();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const el = Player.el();
    switch (e.code) {
      case 'Space': e.preventDefault(); Player.togglePlay(); break;
      case 'ArrowRight': el.currentTime = Math.min((el.currentTime || 0) + (e.shiftKey ? 30 : 5), el.duration || 0); break;
      case 'ArrowLeft': el.currentTime = Math.max((el.currentTime || 0) - (e.shiftKey ? 30 : 5), 0); break;
      case 'ArrowUp': e.preventDefault(); $('#np-volume').value = Math.min(100, Number($('#np-volume').value) + 5); $('#np-volume').dispatchEvent(new Event('input')); break;
      case 'ArrowDown': e.preventDefault(); $('#np-volume').value = Math.max(0, Number($('#np-volume').value) - 5); $('#np-volume').dispatchEvent(new Event('input')); break;
      case 'KeyN': if (e.ctrlKey || e.metaKey) { e.preventDefault(); Player.next(true); } break;
      case 'KeyP': if (e.ctrlKey || e.metaKey) { e.preventDefault(); Player.previous(); } break;
      case 'KeyS': if (!e.ctrlKey && !e.metaKey) Player.setShuffle(!Player.queue.shuffle); break;
      case 'KeyR': Player.cycleRepeat(); break;
      case 'KeyL': $('#btn-lyrics').click(); break;
      case 'KeyQ': $('#btn-queue').click(); break;
      case 'KeyV': Player.toggleAV(); break;
      case 'KeyF': $('#btn-fav').click(); break;
    }
  });

  // ---------- import: buttons, drag-drop, paste ----------
  async function doImport(paths, mode) {
    if (!paths || !paths.length) return;
    toast(`Importing ${paths.length} item${paths.length > 1 ? 's' : ''}...`);
    const r = await window.ec.importPaths(paths, mode);
    let msg = [];
    if (r.import) msg.push(`${r.import.added} added, ${r.import.duplicate} duplicates, ${r.import.error} failed`);
    if (r.import && r.import.linked_missing) msg.push(`${r.import.linked_missing} missing playlist songs linked`);
    if (r.spotify) {
      const p = r.spotify.playlists.map((x) =>
        x.skipped === 'identical' ? `"${x.name}" unchanged` :
        `"${x.name}": ${x.matched} matched, ${x.review || 0} to review, ${x.missing} missing`).join('; ');
      if (p) msg.push(p);
      if (r.spotify.history.imported) msg.push(`${r.spotify.history.imported} Spotify history entries imported (${r.spotify.history.duplicates} duplicates skipped)`);
    }
    toast(msg.join(' · ') || 'Nothing to import', 6000);
    renderReviewBadge();
    render();
  }

  $('#btn-import-copy').addEventListener('click', async () => {
    const r = await window.ec.chooseImport('copy', 'files');
    if (r) { toast(`Imported: ${r.added} added, ${r.duplicate} duplicates`); renderReviewBadge(); render(); }
  });
  $('#btn-import-ref').addEventListener('click', async () => {
    const r = await window.ec.chooseImport('reference', 'files');
    if (r) { toast(`Imported: ${r.added} added, ${r.duplicate} duplicates`); renderReviewBadge(); render(); }
  });
  $('#btn-import-folder').addEventListener('click', async () => {
    const r = await window.ec.chooseImport(null, 'folder');
    if (r) { toast(`Imported: ${r.added} added, ${r.duplicate} duplicates`); renderReviewBadge(); render(); }
  });
  $('#btn-import-spotify').addEventListener('click', async () => {
    const r = await window.ec.spotifyImport();
    if (r) {
      const p = r.playlists.map((x) => x.skipped === 'identical' ? `"${x.name}" unchanged` :
        `"${x.name}": ${x.matched} matched, ${x.review || 0} to review, ${x.missing} missing`).join('; ');
      toast([p, r.history.imported ? `${r.history.imported} history entries (${r.history.duplicates} dups skipped)` : ''].filter(Boolean).join(' · '), 7000);
      renderReviewBadge();
      render();
    }
  });
  $('#btn-add-watch').addEventListener('click', async () => {
    const r = await window.ec.addWatchFolder();
    if (r) { toast(`Watching ${r.folder}: ${r.added} tracks imported`); render(); }
  });

  // Drag and drop files/folders anywhere in the window.
  window.addEventListener('dragover', (e) => { e.preventDefault(); $('#drop-hint').classList.remove('hidden'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#drop-hint').classList.add('hidden'); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    $('#drop-hint').classList.add('hidden');
    const paths = [];
    const items = e.dataTransfer.items;
    const entries = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    async function walkEntry(entry) {
      if (entry.isFile) {
        await new Promise((resolve) => entry.file((f) => { if (f.path) paths.push(f.path); resolve(); }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((resolve) => reader.readEntries(resolve));
          for (const child of batch) await walkEntry(child);
        } while (batch.length);
      }
    }
    if (entries.length) {
      for (const entry of entries) await walkEntry(entry);
    } else {
      for (const f of e.dataTransfer.files) if (f.path) paths.push(f.path);
    }
    if (paths.length) doImport(paths);
  });

  // Ctrl+V paste from Windows Explorer (or paths as text).
  document.addEventListener('paste', async (e) => {
    if (e.target.matches('input, textarea')) return;
    const paths = await window.ec.clipboardPaths();
    if (paths.length) doImport(paths);
  });

  // Live refresh when a watched folder imports new files.
  window.ec.onLibraryChanged(() => { renderReviewBadge(); render(); });

  // ---------- boot ----------
  (async function boot() {
    state.familiarity = await window.ec.getFamiliarity();
    await Player.restore();
    await render();
    await renderReviewBadge();
  })();
})();
