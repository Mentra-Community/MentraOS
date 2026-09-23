#!/usr/bin/env python3
"""Run an audio-repro sequence on one Mentra Live, or a host-only Stage 0 real-flow block.

Sequence run (requires the harness-enabled, release-signed ASG build and authorization to
install it):

    python3 run.py sequence --transport-id 3 --expect-cid <CID> \
        --sequence sequences/m1-a-s1234.json --out runs/ --mic "UMIK-1 @1.5cm, jig A"

Stage 0 (no install; real recording or stream start through existing commands):

    python3 run.py stage0 --transport-id 3 --flow video --count 30 --out runs/

Control an active run:

    python3 run.py control --transport-id 3 pause|resume|abort|status
"""

from __future__ import annotations

import argparse
import json
import platform
import queue
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio_repro.device import (  # noqa: E402
    Device,
    DeviceError,
    audio_flinger_standby,
    check_identity,
    collect_provenance,
    snapshot,
)
from audio_repro.logcat import LogcatFollower  # noqa: E402
from audio_repro.recorder import Recorder  # noqa: E402
from audio_repro.sequence import canonical_bytes, sha256, validate_sequence  # noqa: E402

PROBE_REMOTE = "/data/local/tmp/audio_probe.sh"
PROBE_OUT = "/data/local/tmp/audio_probe.txt"


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _device(args: argparse.Namespace) -> Device:
    return Device(serial=args.serial, transport_id=args.transport_id, adb=args.adb, package=args.package)


def _preflight(device: Device, args: argparse.Namespace, out: Path) -> Dict[str, Any]:
    info = collect_provenance(device)
    problems = check_identity(info, args.expect_serial, args.expect_cid, args.expect_mtk_version)
    (out / "provenance.json").write_text(json.dumps(info, indent=2, sort_keys=True))
    if problems and not args.allow_identity_mismatch:
        raise DeviceError("identity check failed: " + "; ".join(problems))
    return info


def _start_recorder(args: argparse.Namespace, out: Path) -> Optional[Recorder]:
    if args.no_audio:
        return None
    recorder = Recorder(out / "recording.wav", rate=args.record_rate, channels=args.record_channels, command=args.record_cmd)
    recorder.start()
    return recorder


def _start_probe(device: Device, period: float) -> None:
    device.push(Path(__file__).resolve().parent / "device" / "audio_probe.sh", PROBE_REMOTE)
    device.shell(f"rm -f {PROBE_OUT}; nohup sh {PROBE_REMOTE} {PROBE_OUT} {period} >/dev/null 2>&1 &")


def _stop_probe(device: Device, out: Path) -> None:
    device.shell("touch /data/local/tmp/audio_probe.stop")
    time.sleep(0.5)
    try:
        device.pull(PROBE_OUT, out / "audio_probe.txt")
    except DeviceError as error:
        print(f"warning: probe pull failed: {error}", file=sys.stderr)


def _verify_standby_and_signal(device: Device, key: str, timeout_s: float, log: Path) -> None:
    """Poll dumpsys until every AudioFlinger output is in standby, then release the wait op."""
    started = time.monotonic()
    verified = False
    polls = 0
    last: Optional[bool] = None
    while time.monotonic() - started < timeout_s:
        polls += 1
        last = audio_flinger_standby(device.shell("dumpsys media.audio_flinger", timeout=30))
        if last:
            verified = True
            break
        time.sleep(0.25)
    waited_ms = int((time.monotonic() - started) * 1000)
    fields = {"verified": verified, "source": "dumpsys", "waited_ms": waited_ms, "polls": polls}
    if last is None:
        fields["reason"] = "no_standby_lines"
    device.send_command({"type": "audio_repro_signal", "key": key, "fields": fields})
    with log.open("a") as handle:
        handle.write(json.dumps({"host_ns": time.monotonic_ns(), "signal": key, **fields}) + "\n")


