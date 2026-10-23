#!/usr/bin/env python3
"""Fire a BES reset-characterization trigger from the MTK and report the next boot.

Needs a BES image built with M8_CRASH_CHAR_TEST=1 (mentra-live-bes
apps/xysmart/m8_crash_char.h). The trigger is a raw K900 frame written to the
BES UART (/dev/ttyS1) from `adb shell`; ASG keeps running and receives the
replies. Uses the `adb` on PATH.

  bes_crash_trigger.py id                       # print current [BOOT-ID-CANDIDATE]
  bes_crash_trigger.py assert --wait-boot       # crash, then report the new boot
  bes_crash_trigger.py wdt --sleep --wait-boot  # screen off, wait for suspend, then hang
  bes_crash_trigger.py dump --out dump.txt      # cs_log action 0 (never clears)

Kinds: id, assert, exception, wdt (IRQs masked -> hardware watchdog reset, no
crash handler), hang, reboot (app_reset), dump.

WARNING: `hang` busy-loops in the UART command thread with IRQs enabled. On
best1502x the watchdog is fed from a separate RTX timer thread, so it keeps
feeding and BES never resets: the chip wedges with a dead UART and no recovery
short of a physical power cycle. Use `wdt` for the "stuck task blocks the
watchdog" class (that one takes the hardware watchdog and resets cleanly).
"""
import argparse
import json
import os
import re
import struct
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mentra_adb  # noqa: E402

KINDS = ("id", "assert", "exception", "wdt", "hang", "reboot")
UART = "/dev/ttyS1"
REMOTE_FRAME = "/data/local/tmp/bes_crash_trigger.bin"
TRACE_ACTION = "com.mentra.DEBUG_BES_TRACE"
TRACE_RECEIVER = "com.mentra.asg_client/.receiver.DebugBesTraceReceiver"
CANDIDATE = re.compile(
    r"\[BOOT-ID-CANDIDATE\] trng=([0-9a-f]{16}) trng_ok=(\d) reset_hw=0x([0-9a-f]+) "
    r"reset_sw=0x([0-9a-f]+) read_us=(\d+) src=(\w+)")
PAYLOAD = re.compile(r"direction=bes_to_asg layer=asg_uart_input .*?type=k900:sr_log .*?payload=(\{.*\})\s*$")


def k900_frame(inner_json):
    """'##' 0x30 <u16 LE length> <json> '$$' (BES auto-detects the length endianness)."""
    data = inner_json.encode("utf8")
    if len(data) > 0xFFFF:
        raise ValueError("K900 payload too long")
    return b"##" + bytes([0x30]) + struct.pack("<H", len(data)) + data + b"$$"


def crashtest_json(kind):
    return json.dumps({"C": "cs_crashtest", "V": 1, "B": json.dumps({"kind": kind})}, separators=(",", ":"))


def cs_log_json():
    # action 0 only: any other action clears the saved dump.
    return json.dumps({"C": "cs_log", "V": 1, "B": json.dumps({"action": 0})}, separators=(",", ":"))


def send_k900(inner_json):
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as handle:
        handle.write(k900_frame(inner_json))
        path = handle.name
    try:
        mentra_adb.push(path, REMOTE_FRAME)
    finally:
        os.unlink(path)
    code, _ = mentra_adb.shell(f"cat {REMOTE_FRAME} > {UART}")
    if code != 0:
        raise RuntimeError(f"could not write {UART}")


def set_trace_polling(enabled, interval_ms=3000):
    mentra_adb.shell(f"am broadcast -a {TRACE_ACTION} --ez enabled {'true' if enabled else 'false'} "
                     f"--ei interval_ms {interval_ms} -n {TRACE_RECEIVER}")


def mtk_boot_id():
    return mentra_adb.out("cat /proc/sys/kernel/random/boot_id")


def logcat_dump():
    return mentra_adb.shell("logcat -d -v threadtime", timeout=60)[1]


def parse_candidates(text):
    found = []
    for line in text.splitlines():
        if "bes_trace_log" not in line:
            continue
        match = CANDIDATE.search(line)
        if match:
            found.append({"trng": match[1], "trng_ok": int(match[2]),
                          "reset_hw": "0x%02x" % int(match[3], 16), "reset_sw": "0x%08x" % int(match[4], 16),
                          "read_us": int(match[5]), "src": match[6],
                          "logcat": line[:18]})
    return found


def parse_sr_log(text):
    """sr_log packets ASG received from BES, in logcat order: [(cur, body)]."""
    packets = []
    for line in text.splitlines():
        match = PAYLOAD.search(line)
        if not match:
            continue
        try:
            body = json.loads(match[1]).get("B", {})
        except ValueError:
            continue
        if isinstance(body, dict) and "cur" in body:
            packets.append((int(body["cur"]), str(body.get("body", ""))))
    return packets


def assemble_dump(packets):
    """Concatenate the last complete cur 0..n run ending in the cur 255 end packet."""
    end = max((i for i, (cur, _) in enumerate(packets) if cur == 255), default=None)
    if end is None or end == 0:
        return None
    start = end - 1
    while start > 0 and packets[start][0] > 0 and packets[start - 1][0] == packets[start][0] - 1:
        start -= 1
    run = packets[start:end]
    return {"text": "".join(body for _, body in run), "packets": len(run), "complete": run[0][0] == 0}


