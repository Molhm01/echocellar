#!/usr/bin/env bash
# Generate synthetic, original test media (sine tones + drawn cover art) and a
# fake Spotify export. No copyrighted material is used.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=test/fixtures
MUSIC="$OUT/music/Aurora Fields/Night Lines"
MUSIC2="$OUT/music/Copper Veins/Ash & Iron"
EXTRA="$OUT/extra"
rm -rf "$OUT"
mkdir -p "$MUSIC" "$MUSIC2" "$EXTRA" "$OUT/spotify"

python3 - <<'PYEOF'
from PIL import Image, ImageDraw
for name, c1, c2 in [("cover-night-lines.png", (255,140,59), (34,26,21)),
                     ("cover-ash-iron.png", (120,180,255), (20,24,34))]:
    img = Image.new('RGB', (300, 300), c2)
    d = ImageDraw.Draw(img)
    for i in range(0, 300, 6):
        t = i / 300
        d.line([(0, i), (300, i)], fill=tuple(int(a+(b-a)*t) for a, b in zip(c2, c1)))
    d.ellipse([90, 90, 210, 210], outline=(255, 255, 255), width=6)
    img.save(f"test/fixtures/{name}")
PYEOF

tone() { # freq dur outfile extra...
  local freq="$1" dur="$2" out="$3"; shift 3
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=${freq}:duration=${dur}" "$@" "$out"
}

# Aurora Fields — Night Lines (2024)
tone 220 30 /tmp/emberline.wav -ar 44100 -ac 2
ffmpeg -hide_banner -loglevel error -y -i /tmp/emberline.wav -i test/fixtures/cover-night-lines.png \
  -map 0:a -map 1:v -c:a flac -c:v png -disposition:v attached_pic \
  -metadata title="Emberline" -metadata artist="Aurora Fields" -metadata album="Night Lines" \
  -metadata album_artist="Aurora Fields" -metadata date="2024" -metadata track="1" -metadata genre="Ambient" \
  "$MUSIC/01 Emberline.flac"

tone 330 24 /tmp/glass.wav -ar 44100 -ac 2
ffmpeg -hide_banner -loglevel error -y -i /tmp/glass.wav -i test/fixtures/cover-night-lines.png \
  -map 0:a -map 1:v -c:a libmp3lame -q:a 2 -c:v png -disposition:v attached_pic \
  -id3v2_version 3 \
  -metadata title="Glass Roads" -metadata artist="Aurora Fields" -metadata album="Night Lines" \
  -metadata date="2024" -metadata track="2" -metadata genre="Ambient" \
  "$MUSIC/02 Glass Roads.mp3"
cat > "$MUSIC/02 Glass Roads.txt" <<'LRC'
Streetlight on the river
We take the long way home
Every window glowing
Glass roads, glass roads
LRC

tone 262 22 /tmp/harbor.wav -ar 44100 -ac 2
ffmpeg -hide_banner -loglevel error -y -i /tmp/harbor.wav \
  -c:a libvorbis -q:a 5 \
  -metadata title="Harbor Lights (Live)" -metadata artist="Aurora Fields" -metadata album="Night Lines" \
  -metadata date="2024" -metadata track="3" -metadata genre="Ambient" \
  "$MUSIC/03 Harbor Lights (Live).ogg"

cat > "$MUSIC/01 Emberline.lrc" <<'LRC'
[00:00.50]Sparks along the wire
[00:03.00]Hum of the street below
[00:06.00]Everything is quiet
[00:09.00]Emberline, emberline
[00:12.00]Hold the night a little longer
[00:15.00]Let the embers glow
[00:18.00]Sparks along the wire
[00:21.00]Emberline, emberline
LRC

# Video for Emberline: 5s intro + same tone
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x14100e:size=640x360:duration=35:rate=24" \
  -f lavfi -i "sine=frequency=110:duration=5" \
  -f lavfi -i "sine=frequency=220:duration=30" \
  -filter_complex "[1:a][2:a]concat=n=2:v=0:a=1[a]" \
  -map 0:v -map "[a]" -c:v libx264 -preset veryfast -crf 30 -c:a aac -shortest \
  "test/fixtures/Emberline (video).mp4"

# Copper Veins — Ash & Iron (2023)
tone 175 26 /tmp/iron.wav -ar 44100 -ac 2
cp /tmp/iron.wav "$MUSIC2/01 Iron Rain.wav"
python3 - <<'PYEOF'
# minimal WAV LIST INFO tags are not worth it; the importer falls back to filename
PYEOF

tone 392 28 /tmp/blue.wav -ar 48000 -ac 2
ffmpeg -hide_banner -loglevel error -y -i /tmp/blue.wav -af aformat=sample_fmts=s32:channel_layouts=stereo -ar 48000 \
  -c:a alac \
  -metadata title="Blue Static (Remaster)" -metadata artist="Copper Veins" -metadata album="Ash & Iron" \
  -metadata date="2023" -metadata track="2" -metadata genre="Electronic" \
  "$MUSIC2/02 Blue Static (Remaster).m4a"

# The "missing" song, added later during the acceptance test
tone 494 21 /tmp/midnight.wav -ar 44100 -ac 2
ffmpeg -hide_banner -loglevel error -y -i /tmp/midnight.wav \
  -c:a flac \
  -metadata title="Midnight Sun" -metadata artist="Polar Coast" -metadata album="Cold Front" \
  -metadata date="2025" -metadata track="1" -metadata genre="Ambient" \
  "$EXTRA/Polar Coast - Midnight Sun.flac"

# Fake Spotify export
cat > "$OUT/spotify/Playlist1.json" <<'JSON'
[
  {
    "name": "Late Drive",
    "lastModifiedDate": "2026-11-20",
    "items": [
      { "track": { "trackName": "Emberline", "artistName": "Aurora Fields", "albumName": "Night Lines", "trackUri": "spotify:track:EMBERLINE001", "durationMs": 30000 } },
      { "track": { "trackName": "Midnight Sun", "artistName": "Polar Coast", "albumName": "Cold Front", "trackUri": "spotify:track:MIDSUN0001", "durationMs": 21000 } },
      { "track": { "trackName": "Emberline", "artistName": "Aurora Fields", "albumName": "Night Lines", "trackUri": "spotify:track:EMBERLINE001", "durationMs": 30000 } }
    ]
  }
]
JSON
cat > "$OUT/spotify/StreamingHistory_music_0.json" <<'JSON'
[
  { "ts": "2026-10-01T20:00:00Z", "master_metadata_track_name": "Emberline", "master_metadata_album_artist_name": "Aurora Fields", "master_metadata_album_album_name": "Night Lines", "spotify_track_uri": "spotify:track:EMBERLINE001", "ms_played": 28000 },
  { "ts": "2026-10-02T21:00:00Z", "master_metadata_track_name": "Glass Roads", "master_metadata_album_artist_name": "Aurora Fields", "master_metadata_album_album_name": "Night Lines", "spotify_track_uri": "spotify:track:GLASSROADS1", "ms_played": 22000 },
  { "ts": "2026-10-03T18:30:00Z", "master_metadata_track_name": "Midnight Sun", "master_metadata_album_artist_name": "Polar Coast", "master_metadata_album_album_name": "Cold Front", "spotify_track_uri": "spotify:track:MIDSUN0001", "ms_played": 20000 }
]
JSON

echo "fixtures ready:"
find "$OUT" -type f | sort
