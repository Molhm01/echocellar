'use strict';
// Mobile import pipeline: picked files -> app storage -> tags -> library rows.
// Files are copied into the app's private storage (managed mode), so the
// library stays playable even if the originals move or the phone is offline.

const util = require('../../src/lib/util');
const { bytesToBase64 } = require('./b64');

const AUDIO_EXT = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wav', 'webm']);

async function importFiles(db, fileList, onProgress) {
  const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
  const mm = require('music-metadata-browser');
  const files = Array.from(fileList || []);
  let imported = 0;
  const skippedUnsupported = [];
  const duplicates = [];
  const errors = [];

  await Filesystem.mkdir({ path: 'music', directory: Directory.Data, recursive: true }).catch(() => {});
  await Filesystem.mkdir({ path: 'art', directory: Directory.Data, recursive: true }).catch(() => {});

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onProgress) onProgress(i + 1, files.length, f.name);
    try {
      const ext = util.extOf(f.name).replace('.', '').toLowerCase();
      if (!AUDIO_EXT.has(ext)) { skippedUnsupported.push(f.name + ' (not audio)'); continue; }

      const buf = new Uint8Array(await f.arrayBuffer());
      const sha1 = util.sha1String(buf);
      const existing = db.get('SELECT id FROM tracks WHERE sha1 = ?', [sha1]);
      if (existing) { duplicates.push(f.name); continue; }

      let meta = null;
      try {
        meta = await mm.parseBlob(new Blob([buf]), { duration: true });
      } catch (e) { /* untagged or odd container: import with filename title */ }

      const fmt = meta && meta.format || {};
      const common = meta && meta.common || {};
      const codec = (fmt.codec || fmt.container || ext).toString();
      if (/alac/i.test(codec)) {
        skippedUnsupported.push(f.name + ' (ALAC not playable on Android yet)');
        continue;
      }

      const relPath = 'music/' + sha1 + '.' + ext;
      await Filesystem.writeFile({ path: relPath, directory: Directory.Data, data: bytesToBase64(buf), encoding: Encoding.Base64 });

      const title = (common.title || f.name.replace(/\.[^.]+$/, '')).trim();
      const artist = (common.artist || (common.artists && common.artists[0]) || 'Unknown Artist').trim();
      const album = (common.album || '').trim();
      const albumArtist = (common.albumartist || '').trim();

      const id = db.exec(
        `INSERT INTO tracks (path, managed, title, artist, album, album_artist, genre, year, track_no, disc_no,
                             duration_ms, codec, sample_rate, bit_depth, bitrate, size, mtime, sha1, added_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [relPath, title, artist, album, albumArtist,
         (common.genre && common.genre[0]) || null, common.year || null,
         common.track && common.track.no || null, common.disk && common.disk.no || null,
         fmt.duration ? Math.round(fmt.duration * 1000) : null,
         codec, fmt.sampleRate || null, fmt.bitsPerSample || null,
         fmt.bitrate ? Math.round(fmt.bitrate) : null, buf.length, Date.now(), sha1, Date.now(), Date.now()]
      );

      // Embedded cover art -> art/<id>.<ext>
      const pic = common.picture && common.picture[0];
      if (pic && pic.data && id) {
        const picExt = /png/i.test(pic.format || '') ? 'png' : 'jpg';
        const artRel = 'art/' + id + '.' + picExt;
        const picBytes = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data);
        await Filesystem.writeFile({ path: artRel, directory: Directory.Data, data: bytesToBase64(picBytes), encoding: Encoding.Base64 });
        db.exec('UPDATE tracks SET art_path = ? WHERE id = ?', [artRel, id]);
      }
      imported++;
    } catch (e) {
      errors.push(f.name + ': ' + String(e && e.message || e));
    }
  }
  return { imported, skippedUnsupported, duplicates, errors };
}

module.exports = { importFiles };
