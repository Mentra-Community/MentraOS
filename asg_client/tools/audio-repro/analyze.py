#!/usr/bin/env python3
"""Analyze an audio-repro run directory.

    python3 analyze.py run runs/m1-a-s1234-20260923T100000Z [--thresholds thresholds.json]
    python3 analyze.py stage0 runs/stage0-video-20260923T090000Z
    python3 analyze.py calibrate runs/<baseline-run> --cells off|cold --out thresholds.json

Outputs go to <run>/analysis/: cues.jsonl (one row per cue operation), summary.json and
summary.md (per-cell counts with Wilson 95% intervals), and evidence/<trial>-<op>/ bundles for
every suspect or indicator-only cue.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio_repro.analysis import DEFAULT_CUE, analyze_run, scan_stage0  # noqa: E402
from audio_repro.detectors import Thresholds  # noqa: E402


def _thresholds(path: str) -> Thresholds:
    return Thresholds.from_dict(json.loads(Path(path).read_text())) if path else Thresholds()


def calibrate(run_dir: Path, cells: list, out: Path) -> dict:
    """Baseline spread and false-event rate for the chosen cells, with suggested thresholds.

    Pitch and duration thresholds never go below the protocol defaults (2% and 3%); they widen
    only if the baseline itself is wider, and the report says so.
    """
    rows = [json.loads(line) for line in (run_dir / "analysis" / "cues.jsonl").read_text().splitlines()]
    base = [r for r in rows if r["target"] and r["cell"] in cells and r.get("metrics") and r["metrics"].get("found")]
    if not base:
        raise SystemExit("no baseline cues found; run `analyze.py run` first and check --cells")
    pitch = np.array([r["metrics"]["pitch_factor"] for r in base if r["metrics"]["pitch_factor"]])
    duration = np.array([r["metrics"]["duration_ratio"] for r in base if r["metrics"]["duration_ratio"]])
    defaults = Thresholds()
    pitch_spread = float(np.percentile(np.abs(pitch - np.median(pitch)), 99.9)) if len(pitch) else 0.0
    duration_spread = float(np.percentile(np.abs(duration - np.median(duration)), 99.9)) if len(duration) else 0.0
    event_rate = float(np.mean([bool(r["metrics"]["symptoms"]) for r in base]))
    suggested = dict(defaults.__dict__)
    suggested["pitch_deviation"] = max(defaults.pitch_deviation, 2 * pitch_spread)
    suggested["duration_deviation"] = max(defaults.duration_deviation, 2 * duration_spread)
    report = {
        "baseline_cells": cells,
        "baseline_cues": len(base),
        "pitch_median": float(np.median(pitch)) if len(pitch) else None,
        "pitch_p999_abs_dev": pitch_spread,
        "duration_median": float(np.median(duration)) if len(duration) else None,
        "duration_p999_abs_dev": duration_spread,
        "baseline_symptom_rate": event_rate,
        "warning": "baseline symptom rate above 1%: inspect before trusting detections" if event_rate > 0.01 else None,
        "thresholds": suggested,
    }
    out.write_text(json.dumps(suggested, indent=2))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("run_dir", type=Path)
    run.add_argument("--thresholds", default="")
    run.add_argument("--cue", type=Path, default=DEFAULT_CUE)
    stage0 = sub.add_parser("stage0")
    stage0.add_argument("run_dir", type=Path)
    stage0.add_argument("--thresholds", default="")
    stage0.add_argument("--cue", type=Path, default=DEFAULT_CUE)
    stage0.add_argument("--window-s", type=float, default=15.0)
    cal = sub.add_parser("calibrate")
    cal.add_argument("run_dir", type=Path)
    cal.add_argument("--cells", default="off|cold", help="comma-separated baseline cells")
    cal.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    if args.command == "run":
        summary = analyze_run(args.run_dir, args.cue, _thresholds(args.thresholds))
        print((args.run_dir / "analysis" / "summary.md").read_text())
        print(json.dumps({"cues": summary["cues"], "clock_mapping": summary["clock_mapping"]}))
    elif args.command == "stage0":
        print(json.dumps(scan_stage0(args.run_dir, args.cue, _thresholds(args.thresholds), args.window_s), indent=2))
    else:
        print(json.dumps(calibrate(args.run_dir, [c for c in args.cells.split(",") if c], args.out), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