def current_candidate(timeout=30, exclude_trng=None):
    """Ask BES to re-print its boot candidate; return the newest one not equal to exclude_trng."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        since = device_clock()
        try:
            send_k900(crashtest_json("id"))
        except Exception:  # noqa: BLE001 - adb drops while the MTK reboots
            time.sleep(5)
            continue
        for _ in range(3):
            time.sleep(4)
            found = [c for c in parse_candidates(logcat_dump())
                     if c["src"] == "boot" and c["logcat"] >= since and c["trng"] != exclude_trng]
            if found:
                return found[-1]
    return None


def wait_for_suspend(timeout):
    def successes():
        value = mentra_adb.out("cat /sys/power/suspend_stats/success 2>/dev/null || "
                               "grep '^success' /d/suspend_stats 2>/dev/null | awk '{print $2}'")
        return int(value) if value.isdigit() else None
    before = successes()
    mentra_adb.shell("input keyevent KEYCODE_SLEEP")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(5)
        now = successes()
        if before is not None and now is not None and now > before:
            return {"suspended": True, "success_before": before, "success_after": now}
    return {"suspended": False, "success_before": before, "success_after": successes()}


def wait_asg(deadline):
    while time.monotonic() < deadline:
        if mentra_adb.attached() and mentra_adb.out("getprop sys.boot_completed") == "1" \
                and mentra_adb.out("pidof com.mentra.asg_client"):
            return
        time.sleep(5)
    raise TimeoutError("unit did not come back")


def wait_boot(old_mtk_boot, old_trng, timeout):
    """Wait until BES reports a boot candidate different from old_trng.

    A BES reset may or may not reboot the MTK (soft reboot and OTA did on unit 1,
    a crash did not), and a crash spends tens of seconds in the dump handler.
    """
    deadline = time.monotonic() + timeout
    time.sleep(10)
    after = None
    rebooted = False
    while time.monotonic() < deadline and after is None:
        wait_asg(deadline)
        if mtk_boot_id() != old_mtk_boot and not rebooted:
            rebooted = True
            time.sleep(10)  # let ASG reopen the BES UART
        set_trace_polling(True)
        after = current_candidate(timeout=min(40, max(5, deadline - time.monotonic())), exclude_trng=old_trng)
    return rebooted or mtk_boot_id() != old_mtk_boot, after


def device_clock():
    """Device time in logcat threadtime form, for filtering lines after a send."""
    return mentra_adb.out("date '+%m-%d %H:%M:%S.000'")


def pull_dump(out_path, timeout=60):
    set_trace_polling(False)
    time.sleep(10)  # let an in-flight mh_logs transfer finish; it also uses sr_log
    since = device_clock()
    send_k900(cs_log_json())
    deadline = time.monotonic() + timeout
    result = None
    while time.monotonic() < deadline:
        time.sleep(3)
        lines = "\n".join(line for line in logcat_dump().splitlines() if line[:18] >= since)
        result = assemble_dump(parse_sr_log(lines))
        if result:
            break
    set_trace_polling(True)
    if not result:
        # Firmware without a saved dump logs "__CRASH_DUMP: no crash logs available"
        # to TRACE and sends no sr_log at all.
        return {"out": None, "bytes": 0, "packets": 0, "complete": False, "crash_context": None,
                "note": "no cs_log reply (no saved dump on pre-contract firmware?)"}
    with open(out_path, "w", encoding="utf8") as handle:
        handle.write(result["text"])
    context = re.findall(r"\[CRASH-CONTEXT\][^\n]*", result["text"])
    return {"out": out_path, "bytes": len(result["text"].encode("utf8")), "packets": result["packets"],
            "complete": result["complete"], "crash_context": context[-1] if context else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kind", choices=KINDS + ("dump",))
    parser.add_argument("--sleep", action="store_true", help="screen off and wait for an MTK suspend first")
    parser.add_argument("--sleep-timeout", type=float, default=120)
    parser.add_argument("--wait-boot", action="store_true", help="after the trigger, report the new boot")
    parser.add_argument("--timeout", type=float, default=240)
    parser.add_argument("--out", default="bes_dump.txt", help="dump output path (kind dump)")
    args = parser.parse_args(argv)

    report = {"kind": args.kind, "host_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if not mentra_adb.attached():
        print("adb device not reachable", file=sys.stderr)
        return 2
    if args.kind == "dump":
        report["dump"] = pull_dump(args.out)
        print(json.dumps(report, indent=2))
        return 0 if report["dump"]["complete"] or report["dump"]["packets"] == 0 else 1
    set_trace_polling(True)
    if args.kind == "id":
        report["candidate"] = current_candidate()
        print(json.dumps(report, indent=2))
        return 0 if report["candidate"] else 1

    report["before"] = current_candidate()
    old_mtk_boot = mtk_boot_id()
    if args.sleep:
        report["sleep"] = wait_for_suspend(args.sleep_timeout)
    if args.kind == "hang":
        print("WARNING: 'hang' wedges BES with no reset; recovery needs a physical power cycle.",
              file=sys.stderr)
    report["trigger_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    send_k900(crashtest_json(args.kind))
    if args.wait_boot:
        rebooted, after = wait_boot(old_mtk_boot, (report["before"] or {}).get("trng"), args.timeout)
        report["mtk_rebooted"] = rebooted
        report["after"] = after
        before_trng = (report["before"] or {}).get("trng")
        report["new_bes_boot"] = bool(after and after["trng"] != before_trng)
    print(json.dumps(report, indent=2))
    return 0 if not args.wait_boot or report.get("new_bes_boot") else 1


if __name__ == "__main__":
    sys.exit(main())
