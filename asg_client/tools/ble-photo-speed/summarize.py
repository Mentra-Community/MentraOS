#!/usr/bin/env python3
"""Summarize BLE photo speed runs: per-cell table, speed floor, limiting leg.

Usage:
  python3 summarize.py [RUN_DIR_OR_RUNS_ROOT ...] [--json] [--exclude-b]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blespeed.report import build_report, load_runs, render_text  # noqa: E402
from blespeed.results import ResultsFormatError  # noqa: E402
from blespeed.stats import FLOOR_MARGIN, FLOOR_STEP_KBPS  # noqa: E402

DEFAULT_RUNS = Path(__file__).resolve().parent / "runs"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="*", type=Path, default=[DEFAULT_RUNS],
                        help="run directories, or a directory containing them (default: runs/)")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--exclude-b", action="store_true",
                        help="leave condition B (backgrounded, screen locked) out of the floor")
    parser.add_argument("--margin", type=float, default=FLOOR_MARGIN)
    parser.add_argument("--step", type=int, default=FLOOR_STEP_KBPS)
    args = parser.parse_args(argv)
    try:
        runs = load_runs(args.paths)
    except ResultsFormatError as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
    report = build_report(runs, exclude_b=args.exclude_b, margin=args.margin, step=args.step)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        sys.stdout.write(render_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
