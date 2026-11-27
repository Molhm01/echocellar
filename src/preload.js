'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ec', {
  // library
  importPaths: (paths, mode) => invoke('library:importPaths', paths, mode),
  chooseImport: (mode, kind) => invoke('library:chooseImport', mode, kind),
  tracks: (q) => invoke('library:tracks', q),
  artists: () => invoke('library:artists'),
  albums: () => invoke('library:albums'),
  albumTracks: (album, artist) => invoke('library:albumTracks', album, artist),
  artistTracks: (artist) => invoke('library:artistTracks', artist),
  duplicates: () => invoke('library:duplicates'),
  refreshMissing: () => invoke('library:refreshMissing'),
  relinkFolder: (oldRoot, newRoot) => invoke('library:relinkFolder', oldRoot, newRoot),
  watchFolders: () => invoke('library:watchFolders'),
  addWatchFolder: () => invoke('library:addWatchFolder'),
  removeWatchFolder: (p) => invoke('library:removeWatchFolder', p),
  attachVideo: (trackId, offsetMs) => invoke('library:attachVideo', trackId, offsetMs),
  setVideoOffset: (trackId, offsetMs) => invoke('library:setVideoOffset', trackId, offsetMs),
  toggleFavorite: (trackId) => invoke('library:toggleFavorite', trackId),
  favorites: () => invoke('library:favorites'),
  track: (id) => invoke('library:track', id),
  recentTracks: (limit) => invoke('library:recentTracks', limit),

  // spotify
  spotifyImport: () => invoke('spotify:import'),
  spotifyReviewList: () => invoke('spotify:reviewList'),
  spotifyResolve: (entryId, trackId) => invoke('spotify:resolve', entryId, trackId),

  // playlists
  playlists: () => invoke('playlists:list'),
  playlistEntries: (id) => invoke('playlists:entries', id),
  createPlaylist: (name) => invoke('playlists:create', name),
  renamePlaylist: (id, name) => invoke('playlists:rename', id, name),
  deletePlaylist: (id) => invoke('playlists:delete', id),
  addToPlaylist: (id, trackIds) => invoke('playlists:add', id, trackIds),
  removeEntry: (entryId) => invoke('playlists:removeEntry', entryId),
  moveEntry: (entryId, newPosition) => invoke('playlists:moveEntry', entryId, newPosition),

  // playback
  recordSession: (s) => invoke('playback:recordSession', s),
  savePlaybackState: (state) => invoke('playback:saveState', state),
  restorePlaybackState: () => invoke('playback:restoreState'),
  onMediaKey: (fn) => ipcRenderer.on('media-key', (_e, k) => fn(k)),

  // lyrics
  lyrics: (trackId) => invoke('lyrics:get', trackId),

  // search
  search: (q) => invoke('search:instant', q),

  // recs
  recsHome: (familiarity) => invoke('recs:home', familiarity),
  trackRadio: (id, familiarity) => invoke('recs:trackRadio', id, familiarity),
  artistRadio: (name, familiarity) => invoke('recs:artistRadio', name, familiarity),
  similarArtists: (name) => invoke('recs:similarArtists', name),
  discovery: () => invoke('recs:discovery'),
  getFamiliarity: () => invoke('recs:getFamiliarity'),
  setFamiliarity: (v) => invoke('recs:setFamiliarity', v),

  // catalog
  catalogCoverage: () => invoke('catalog:coverage'),
  catalogSearch: (q) => invoke('catalog:search', q),
  catalogArtist: (id) => invoke('catalog:artist', id),
  catalogImportFile: () => invoke('catalog:importFile'),
  catalogUpdateFromUrl: (url) => invoke('catalog:updateFromUrl', url),
  catalogSetMode: (mode) => invoke('catalog:setMode', mode),
  catalogGetMode: () => invoke('catalog:getMode'),
  catalogSaveMedia: (trackId) => invoke('catalog:saveMedia', trackId),
  catalogEdit: (entity, id, patch) => invoke('catalog:edit', entity, id, patch),

  // stats
  timeline: (opts) => invoke('stats:timeline', opts),
  totals: (opts) => invoke('stats:totals', opts),
  top: (opts) => invoke('stats:top', opts),
  exportHistory: (format) => invoke('stats:export', format),

  clipboardPaths: () => invoke('clipboard:paths'),
  onLibraryChanged: (fn) => ipcRenderer.on('library-changed', () => fn()),

  // app
  settings: () => invoke('app:settings'),
  setSetting: (k, v) => invoke('app:setSetting', k, v),
  backup: () => invoke('app:backup'),
  restore: () => invoke('app:restore'),
  appInfo: () => invoke('app:info'),

  // test hooks (only present when launched with ECHOCELLAR_TEST=1)
  test: {
    state: () => invoke('test:state'),
    importPathsSync: (paths, mode) => invoke('test:importPathsSync', paths, mode),
    spotifyImportPaths: (paths) => invoke('test:spotifyImportPaths', paths),
    setOnline: (v) => invoke('test:setOnline', v),
    attachVideo: (trackId, videoPath, offsetMs) => invoke('test:attachVideo', trackId, videoPath, offsetMs),
  },
});
