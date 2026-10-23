#!/usr/bin/env python3
"""Run pairing-matrix cases from the CURRENT immutable harness snapshot.

    python3 run_case.py [--run x2] [--snapshot N] [--lane unit2] CASE [CASE ...]

Resolves runs/<run>/harness-snapshot-current (or --snapshot N), verifies the snapshot against its
manifest, then execs `cases.py --run <run> CASE...` from inside the snapshot directory
(cwd and PYTHONPATH = the snapshot; results and run.json stay in the live runs/<run>/).
cases.py writes runs/<run>/active.pid and refuses to start while it points at a live process.

Environment needed for device cases (cases.py refuses to start without it):
    PMX_PHONE_ADB    path to the S22's plain adb binary (phone commands use -s <S22 serial>)
    PMX_GLASSES_*    or runs/<run>/run.json glasses_name / glasses_code / glasses_mac
Glasses commands always go through the unit3 wrapper; ANDROID_SERIAL is removed.
Interpreter: PMX_PYTHON, else ~/.venvs/mentra-ble/bin/python when it exists (needs bleak), else this python.

--lane unit2 (or PMX_LANE=unit2) is opt-in: the same snapshot runs against the unit2 wrapper and the unit2 lab-units
guard, with run.json / active.pid / results.jsonl under runs/<run>/lanes/unit2/. It refuses a snapshot whose pmx.py does
not know lanes (it would silently drive unit3). Without a lane nothing below changes.

Stub only: keep this file tiny so editing it cannot change what a published snapshot does.
"""

import argparse
import os
import sys
from pathlib import Path

import ident
import snapshot

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.environ.get("PMX_RUN", "x2"))
    ap.add_argument("--snapshot", type=int, default=None)
    ap.add_argument("--lane", default=None, help="opt-in glasses lane (unit2); default is the unit3 path")
    ap.add_argument("cases", nargs="+")
    args = ap.parse_args()
    try:
        lane = ident.lane_of({"PMX_LANE": args.lane if args.lane is not None else os.environ.get("PMX_LANE", "")})
    except ident.LaneError as exc:
        raise SystemExit(str(exc))
    info = snapshot.verify(args.run, args.snapshot)
    if lane and not snapshot.supports_lane(info):
        raise SystemExit(f"snapshot {info['snapshot_id']} does not support --lane {lane}: publish a lane-aware snapshot first")
    snap_dir = Path(info["dir"])
    venv = Path.home() / ".venvs" / "mentra-ble" / "bin" / "python"
    py = os.environ.get("PMX_PYTHON") or (str(venv) if venv.exists() else sys.executable)
    env = dict(os.environ)
    env.pop("ANDROID_SERIAL", None)
    env["PMX_RUNS_DIR"] = str(snapshot.runs_dir())
    env["PMX_RUN"] = args.run
    run_arg = args.run
    if lane:
        run_arg = ident.lane_run_name(args.run, lane)  # runs/<run>/lanes/<lane>: own run.json, active.pid, results.jsonl
        env["PMX_LANE"] = lane
        env["PMX_RUN"] = run_arg
        for k in ("PMX_GLASSES_NAME", "PMX_GLASSES_CODE", "PMX_GLASSES_MAC", "PMX_UNIT3_CID"):
            env.pop(k, None)  # unit3 identity must not leak into the lane
    else:
        env.pop("PMX_LANE", None)
    env["PYTHONPATH"] = str(snap_dir)
    env["PYTHONDONTWRITEBYTECODE"] = "1"  # the snapshot dir is read-only and must stay byte-identical
    cmd = [py, "cases.py", "--run", run_arg, *args.cases]
    print(f"snapshot {info['snapshot_id']} manifest_sha256={info['manifest_sha256']}\n  cd {snap_dir} && {' '.join(cmd)}",
          flush=True)
    os.chdir(snap_dir)
    os.execve(py, cmd, env)


if __name__ == "__main__":
    main()
