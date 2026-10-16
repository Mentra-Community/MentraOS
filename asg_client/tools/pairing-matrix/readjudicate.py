#!/usr/bin/env python3
"""Offline re-adjudication of ONE assertion ("R15 4b previous owner removed (R4)") from an existing case dir.

    python3 readjudicate.py runs/x2/<case dir> [--dry-run]

Reads the case dir's bes_trace.txt and the case's row in <runs>/results.jsonl. It never touches hardware, never
edits results.jsonl or the case dir, and appends one row to <runs>/readjudications.jsonl:

    {"case": ..., "status": "PASS"|"OPEN", "readjudicated": true,
     "reason": "harness proof rule fix (snapshot 4)", "original_status": "OPEN", ...}

Only a case whose ONLY gap/failure is that assertion is eligible; PASS requires the BES owner-record proof
(owner_lost.owner_removal_transitions: pre-entry own>=1, then st=PAIRING own=0/0 with a greater window generation).
The newest transition in the trace is used. Anything else prints why and writes nothing.
Run it from the published snapshot (`runs/x2/harness-snapshot-4/readjudicate.py`) so the rule is the hashed one.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import owner_lost

HERE = Path(__file__).resolve().parent
GAP_NAME = "R15 4b previous owner removed (R4)"
REASON = "harness proof rule fix (snapshot 4)"


def load_rows(path: Path) -> list:
    rows = []
    if path.is_file():
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def original_row(case_dir: Path, rows: list) -> dict | None:
    case = case_dir.name.split("__rerun")[0]
    by_dir = [r for r in rows if r.get("dir") and Path(r["dir"]).resolve() == case_dir.resolve()]
    if by_dir:
        return by_dir[-1]
    same = [r for r in rows if r.get("case") == case]
    return same[-1] if same else None


def snapshot_ident() -> dict:
    m = HERE / "manifest.json"
    if not m.is_file():
        return {"tool_snapshot_id": None, "tool_manifest_sha256": None}
    raw = m.read_bytes()
    return {"tool_snapshot_id": json.loads(raw).get("snapshot_id"), "tool_manifest_sha256": hashlib.sha256(raw).hexdigest()}


def adjudicate(case_dir: Path) -> tuple:
    """(row_or_None, message). row is None when the case is not eligible."""
    runs = case_dir.resolve().parent
    rows = load_rows(runs / "results.jsonl")
    orig = original_row(case_dir, rows)
    if orig is None:
        return None, f"no result row for {case_dir.name} in {runs / 'results.jsonl'}"
    failed = [c["check"] for c in orig.get("checks", []) if not c.get("ok")]
    gaps = [g.get("gap") for g in orig.get("gaps", [])]
    if orig.get("status") != "OPEN":
        return None, f"original status is {orig.get('status')}, only OPEN cases are re-adjudicated"
    if failed or gaps != [GAP_NAME]:
        return None, f"not eligible: failed checks {failed}, gaps {gaps} (only the single gap {GAP_NAME!r} may remain)"
    trace = case_dir / "bes_trace.txt"
    if not trace.is_file():
        return None, f"{trace} missing"
    lines = trace.read_text().splitlines()
    proof_pair = owner_lost.owner_removal_proof(lines, None, newest=True)  # same code as the live path
    transitions = [proof_pair] if proof_pair else []
    base = {
        "case": orig.get("case"), "dir": str(case_dir), "readjudicated": True, "reason": REASON,
        "original_status": orig.get("status"), "original_snapshot_id": orig.get("snapshot_id"),
        "original_manifest_sha256": orig.get("manifest_sha256"), "assertion": GAP_NAME,
        "t": time.strftime("%H:%M:%S"), **snapshot_ident(),
    }
    if not transitions:
        base.update(status="OPEN", evidence=[], detail="no BES owner-record transition (own>=1 -> PAIRING own=0/0, greater generation)")
        return base, "GAP: the BES trace has no pre-entry own>=1 line followed by a st=PAIRING own=0/0 line of a greater generation"
    pre, proof = transitions[0]
    base.update(status="PASS", evidence=[pre, proof],
                detail="BES owner record: previous owner own>=1, then st=PAIRING own=0/0 with a greater window generation")
    return base, f"PASS: previous owner removed\n  before: {pre}\n  after : {proof}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("case_dir")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    case_dir = Path(args.case_dir)
    if not case_dir.is_dir():
        sys.exit(f"not a case dir: {case_dir}")
    row, msg = adjudicate(case_dir)
    print(msg)
    if row is None:
        sys.exit(1)
    out = case_dir.resolve().parent / "readjudications.jsonl"
    prior = load_rows(out)
    if any(r.get("dir") == row["dir"] and r.get("status") == row["status"] and r.get("assertion") == GAP_NAME for r in prior):
        print(f"already recorded in {out}; nothing appended")
        return
    if args.dry_run:
        print("dry run: nothing written")
        return
    with open(out, "a") as fh:
        fh.write(json.dumps(row) + "\n")
    print(f"appended {row['status']} row to {out}")


if __name__ == "__main__":
    main()
