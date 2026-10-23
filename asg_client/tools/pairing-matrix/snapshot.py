#!/usr/bin/env python3
"""Immutable harness snapshots for the pairing matrix.

    python3 snapshot.py publish [--run x2]    copy the harness files to runs/<run>/harness-snapshot-<n>/
    python3 snapshot.py verify  [N] [--run x2]  re-hash a snapshot against its manifest (default: current)
    python3 snapshot.py current [--run x2]    print the current snapshot id, dir and manifest sha256

A snapshot holds the harness .py files plus manifest.json:
    {"snapshot_id": n, "created": ..., "files": {"pmx.py": "<sha256>", ...}}
Files are made read-only. `runs/<run>/harness-snapshot-current` names the current id; each case runs
from that directory (run_case.py), so later edits to the live files cannot change its imports or
subprocesses. Results record the snapshot id and the sha256 of manifest.json.
Publish between cases only. Old snapshots are never modified or deleted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Harness modules that a case imports or spawns. Tests, snapshot.py and run_case.py stay outside.
HARNESS_FILES = ("ident.py", "pmx.py", "ios.py", "owner_lost.py", "readjudicate.py", "cases.py", "mac_central.py", "ble_scan.py", "watch.py")
PROTECTED = re.compile(r"^(x1|baseline|m\d+)$")


def runs_dir() -> Path:
    return Path(os.environ.get("PMX_RUNS_DIR") or (HERE / "runs"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot_dirs(run_dir: Path) -> dict:
    out = {}
    for d in run_dir.glob("harness-snapshot-*"):
        m = re.fullmatch(r"harness-snapshot-(\d+)", d.name)
        if m and d.is_dir():
            out[int(m.group(1))] = d
    return out


def current_id(run_dir: Path) -> int | None:
    f = run_dir / "harness-snapshot-current"
    try:
        return int(f.read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def publish(run: str) -> dict:
    if PROTECTED.match(run):
        raise SystemExit(f"refusing to publish into old evidence run {run!r}")
    run_dir = runs_dir() / run
    run_dir.mkdir(parents=True, exist_ok=True)
    missing = [f for f in HARNESS_FILES if not (HERE / f).is_file()]
    if missing:
        raise SystemExit(f"harness files missing: {missing}")
    existing = snapshot_dirs(run_dir)
    n = (max(existing) + 1) if existing else 1
    dest = run_dir / f"harness-snapshot-{n}"
    dest.mkdir()
    files = {}
    for name in HARNESS_FILES:
        data = (HERE / name).read_bytes()
        (dest / name).write_bytes(data)
        files[name] = hashlib.sha256(data).hexdigest()
    manifest = {
        "snapshot_id": n,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source_dir": str(HERE),
        "files": files,
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    for f in dest.iterdir():
        f.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    dest.chmod(stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    tmp = run_dir / "harness-snapshot-current.tmp"
    tmp.write_text(f"{n}\n")
    tmp.replace(run_dir / "harness-snapshot-current")
    return {"snapshot_id": n, "dir": str(dest), "manifest_sha256": sha256_file(dest / "manifest.json")}


def verify(run: str, n: int | None = None) -> dict:
    run_dir = runs_dir() / run
    n = n if n is not None else current_id(run_dir)
    if n is None:
        raise SystemExit(f"no current snapshot for run {run!r}")
    dest = run_dir / f"harness-snapshot-{n}"
    manifest_path = dest / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"snapshot {n} has no manifest.json at {dest}")
    manifest = json.loads(manifest_path.read_text())
    bad = []
    for name, want in manifest["files"].items():
        f = dest / name
        if not f.is_file() or sha256_file(f) != want:
            bad.append(name)
    extra = sorted(p.name for p in dest.iterdir() if p.name not in manifest["files"] and p.name != "manifest.json"
                   and p.name != "__pycache__")
    if bad or extra:
        raise SystemExit(f"snapshot {n} does not match its manifest: changed/missing={bad} unexpected={extra}")
    return {"snapshot_id": n, "dir": str(dest), "manifest_sha256": sha256_file(manifest_path), "files": len(manifest["files"])}


def supports_lane(info: dict) -> bool:
    """True when the snapshot's own pmx.py/ident.py understand PMX_LANE. An older snapshot (e.g. 10) does not, and
    would silently route a lane run to unit3, so a lane run must refuse it."""
    snap = Path(info["dir"])
    try:
        return all("PMX_LANE" in (snap / n).read_text() for n in ("pmx.py", "ident.py")) and \
            "assert_lane_unit" in (snap / "pmx.py").read_text()
    except OSError:
        return False


def current(run: str) -> dict:
    run_dir = runs_dir() / run
    n = current_id(run_dir)
    if n is None:
        raise SystemExit(f"no current snapshot for run {run!r}")
    dest = run_dir / f"harness-snapshot-{n}"
    return {"snapshot_id": n, "dir": str(dest), "manifest_sha256": sha256_file(dest / "manifest.json")}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["publish", "verify", "current"])
    ap.add_argument("n", nargs="?", type=int)
    ap.add_argument("--run", default=os.environ.get("PMX_RUN", "x2"))
    args = ap.parse_args()
    if args.cmd == "publish":
        out = publish(args.run)
    elif args.cmd == "verify":
        out = verify(args.run, args.n)
    else:
        out = current(args.run)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    sys.exit(main())
