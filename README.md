# Echocellar

An offline-first, open-source desktop music player for your personal collection.
Copy in music you own, bring over your Spotify playlists and listening history,
turn off Wi-Fi, and keep listening. No account, no subscription, no API keys,
no cloud service required.

## Features

- **Easy importing** — drag files or folders into the window, paste files copied
  in Windows Explorer with Ctrl+V, or add a watched folder that imports new
  music automatically. Choose whether files are copied into a managed library
  (your originals are never modified) or played in place. Embedded tags and
  cover art are read, duplicates are flagged, and moved folders can be relinked.
- **Spotify export import** — import the JSON files from your Spotify account
  data export: playlists (names, order, and intentional repeats preserved),
  saved tracks, and extended listening history. Entries are matched to your
  local files by artist, title, album and duration; ambiguous matches (live,
  remastered, clean/explicit versions) wait in a review queue for your call.
  Missing songs keep their playlist positions and turn playable automatically
  when you add the matching audio later. Reimporting the same export changes
  nothing.
- **A familiar player** — Home, Search, Library, Playlists, artist and album
  pages, a queue, and a persistent Now Playing bar. Instant search, drag to
  reorder, keyboard shortcuts and media keys. Your queue and playback position
  are restored when you reopen the app.
- **Playback** — play, pause, seek, next, previous, repeat-one, repeat-all, and
  shuffle. Shuffle plays every queued song once before reshuffling, keeps its
  order across pauses and restarts, and Previous retraces what you actually
  heard.
- **Lossless audio, video, lyrics** — FLAC, ALAC, WAV, MP3, AAC and Ogg Vorbis
  play natively (ALAC decodes losslessly to PCM through a bundled ffmpeg; your
  source files are never transcoded). The real codec, sample rate and bit
  depth are shown. Attach a local music video to a song and switch between
  audio and video in place, with a manual offset for videos with an intro;
  switching is one listening session. Embedded lyrics, plain-text and
  timestamped .lrc files are supported, with line highlighting and
  click-to-seek.
- **Offline recommendations** — Track Radio, Artist Radio, Similar Artists and
  a weekly mix, built locally from your listening history, favorites, skips,
  playlist co-occurrence and genres. A familiarity/discovery slider tunes how
  adventurous the mixes get. Songs your playlists reference but you don't own
  yet are listed separately in Discover.
- **Offline catalog** — a bundled starter catalog plus optional dataset
  imports (MusicBrainz-format JSONL; see `tools/build-catalog-from-musicbrainz.py`).
  Weekly, monthly, manual or USB/file updates. Imports are atomic: if a
  download or import is interrupted, the existing catalog stays usable and the
  update can resume. Your edits are preserved. Catalog entries show whether
  you have playable media, and entries with an authorized download can be
  saved straight into your library.
- **History and statistics** — a searchable timeline, minutes listened, top
  tracks/artists/albums by week, month, year or custom range. Only time you
  actually heard counts; pauses and seeks are excluded. A track you advance
  past before 30 seconds (and before its halfway point) is a skip. Export your
  history as CSV or JSON, and back up or restore the library database.

## Install (Windows)

Run `Echocellar Setup <version>.exe`, choose an install folder, and launch
Echocellar. Everything it needs is bundled in the installer.

## Build from source

Requires Node.js 20+ and npm.

```sh
npm install
npm start            # run the app
npm run test:unit    # core logic tests (matching, shuffle, import idempotency)
npm run test:e2e     # packaged-flow acceptance test (headless, uses fixtures)
npm run dist         # build the Windows NSIS installer into release/
```

To build the Windows installer on Linux, place a Windows ffmpeg binary at
`build/bin/win/ffmpeg.exe` first (the installer bundles it for ALAC playback):

```sh
curl -L https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-win32-x64.gz | gunzip > build/bin/win/ffmpeg.exe
chmod +x build/bin/win/ffmpeg.exe
```

## Test media and data

`scripts/make-fixtures.sh` generates synthetic, original test audio (sine-wave
recordings created with ffmpeg, no copyrighted material) and a fake Spotify
export used by the acceptance test.

## Layout

```
src/main.js        Electron main process: window, protocol, IPC, watchers
src/library.js     file import, tagging, dedupe, relink, watch
src/spotify.js     Spotify export parsing + matching  (src/lib/spotify.js)
src/lib/           pure logic: db, matcher, queue, recommendations, lyrics
src/renderer/      UI (HTML/CSS/JS, no build step)
test/              unit + end-to-end acceptance tests
scripts/           fixture generation
tools/             dataset tooling (MusicBrainz conversion)
```

## Privacy

Echocellar stores your library, playlists and listening history in a local
SQLite database on your computer. It makes no network requests in everyday
use; the only outbound requests are catalog dataset updates you ask for.
