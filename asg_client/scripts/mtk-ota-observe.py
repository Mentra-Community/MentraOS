#!/usr/bin/env python3
"""Observe one MTK OTA and its target boot; never dispatch or reboot a device."""
import argparse
from contextlib import suppress
import math
import os
import re
import selectors
import signal
import subprocess
import time


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError("OTA observation deadline expired; do not resend the update")
    return value


def stop_reader(process):
    if process.poll() is None:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    process.wait()
    if process.stdout:
        process.stdout.close()


def read_device(deadline, *args):
    remaining(deadline)
    process = subprocess.Popen(["adb", "shell", *args], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        try:
            output, _ = process.communicate(timeout=min(5, remaining(deadline)))
        except subprocess.TimeoutExpired:
            stop_reader(process)
            remaining(deadline)
            return ""
        remaining(deadline)  # A late result cannot qualify a completed boot.
        return output.decode("utf8", errors="replace").strip() if process.returncode == 0 else ""
    finally:
        stop_reader(process)


def verify_target_boot(deadline, source_boot, source_cid, target_version, target_slot):
    while True:
        boot = read_device(deadline, "cat", "/proc/sys/kernel/random/boot_id")
        if boot and boot != source_boot and read_device(deadline, "getprop", "sys.boot_completed") == "1":
            version = read_device(deadline, "getprop", "ro.custom.ota.version")
            slot = read_device(deadline, "getprop", "ro.boot.slot_suffix")
            cid = read_device(deadline, "cat", "/sys/block/mmcblk0/device/cid")
            if version and slot and cid:
                if cid != source_cid:
                    raise ValueError("Different eMMC identity after reboot")
                if version != target_version:
                    raise ValueError(f"Postboot firmware is {version}, expected {target_version}")
                if slot != target_slot:
                    raise ValueError(f"Postboot slot is {slot}, expected {target_slot}")
                closing_boot = read_device(deadline, "cat", "/proc/sys/kernel/random/boot_id")
                if closing_boot:
                    if closing_boot != boot:
                        raise ValueError("Boot changed during target verification")
                    remaining(deadline)
                    print("✅ Verified target MTK on the new boot and slot.", flush=True)
                    return
        time.sleep(min(1, remaining(deadline)))


def observe(source_boot, source_cid, target_version, target_slot, timeout=900, activity_timeout=15):
    deadline = time.monotonic() + timeout
    activity_deadline = time.monotonic() + activity_timeout
    saw_activity = False
    last_download = last_install = -1
    process = subprocess.Popen(["adb", "logcat", "-v", "time"], stdout=subprocess.PIPE,
                               start_new_session=True)
    pending = b""
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            finished = False
            while not finished:
                budget = remaining(deadline)
                if not saw_activity and time.monotonic() >= activity_deadline:
                    return 3
                if not saw_activity:
                    budget = min(budget, max(0, activity_deadline - time.monotonic()))
                if not selector.select(min(1, budget)):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    print("ℹ️  Log stream closed. Checking the target boot without resending OTA...", flush=True)
                    break
                pending += chunk
                if len(pending) > 256 * 1024:
                    raise ValueError("Oversized logcat line")
                lines = pending.split(b"\n")
                pending = lines.pop()
                for raw in lines:
                    remaining(deadline)
                    line = raw.decode("utf8", errors="replace")
                    if "OtaHelper not initialized - is OtaService running?" in line:
                        return 2
                    if any(message in line for message in ("Failed to download MTK firmware", "MTK firmware verification failed", "MTK OTA error:")):
                        raise ValueError(line.strip())
                    if '"type":"mtk_update_complete"' in line or "MTK OTA success:" in line:
                        print("✅ Payload staged. Waiting for the ASG-owned MTK-only reboot...", flush=True)
                        finished = True
                        break
                    if "MTK OTA source URL:" in line:
                        saw_activity = True
                        print("📥 Downloading MTK patch...", flush=True)
                    match = re.search(r"MTK firmware download progress: ([0-9]+)%", line)
                    progress = int(match[1]) if match else 100 if "MTK firmware downloaded to:" in line else None
                    if progress is not None:
                        saw_activity = True
                        if progress != last_download:
                            print(f"📥 Downloading MTK patch: {progress}%", flush=True)
                            last_download = progress
                    match = re.search(r"MTK OTA update - cmd: (write|update), msg: ([0-9]+)", line)
                    if match:
                        saw_activity = True
                        progress = (50 if match[1] == "update" else 0) + int(match[2]) // 2
                        if progress > last_install:
                            print(f"🛠️ Installing MTK firmware: {progress}%", flush=True)
                            last_install = progress
    finally:
        stop_reader(process)
    verify_target_boot(deadline, source_boot, source_cid, target_version, target_slot)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-boot", "source-cid", "target-version", "target-slot"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--activity-timeout", type=float, default=15)
    args = parser.parse_args()
    if any(not math.isfinite(value) or value <= 0 for value in (args.timeout, args.activity_timeout)):
        parser.error("Timeouts must be finite and positive")
    def interrupted(_signum, _frame):
        # selectors retries InterruptedError; use the normal cancellation path.
        raise KeyboardInterrupt("OTA observation interrupted; do not resend the update")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        raise SystemExit(observe(args.source_boot, args.source_cid, args.target_version,
                                 args.target_slot, args.timeout, args.activity_timeout))
    except (OSError, ValueError, KeyboardInterrupt) as error:
        parser.exit(1, f"❌ {error}\n")