def run_sequence(args: argparse.Namespace) -> int:
    sequence = json.loads(Path(args.sequence).read_text())
    errors = validate_sequence(sequence)
    if errors:
        print("invalid sequence:\n" + "\n".join(errors), file=sys.stderr)
        return 2
    data = canonical_bytes(sequence)
    run_id = sequence["run_id"]
    out = Path(args.out) / f"{run_id}-{_utc_stamp()}"
    out.mkdir(parents=True, exist_ok=False)
    (out / "sequence.json").write_bytes(data)
    trials = sequence["trials"]
    last_in_block = {trial["id"] for trial, nxt in zip(trials, trials[1:] + [None]) if nxt is None or nxt["block"] != trial["block"]}

    device = _device(args)
    provenance = _preflight(device, args, out)
    device.enable_gate()
    remote_sequence = f"{device.harness_root}/sequences/{run_id}.json"
    device.push(out / "sequence.json", remote_sequence)

    follower = LogcatFollower(device.base(), out / "logcat.txt", out / "host_sync.jsonl")
    follower.start()
    recorder = _start_recorder(args, out)
    if args.probe:
        _start_probe(device, args.probe_period)
    started_wall = datetime.now(timezone.utc).isoformat()
    snapshots: List[Dict[str, str]] = [snapshot(device, out / "snapshots", "run-start", not args.no_tinymix)]
    device.send_command({"type": "audio_repro_run", "sequence_path": f"sequences/{run_id}.json"})

    outcome = "timeout"
    deadline = time.monotonic() + args.timeout_s
    signals_log = out / "host_signals.jsonl"
    try:
        while time.monotonic() < deadline:
            try:
                line = follower.lines.get(timeout=1.0)
            except queue.Empty:
                continue
            run_field = line.fields.get("run")
            if line.kind == "run_rejected" or line.kind == "refused":
                print(f"device rejected the run: {line.text}", file=sys.stderr)
                outcome = "rejected"
                break
            if run_field and run_field != run_id:
                continue
            if line.kind == "await":
                key = line.fields.get("key", "")
                threading.Thread(
                    target=_verify_standby_and_signal,
                    args=(device, key, args.standby_timeout_s, signals_log),
                    daemon=True,
                ).start()
            elif line.kind == "trial_end":
                trial_id = line.fields.get("trial", "")
                print(f"{trial_id}: {line.fields.get('outcome')} {line.fields.get('flags', '')}", flush=True)
                if trial_id in last_in_block:
                    device.send_command({"type": "audio_repro_pause"})
                    snapshots.append(snapshot(device, out / "snapshots", f"after-{trial_id}", not args.no_tinymix))
                    device.send_command({"type": "audio_repro_resume"})
            elif line.kind == "run_done":
                outcome = line.fields.get("reason", "done")
                break
    except KeyboardInterrupt:
        device.send_command({"type": "audio_repro_abort"})
        outcome = "interrupted"
        time.sleep(3)
    finally:
        snapshots.append(snapshot(device, out / "snapshots", "run-end", not args.no_tinymix))
        if args.probe:
            _stop_probe(device, out)
        if recorder:
            recorder.stop()
        time.sleep(1)
        follower.stop()
        try:
            device.pull(f"{device.harness_root}/runs/{run_id}", out / "device")
        except DeviceError as error:
            print(f"warning: device pull failed: {error}", file=sys.stderr)
        if not args.keep_gate:
            device.disable_gate()

    run_json = {
        "run_id": run_id,
        "kind": "sequence",
        "outcome": outcome,
        "sequence_sha256": sha256(data),
        "seed": sequence.get("seed"),
        "generator": sequence.get("generator"),
        "instrumentation_level": "L1" if args.probe else "L0",
        "provenance": provenance,
        "acoustic": {**(recorder.describe() if recorder else {"disabled": True}), "setup": args.mic},
        "host": {"platform": platform.platform(), "python": platform.python_version()},
        "started_utc": started_wall,
        "ended_utc": datetime.now(timezone.utc).isoformat(),
        "snapshots": snapshots,
        "notes": args.notes,
    }
    (out / "run.json").write_text(json.dumps(run_json, indent=2, sort_keys=True))
    print(json.dumps({"out": str(out), "outcome": outcome}))
    return 0 if outcome == "completed" else 1


def _flow_commands(args: argparse.Namespace, index: int) -> tuple:
    request_id = f"stage0-{index:03d}"
    if args.flow == "video":
        start = {"type": "start_video_recording", "requestId": request_id, "sound": True}
        stop = {"type": "stop_video_recording", "requestId": request_id}
    else:
        if not args.stream_url:
            raise SystemExit("--stream-url is required for stream flows")
        start = {"type": "start_stream", "streamUrl": args.stream_url, "requestId": request_id}
        stop = {"type": "stop_stream", "requestId": request_id}
    return start, stop


