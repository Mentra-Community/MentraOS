#!/usr/bin/env python3
"""Blinded listening labels for detector validation and confirmation.

    python3 label.py export runs/<run> --seed 7 --normals-per-suspect 1
        -> runs/<run>/labels/clips/clip_0001.wav ..., labels.csv (fill in), key.json (do not open)
    python3 label.py import runs/<run>
        -> marks listener-agreed suspects as confirmed and reports detector agreement

Clips mix every suspect with randomly chosen normal cues in shuffled order, so the listener does
not know which clips the detectors flagged. A cue is confirmed only when the detectors flagged
it and the listener heard low pitch or pops.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio_repro.analysis import render_summary, summarize, load_events  # noqa: E402
from audio_repro.wavio import read_wav, write_wav  # noqa: E402

COLUMNS = ["clip", "low_pitch", "pops", "other", "notes"]


def _rows(run_dir: Path):
    return [json.loads(line) for line in (run_dir / "analysis" / "cues.jsonl").read_text().splitlines()]


def export(run_dir: Path, seed: int, normals_per_suspect: float, lead_s: float, tail_s: float) -> dict:
    rows = _rows(run_dir)
    suspects = [r for r in rows if r.get("outcome") == "suspect" and r.get("onset_s") is not None]
    normals = [r for r in rows if r.get("outcome") == "normal" and r.get("onset_s") is not None]
    rng = random.Random(seed)
    count = min(len(normals), max(1, int(round(len(suspects) * normals_per_suspect)))) if normals else 0
    chosen = suspects + rng.sample(normals, count)
    rng.shuffle(chosen)
    recording, rate = read_wav(run_dir / "recording.wav")
    folder = run_dir / "labels"
    (folder / "clips").mkdir(parents=True, exist_ok=True)
    key = {}
    for index, row in enumerate(chosen, 1):
        name = f"clip_{index:04d}.wav"
        start = max(0, int((row["onset_s"] - lead_s) * rate))
        write_wav(folder / "clips" / name, recording[start:int((row["onset_s"] + tail_s) * rate)], rate)
        key[name] = {"trial": row["trial"], "op": row["op"], "detector": row["outcome"]}
    (folder / "key.json").write_text(json.dumps(key, indent=2))
    with (folder / "labels.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(COLUMNS)
        for name in sorted(key):
            writer.writerow([name, "", "", "", ""])
    return {"clips": len(key), "suspects": len(suspects), "normals": count, "folder": str(folder)}


def _yes(value: str) -> bool:
    return value.strip().lower() in ("y", "yes", "1", "true", "x")


def import_labels(run_dir: Path) -> dict:
    folder = run_dir / "labels"
    key = json.loads((folder / "key.json").read_text())
    labels = {}
    with (folder / "labels.csv").open() as handle:
        for row in csv.DictReader(handle):
            if row["clip"] in key and any(row[c].strip() for c in ("low_pitch", "pops", "other")):
                labels[row["clip"]] = row
    tp = fp = tn = fn = 0
    by_cue = {}
    for clip, row in labels.items():
        entry = key[clip]
        heard = _yes(row["low_pitch"]) or _yes(row["pops"])
        flagged = entry["detector"] == "suspect"
        tp += flagged and heard
        fp += flagged and not heard
        fn += (not flagged) and heard
        tn += (not flagged) and not heard
        by_cue[(entry["trial"], entry["op"])] = {"heard": heard, "low_pitch": _yes(row["low_pitch"]),
                                                "pops": _yes(row["pops"]), "other": row["other"], "notes": row["notes"]}
    rows = _rows(run_dir)
    for row in rows:
        label = by_cue.get((row["trial"], row["op"]))
        if label is None:
            continue
        row["listener"] = label
        row["label_confirmed"] = row.get("outcome") == "suspect" and label["heard"]
        if row["label_confirmed"]:
            row["outcome"] = "confirmed"
    with (run_dir / "analysis" / "cues.jsonl").open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    summary = summarize(rows, load_events(run_dir / "device" / "events.jsonl"))
    (run_dir / "analysis" / "summary-labeled.md").write_text(render_summary(summary))
    agreement = {
        "labeled": len(labels),
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "true_negative": tn,
        "sensitivity": tp / (tp + fn) if tp + fn else None,
        "specificity": tn / (tn + fp) if tn + fp else None,
    }
    (run_dir / "analysis" / "label-agreement.json").write_text(json.dumps(agreement, indent=2))
    return agreement


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    exp = sub.add_parser("export")
    exp.add_argument("run_dir", type=Path)
    exp.add_argument("--seed", type=int, default=7)
    exp.add_argument("--normals-per-suspect", type=float, default=1.0)
    exp.add_argument("--lead-s", type=float, default=0.3)
    exp.add_argument("--tail-s", type=float, default=1.2)
    imp = sub.add_parser("import")
    imp.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    if args.command == "export":
        print(json.dumps(export(args.run_dir, args.seed, args.normals_per_suspect, args.lead_s, args.tail_s), indent=2))
    else:
        print(json.dumps(import_labels(args.run_dir), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
