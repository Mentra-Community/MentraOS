#!/usr/bin/env python3
"""Record glasses + phone logcat and BES ring dumps for a manual (hand) session.

Usage: watch.py <run-subdir> <seconds>
Writes glasses.log, phone.log, bes_trace.txt and events.txt (pairing-relevant lines).
"""

import sys
import time

import pmx

KEYS = (
    "PWR press", "3-press", "not ready", "NOT_READY", "mode_enter_done", "window_close",
    "cancel", "owner committed", "logical session", "auto-enter", "state ", "reap",
    "ble_reject", "clear_owner", "poweroff", "shutdown",
)


def main() -> None:
    sub, seconds = sys.argv[1], float(sys.argv[2])
    d = pmx.RUNS / "m1" / sub
    d.mkdir(parents=True, exist_ok=True)
    g = pmx.LogTap(pmx.GLASSES, d / "glasses.log").start(clear=False)
    p = pmx.LogTap(pmx.PHONE, d / "phone.log").start(clear=False)
    pmx.bes_trace(True, 3000)
    end = time.time() + seconds
    while time.time() < end:
        time.sleep(15)
        if not g._proc or g._proc.poll() is not None:
            # Glasses Android went away (power off / reboot); reattach when it returns.
            if pmx.wait_glasses_boot(60):
                g.stop()
                g = pmx.LogTap(pmx.GLASSES, d / f"glasses-{int(time.time())}.log").start(clear=False)
                pmx.bes_trace(True, 3000)
    g.stop()
    p.stop()
    lines = pmx.bes_lines(g, 0)
    (d / "bes_trace.txt").write_text("\n".join(lines) + "\n")
    ev = [l for l in lines if any(k in l for k in KEYS)]
    ev += [l for _, l in g.since(0) if "PairingAudio" in l]
    ev += [l for _, l in p.since(0) if ("entering pairing" in l or "Owner loss" in l) and "ReactNativeJS" not in l]
    (d / "events.txt").write_text("\n".join(ev) + "\n")
    print("\n".join(ev[-80:]))


if __name__ == "__main__":
    main()
