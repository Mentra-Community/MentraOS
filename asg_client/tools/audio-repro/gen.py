#!/usr/bin/env python3
"""Generate a concrete, replayable audio-repro sequence from a matrix and a seed.

Example:
    python3 gen.py --matrix matrices/m1.json --seed 1234 --blocks A --out sequences/m1-a-s1234.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio_repro.generator import generate, write  # noqa: E402
from audio_repro.sequence import sha256  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--matrix", required=True, type=Path)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--blocks", help="comma-separated block IDs (default: all, in matrix order)")
    parser.add_argument("--reps-scale", type=float, default=1.0, help="scale repetitions, e.g. 0.25 for a smoke run")
    parser.add_argument("--run-id", help="default: <matrix>-s<seed>")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    matrix_bytes = args.matrix.read_bytes()
    matrix = json.loads(matrix_bytes)
    blocks = [b for b in args.blocks.split(",") if b] if args.blocks else None
    sequence = generate(
        matrix,
        args.seed,
        blocks=blocks,
        reps_scale=args.reps_scale,
        run_id=args.run_id,
        matrix_sha=sha256(matrix_bytes),
    )
    digest = write(sequence, args.out)
    print(json.dumps({"out": str(args.out), "run_id": sequence["run_id"], "trials": len(sequence["trials"]), "sha256": digest}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
