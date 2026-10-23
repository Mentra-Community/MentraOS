#!/usr/bin/env python3
"""Report MTK kernel suspend evidence around a window, over adb (PATH adb).

Reads whatever the kernel exposes on the unit:
  /sys/power/suspend_stats/*          suspend success / per-step failure counts
  /sys/class/wakeup/*/                per-source active_count, *_time_ms, etc.
  dmesg                              "PM: suspend"/"PM: resume" entries
  logcat                             BES [LOG-DELIVERY] delivery-wake lines

Run with --before to snapshot, exercise the device, then --after <file> to diff;
or --window <seconds> to snapshot, wait, and diff in one call. Reports suspend
count, failed suspends, wake sources that changed, per-wake durations, and the
BES delivery wakes seen in the window.
"""
import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mentra_adb  # noqa: E402

WAKEUP_FIELDS = ("active_count", "event_count", "wakeup_count", "expire_count",
                 "active_time_ms", "total_time_ms", "max_time_ms", "last_change_ms",
                 "prevent_suspend_time_ms")
DELIVERY = re.compile(r"\[LOG-DELIVERY\][^\n\"]*")


def read_suspend_stats():
    stats = {}
    text = mentra_adb.out(
        "cd /sys/power/suspend_stats 2>/dev/null && for f in *; do printf '%s\\t' \"$f\"; cat \"$f\"; echo; done")
    for line in text.splitlines():
        if "\t" in line:
            key, _, value = line.partition("\t")
            stats[key.strip()] = value.strip()
    return stats


def read_wakeups():
    sources = {}
    # One shell pass over every source: "name<TAB>field<TAB>value" lines.
    script = ("for d in /sys/class/wakeup/*/; do n=$(cat \"$d/name\" 2>/dev/null); "
              + "; ".join(f'printf \"%s\\t{f}\\t%s\\n\" \"$n\" \"$(cat \"$d/{f}\" 2>/dev/null)\"'
                          for f in WAKEUP_FIELDS) + "; done")
    for line in mentra_adb.out(script).splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or not parts[0]:
            continue
        name, field, value = parts
        entry = sources.setdefault(name, {})
        try:
            entry[field] = int(value)
        except ValueError:
            entry[field] = value
    return sources


def dmesg_pm_count():
    text = mentra_adb.out("dmesg 2>/dev/null | grep -E 'PM: suspend|PM: resume|PM: Syncing|suspend entry|suspend exit'")
    enter = len(re.findall(r"PM: suspend entry|PM: suspend\b", text))
    exit_ = len(re.findall(r"PM: resume|suspend exit", text))
    return {"dmesg_suspend_entry": enter, "dmesg_resume": exit_}


def logcat_delivery_lines():
    text = mentra_adb.shell("logcat -d", timeout=60)[1]
    return DELIVERY.findall(text)


def snapshot():
    return {"host_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "device_uptime": mentra_adb.out("cat /proc/uptime"),
            "suspend_stats": read_suspend_stats(),
            "wakeups": read_wakeups(),
            "dmesg": dmesg_pm_count(),
            "delivery_lines": logcat_delivery_lines()}


def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def diff(before, after):
    bs, as_ = before["suspend_stats"], after["suspend_stats"]
    sb, sa = as_int(bs.get("success")), as_int(as_.get("success"))
    report = {"from_utc": before["host_utc"], "to_utc": after["host_utc"],
              "suspend_success_delta": (sa - sb) if sb is not None and sa is not None else None,
              "suspend_success_before": sb, "suspend_success_after": sa,
              "failed_suspends": {}, "dmesg": {k: after["dmesg"][k] - before["dmesg"].get(k, 0)
                                               for k in after["dmesg"]},
              "wake_sources": [], "bes_delivery_wakes": 0}
    for key, value in as_.items():
        if key.startswith("fail"):
            d = (as_int(value) or 0) - (as_int(bs.get(key)) or 0)
            if d:
                report["failed_suspends"][key] = d
    report["last_failed_dev"] = as_.get("last_failed_dev") or None
    report["last_failed_step"] = as_.get("last_failed_step") or None

    for name, after_src in after["wakeups"].items():
        before_src = before["wakeups"].get(name, {})
        d_active = (as_int(after_src.get("active_count")) or 0) - (as_int(before_src.get("active_count")) or 0)
        d_event = (as_int(after_src.get("event_count")) or 0) - (as_int(before_src.get("event_count")) or 0)
        d_total = (as_int(after_src.get("total_time_ms")) or 0) - (as_int(before_src.get("total_time_ms")) or 0)
        if d_active or d_event or d_total:
            report["wake_sources"].append({
                "name": name, "active_count_delta": d_active, "event_count_delta": d_event,
                "total_time_ms_delta": d_total, "max_time_ms": as_int(after_src.get("max_time_ms")),
                "per_wake_ms": round(d_total / d_active, 1) if d_active else None})
    report["wake_sources"].sort(key=lambda s: s["total_time_ms_delta"], reverse=True)

    before_set = set(before["delivery_lines"])
    report["bes_delivery_wake_lines"] = [l for l in after["delivery_lines"] if l not in before_set]
    report["bes_delivery_wakes"] = len(report["bes_delivery_wake_lines"])
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--before", metavar="FILE", help="write a snapshot to FILE and exit")
    parser.add_argument("--after", metavar="FILE", help="diff the current state against the snapshot in FILE")
    parser.add_argument("--window", type=float, metavar="SECONDS",
                        help="snapshot, wait SECONDS, then diff in one run")
    parser.add_argument("--out", help="write the full JSON report/snapshot here too")
    args = parser.parse_args(argv)

    if not mentra_adb.attached():
        print("adb device not reachable", file=sys.stderr)
        return 2

    if args.before and not args.window:
        snap = snapshot()
        json.dump(snap, open(args.before, "w"), indent=1)
        print(f"snapshot written to {args.before} ({len(snap['wakeups'])} wake sources)")
        return 0

    if args.after and not args.window:
        before = json.load(open(args.after))
        report = diff(before, snapshot())
    elif args.window:
        before = snapshot()
        time.sleep(args.window)
        report = diff(before, snapshot())
    else:
        report = snapshot()
        report = {"snapshot": {k: report[k] for k in ("host_utc", "suspend_stats", "dmesg")},
                  "wake_source_count": len(report["wakeups"]),
                  "delivery_lines": len(report["delivery_lines"])}

    print(json.dumps(report, indent=2))
    if args.out:
        json.dump(report, open(args.out, "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
