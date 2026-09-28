#!/usr/bin/env python3
"""Run one BLE photo speed cell: N sequential photos from Mentra Live to one phone.

Example:
  python3 run_cell.py --phone iphone15 --phone-os ios --phone-udid <UDID> \
      --condition A --size medium --count 10 --glasses-serial <SERIAL>

Needs an ASG build with AsgConstants.ENABLE_PHOTO_TIMING_LOGS = true.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blespeed import adbio  # noqa: E402
from blespeed.outcome import TrackerConfig  # noqa: E402
from blespeed.session import (  # noqa: E402
    CONDITIONS,
    PHONE_OSES,
    REQUIRED_BAUD,
    SIZES,
    CellConfig,
    CellSession,
    dry_run_commands,
    format_command,
)

DEFAULT_RUNS = Path(__file__).resolve().parent / "runs"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--phone", required=True, help="phone label, e.g. iphone15 or pixel8")
    p.add_argument("--phone-os", required=True, choices=PHONE_OSES)
    p.add_argument("--condition", required=True, choices=CONDITIONS)
    p.add_argument("--size", required=True, choices=SIZES)
    p.add_argument("--count", type=int, default=10, help="measured photos (default 10)")
    p.add_argument("--glasses-serial", help="glasses adb serial (required if >1 adb device)")
    p.add_argument("--phone-serial", help="Android phone adb serial, for phone log capture")
    p.add_argument("--phone-udid", help="iPhone UDID, for idevicesyslog capture")
    p.add_argument("--no-warmup", action="store_true", help="skip the discarded warm-up photo")
    p.add_argument("--no-disconnect-wifi", action="store_true",
                   help="do not send disconnect_wifi before the cell")
    p.add_argument("--wait-transport", type=float, default=0.0, metavar="SECONDS",
                   help="wait up to SECONDS for the phone log to show L2CAP open or GATT")
    p.add_argument("--allow-unknown-baud", action="store_true",
                   help="continue when the glasses log has no UART baud line")
    p.add_argument("--required-baud", type=int, default=REQUIRED_BAUD)
    p.add_argument("--timeout", type=float, default=60.0, help="per-attempt timeout (s)")
    p.add_argument("--settle", type=float, default=2.0, help="pause between photos (s)")
    p.add_argument("--busy-retry-delay", type=float, default=2.0)
    p.add_argument("--max-busy-retries", type=int, default=5)
    p.add_argument("--bes-fw", help="override BES firmware version for provenance")
    p.add_argument("--app-build", help="Mentra App build for provenance")
    p.add_argument("--asg-commit", help="ASG commit the installed APK was built from")
    p.add_argument("--notes", default="")
    p.add_argument("--out", type=Path, default=DEFAULT_RUNS, help="runs root (default: runs/)")
    p.add_argument("--run-id", help="override the run directory name")
    p.add_argument("--dry-run", action="store_true", help="print commands without running adb")
    return p


def config_from_args(args: argparse.Namespace) -> CellConfig:
    return CellConfig(
        phone=args.phone, phone_os=args.phone_os, condition=args.condition, size=args.size,
        out_root=args.out, count=args.count, glasses_serial=args.glasses_serial,
        phone_serial=args.phone_serial, phone_udid=args.phone_udid,
        warmup=not args.no_warmup, disconnect_wifi=not args.no_disconnect_wifi,
        wait_transport_s=args.wait_transport, allow_unknown_baud=args.allow_unknown_baud,
        required_baud=args.required_baud, settle_s=args.settle,
        tracker=TrackerConfig(timeout_s=args.timeout, busy_retry_delay_s=args.busy_retry_delay,
                              max_busy_retries=args.max_busy_retries),
        bes_fw=args.bes_fw, app_build=args.app_build, asg_commit=args.asg_commit,
        notes=args.notes, run_id=args.run_id,
    )


def main(argv: Optional[List[str]] = None, runner: Optional[adbio.ProcessRunner] = None,
         clock=None, id_gen=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = config_from_args(args)
        config.validate()
    except ValueError as e:
        print("error: %s" % e, file=sys.stderr)
        return 2
    if args.dry_run:
        for command in dry_run_commands(config, id_gen or adbio.BleImgIdGenerator()):
            print(format_command(command))
        return 0
    session = CellSession(config, runner or adbio.SubprocessRunner(), clock=clock, id_gen=id_gen)
    try:
        result = session.run()
    except FileExistsError as e:
        print("error: run directory already exists: %s" % e.filename, file=sys.stderr)
        return 2
    finished = sum(1 for r in result.rows if r.outcome == "finished" and not r.warmup)
    measured = sum(1 for r in result.rows if not r.warmup)
    print("Run directory: %s" % result.run_dir)
    print("Measured photos finished: %d/%d" % (finished, measured))
    return 1 if result.aborted else 0


if __name__ == "__main__":
    sys.exit(main())
