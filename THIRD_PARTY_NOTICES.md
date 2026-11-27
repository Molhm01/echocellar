# Third-party notices

Echocellar is built from open-source components:

| Component | License | Purpose |
| --- | --- | --- |
| Electron | MIT | Desktop application shell (Chromium + Node.js) |
| Chromium (inside Electron) | BSD-3-Clause and others | UI, audio/video playback engine |
| sql.js | MIT | SQLite compiled to WebAssembly; local library database |
| music-metadata | MIT | Embedded tag and cover art reading |
| chokidar | MIT | Watched-folder monitoring |
| ffmpeg-static | MIT (bundles ffmpeg) | Lossless decode of ALAC and other codecs to PCM |
| ffmpeg | LGPL-2.1-or-later (bundled build) | Audio decoding; no part of ffmpeg is modified |

## Datasets

- The bundled starter catalog contains factual artist/release/track names
  compiled for this project.
- Optional full catalog datasets can be produced from the MusicBrainz database,
  which is available under CC0 (core data) and CC BY-SA / other licenses for
  some derived data. See https://musicbrainz.org/doc/About/Data_License before
  redistributing converted datasets. `tools/build-catalog-from-musicbrainz.py`
  converts a MusicBrainz JSON dump into Echocellar's dataset format.

## Media used in tests

All test fixtures are synthetic: sine-wave audio generated with ffmpeg and
programmatically drawn cover art. No copyrighted recordings, lyrics or artwork
are distributed with this project. Lyrics shown in the app always come from
your own files.