def run_stage0(args: argparse.Namespace) -> int:
    run_id = f"stage0-{args.flow}-{_utc_stamp()}"
    out = Path(args.out) / run_id
    out.mkdir(parents=True, exist_ok=False)
    device = _device(args)
    provenance = _preflight(device, args, out)
    follower = LogcatFollower(device.base(), out / "logcat.txt", out / "host_sync.jsonl")
    follower.start()
    recorder = _start_recorder(args, out)
    if args.probe:
        _start_probe(device, args.probe_period)
    events = (out / "host_events.jsonl").open("a")

    def note(kind: str, **fields: Any) -> None:
        events.write(json.dumps({"host_ns": time.monotonic_ns(), "kind": kind, **fields}) + "\n")
        events.flush()

    try:
        for index in range(args.count):
            start, stop = _flow_commands(args, index)
            note("flow_start", index=index, command=start)
            device.send_command(start)
            time.sleep(args.hold_s)
            note("flow_stop", index=index, command=stop)
            device.send_command(stop)
            time.sleep(args.gap_s)
            if args.bes_logs:
                # One immediate mh_logs poll through the existing debug receiver, outside audio.
                note("bes_log_pull", index=index)
                device.shell("am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled true --ei interval_ms 60000")
                time.sleep(4)
                device.shell("am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled false")
            if args.snapshot_every and (index + 1) % args.snapshot_every == 0:
                snapshot(device, out / "snapshots", f"after-{index:03d}", not args.no_tinymix)
            print(f"stage0 {args.flow} {index + 1}/{args.count}", flush=True)
    finally:
        if args.probe:
            _stop_probe(device, out)
        if recorder:
            recorder.stop()
        time.sleep(1)
        follower.stop()
        events.close()

    run_json = {
        "run_id": run_id,
        "kind": "stage0",
        "flow": args.flow,
        "count": args.count,
        "hold_s": args.hold_s,
        "gap_s": args.gap_s,
        "instrumentation_level": "L1" if args.probe else "L0",
        "provenance": provenance,
        "acoustic": {**(recorder.describe() if recorder else {"disabled": True}), "setup": args.mic},
        "notes": args.notes,
    }
    (out / "run.json").write_text(json.dumps(run_json, indent=2, sort_keys=True))
    print(json.dumps({"out": str(out)}))
    return 0


def run_control(args: argparse.Namespace) -> int:
    device = _device(args)
    payload: Dict[str, Any] = {"type": f"audio_repro_{args.action}"}
    if args.action == "signal":
        payload["key"] = args.key
    print(device.send_command(payload).strip())
    return 0


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--transport-id", help="adb transport ID (preferred; see `adb devices -l`)")
    parser.add_argument("--serial", help="adb serial; the placeholder 0123456789ABCDEF is not unique")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--package", default="com.mentra.asg_client")


def _add_run_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--out", default="runs")
    parser.add_argument("--expect-serial")
    parser.add_argument("--expect-cid", help="required when the serial is the placeholder")
    parser.add_argument("--expect-mtk-version")
    parser.add_argument("--allow-identity-mismatch", action="store_true")
    parser.add_argument("--no-audio", action="store_true", help="skip acoustic recording (not for symptom runs)")
    parser.add_argument("--record-cmd", help="template with {rate} {channels} {out}")
    parser.add_argument("--record-rate", type=int, default=48000)
    parser.add_argument("--record-channels", type=int, default=1)
    parser.add_argument("--mic", default="", help="acoustic setup: microphone, distance, jig, room")
    parser.add_argument("--probe", action="store_true", help="instrumentation level L1: /proc/asound probe")
    parser.add_argument("--probe-period", type=float, default=0.02)
    parser.add_argument("--no-tinymix", action="store_true")
    parser.add_argument("--notes", default="")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    seq = sub.add_parser("sequence", help="run a generated sequence through the device harness")
    _add_common(seq)
    _add_run_options(seq)
    seq.add_argument("--sequence", required=True)
    seq.add_argument("--timeout-s", type=float, default=6 * 3600)
    seq.add_argument("--standby-timeout-s", type=float, default=20.0)
    seq.add_argument("--keep-gate", action="store_true")

    stage0 = sub.add_parser("stage0", help="host-only real-flow block (no harness install)")
    _add_common(stage0)
    _add_run_options(stage0)
    stage0.add_argument("--flow", choices=["video", "rtmp", "whip"], required=True)
    stage0.add_argument("--stream-url")
    stage0.add_argument("--count", type=int, default=30)
    stage0.add_argument("--hold-s", type=float, default=4.0)
    stage0.add_argument("--gap-s", type=float, default=6.0)
    stage0.add_argument("--bes-logs", action="store_true", help="pull BES trace after each flow, outside audio")
    stage0.add_argument("--snapshot-every", type=int, default=10)

    control = sub.add_parser("control", help="pause/resume/abort/status/signal an active run")
    _add_common(control)
    control.add_argument("action", choices=["pause", "resume", "abort", "status", "signal"])
    control.add_argument("--key", help="for signal, e.g. w0.satisfied")

    args = parser.parse_args()
    try:
        if args.command == "sequence":
            return run_sequence(args)
        if args.command == "stage0":
            return run_stage0(args)
        return run_control(args)
    except DeviceError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
