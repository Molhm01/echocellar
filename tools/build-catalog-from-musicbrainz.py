#!/usr/bin/env python3
"""Convert MusicBrainz JSON dumps into an Echocellar catalog dataset (.jsonl).

MusicBrainz publishes database dumps at https://metabrainz.org/supporters/account-type
and ftp://ftp.musicbrainz.org/pub/musicbrainz/data/json-dumps/ as JSON-lines
files (one entity per line) inside tar archives: mbdump/artist, mbdump/release,
mbdump/recording etc. Extract the archive, then run:

    python3 tools/build-catalog-from-musicbrainz.py \
        --artist mbdump/artist --release mbdump/release --recording mbdump/recording \
        --out catalog-full.jsonl

The output file is what Echocellar imports (Catalog view -> Import dataset
file, or host it and use Update from URL). Expect the full dataset to be large:
the MusicBrainz dumps are tens of gigabytes compressed, and the converted
JSONL will be similar in scale. Echocellar shows the download/disk estimate
before importing.

License note: MusicBrainz core data is CC0; some derived data is CC BY-SA.
Check https://musicbrainz.org/doc/About/Data_License before redistributing.
"""
import argparse
import json
import sys


def emit(out, rec):
    out.write(json.dumps(rec, separators=(",", ":")) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--artist", help="path to mbdump/artist JSONL")
    ap.add_argument("--release", help="path to mbdump/release JSONL")
    ap.add_argument("--recording", help="path to mbdump/recording JSONL")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    counts = {"artists": 0, "releases": 0, "tracks": 0}
    with open(args.out, "w") as out:
        if args.artist:
            with open(args.artist) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        a = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    emit(out, {
                        "type": "artist",
                        "id": "mb-" + a["id"],
                        "name": a.get("name"),
                        "sort_name": a.get("sort-name"),
                        "country": a.get("country"),
                        "begin": (a.get("life-span") or {}).get("begin"),
                    })
                    counts["artists"] += 1
        if args.release:
            with open(args.release) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    credit = (r.get("artist-credit") or [{}])[0]
                    year = (r.get("date") or "")[:4] or None
                    emit(out, {
                        "type": "release",
                        "id": "mb-" + r["id"],
                        "artist_id": "mb-" + credit.get("id", ""),
                        "title": r.get("title"),
                        "year": int(year) if year and year.isdigit() else None,
                        "release_type": (r.get("release-group") or {}).get("primary-type"),
                    })
                    counts["releases"] += 1
        if args.recording:
            with open(args.recording) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        t = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    emit(out, {
                        "type": "track",
                        "id": "mb-" + t["id"],
                        "release_id": None,  # recording->release links live in mbdump/track
                        "title": t.get("title"),
                        "duration_ms": t.get("length"),
                        "position": None,
                        "media_url": None,
                    })
                    counts["tracks"] += 1
    json.dump(counts, sys.stderr)
    sys.stderr.write("\n")


if __name__ == "__main__":
    main()
