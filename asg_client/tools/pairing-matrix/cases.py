#!/usr/bin/env python3
"""Pairing matrix cases. Usage: cases.py --run <dir-name> CASE [CASE ...]

Each case starts fresh glasses + phone logcat taps, writes them under
runs/<run>/<case>/ and appends a verdict row to runs/<run>/results.jsonl.

Device runs (`--run x2`) execute from an immutable harness snapshot via run_case.py; every
result row carries the snapshot id and manifest sha256. Glasses are unit3 only (pmx routing,
lab-units guard at every case start); the glasses identity comes from ident.py.
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import signal
import sys
import time
from pathlib import Path

import ident
import ios
import owner_lost
import pmx

HERE = Path(__file__).resolve().parent
PROTECTED_RUNS = {"x1", "m1", "m2", "m3", "m4", "baseline"}  # old evidence: never written

class PreconditionFailed(Exception):
    """Ownership does not match the case's precondition: stop, do not run the case body."""


CASES = {}


def case(cid):
    def deco(fn):
        CASES[cid] = fn
        return fn

    return deco


def superseded(old: str, new: str, why: str) -> None:
    """Register `old` as a case that ends NOT_TESTABLE and names its replacement.

    Case IDs that encoded the removed behavior (R15 owner-lost card, single-click cancel, forget-on-entry, the T0-T9
    confirm matrix) stay resolvable so an old command line gets a clear answer instead of "unknown case"."""

    def fn(ctx):
        ctx.not_testable(f"SUPERSEDED by {new} (OS-2055 v4): {why}")

    fn.__doc__ = f"SUPERSEDED by {new}: {why}"
    CASES[old] = fn


TRANSFER_ENV = "MENTRA_TRANSFER"
FAULT_ENV = "MENTRA_PAIRING_FAULT_INJECT"  # declares the debug-build step the flashed BES carries (1|2|3)
FAULT_LOG_RX = r"fault inject reboot after commit step (\d)"
# Wire keys that exist only on v4 firmware. V4OFF requires none of them in any log.
TRANSFER_KEY_RX = r"""\\?["']?(pairing_mode_ended|window_id|owner_changed|phone_hello)\\?["']?\s*[:=]"""
PROTOCOL_VERSION_RX = re.compile(r"protocol_version\W{0,4}(\d+)")


def transfer_mode() -> str:
    """'on' or 'off' from MENTRA_TRANSFER (default on: the flag defaults to 1). Anything else is an error."""
    value = os.environ.get(TRANSFER_ENV, "on").strip().lower() or "on"
    if value not in ("on", "off"):
        raise ValueError(f"{TRANSFER_ENV} must be 'on' or 'off', got {value!r}")
    return value


def transfer_on() -> bool:
    return transfer_mode() == "on"




def require_transfer(ctx, want_on: bool = True) -> bool:
    """True when the flashed-firmware mode matches the case; otherwise the case ends NOT_TESTABLE."""
    if transfer_on() == want_on:
        ctx.note(f"{TRANSFER_ENV}={transfer_mode()}")
        return True
    ctx.not_testable(f"needs ownership-transfer firmware {'ON' if want_on else 'OFF'}: run with "
                     f"{TRANSFER_ENV}={'on' if want_on else 'off'} against a build flashed that way "
                     f"(this run has {TRANSFER_ENV}={transfer_mode()})")
    return False


def needs_v4(fn):
    """Decorator: the case encodes v4 behavior, so it ends NOT_TESTABLE against flag-off firmware."""
    import functools

    @functools.wraps(fn)
    def wrapper(ctx):
        if not require_transfer(ctx, want_on=True):
            return None
        return fn(ctx)

    return wrapper




def fresh_case_dir(run_dir: Path, cid: str) -> Path:
    """runs/<run>/<case>/, or <case>__rerun<n> when that already holds evidence (never overwrite)."""
    d = run_dir / cid
    n = 1
    while d.exists() and any(d.iterdir()):
        n += 1
        d = run_dir / f"{cid}__rerun{n}"
    d.mkdir(parents=True, exist_ok=True)
    return d


class Ctx:
    def __init__(self, run_dir: Path, cid: str):
        # Fail closed before any tap starts: identity configured, phone route set, exactly one unit3.
        ident.get().mac_dash  # name, code and MAC must all be configured (blueutil steps need the MAC)
        pmx.phone_adb_path()
        self.unit3 = dict(pmx.assert_unit3())
        self.dir = fresh_case_dir(run_dir, cid)
        self.cid = cid
        self.g = pmx.LogTap(pmx.GLASSES, self.dir / "glasses.log").start()
        self.p = pmx.LogTap(pmx.PHONE, self.dir / "phone.log").start()
        self.i = ios.SimLogTap(self.dir / "ios.log").start()
        pmx.adb(pmx.PHONE, "reverse", "tcp:8081", "tcp:8081")
        pmx.psh("svc power stayon true")
        pmx.bes_trace(True, 1000)
        time.sleep(1)
        self.notes: list = []
        self.checks: list = []
        self.gaps: list = []
        self.bench: list = []  # informational bench observations; never part of the product verdict
        self.blocked: str = ""  # precondition/guard failure: the case ends BLOCKED and the run stops
        self.invalid: str = ""  # a required observation window ran short: the case is INVALID, not a pass
        self.phases: list = []
        self._phase_open: dict = {}
        self.stop_run_reason: str = ""  # the verdict stands, but the next case cannot run (e.g. unit3 adb absent)

    def note(self, msg: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.notes.append(f"{stamp} {msg}")
        print(f"  {stamp} {msg}", flush=True)

    def bes_wait(self, pattern: str, timeout: float, mark: int | None = None):
        hit = pmx.bes_wait(self.g, pattern, mark if mark is not None else 0, timeout)
        self.note(f"bes_wait /{pattern}/ -> {hit[1].strip() if hit else 'TIMEOUT'}")
        return hit

    def log_wait(self, tap: pmx.LogTap, pattern: str, timeout: float, mark: int = 0):
        hit = tap.wait_for(pattern, mark, timeout)
        who = "glasses" if tap is self.g else "phone"
        self.note(f"{who}_wait /{pattern}/ -> {hit[1][:220] if hit else 'TIMEOUT'}")
        return hit

    def bes(self, pattern: str = "", mark: int = 0) -> list:
        return pmx.bes_lines(self.g, mark, pattern)

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"check": name, "ok": bool(ok), "detail": detail})
        self.note(f"CHECK {'PASS' if ok else 'FAIL'} {name} {detail}")
        if not ok and name.startswith("precondition"):
            raise PreconditionFailed(name)
        return ok

    def adv(self, seconds: float = 5.0):
        a = pmx.glasses_adv(seconds=seconds)
        m = (a or {}).get("mentra", {})
        self.note(f"adv: {'absent' if not a else m}")
        return a

    def shot(self, name: str) -> Path:
        return pmx.screenshot(self.dir / f"{name}.png")

    def phase_begin(self, name: str) -> None:
        self._phase_open[name] = time.time()

    def phase_end(self, name: str) -> None:
        start = self._phase_open.pop(name, None)
        end = time.time()
        self.phases.append({"phase": name, "start": start if start is not None else end, "end": end})

    def mark_invalid(self, why: str) -> None:
        self.invalid = why
        self.note(f"INVALID {why}")

    def bench_note(self, name: str, ok: bool, detail: str = "") -> None:
        """Bench observation (for example how long adb took to return). Recorded, never fails the case."""
        self.bench.append({"bench": name, "ok": bool(ok), "detail": detail})
        self.note(f"BENCH {'ok' if ok else 'NOTE'} {name} {detail}")

    def gap(self, name: str, detail: str = "") -> None:
        """A required BES proof is missing and no other source proves the SAME fact: harness gap.

        The case cannot PASS; it ends OPEN unless a check failed (FAIL)."""
        self.gaps.append({"gap": name, "detail": detail})
        self.note(f"HARNESS GAP {name}: {detail}")

    def finish(self) -> dict:
        time.sleep(4)
        self.g.stop()
        self.p.stop()
        self.i.stop()
        (self.dir / "bes_trace.txt").write_text("\n".join(pmx.bes_lines(self.g, 0)) + "\n")
        (self.dir / "notes.txt").write_text("\n".join(self.notes) + "\n")
        for name, start in list(self._phase_open.items()):
            self.phases.append({"phase": name, "start": start, "end": time.time(), "open": True})
            self._phase_open.pop(name, None)
        wall = union_duration([(p["start"], p["end"]) for p in self.phases])
        (self.dir / "phases.jsonl").write_text("".join(json.dumps(p) + "\n" for p in self.phases))
        self.note(f"phase wall {wall:.1f}s union of {len(self.phases)} intervals (overlapping intervals counted once)")
        failed = [c for c in self.checks if not c["ok"]]
        status = "FAIL" if failed else ("OPEN" if self.gaps else "PASS")
        if self.invalid:
            status = "INVALID"
        if self.blocked:
            status = "BLOCKED"
        if self.untestable:
            status = "NOT_TESTABLE" if not self.checks else status
        return {
            "status": status,
            "checks": self.checks,
            "gaps": self.gaps,
            "bench_notes": self.bench,
            "phases": self.phases,
            "phase_wall_s": round(wall, 1),
            "blocked_reason": self.blocked,
            "invalid_reason": self.invalid,
            "run_blocked_after": self.stop_run_reason,
            "untestable": self.untestable,
            "dir": str(self.dir),
            "unit3": self.unit3,
        }

    untestable: str = ""

    def not_testable(self, why: str) -> None:
        self.untestable = why
        self.note(f"NOT TESTABLE: {why}")

    def ios_wait(self, pattern: str, timeout: float, mark: int = 0):
        hit = self.i.wait_for(pattern, mark, timeout)
        self.note(f"ios_wait /{pattern}/ -> {hit[1][-200:] if hit else 'TIMEOUT'}")
        return hit

    def ishot(self, name: str) -> Path:
        return ios.screenshot(self.dir / f"ios_{name}.png")


class PreviousOwnerLinkDown(Exception):
    """The phone that should be the previous owner has no live link to the glasses: the case ends BLOCKED."""


def union_duration(intervals: list) -> float:
    """Wall time of intervals, counting overlap once. A limit (a cap, a timeout) is not a duration."""
    segs = sorted((float(a), float(b)) for a, b in intervals if b >= a)
    if not segs:
        return 0.0
    total = 0.0
    start, end = segs[0]
    for a, b in segs[1:]:
        if a <= end:
            end = max(end, b)
        else:
            total += end - start
            start, end = a, b
    return total + (end - start)


USB_BUDGET_S = 180.0  # expected USB return; over this is a bench note
USB_CAP_S = 240.0  # from the reboot request; no USB by then is BLOCKED


LINK_UP_RX = owner_lost.LINK_UP_RX
LINK_DOWN_RX = owner_lost.LINK_DOWN_RX


def link_state(lines: list, up: re.Pattern, down: re.Pattern):
    """True when the newest link event in `lines` is a readiness/heartbeat-pong line, False when it is a
    disconnect/owner-loss line, None when there is no link event at all. ReactNativeJS duplicates are ignored."""
    state = None
    for _, line in lines:
        if "ReactNativeJS" in line:
            continue
        if up.search(line):
            state = True
        elif down.search(line):
            state = False
    return state


# The Android phone SDK reads RSSI every 10 s while the GATT link is up and stops polling on disconnect, so a
# fresh RSSI line proves a live link up to 30 s sooner than waiting for the 30 s heartbeat pong. iOS has no such
# periodic log line and keeps the pong/ready evidence.
LINK_FRESH_RX = {
    "s22": re.compile(r"LIVE: \U0001F4F6 RSSI: -?\d+ dBm"),
}
# TEMPORARY BENCH SPEEDUPS (opt-in): PMX_BENCH_SPEEDUPS=1 enables the RSSI shortcut above and the software wake of
# the glasses while waiting for the link. Both are iteration aids only. Default is OFF (strict: wait for a real
# pong/ready line, no wake); final and release-gate runs must be strict. See runs/x2/temporary-speedups.md.
def bench_speedups() -> bool:
    return os.environ.get("PMX_BENCH_SPEEDUPS") == "1"
_LOGCAT_TS_RX = re.compile(r"^\s*(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)")


def link_fresh(lines: list, fresh: re.Pattern, down: re.Pattern, max_age_s: float = 15.0, now=None) -> bool:
    """True when the newest link event is a fresh periodic link line (not followed by a disconnect/owner-loss
    line) no older than `max_age_s`. A line without a parseable logcat timestamp never counts."""
    import datetime

    now = now or datetime.datetime.now()
    stamp = None
    for _, line in lines:
        if "ReactNativeJS" in line:
            continue
        if fresh.search(line):
            stamp = line
        elif down.search(line):
            stamp = None
    if stamp is None:
        return False
    m = _LOGCAT_TS_RX.match(stamp)
    if not m:
        return False
    month, day, hh, mm, ss = (int(m.group(i)) for i in range(1, 6))
    try:
        seen = datetime.datetime(now.year, month, day, hh, mm, ss, int(m.group(6).ljust(6, "0")[:6]))
    except ValueError:
        return False
    return -2.0 <= (now - seen).total_seconds() <= max_age_s


def await_live_link(ctx, who: str, timeout: float = 60.0, poll: float = 2.0, clock=None) -> str:
    """Require a live link to the previous owner phone right before the gesture. The phone logs a heartbeat pong
    every 30 s while connected and ready, so a live link shows up within one heartbeat; nothing is poked (no extra
    presses, no reconnect nudges). Not live after `timeout` -> PreviousOwnerLinkDown (case BLOCKED)."""
    clock = clock or time
    tap = ctx.p if who == "s22" else ctx.i
    up, down = LINK_UP_RX[who], LINK_DOWN_RX[who]
    deadline = clock.time() + timeout
    state = None
    wake_every, last_wake = 8.0, 0.0
    while True:
        # The glasses' Android sleeps within seconds and then does not answer the phone's ping, so a live link
        # would never log a pong. A software wake over adb is not a BES button press and sends nothing to the phone.
        if bench_speedups() and clock is time and clock.time() - last_wake >= wake_every:
            last_wake = clock.time()
            try:
                pmx.gsh("input keyevent KEYCODE_WAKEUP", timeout=10)
            except Exception as exc:  # noqa: BLE001 - wake is best effort, the pong check below decides
                ctx.note(f"glasses wake skipped: {exc}")
        lines = tap.since(0)
        state = link_state(lines, up, down)
        if state:
            ctx.note(f"live link to the previous owner ({who}) confirmed")
            return "live"
        fresh = LINK_FRESH_RX.get(who)
        if bench_speedups() and fresh is not None and link_fresh(lines, fresh, down):
            ctx.note(f"live link to the previous owner ({who}) confirmed by a fresh RSSI read (10 s poll)")
            return "live"
        if clock.time() >= deadline:
            break
        clock.sleep(poll)
    why = {None: "no link event (no heartbeat pong / ready line) in the log", False: "last link event is a disconnect"}[state]
    raise PreviousOwnerLinkDown(
        f"precondition: previous owner has no live link ({who}): {why} within {timeout:.0f} s; "
        "restore the link (no extra presses were tried)")


def run_transition(ctx, previous_owner: str, **kw):
    """owner_lost.window_transition with the live-link precondition (waits up to 60 s right before the gesture).

    Pass `scenario` = timeout (O1) | cancel (O2) | takeover (O4) and a `trigger` that makes the one 3-press gesture."""
    kw.setdefault("live_link", lambda: await_live_link(ctx, previous_owner))
    kw.setdefault("adv", lambda: ctx.adv(5))
    return owner_lost.window_transition(ctx, previous_owner, **kw)


def pair_again_visible_s22() -> bool:
    """S7: the Home card after a takeover. One button, "Pair Again"; nothing else."""
    return pmx.ui_find(r"^Pair Again$") is not None


def tap_pair_again_s22() -> None:
    """Pair Again opens the pairing prep directly (no confirm modal, no unpair step first)."""
    pmx.tap_text(r"^Pair Again$", 8)
    time.sleep(2)


def pair_from_app(ctx: Ctx, timeout: float = 60, accept_dialog: bool = True):
    """Drive the Mentra App pairing flow; returns the owner-commit BES line or None."""
    mark = ctx.g.mark()
    res = pmx.app_pair(timeout=timeout, accept_dialog=accept_dialog)
    ctx.note(f"app_pair: {res}")
    ctx.shot("pair_flow_end")
    return ctx.bes_wait(r"owner committed from ble bond", 30, mark), res


# ----------------------------------------------------------------------- cases


@case("C3")
@needs_v4
def c3_enter_with_absent_owner(ctx: Ctx):
    """Owner exists but is absent (no BLE phone); 3 presses KEEP it (V2: entering forgets nothing) and open the window."""
    media_before = pmx.media_count()
    m = ctx.g.mark()
    pmx.inject(pmx.presses(3, 300), 50)
    ctx.check("3-press fires", ctx.bes_wait(r"3-press queue pairing mode", 15, m) is not None)
    ctx.check("mode_enter_done", ctx.bes_wait(r"mode_enter_done", 10, m) is not None)
    dump = ctx.bes(r"lxy pair: mode_enter_done", m)
    ctx.check(
        "owner retained, window open",
        bool(dump) and "own=0/0" not in dump[-1] and "st=PAIRING" in dump[-1],
        dump[-1] if dump else "",
    )
    ctx.check("BES logged the retained owner", bool(ctx.bes(r"xfer enter, owner retained", m)),
              str(ctx.bes(r"xfer enter", m)[:1]))
    ctx.check("no entering_pairing_mode without BLE phone (mode_enter no_ble_phone retained_owner)",
              not ctx.bes(r"entering_pairing_mode", m) and bool(ctx.bes(r"pairflow mode_enter no_ble_phone retained_owner", m)),
              str(ctx.bes(r"pairflow mode_enter", m)[:1]))
    ctx.check("no bond change on entry", not ctx.bes(r"clear_owner|commit [123]/3|bond_deleted", m))
    a = ctx.adv(6)
    m2 = (a or {}).get("mentra", {})
    ctx.check("adv pairing flag", bool(m2.get("pairing")), json.dumps(m2))
    ctx.check("adv OWNER_CHANGED clear", not m2.get("owner_changed"), json.dumps(m2))
    spk = ctx.log_wait(ctx.g, r"hm_spkcode received code=", 25, 0)
    ctx.check("spoken code sent to ASG", spk is not None)
    ctx.check("media untouched", pmx.media_count() == media_before, f"{media_before}")


def enter_pairing(ctx: Ctx, n: int = 3, gap_ms: int = 300) -> int:
    m = ctx.g.mark()
    pmx.inject(pmx.presses(n, gap_ms), 50)
    hit = ctx.bes_wait(r"mode_enter_done|hm_spkcode sent|click window expired n=3 fired=1", 20, m)
    ctx.check("entered pairing", hit is not None, hit[1] if hit else "")
    return m


# Window-end speech. timeout and cancel each have a clip. A successful pair speaks
# "Mentra connected." and does not use these. pairing_exited.wav remains the fallback
# when the reason is missing or the new clip is not in the APK.
PHRASE_TIMEOUT = "Pairing mode ended. No new phone paired."
PHRASE_CANCELLED = "Pairing cancelled."
ASSET_TIMEOUT = "pairing/pairing_ended_no_phone.wav"
ASSET_CANCELLED = "pairing/pairing_cancelled.wav"


def exit_speech(ctx: Ctx, phrase: str, asset: str, gmark: int = 0) -> list:
    """Glasses log lines for one reason's exit clip.

    PairingCodeSpeaker logs ``pairing-ended asset dispatched ... asset=<path>``. A line that
    contains the spoken sentence counts too.
    """
    return [line for _, line in ctx.g.since(gmark) if phrase in line or asset in line]


def wrong_exit_speech(ctx: Ctx, gmark: int = 0) -> list:
    """Timeout or cancel clips. A successful pair must not speak either."""
    return exit_speech(ctx, PHRASE_TIMEOUT, ASSET_TIMEOUT, gmark) + exit_speech(
        ctx, PHRASE_CANCELLED, ASSET_CANCELLED, gmark
    )


@case("F1")
@needs_v4
def f1_idle_expiry(ctx: Ctx):
    """No owner (run R_NONE first): the one 120 s window expires with no phone: locked, no owner, timeout phrase once.

    V1: a single 120 s window, no idle timer and no 300 s cap. BES closes with reason `timeout` and ASG says
    "Pairing mode ended. No new phone paired." once.
    """
    pmx.bes_trace(True, 1000)
    time.sleep(3)
    m = enter_pairing(ctx)
    t0 = time.time()
    hit = ctx.bes_wait(r"window_close reason=", 150, m)
    elapsed = time.time() - t0
    ctx.check("window closes", hit is not None, hit[1] if hit else "")
    ctx.check("closes near 120 s", hit is not None and 110 <= elapsed <= 135, f"{elapsed:.0f}s")
    ctx.check("close reason is timeout", hit is not None and "reason=timeout" in hit[1], hit[1] if hit else "")
    time.sleep(6)
    ctx.check("hm_pairexit reason=timeout", bool(ctx.bes(r"hm_pairexit sent reason=timeout", m)))
    exits = exit_speech(ctx, PHRASE_TIMEOUT, ASSET_TIMEOUT)
    ctx.check(
        'timeout phrase exactly once: "Pairing mode ended. No new phone paired."',
        len(exits) == 1,
        str(exits),
    )
    codes = [l for _, l in ctx.g.since(0) if "hm_spkcode received" in l]
    ctx.check("code spoken once", len(codes) == 1, str(len(codes)))
    dump = ctx.bes(r"window_close st=", m)
    ctx.check("no owner after expiry", bool(dump) and "own=0/0" in dump[-1], dump[-1] if dump else "")
    a = ctx.adv(6)
    m2 = (a or {}).get("mentra", {})
    ctx.check("not advertising pairing after expiry", not m2.get("pairing"), json.dumps(m2) if a else "absent")


@case("D1")
def d1_first_pair(ctx: Ctx):
    """S22 pairs from scratch while the window is open."""
    enter_pairing(ctx)
    hit, res = pair_from_app(ctx)
    ctx.check("android pairing dialog shown and accepted", res["dialog_accepted"], str(res["steps"]))
    ctx.check("owner committed", hit is not None, hit[1] if hit else "")
    close = ctx.bes_wait(r"state PAIRING -> OWNER_ONLY", 20)
    ctx.check("window closed on commit", close is not None, close[1] if close else "")
    # A successful pair speaks "Mentra connected.", not the timeout or cancel clips.
    # BES omits hm_pairexit when Connected is the next prompt.
    exit_line = ctx.bes_wait(
        r"hm_pairexit sent reason=paired|hm_pairexit skipped, connected follows", 20)
    ctx.check("paired speaks Mentra connected, or hm_pairexit skipped because Connected follows",
              exit_line is not None)
    wrong = wrong_exit_speech(ctx)
    ctx.check("successful pair does not speak the timeout or cancel phrase", not wrong, str(wrong))
    time.sleep(20)
    conn = ctx.bes(r"logical session connected")
    ctx.check("Connected plays exactly once", len(conn) == 1, str(conn))
    dump = ctx.bes(r"st=OWNER_ONLY .*own=1/1")
    ctx.check("owner BLE+Classic recorded", bool(dump), dump[-1] if dump else "")
    bonds = pmx.glasses_bonds()
    ctx.check("phone bonded", bool(bonds), str(bonds))
    ctx.shot("after_pair")


def phone_lines(ctx: Ctx, pattern: str, mark: int = 0) -> list:
    import re

    rx = re.compile(pattern)
    return [l for _, l in ctx.p.since(mark) if rx.search(l) and "ReactNativeJS" not in l]


superseded("D4", "O1_S22", "the owner is kept and the 120 s window times out; there is no owner-lost card, no single-click "
           "close and no ownerless end state any more")


def mac_central(*args: str, timeout: float = 200) -> list:
    import subprocess

    proc = subprocess.run(
        [sys.executable, str(pmx.HERE / "mac_central.py"), *args],
        capture_output=True, text=True, timeout=timeout,
    )
    rows = []
    for line in proc.stdout.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows


@case("E1MAC")
def e1_stranger_outside_window(ctx: Ctx):
    """Outside pairing, the Mac (stranger) cannot connect or bond."""
    m = ctx.g.mark()
    rows = mac_central("--hold", "8", "--read", "--attempts", "2")
    ctx.note(f"mac: {rows}")
    ctx.check("stranger never gets a usable link",
              all(not r.get("connected") or r.get("link_seconds", 0) < 2 for r in rows), str(rows))
    a = ctx.adv(5)
    ctx.check("advertises secure trailer, not pairing", bool(a) and not a["mentra"].get("pairing"),
              json.dumps((a or {}).get("mentra")))


@case("D3MAC")
def d3_unbonded_central_reaped(ctx: Ctx):
    """In the window, an unbonded Mac central holding the single BLE slot is dropped at ~60 s."""
    m = enter_pairing(ctx)
    rows = mac_central("--hold", "80")
    ctx.note(f"mac: {rows}")
    r = rows[0] if rows else {}
    ctx.check("Mac connects inside the window", bool(r.get("connected")), str(r))
    ctx.check("peer drops the unbonded link near 60 s",
              r.get("dropped_by_peer") and 55 <= r.get("link_seconds", 0) <= 70, str(r.get("link_seconds")))
    reap = ctx.bes(r"reap unbonded central", m)
    ctx.note(f"reap lines: {reap}")
    a = ctx.adv(5)
    ctx.check("window still open after reap", bool(a) and a["mentra"].get("pairing"),
              json.dumps((a or {}).get("mentra")))


@case("MAC_OWNER")
def mac_becomes_owner(ctx: Ctx):
    """In the window, the Mac bonds and becomes owner (stand-in for a second phone)."""
    m = enter_pairing(ctx)
    rows = mac_central("--hold", "25", "--read", "--pair")
    ctx.note(f"mac: {rows}")
    commit = ctx.bes_wait(r"owner committed|smp_accept=1|st=OWNER_ONLY .*own=1/", 30, m)
    ctx.check("Mac committed as owner", commit is not None, commit[1] if commit else "")
    exit_line = ctx.bes_wait(
        r"hm_pairexit sent reason=paired|hm_pairexit skipped, connected follows", 30, m)
    ctx.check("paired speaks Mentra connected, or hm_pairexit skipped because Connected follows",
              exit_line is not None)
    wrong = wrong_exit_speech(ctx, m)
    ctx.check("successful pair does not speak the timeout or cancel phrase", not wrong, str(wrong))


def wait_owner_link(ctx: Ctx, mark: int, timeout: float = 60):
    """Phone-side proof the owner is back: BLE ready on the S22."""
    return ctx.log_wait(
        ctx.p, r"BLE reconnection fully ready|fully ready \(Core TX/RX|Received glasses_ready", timeout, mark
    )


def no_owner_loss(ctx: Ctx, mark: int) -> None:
    lost = phone_lines(ctx, owner_lost.REMOVED_SIGNAL_RX.pattern + r"|" + owner_lost.REJECTED_RX.pattern, mark)
    ctx.check("no removed owner-loss signal and no pairing_rejected state", not lost, str(lost[:2]))
    gm = ctx.bes(r"clear_owner|st=\w+ .*own=0/0")
    ctx.check("glasses kept the owner", not gm, str(gm[:2]))


@case("G3")
def g3_bt_toggle(ctx: Ctx):
    """S22 Bluetooth off/on: owner reconnects with zero action, no owner loss."""
    pm = ctx.p.mark()
    pmx.phone_bt(False)
    time.sleep(8)
    pmx.phone_bt(True)
    ctx.check("owner reconnects", wait_owner_link(ctx, pm, 90) is not None)
    no_owner_loss(ctx, pm)
    pmx.app_home()
    ctx.check("no Pair Again card after the Bluetooth toggle", not pair_again_visible_s22())
    ctx.shot("after_bt_toggle")


@case("G4")
def g4_airplane(ctx: Ctx):
    """S22 airplane mode on/off."""
    pm = ctx.p.mark()
    pmx.psh("cmd connectivity airplane-mode enable")
    time.sleep(10)
    pmx.psh("cmd connectivity airplane-mode disable")
    time.sleep(2)
    pmx.phone_bt(True)
    ctx.check("owner reconnects", wait_owner_link(ctx, pm, 90) is not None)
    no_owner_loss(ctx, pm)


@case("G5")
def g5_app_force_stop(ctx: Ctx):
    """Mentra App force-stop and relaunch."""
    pm = ctx.p.mark()
    pmx.app_restart()
    ctx.check("owner reconnects", wait_owner_link(ctx, pm, 90) is not None)
    no_owner_loss(ctx, pm)
    time.sleep(3)
    ctx.shot("home")


def reboot_unit3_android(ctx: Ctx) -> None:
    """Start an Android reboot of unit3 through adb (unit3 re-asserted first). The glasses tap stops; no glasses adb
    is used again until adb_return_bench() has seen unit3 back and re-asserted it. The USB cap is measured from
    this request (`ctx.t_reboot`), not from when the Bluetooth checks finish."""
    pmx.assert_unit3()
    ctx.phase_begin("reboot_request")
    pmx.gsh("reboot", timeout=10)
    ctx.phase_end("reboot_request")
    ctx.g.stop()
    ctx.t_reboot = time.time()
    ctx.phase_begin("usb_return")


def adb_return_bench(ctx: Ctx, max_s: float = USB_CAP_S, trace_ms: int = 1000, poll: float = 5) -> bool:
    """Wait only for the USB time still left since the reboot request.

    Bluetooth checks run first. If USB is already back, this adds no wait. The cap is 4 minutes from
    `ctx.t_reboot` (3 minutes logs an over-budget note). No USB by the cap ends the case BLOCKED and stops
    the run. `max_s` cannot raise the cap above 4 minutes. Poll every 5 s. BES flashes are not this path:
    USB stays gone until a physical replug.
    """
    cap = min(float(max_s), USB_CAP_S)
    t_reboot = getattr(ctx, "t_reboot", None)
    if t_reboot is None:
        t_reboot = time.time()
        ctx.t_reboot = t_reboot
    if "usb_return" not in ctx._phase_open:
        ctx.phase_begin("usb_return")
    remaining = max(0.0, t_reboot + cap - time.time())
    el = pmx.wait_unit3_return(remaining, poll)
    ctx.phase_end("usb_return")
    since = time.time() - t_reboot
    if el is None:
        reason = "unit3 USB not back within 4 min of the reboot" if cap >= USB_CAP_S else (
            f"unit3 USB not back within {cap:.0f}s of the reboot")
        ctx.blocked = reason
        ctx.stop_run_reason = reason
        ctx.bench_note("usb return within cap", False, f"absent {since:.0f}s after the reboot request (cap {cap:.0f}s)")
        ctx.note(reason)
        return False
    ctx.note(f"adb return measured: unit3 back {since:.0f} s after the reboot request")
    if since > USB_BUDGET_S:
        ctx.bench_note("usb return over the 3 min budget", False, f"{since:.0f} s after the reboot request")
    ok = pmx.wait_glasses_boot(300)  # boot_completed + ASG running, and assert_unit3() again
    ctx.bench_note("adb returned and exactly one unit3", ok, f"{since:.0f} s after the reboot request")
    if not ok:
        ctx.stop_run_reason = "unit3 booted state not confirmed after the Android reboot (bench)"
        return False
    pmx.assert_unit3()
    pmx.gsh("dumpsys battery set level 80")
    ctx.g = pmx.LogTap(pmx.GLASSES, ctx.dir / "glasses_after.log").start(clear=False)
    pmx.bes_trace(True, trace_ms)
    return True


@case("E3")
def e3_mtk_reboot(ctx: Ctx):
    """E3 (e3_mtk_reboot): S22 owner with a live link (run R_S22 first), glasses Android (MTK) reboot via adb. The
    product verdict is taken on BLE readiness, without adb: the owner reconnects with no action, no owner loss/notice,
    owner kept (bond held and re-admitted), no Pair Again card, no pairing window (advertisement flag clear). USB
    recovery is counted from the reboot request and overlaps these checks; 4 minutes with no USB is BLOCKED."""
    ctx.check("precondition S22 owner (run R_S22 first)", s22_holds_bond())
    await_live_link(ctx, "s22")
    pm = ctx.p.mark()
    tick0 = (ring_generation(ctx) or (0, 0))[0]
    reboot_unit3_android(ctx)
    ctx.phase_begin("ble_reconnect")
    ctx.check("owner reconnects after reboot (BLE readiness, no adb)", wait_owner_link(ctx, pm, 180) is not None)
    ctx.phase_end("ble_reconnect")
    time.sleep(10)
    no_owner_loss(ctx, pm)
    pmx.app_home()
    ctx.check("no Pair Again card after the reboot", not pair_again_visible_s22())
    a = ctx.adv(6)
    ctx.check("no pairing window opened by the reboot (advertisement pairing flag clear)",
              bool(a) and not a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))
    ctx.check("owner kept: the S22 still holds its bond", s22_holds_bond())
    if adb_return_bench(ctx, trace_ms=3000):
        win = ring_after_tick(ctx, tick0, r"mode_enter_done|auto-enter")
        ctx.bench_note("BES ring (after adb returned) shows no new window", not win, str(win[:2]))
        ctx.note("readiness lines: " + str(ctx.bes(r"mtk|ready|NOT_READY|not ready")[:8]))


@case("B8")
def b8_short_and_camera(ctx: Ctx):
    """Short press -> battery path, camera press -> photo; neither counts toward pairing."""
    m = ctx.g.mark()
    before = pmx.media_count()
    pmx.inject("DUC", 100)
    time.sleep(4)
    pmx.inject("DU", 100, code="fn2")
    time.sleep(12)
    after = pmx.media_count()
    ctx.check("single click forwarded to MTK (sr_keyevt/battery)",
              bool(ctx.bes(r"lxy key left click", m)), str(ctx.bes(r"left click", m)[:2]))
    ctx.check("camera press counted as camera, not pairing",
              not ctx.bes(r"3-press|mode_enter", m), "")
    ctx.note(f"media {before} -> {after}")
    ctx.check("camera press produced media", after > before, f"{before}->{after}")
    ctx.check("state unchanged", not ctx.bes(r"state OWNER_ONLY -> PAIRING", m))


@case("B2B4")
def b2_b4_no_fire(ctx: Ctx):
    """Gaps > 4 s between presses never fire; 2 presses + 5 s + 1 press does not fire."""
    m = ctx.g.mark()
    pmx.inject(pmx.presses(3, 4300), 50)
    time.sleep(14)
    pmx.inject(pmx.presses(2, 300), 50)
    time.sleep(5.5)
    pmx.inject("DU", 50)
    time.sleep(8)
    ctx.check("no pairing entry", not ctx.bes(r"3-press queue|mode_enter", m),
              str(ctx.bes(r"PWR press", m)))
    ctx.note("presses: " + str(ctx.bes(r"PWR press n=", m)))


def pairexits(ctx: Ctx, gmark: int = 0) -> list:
    """Any pairing-exit speech, including the generic pairing_exited fallback."""
    return [
        line
        for _, line in ctx.g.since(gmark)
        if (
            "pairing-ended asset dispatched" in line
            or ASSET_TIMEOUT in line
            or ASSET_CANCELLED in line
            or "pairing/pairing_exited.wav" in line
            or PHRASE_TIMEOUT in line
            or PHRASE_CANCELLED in line
            or ("hm_pairexit received" in line and "PairingAudio" in line)
        )
    ]


@case("B11")
@needs_v4
def b11_single_press_respeaks_triple_cancels(ctx: Ctx):
    """V1: inside the window one press only re-speaks the code and never closes it; a triple press toggles (cancels).

    The cancel speech is "Pairing cancelled." (hm_pairexit cancelled, BES reason toggle), once. A single press that
    cancelled the window (`cancel by single click`) is the removed behavior and fails this case.
    """
    m = ctx.g.mark()
    pmx.inject(pmx.presses(3, 300), 50)
    ctx.bes_wait(r"mode_enter_done", 20, m)
    time.sleep(6)  # long past the old 2 s grace and 4 s count reset: a single press used to cancel here
    m2 = ctx.g.mark()
    pmx.inject("single", 50)
    spoke = ctx.bes_wait(r"pairflow gesture single_press_respeak", 15, m2)
    ctx.check("single press re-speaks the code", spoke is not None, spoke[1] if spoke else "")
    time.sleep(3)
    ctx.check("single press did not close the window",
              not ctx.bes(r"cancel by single click|window_close reason=", m2), str(ctx.bes(r"cancel|window_close", m2)[:2]))
    a = ctx.adv(5)
    ctx.check("window still open after the single press", bool(a) and a["mentra"].get("pairing"),
              json.dumps((a or {}).get("mentra")))
    m3 = ctx.g.mark()
    pmx.inject("triple", 50)
    hit = ctx.bes_wait(r"3-press while pairing, cancel", 15, m3)
    ctx.check("triple press toggles the window (cancel)", hit is not None, hit[1] if hit else "")
    close = ctx.bes_wait(r"window_close reason=toggle", 10, m3)
    ctx.check("close reason is toggle", close is not None, close[1] if close else "")
    time.sleep(6)
    ctx.check("hm_pairexit reason=cancelled", bool(ctx.bes(r"hm_pairexit sent reason=cancelled", m3)))
    ex = exit_speech(ctx, PHRASE_CANCELLED, ASSET_CANCELLED, m3)
    ctx.check('cancel phrase exactly once: "Pairing cancelled."', len(ex) == 1, str(ex))
    a = ctx.adv(5)
    ctx.check("adv pairing flag cleared", bool(a) and not a["mentra"].get("pairing"), "")


@case("D6")
def d6_app_unpair_clears_glasses(ctx: Ctx):
    """NEW-4/R10: app Unpair clears the owner on the glasses and the Android bond."""
    # Poll the BES ring every second: at 3 s the unpair line fell into a ring gap.
    pmx.bes_trace(True, 1000)
    time.sleep(3)
    m = ctx.g.mark()
    ok = pmx.app_unpair()
    ctx.check("app returns to Pair glasses", ok)
    hit = ctx.bes_wait(r"clear_owner reason=phone_unpair", 20, m)
    ctx.check("glasses received unpair and cleared owner (clear_owner reason=phone_unpair)",
              hit is not None, hit[1] if hit else "")
    ctx.check("Android bond removed", not pmx.glasses_bonds())
    time.sleep(5)
    ctx.check("no pairing window opened by unpair", not ctx.bes(r"state OWNER_ONLY -> PAIRING", m))


@case("A3")
def a3_presses_during_mtk_reboot(ctx: Ctx):
    """3 presses land while Android reboots (delayed injection). Expect not-ready, no window."""
    pmx.inject(pmx.presses(3, 300), 50, delay_ms=12000)
    time.sleep(1)
    reboot_unit3_android(ctx)
    ok = adb_return_bench(ctx, trace_ms=3000)  # BES ring needs adb; USB cap is 4 min from the reboot request
    ctx.check("glasses Android back (adb)", ok)
    if not ok:
        return
    time.sleep(15)
    lines = ctx.bes(r"3-press|MTK not ready|did not answer ping|mode_enter|mark_mtk_off|android_poweroff|PWR press|dbgkey")
    ctx.note("lines: " + " || ".join(lines[:12]))
    ctx.check("presses ran while MTK was down", any("PWR press n=3" in l for l in lines), "")
    ctx.check("gesture refused while not ready", any("MTK not ready" in l or "did not answer ping" in l for l in lines), "")
    ctx.check("no window opened", not any("mode_enter_done" in l for l in lines), "")
    a = ctx.adv(5)
    ctx.check("not advertising pairing", bool(a) and not a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))


def tick_floor(ctx: Ctx, tick0: int) -> int:
    """Ticks restart at 0 when BES itself rebooted; then every line in the ring belongs to the new boot."""
    ticks = [t for t in (ring_tick(l) for l in ctx.bes("", 0)) if t is not None]
    return 0 if ticks and max(ticks) < tick0 else tick0


@case("A5")
def a5_auto_window_once_per_boot(ctx: Ctx):
    """R3 from R_NONE: reboot the glasses; exactly one auto window opens at MTK-ready; the S22 pairs in it; a second
    disconnect in the same boot (S22 Bluetooth off/on) does not reopen the window.
    PMX_A5_MODE=android (default: adb reboot) or bes_booted (the coordinator just reflashed/power-cycled BES; no reboot
    here). BES evaluates auto-pair once per BES boot (m8_pairing.cpp g_auto_pair_evaluated), so an Android-only
    reboot may not reopen the window: that is recorded as a harness gap (case OPEN), not a pass."""
    p = own_probe(ctx)
    ctx.check("precondition no owner (run R_NONE first)", p.get("own") == 0 and not s22_holds_bond(), str(p.get("line", ""))[-90:])
    mode = os.environ.get("PMX_A5_MODE", "android")
    tick0 = (ring_generation(ctx) or (0, 0))[0]
    if mode == "android":
        reboot_unit3_android(ctx)
        ok = adb_return_bench(ctx)  # the BES ring needs adb; USB cap is 4 min from the reboot request
        ctx.check("glasses Android back and still exactly one unit3", ok)
        if not ok:
            return
    else:
        ctx.note("PMX_A5_MODE=bes_booted: BES was just booted by the coordinator; observing the boot already in progress")
        tick0 = 0
    ctx.phase_begin("auto_window")
    hit = prove_wait(ctx, lambda: ring_after_tick(ctx, tick_floor(ctx, tick0), r"auto-enter pairing|mode_enter_done"), 150)
    ctx.phase_end("auto_window")
    floor = tick_floor(ctx, tick0)
    bes_rebooted = floor == 0 and tick0 > 0
    if hit is None:
        if mode == "android" and not bes_rebooted:
            ctx.gap("A5 auto window after an Android-only reboot",
                    "no `auto-enter pairing`/mode_enter_done in 150 s and the BES ring ticks continue (BES did not "
                    "reboot): auto-pair is once per BES boot, so R3 needs a BES boot (re-run with PMX_A5_MODE=bes_booted "
                    "right after a BES reflash/power cycle). Continuing with a manual 3-press window for the rest.")
        else:
            ctx.check("exactly one auto window at MTK-ready", False, "no auto-enter/mode_enter_done after the boot")
        open_window(ctx)
    else:
        time.sleep(15)
        auto = ring_after_tick(ctx, floor, r"auto-enter pairing")
        enters = ring_after_tick(ctx, floor, r"mode_enter_done")
        ctx.check("exactly one auto-enter at MTK-ready", len(auto) == 1, str(auto))
        ctx.check("exactly one window opened (one mode_enter_done)", len(enters) <= 1, str(enters))
        a = ctx.adv(5)
        ctx.check("auto window advertises pairing (flag + code)", bool(a) and a["mentra"].get("pairing"),
                  json.dumps((a or {}).get("mentra")))
    gm = ctx.g.mark()
    pmx.open_pairing_scan()
    res = pmx.app_pair(timeout=60)
    ctx.note(f"S22 app_pair: {res}")
    s22_finish_setup()
    commit = ctx.bes_wait(r"owner committed from ble bond", 20, gm)
    pr = own_probe(ctx)
    ctx.check("S22 paired in the window", bool(res.get("success_screen")) and (
        commit is not None or (pr.get("own") == 1 and s22_holds_bond())), str(res.get("steps")))
    tick1 = (ring_generation(ctx) or (0, 0))[0]
    pm = ctx.p.mark()
    pmx.phone_bt(False)
    time.sleep(8)
    pmx.phone_bt(True)
    ctx.check("owner reconnects after the second disconnect", wait_owner_link(ctx, pm, 90) is not None)
    time.sleep(10)
    no_owner_loss(ctx, pm)
    ctx.check("second disconnect in the same boot did not reopen a window",
              not ring_after_tick(ctx, tick1, r"auto-enter pairing|mode_enter_done|state OWNER_ONLY -> PAIRING"))
    a = ctx.adv(5)
    ctx.check("advertisement not in pairing mode after the second disconnect",
              bool(a) and not a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))


def prove_wait(ctx: Ctx, fn, timeout: float):
    """Poll fn() (a list of lines) until non-empty or timeout; returns the first line or None."""
    deadline = time.time() + timeout
    while True:
        lines = fn()
        if lines:
            return lines[0]
        if time.time() >= deadline:
            return None
        time.sleep(2)


@case("E1B")
def e1b_phone_cannot_pick_owned_glasses(ctx: Ctx):
    """Mac owns the glasses; S22 scan shows them as not pairable, and the Mac reconnects (E3, BLE-only owner)."""
    pm = ctx.p.mark()
    pmx.app_home()
    pmx.tap_text(r"^Pair glasses$", 8)
    time.sleep(2)
    pmx.tap_text(r"^Mentra Live$", 8)
    time.sleep(12)
    ctx.shot("scan_list")
    found = phone_lines(ctx, rf"Found compatible K900 glasses device: {re.escape(ident.name())}", pm)
    ctx.note(f"scan hits: {found[:2]}")
    ctx.check("glasses not offered as pairing-mode", not any("pairingMode=true" in l for l in found), str(found[:1]))
    pmx.psh("input keyevent KEYCODE_BACK")
    pmx.psh("input keyevent KEYCODE_BACK")
    m = ctx.g.mark()
    rows = mac_central("--hold", "10", "--read")
    ctx.note(f"mac owner reconnect: {rows}")
    r = rows[0] if rows else {}
    ctx.check("owner Mac reconnects without pairing", r.get("connected") and not r.get("dropped_by_peer"), str(r))
    ctx.check("no window opened", not ctx.bes(r"state OWNER_ONLY -> PAIRING", m))


superseded("D4B", "O4_S22_MAC", "yield/reclaim assertions no longer exist")


@case("D1NOACCEPT")
def d1_declined_dialog_never_reports_success(ctx: Ctx):
    """BUG-1: the user declines the Android pairing dialog -> Pairing Failed, no owner, no re-prompts."""
    m = enter_pairing(ctx)
    pm = ctx.p.mark()
    pmx.open_pairing_scan()
    picked = declined = False
    failed_screen = None
    deadline = time.time() + 60
    while time.time() < deadline:
        nodes = pmx.ui_nodes()
        if not picked and pmx.ui_find(rf"^{re.escape(ident.code())}$", nodes):
            pmx.tap(*pmx.ui_find(rf"^{re.escape(ident.code())}$", nodes).center)
            picked = True
        cancel = pmx.ui_find(r"^取消$", nodes)
        if cancel and pmx.ui_find(r"配对请求", nodes) and not declined:
            pmx.tap(*cancel.center)
            declined = True
            ctx.note("declined the system pairing dialog")
        if pmx.ui_find(r"^Pairing Failed$", nodes):
            failed_screen = time.strftime("%H:%M:%S")
            break
        if pmx.ui_find(r"^Success$", nodes):
            break
        time.sleep(1)
    ctx.shot("after_decline")
    ctx.check("dialog declined", declined)
    ctx.check("Pairing Failed screen shown", failed_screen is not None, str(failed_screen))
    js = [l for _, l in ctx.p.since(pm) if "PAIRING_TIMING checkpoint=" in l and "ReactNativeJS" in l]
    ctx.check("success navigation never scheduled",
              not any("navigate_success_scheduled" in l for l in js), "")
    prompts = 0
    end = time.time() + 60
    while time.time() < end:
        if pmx.ui_find(r"配对请求"):
            prompts += 1
            c = pmx.ui_find(r"^取消$")
            if c:
                pmx.tap(*c.center)
        time.sleep(3)
    ctx.check("no further pairing prompts for 60 s", prompts == 0, str(prompts))
    promoted = phone_lines(ctx, r"PairingIdentity: promotion", pm)
    ctx.check("target never promoted to default device", not promoted, str(promoted[:1]))
    ctx.check("glasses did not commit an owner", not ctx.bes(r"owner committed|own=1/", m))


@case("O1_GRACE")
@needs_v4
def o1_owner_returns_inside_window_is_refused(ctx: Ctx):
    """V4: the S22 owner has Bluetooth off while the window opens (no notice), then comes back INSIDE the window.

    It never sends pair_select, so once it encrypts with its existing LTK it is refused after 3 s with HCI 0x14
    (`owner refused ... grace_over`). Required: that refusal in the BES ring, no bond change (own=1 stays, no commit/clear_owner), the
    window still open and advertising. After the cancel (triple press) the owner reconnects with zero action and
    nothing was wiped."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    await_live_link(ctx, "s22")  # BLOCKED, not failed, when the previous owner has no live link
    pmx.phone_bt(False)
    time.sleep(6)
    wm = ctx.g.mark()
    open_window(ctx)
    ctx.check("window open while the phone is offline", ctx.bes_wait(r"mode_enter_done", 15, wm) is not None)
    pmx.phone_bt(True)
    refused_line = ctx.bes_wait(owner_lost.BES_OWNER_REFUSED_RX, 90, wm)
    ctx.check("owner refused after its one grace (HCI 0x14)", refused_line is not None,
              refused_line[1] if refused_line else "")
    ctx.check("no bond change while the owner is refused",
              not ctx.bes(r"owner committed|clear_owner|commit [123]/3|bond_deleted", wm))
    a = ctx.adv(5)
    ctx.check("window still open and advertising", bool(a) and a["mentra"].get("pairing"),
              json.dumps((a or {}).get("mentra")))
    ctx.shot("owner_inside_window")
    cm = ctx.g.mark()
    pmx.inject("triple", 50)
    ctx.check("triple press cancels", ctx.bes_wait(r"3-press while pairing, cancel", 15, cm) is not None)
    time.sleep(8)
    up = link_state(ctx.p.since(0), LINK_UP_RX["s22"], LINK_DOWN_RX["s22"])
    deadline = time.time() + 120
    while not up and time.time() < deadline:
        time.sleep(3)
        up = link_state(ctx.p.since(0), LINK_UP_RX["s22"], LINK_DOWN_RX["s22"])
    ctx.check("owner reconnects with zero action after the window", bool(up))
    ctx.check("no Pair Again card", not pair_again_visible_s22())
    ctx.check("glasses did not commit any owner", not ctx.bes(r"owner committed", wm))


@case("O1_BTOFF")
@needs_v4
def o1_owner_offline_across_window(ctx: Ctx):
    """O1 with the owner offline for the whole window: Bluetooth off, 3 presses, the window times out, Bluetooth on.

    Nothing was wiped (V2), the advertisement pairing flag is clear and OWNER_CHANGED clear, and the owner
    reconnects with zero action: no Pair Again card, no connect prompt."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    await_live_link(ctx, "s22")
    pmx.phone_bt(False)
    time.sleep(6)
    wm = ctx.g.mark()
    open_window(ctx)
    hit = ctx.bes_wait(r"window_close reason=timeout", 150, wm)
    ctx.check("window closed by timeout", hit is not None, hit[1] if hit else "")
    ctx.check("no bond change", not ctx.bes(r"owner committed|clear_owner|commit [123]/3|bond_deleted", wm))
    pmx.phone_bt(True)
    deadline = time.time() + 120
    up = None
    while not up and time.time() < deadline:
        time.sleep(3)
        up = link_state(ctx.p.since(0), LINK_UP_RX["s22"], LINK_DOWN_RX["s22"])
    ctx.check("owner reconnects with zero action", bool(up))
    a = ctx.adv(5)
    m2 = (a or {}).get("mentra", {}) if a else {}
    ctx.check("adv: pairing flag clear, OWNER_CHANGED clear", bool(a) and not m2.get("pairing") and not m2.get("owner_changed"),
              json.dumps(m2))
    ctx.shot("after_rejoin")
    ctx.check("no Pair Again card", not pair_again_visible_s22())


superseded("BTOFF_REJOIN", "O1_GRACE", "the missed-notice owner-loss card no longer exists")
superseded("BTOFF_REJOIN_LOCKED", "O1_BTOFF", "forget-on-entry plus single-click close (ownerless and locked) is removed")


superseded("D4FIX", "O1_S22", "the 300 s yield no longer exists; one 120 s window")


@case("D5D7")
@needs_v4
def d5_d7_pair_again_from_card(ctx: Ctx):
    """S7: after a takeover the old S22 shows only Pair Again. Tap it (no confirm modal), pair, the card clears.

    The takeover itself is O4 (the Mac stands in for phone B). This case needs the S22 to start from the Pair Again
    card: run O4_S22_MAC right before it (or set PMX_D5D7_PREPARED=1 when the card is already up)."""
    if os.environ.get("PMX_D5D7_PREPARED") != "1":
        ctx.check("precondition S22 owner", r_s22(ctx))
        time.sleep(5)
        ios.mac_forget()
        run_transition(
            ctx, "s22", scenario="takeover",
            trigger=lambda: open_window(ctx, settle=False),
            during=lambda: mac_new_owner(ctx),
            new_owner_bond=ios.mac_bonded,
        )
    pmx.app_home()
    ctx.check("precondition Pair Again card visible", pair_again_visible_s22())
    ctx.shot("card_before_pair_again")
    pmx.inject(pmx.presses(3, 300), 50)  # a fresh window for the S22 to join
    time.sleep(6)
    tap_pair_again_s22()
    gm = ctx.g.mark()
    res = pmx.app_pair(timeout=60)
    ctx.note(f"app_pair: {res}")
    ctx.check("S22 Success screen", bool(res.get("success_screen")), str(res.get("steps")))
    ex = ctx.bes_wait(r"hm_pairexit sent reason=paired|hm_pairexit skipped, connected follows", 30, gm)
    ctx.check("glasses committed S22 again (Mentra connected, or hm_pairexit skipped)", ex is not None)
    wrong = wrong_exit_speech(ctx, gm)
    ctx.check("successful pair does not speak the timeout or cancel phrase", not wrong, str(wrong))
    ctx.check("BES owner committed", ctx.bes_wait(r"owner committed from ble bond", 15, gm) is not None
              or (own_probe(ctx).get("own") == 1 and s22_holds_bond()))
    s22_finish_setup()
    time.sleep(5)
    ctx.shot("home_after_pair_again")
    ctx.check("Pair Again card gone", not pair_again_visible_s22())


def make_s22_owner(ctx: Ctx) -> bool:
    ios.bridge(False)  # the iOS radio must not hold the glasses' single BLE slot
    pmx.app_home()
    if pair_again_visible_s22():
        tap_pair_again_s22()
    pmx.open_pairing_scan()
    m = ctx.g.mark()
    pmx.inject(pmx.presses(3, 300), 50)
    time.sleep(6)
    res = pmx.app_pair(timeout=60, pick_timeout=15)
    ctx.note(f"make_s22_owner: {res}")
    if "pick_timeout" in res["steps"]:
        ctx.shot("r_s22_no_pick")
    for _ in range(6):
        n = pmx.ui_nodes()
        lb = pmx.ui_find(r"Open debugger to view warnings", n)
        if lb:
            pmx.tap(lb.bounds[2] - 60, (lb.bounds[1] + lb.bounds[3]) // 2)
            time.sleep(1)
            continue
        b = pmx.ui_find(r"^(Continue setup|Continue|Skip|Done|Next|Got it)$", n)
        if not b:
            break
        pmx.tap(*b.center)
        time.sleep(2)
    return res["success_screen"]


@case("OWN")
def own_s22(ctx: Ctx):
    """Setup: make the S22 the owner."""
    import subprocess

    subprocess.run(["blueutil", "--unpair", ios.glasses_mac()], capture_output=True)
    ctx.check("S22 is owner", make_s22_owner(ctx))


def answer_mac_sheet_while(fn, interval: float = 1.0):
    """Run fn() while a helper answers the macOS 'Connection Request' pairing sheet (Connect), like a user."""
    import threading

    stop = threading.Event()
    answered = []

    def loop():
        while not stop.is_set():
            try:
                if ios.mac_sheet():
                    answered.append(ios.mac_sheet_click("Connect"))
            except Exception:  # noqa: BLE001
                pass
            stop.wait(interval)

    th = threading.Thread(target=loop, daemon=True)
    th.start()
    try:
        return fn(), len(answered)
    finally:
        stop.set()
        th.join(timeout=10)


def mac_new_owner(ctx: Ctx, settle_s: float = 3.0, hold_s: int = 25):
    """The Mac bonds inside the open window as the new owner (stand-in for a second phone)."""
    time.sleep(settle_s)
    (rows, sheets) = answer_mac_sheet_while(lambda: mac_central("--hold", str(hold_s), "--read", "--pair"))
    ctx.note(f"mac new owner: {rows}; macOS sheets answered: {sheets}")
    return rows


@case("O4_S22_MAC")
@needs_v4
def o4_s22_owner_mac_takes_over(ctx: Ctx):
    """O4: S22 owner (A); 3 presses; the Mac (bare central, stand-in for phone B) takes the window.

    BES commits B in the V2 order (1/3 delete A's BLE bond, 2/3 Classic, 3/3 other links), closes `paired` and sets
    OWNER_CHANGED. A stays on the popup-then-nothing path in the window, then reaches pairing_rejected and shows
    only Pair Again within 10 s, with no connect attempt for the next 20 s."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    time.sleep(5)
    ios.mac_forget()  # clean Mac bond for the confirmed glasses MAC only
    gm = ctx.g.mark()
    res = run_transition(
        ctx, "s22", scenario="takeover",
        trigger=lambda: open_window(ctx, settle=False),
        during=lambda: mac_new_owner(ctx),
        new_owner_bond=ios.mac_bonded,
    )
    rows = res.during_value or []
    ctx.check("Mac connected inside the window", bool(rows) and bool(rows[0].get("connected")), str(rows[:1]))
    ctx.check("hm_pairexit reason=paired, or skipped because Connected follows",
              ctx.bes_wait(r"hm_pairexit sent reason=paired|hm_pairexit skipped, connected follows", 10, gm)
              is not None)
    wrong = wrong_exit_speech(ctx, gm)
    ctx.check("takeover does not speak the timeout or cancel phrase", not wrong, str(wrong))
    ctx.check("Mac bond created", ios.mac_bonded())
    pmx.app_home()
    time.sleep(2)
    ctx.shot("s22_pair_again_card")


superseded("D4BFIX", "O4_S22_MAC", "R15 stand-down assertions replaced by the v4 takeover observation")


# ------------------------------------------------- cross-platform (iOS simulator + S22)
#
# The iOS side is the Mentra App in the iOS Simulator; its BLE runs on the Mac radio
# through the ImpossiBLE passthrough helper, so "iOS bond" == the Mac's bond with the configured glasses.


def open_window(ctx: Ctx, delay_ms: int = 0, settle: bool = True) -> bool:
    """Exactly one 3-press gesture. Never repeat it: extra presses can close or reset the window.
    settle=False returns right after the broadcast (window_transition measures from the phone's pairing_mode line)."""
    pmx.inject(pmx.presses(3, 300), 50, delay_ms=delay_ms)
    if settle:
        time.sleep(3 + delay_ms / 1000)
    return True


def own_probe(ctx: Ctx) -> dict:
    """One injected short press; the click-window dump carries st= and own=. V1: a press inside a window only
    re-speaks the code (it never closes it), and an owner is retained (not forgotten) on entry, so the probe is safe
    in both states."""
    import re

    hit = None
    for _ in range(2):
        m = ctx.g.mark()
        pmx.inject(pmx.presses(1), 50)
        hit = ctx.bes_wait(r"click_window_end st=\w+ .*own=\d/\d", 20, m)
        if hit:
            break
    out = {"st": None, "own": None, "line": hit[1] if hit else ""}
    if hit:
        mm = re.search(r"st=(\w+) .*own=(\d)/(\d)", hit[1])
        if mm:
            out = {"st": mm.group(1), "own": int(mm.group(2)), "classic": int(mm.group(3)), "line": hit[1]}
    ctx.note(f"own_probe: {out}")
    return out


def s22_holds_bond() -> bool:
    return bool(pmx.glasses_bonds())


def s22_finish_setup() -> None:
    for _ in range(6):
        n = pmx.ui_nodes()
        lb = pmx.ui_find(r"Open debugger to view warnings", n)
        if lb:
            pmx.tap(lb.bounds[2] - 60, (lb.bounds[1] + lb.bounds[3]) // 2)
            time.sleep(1)
            continue
        b = pmx.ui_find(r"^(Continue setup|Continue|Skip|Done|Next|Got it)$", n)
        if not b:
            break
        pmx.tap(*b.center)
        time.sleep(2)


def ios_pair_hooks(ctx: Ctx, gm: int) -> dict:
    """window_open / window_closed callbacks for ios.pair. Read-only: BES ring, ASG log, Mac advertisement scan.
    Nothing here presses a glasses button (one 3-press gesture per window, never retried)."""
    state = {"adv_clear": 0, "last_adv": 0.0}

    def window_open():
        a = pmx.glasses_adv(seconds=3)
        m = (a or {}).get("mentra", {})
        ctx.note(f"rescan check: Mac advertisement {m if a else 'absent'}")
        return bool(a) and bool(m.get("pairing"))

    def window_closed():
        closes = ctx.bes(r"window_close reason=\w+", gm)
        if closes:
            return closes[-1].strip()[-60:]
        exits = [l for _, l in ctx.g.since(gm) if "hm_pairexit received reason=" in l]
        if exits:
            return exits[-1].strip()[-70:]
        now = time.time()
        if now - state["last_adv"] >= 10:
            state["last_adv"] = now
            a = pmx.glasses_adv(seconds=3)
            if a and not a.get("mentra", {}).get("pairing"):
                state["adv_clear"] += 1
            elif a:
                state["adv_clear"] = 0
            if state["adv_clear"] >= 2:
                return "advertisement pairing flag cleared"
        return None

    return {"window_open": window_open, "window_closed": window_closed}


def ios_pair(ctx: Ctx, timeout: float = 180):
    """Simulator app pairs with the glasses inside an open window. Returns (commit_hit, ui_result).

    No early abort: Pair Audio alone can take ~90 s and the sheet must be answered, so the run ends on the
    Success/Failed screen or the timeout, never on a first decisive line. `commit_hit` is the BES line;
    when the BES ring dropped it, `ui_result["commit_source"]` says the commit rests on pairing_info only
    (enough for setup recipes, NOT proof of a BES commit: window_transition decides that)."""
    ios.require_fresh_advert()
    gm, im = ctx.g.mark(), ctx.i.mark()
    res = ios.pair(timeout=timeout, **ios_pair_hooks(ctx, gm))
    ctx.note(f"ios.pair: {res}")
    if res.get("rescans"):
        ctx.note(f"stale advert: {res['rescans']} rescan(s), steps {res['steps']}")
    if res.get("window_closed_before_pick"):
        ctx.check("iOS picked the glasses before the window closed", False, res["window_closed_before_pick"])
    if res.get("t_pick"):
        ctx.note(f"pick -> end {time.time() - res['t_pick']:.0f}s")
    ctx.ishot("pair_flow_end")
    commit = ctx.bes_wait(r"owner committed from ble bond", 15, gm)
    info = ctx.i.grep(r"pairing_info confirms owner commit", im)
    res["pairing_info"] = len(info)
    res["commit_source"] = "bes" if commit else ("pairing_info" if info else "none")
    ctx.note(f"ios pairing_info lines: {len(info)}")
    if commit is None and info and res.get("success_screen"):
        commit = (time.time(), "pairing_info confirms owner commit (BES ring dropped the commit line)")
    ios.finish_setup()
    return commit, res


def ios_success_after_pairing_info(ctx: Ctx, im: int) -> bool:
    """Success navigation must not be scheduled before native pairing_info confirmed the commit."""
    lines = ctx.i.since(im)
    t_info = next((t for t, l in lines if "pairing_info confirms owner commit" in l), None)
    t_nav = next((t for t, l in lines if "navigate_success_scheduled" in l), None)
    ctx.note(f"ios pairing_info at {t_info}, navigate_success_scheduled at {t_nav}")
    if t_nav is None:
        return t_info is not None
    return t_info is not None and t_info <= t_nav


def r_none(ctx: Ctx) -> bool:
    """R_NONE: no owner anywhere. Owner phone unpairs in its app; both bonds removed."""
    if ios.mac_bonded() or ios.pair_again_card():
        ios.unpair()
    if s22_holds_bond() or pair_again_visible_s22():
        pmx.app_unpair()
    ios.mac_forget()
    time.sleep(3)
    p = own_probe(ctx)
    ok = p.get("own") == 0 and not s22_holds_bond() and not ios.mac_bonded()
    ctx.note(f"R_NONE -> {ok}")
    return ok


def r_s22(ctx: Ctx) -> bool:
    p = own_probe(ctx)
    if p.get("own") == 1 and s22_holds_bond() and not ios.mac_bonded():
        ctx.note("R_S22: already S22 owner")
        return True
    ios.mac_forget()
    ok = False
    for attempt in (1, 2):
        ok = make_s22_owner(ctx)
        time.sleep(5)
        p = own_probe(ctx)
        ok = ok and p.get("own") == 1 and s22_holds_bond()
        if ok:
            break
        ctx.note(f"R_S22 attempt {attempt} failed; retrying")
    ctx.note(f"R_S22 -> {ok}")
    return ok


def r_ios(ctx: Ctx) -> bool:
    # No shortcut: a Mac bond plus own=1 can also mean the S22 owns the glasses, so always re-pair iOS.
    ctx.note(f"reset_ios_side: {ios.reset_ios_side()}")
    ios.open_pairing_scan()
    open_window(ctx)
    time.sleep(2)
    commit, res = ios_pair(ctx)
    # pairing_info on the phone is the commit evidence; the BES ring line is flaky and a probe press
    # while the iPhone holds the link is not reliable.
    ok = commit is not None and bool(res.get("success_screen")) and ios.mac_bonded()
    ctx.note(f"R_IOS -> {ok}")
    return ok


@case("X2")
def x2_ios_declines_sheet(ctx: Ctx):
    """iOS declines the system pairing sheet."""
    ctx.not_testable("simulator BLE bonds through macOS, which pairs Just Works without a sheet; nothing to decline")


@case("D3")
def d3_ios_unanswered_sheet(ctx: Ctx):
    """Unbonded central holds the slot ~60 s with the sheet unanswered."""
    ctx.not_testable("no unbonded central available: the only second central is the Mac, which auto-bonds inside the window")


@case("R_S22")
def setup_r_s22(ctx: Ctx):
    """Reset recipe: S22 is the owner."""
    ctx.check("S22 is owner", r_s22(ctx))


@case("R_IOS")
def setup_r_ios(ctx: Ctx):
    """Reset recipe: iOS (simulator via Mac radio) is the owner."""
    ctx.check("iOS is owner", r_ios(ctx))


@case("R_NONE")
def setup_r_none(ctx: Ctx):
    """Reset recipe: no owner."""
    ctx.check("no owner", r_none(ctx))


@case("E1")
def e1_ios_stranger(ctx: Ctx):
    """S22 owner; the iOS app (not owner, no bond) tries to pair outside any window: rejected."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    ios.mac_forget()
    gm, im = ctx.g.mark(), ctx.i.mark()
    ios.app_restart()
    res = ios.pair(timeout=40)
    ctx.note(f"ios.pair (outside window): {res}")
    ctx.ishot("stranger_attempt")
    texts = ios.visible_texts()
    ctx.note(f"ios screen: {texts[:12]}")
    reached = "scan:True" in res["steps"]
    ctx.check("iOS app reached the scan list (case is valid)", reached, str(res["steps"]))
    ctx.check("iOS never reaches Success", reached and not res["success_screen"])
    rows = [t for t in texts if re_s(re.escape(ident.code()), t) and not re_s(r"not in pairing mode", t)]
    ctx.check("iOS scan does not offer the glasses as pairable", reached and not rows, str(texts[:10]))
    ctx.check("glasses kept the S22 owner", not ctx.bes(r"owner committed|clear_owner", gm))
    ctx.check("no Mac bond created", not ios.mac_bonded())
    rej = ctx.bes(r"reject|drop|auth", gm)
    ctx.note(f"BES reject lines: {rej[:4]}")
    a = ctx.adv(5)
    m2 = (a or {}).get("mentra", {})
    ctx.note(f"adv: {m2}")
    ctx.check("adv not in pairing mode (R12)", not a or not m2.get("pairing"), json.dumps(m2))
    ios.tap_text(r"^Back$", 2)


def find_card_ios() -> bool:
    return ios.find(r"^Pair Again$") is not None


def re_s(pattern: str, text: str) -> bool:
    import re

    return re.search(pattern, text, re.I) is not None


@case("E2")
def e2_classic_stranger(ctx: Ctx):
    """S22 owner; the Mac (stranger) opens a Classic connection: rejected, no window."""
    import subprocess

    ctx.check("precondition S22 owner", r_s22(ctx))
    ios.mac_forget()
    gm = ctx.g.mark()
    proc = subprocess.run(["blueutil", "--connect", ios.glasses_mac()], capture_output=True, text=True, timeout=40)
    ctx.note(f"blueutil --connect rc={proc.returncode} err={proc.stderr.strip()[:120]}")
    time.sleep(8)
    conn = subprocess.run(["blueutil", "--is-connected", ios.glasses_mac()], capture_output=True, text=True).stdout.strip()
    ctx.check("Classic link not established", conn != "1", f"is-connected={conn}")
    acl = ctx.bes(r"classic|acl|reject|NOT_ACCESSIBLE|BT-PAIR", gm)
    ctx.note(f"BES classic lines: {acl[:5]}")
    ctx.check("no window opened", not ctx.bes(r"state OWNER_ONLY -> PAIRING", gm))
    ctx.check("owner unchanged", not ctx.bes(r"owner committed|clear_owner", gm))
    ios.mac_forget()


def ios_takeover_during(ctx: Ctx, settle_s: float = 4.0):
    """New-owner action for the iPhone side: sit out the settle time, then pair from the open scan list."""
    def run():
        time.sleep(settle_s)
        return ios_pair(ctx)
    return run


@case("O4_S22_IOS")
@needs_v4
def o4_s22_owner_ios_takes_over(ctx: Ctx):
    """O4 (S22 half of the two-platform smoke): S22 owner (A) -> 3 presses -> the iOS app (B) pairs.

    A sees the once-per-window popup, then pairing_rejected with only Pair Again after the commit; iOS shows
    Success only after pairing_info confirmed the commit. A paired close skips hm_pairexit so Connected
    is the only success prompt."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    ios.mac_forget()
    ios.reset_ios_side()
    ios.open_pairing_scan()
    gm, im = ctx.g.mark(), ctx.i.mark()
    res = run_transition(
        ctx, "s22", scenario="takeover",
        trigger=lambda: open_window(ctx, settle=False),
        during=ios_takeover_during(ctx),
        new_owner_bond=ios.mac_bonded,
    )
    commit, pres = res.during_value or (None, {})
    ctx.check("iOS Success screen", bool(pres.get("success_screen")), str(pres.get("steps")))
    ctx.check("iOS pairing_info seen", pres.get("pairing_info", 0) > 0, str(pres.get("commit_source")))
    ctx.check("iOS Success only after pairing_info", ios_success_after_pairing_info(ctx, im))
    ex = [l for _, l in ctx.g.since(gm) if "hm_pairexit received reason=" in l]
    skipped = ctx.bes(r"hm_pairexit skipped, connected follows", gm)
    ctx.check(
        "hm_pairexit once, or skipped because Connected follows",
        len(ex) == 1 or (len(ex) == 0 and bool(skipped)),
        str([e[-60:] for e in ex]),
    )
    ctx.check("Mac (iOS) bond created", ios.mac_bonded())
    pmx.app_home()
    time.sleep(3)
    ctx.shot("s22_after_takeover")
    ctx.ishot("ios_home")


superseded("X6", "O4_S22_IOS", "R15 stand-down assertions replaced by the v4 takeover observation")


@case("X3")
def x3_ios_reconnects(ctx: Ctx):
    """iOS owner reconnects with no user action: app relaunch, Bluetooth toggle, background + ASG reboot."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    rx = r"Received glasses_ready|pairing_info confirms owner commit|glasses_ready before owner"
    im = ctx.i.mark()
    ios.app_restart()
    ctx.check("reconnect after app relaunch", ctx.ios_wait(rx, 60, im) is not None)
    time.sleep(5)
    im = ctx.i.mark()
    ios.bridge(False)
    time.sleep(10)
    ios.bridge(True)
    ctx.check("reconnect after Bluetooth off/on", ctx.ios_wait(rx, 90, im) is not None)
    time.sleep(5)
    await_live_link(ctx, "ios")
    im = ctx.i.mark()
    ios.simctl("launch", ios.SIM, "com.apple.Preferences")
    time.sleep(3)
    reboot_unit3_android(ctx)
    ctx.phase_begin("ble_reconnect")
    got = ctx.ios_wait(rx, 180, im)
    ctx.phase_end("ble_reconnect")
    ctx.check("reconnect (app backgrounded) after ASG reboot (BLE readiness, no adb)", got is not None)
    lost = ctx.i.grep(owner_lost.REJECTED_RX.pattern + r"|" + owner_lost.PAIRING_MODE_RX.pattern, 0)
    ctx.check("no pairing_mode / pairing_rejected state", not lost, str(lost[:1]))
    ios.home()
    ctx.check("no Pair Again card", find_card_ios() is False)
    ctx.ishot("after_x3")
    adb_return_bench(ctx)


@case("NEW5")
def new5_rf_loss_not_owner_loss(ctx: Ctx):
    """RF loss is not owner loss: the iOS radio is gone for 2 minutes, then returns."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    im, gm = ctx.i.mark(), ctx.g.mark()
    ios.bridge(False)
    ctx.note("radio away for 120 s")
    time.sleep(120)
    ios.bridge(True)
    got = ctx.ios_wait(r"Received glasses_ready|pairing_info confirms owner commit", 120, im)
    ctx.check("reconnects after the outage", got is not None)
    ctx.check("no pairing_rejected state", not ctx.i.grep(owner_lost.REJECTED_RX.pattern, im))
    ctx.check("glasses kept the owner", not ctx.bes(r"clear_owner|owner committed", gm))
    ctx.check("no Pair Again card", not ios.pair_again_card())


@case("O4_IOS_S22")
@needs_v4
def o4_ios_owner_s22_takes_over(ctx: Ctx):
    """O4 (simulator-app half of the two-platform smoke): iOS owner (A) -> 3 presses -> the S22 (B) pairs.

    The iOS app sees the popup, then pairing_rejected with only Pair Again within 10 s after the commit and makes no
    connect attempt for 20 s."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    clear_s22_card(ctx)
    pmx.open_pairing_scan()
    gm, im = ctx.g.mark(), ctx.i.mark()
    res = run_transition(
        ctx, "ios", scenario="takeover",
        trigger=lambda: open_window(ctx, settle=False),
        during=lambda: s22_takeover_pair(ctx),
        new_owner_bond=s22_holds_bond,
    )
    commit, pres = res.during_value or (None, {})
    ctx.check("S22 Success screen", bool(pres.get("success_screen")), str(pres.get("steps")))
    ctx.check("S22 bond created", s22_holds_bond())
    ctx.ishot("pair_again_card")
    texts = ios.visible_texts()
    ctx.note(f"iOS card text: {texts[:15]}")
    ctx.check("iOS card offers Pair Again and nothing to unpair", any(re_s(r"^Pair Again$", t) for t in texts)
              and not any(re_s(r"^Unpair", t) for t in texts), str(texts[:10]))
    p = own_probe(ctx)
    ctx.check("S22 kept ownership", p.get("own") == 1 and s22_holds_bond(), p.get("line", "")[-80:])


superseded("X5", "O4_IOS_S22", "R15 stand-down assertions replaced by the v4 takeover observation")


def clear_s22_card(ctx: Ctx) -> None:
    """If the S22 still shows the Pair Again card, tap it so the scan starts from a clean state (no confirm modal)."""
    if pair_again_visible_s22():
        tap_pair_again_s22()


def s22_takeover_pair(ctx: Ctx, settle_s: float = 5.0):
    """New-owner action for the S22 side: settle, pick the glasses on the open scan list, finish setup."""
    time.sleep(settle_s)
    gm = ctx.g.mark()
    res = pmx.app_pair(timeout=60)
    ctx.note(f"S22 app_pair: {res}")
    commit = ctx.bes_wait(r"owner committed from ble bond", 15, gm)
    s22_finish_setup()
    return commit, res


@case("X7A")
def x7a_settings_detour(ctx: Ctx):
    """After a takeover (run right after O4_IOS_S22 while the iOS Pair Again card is live): forget in Settings (Mac
    bond), Pair Again from the card, 3 presses -> iOS owner again. The S22 (owner from O4_IOS_S22) is the previous
    owner of this window and takes the Pair Again card. Ends with the iPhone as owner."""
    if not ios.pair_again_card():
        ctx.not_testable("needs the iOS Pair Again card from O4_IOS_S22")
        return
    ios.mac_forget()
    ctx.check("bond forgotten", not ios.mac_bonded())
    ios.pair_again_from_card()
    ios.open_pairing_scan()
    gm, im = ctx.g.mark(), ctx.i.mark()
    if s22_holds_bond():
        res = run_transition(
            ctx, "s22", scenario="takeover",
            trigger=lambda: open_window(ctx, settle=False),
            during=ios_takeover_during(ctx, settle_s=2.0),
            new_owner_bond=ios.mac_bonded,
        )
        commit, pres = res.during_value or (None, {})
    else:
        ctx.note("S22 holds no bond: no previous Android owner, takeover assertions for S22 skipped")
        open_window(ctx)
        time.sleep(2)
        commit, pres = ios_pair(ctx)
    ctx.check("iOS owner again (Success + pairing_info)",
              bool(pres.get("success_screen")) and pres.get("pairing_info", 0) > 0, str(pres.get("steps")))
    ctx.check("Success only after pairing_info", ios_success_after_pairing_info(ctx, im))
    ctx.check("Mac (iOS) bond created", ios.mac_bonded())
    ctx.check("Pair Again card gone", not ios.pair_again_card())
    ctx.ishot("ios_owner_again")


@case("X7B")
def x7b_forget_while_owner(ctx: Ctx):
    """iOS owner forgets the glasses in Settings. Pass: (a) owner kept + guidance, or (b) bond_deleted + guidance."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    gm, im = ctx.g.mark(), ctx.i.mark()
    ios.mac_forget()
    ctx.note("forgot the Mac bond while connected; waiting 90 s for the app to react")
    time.sleep(90)
    cleared = ctx.bes(r"clear_owner reason=\w+", gm)
    committed = ctx.bes(r"owner committed", gm)
    windows = ctx.bes(r"state OWNER_ONLY -> PAIRING", gm)
    lost = ctx.i.grep(owner_lost.REJECTED_RX.pattern, im)
    p = own_probe(ctx)
    texts = ios.home()
    ctx.ishot("after_forget")
    ctx.note(f"BES clear={cleared[:2]} commit={committed[:1]} window={windows[:1]} own={p}")
    ctx.note(f"iOS pairing_rejected lines={lost[:2]} screen={texts[:12]}")
    outcome_a = p.get("own") == 1 and not cleared
    outcome_b = any("bond_deleted" in c for c in cleared) and not windows
    ctx.note(f"outcome: {'a (owner kept)' if outcome_a else 'b (bond_deleted)' if outcome_b else 'neither'}")
    ctx.check("allowed outcome (a) or (b)", outcome_a or outcome_b)
    ctx.check("no silent ownership change to another phone", not committed)
    ctx.check("no window opened by itself", not windows)
    sheets = ctx.i.grep(r"pairing (request|sheet)|Pair\?", im)
    ctx.check("no sheet loop", len(sheets) <= 1, str(len(sheets)))
    guided = any(re_s(r"pair again|press|another phone|forget|pair glasses", t) for t in texts) or bool(
        ctx.i.grep(r"Glasses connected|Received glasses_ready", im))
    ctx.check("app is not dead-ended (guidance or reconnected)", guided, str(texts[:8]))


@case("X4")
def x4_ios_unpair(ctx: Ctx):
    """iOS app Unpair: clear_owner reason=phone_unpair; forget hint; window behaviour recorded."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    gm = ctx.g.mark()
    ok = ios.unpair()
    ctx.ishot("after_unpair")
    texts = ios.visible_texts()
    ctx.check("app returns to Pair glasses", ok, str(texts[:8]))
    hit = ctx.bes_wait(r"clear_owner reason=phone_unpair", 20, gm)
    p = None if hit else own_probe(ctx)  # the ring can drop the line; own=0 after the unpair is the state evidence
    ctx.check("glasses cleared owner (phone_unpair)", hit is not None or (p or {}).get("own") == 0,
              hit[1] if hit else str(p))
    hint = any(re_s(r"forget in settings|forget mentra live", t) for t in texts)
    ctx.note(f"forget hint after a user unpair (informational; the Pair Again card carries no forget guidance, "
             f"liveOwnerLostIosBluetooth): {hint}")
    time.sleep(8)
    win = ctx.bes(r"state OWNER_ONLY -> PAIRING|mode_enter_done", gm)
    ctx.note(f"window after unpair (R3 opens on the next MTK-ready, not immediately): {win[:2]}")
    ios.mac_forget()


@case("X1")
def x1_first_ios_pair(ctx: Ctx):
    """No owner -> 3 presses -> iOS pairs; S22 cannot pick the owned glasses."""
    p = own_probe(ctx)
    if p.get("own") != 0:
        ctx.check("precondition no owner", r_none(ctx))
    ios.mac_forget()
    ios.open_pairing_scan()
    im = ctx.i.mark()
    open_window(ctx)
    time.sleep(2)
    commit, res = ios_pair(ctx)
    ctx.check("iOS owner", commit is not None and res["success_screen"], str(res["steps"]))
    ctx.check("Success only after pairing_info", ios_success_after_pairing_info(ctx, im))
    time.sleep(5)
    pm = ctx.p.mark()
    pmx.app_home()
    pmx.tap_text(r"^Pair glasses$", 8)
    time.sleep(2)
    pmx.tap_text(r"^Mentra Live$", 8)
    time.sleep(12)
    ctx.shot("s22_scan")
    found = phone_lines(ctx, rf"Found compatible K900 glasses device: {re.escape(ident.name())}", pm)
    ctx.check("S22 is not offered the glasses as pairable", not any("pairingMode=true" in l for l in found), str(found[:1]))
    pmx.psh("input keyevent KEYCODE_BACK")
    pmx.psh("input keyevent KEYCODE_BACK")


@case("O1_IOS")
@needs_v4
def o1_ios_owner_window_times_out(ctx: Ctx):
    """O1 on iOS: iOS owner (A); 3 presses; nobody pairs; the single 120 s window times out.

    The owner is kept (nothing wiped), BES closes with reason `timeout` near 120 s, hm_pairexit timeout once
    ("Pairing mode ended. No new phone paired."), A shows the popup once, returns to normal and reconnects with
    its keys; no Pair Again card, no connect prompt."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    gm = ctx.g.mark()
    res = run_transition(
        ctx, "ios", scenario="timeout",
        trigger=lambda: open_window(ctx, settle=False),
        adv=lambda: ctx.adv(5),
    )
    ctx.ishot("o1_ios_after_timeout")
    ctx.check("glasses did not commit any owner", not ctx.bes(r"owner committed", gm))


@case("O1_S22")
@needs_v4
def o1_s22_owner_window_times_out(ctx: Ctx):
    """O1 on Android: S22 owner (A); 3 presses; nobody pairs; the single 120 s window times out.

    Same assertions as O1_IOS: owner kept, `window_close reason=timeout` near 120 s, hm_pairexit timeout once, the
    popup once, A back to normal and reconnected with zero action, no Pair Again card."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    pmx.app_home()
    gm = ctx.g.mark()
    res = run_transition(
        ctx, "s22", scenario="timeout",
        trigger=lambda: open_window(ctx, settle=False),
        adv=lambda: ctx.adv(5),
    )
    ctx.shot("o1_s22_after_timeout")
    ctx.check("glasses did not commit any owner", not ctx.bes(r"owner committed", gm))


@case("O2_IOS")
@needs_v4
def o2_ios_owner_cancel_by_triple(ctx: Ctx):
    """O2 on iOS: iOS owner (A); 3 presses, then a triple press ~6 s in toggles the window closed.

    Owner kept, `3-press while pairing, cancel` and `window_close reason=toggle`, hm_pairexit cancelled once
    ("Pairing cancelled."), A returns to normal and reconnects, no Pair Again card, no connect prompt."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    gm = ctx.g.mark()
    res = run_transition(
        ctx, "ios", scenario="cancel", cancel_at_s=6.0,
        trigger=lambda: open_window(ctx, settle=False),
        adv=lambda: ctx.adv(5),
    )
    ctx.ishot("o2_ios_after_cancel")
    ctx.check("glasses did not commit any owner", not ctx.bes(r"owner committed", gm))


@case("O2_S22")
@needs_v4
def o2_s22_owner_cancel_by_triple(ctx: Ctx):
    """O2 on Android: same as O2_IOS with the S22 as the owner."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    pmx.app_home()
    gm = ctx.g.mark()
    res = run_transition(
        ctx, "s22", scenario="cancel", cancel_at_s=6.0,
        trigger=lambda: open_window(ctx, settle=False),
        adv=lambda: ctx.adv(5),
    )
    ctx.shot("o2_s22_after_cancel")
    ctx.check("glasses did not commit any owner", not ctx.bes(r"owner committed", gm))


superseded("X11", "O2_IOS", "cancel is a triple press now; a single click only re-speaks the code")
superseded("X10", "O1_IOS", "the owner is kept and the window times out; no owner-lost card, no ownerless end state")


def ring_tick(line: str) -> int | None:
    m = re.match(r"\s*(\d+) \|", line)
    return int(m.group(1)) if m else None


def ring_generation(ctx: Ctx, mark: int = 0):
    """(tick, window generation) of the newest BES ring line that carries `generation=`; None when empty."""
    best = None
    for line in ctx.bes(r"generation=\d+", mark):
        t = ring_tick(line)
        g = re.search(r"generation=(\d+)", line)
        if t is not None and g and (best is None or t >= best[0]):
            best = (t, int(g.group(1)))
    return best


def ring_after_tick(ctx: Ctx, tick: int, pattern: str, mark: int = 0) -> list:
    """BES lines newer than `tick`: the ring replays history on every dump, so a mark alone is not enough."""
    return [l for l in ctx.bes(pattern, mark) if (ring_tick(l) or 0) > tick]


@case("B5B6")
@needs_v4
def b5_b6_presses_and_reentry(ctx: Ctx):
    """4 and 5 presses fire exactly one entry (proved by window generation +1 and the advertisement pairing flag,
    not only by a ring line); a gesture of 3 presses during a window TOGGLES it closed (V1: no restart, no forget),
    and the next one opens a fresh window (generation +1). Start from R_NONE."""
    for n in (4, 5):
        before = ring_generation(ctx)
        if before is None:
            own_probe(ctx)  # one short press: its click_window_end dump carries the current generation
            before = ring_generation(ctx)
        ctx.check(f"{n} presses: generation baseline in the ring", before is not None, str(before))
        tick0, gen0 = before or (0, 0)
        pmx.inject(pmx.presses(n, 300), 50)
        time.sleep(8)
        gens = sorted({int(re.search(r"generation=(\d+)", l).group(1))
                       for l in ring_after_tick(ctx, tick0, r"generation=\d+")})
        entries = ring_after_tick(ctx, tick0, r"mode_enter_done")
        ctx.note(f"{n} presses: generations after the gesture {gens}, mode_enter_done lines {len(entries)}")
        ctx.check(f"{n} presses -> exactly one window generation (+1)",
                  bool(gens) and max(gens) == gen0 + 1, f"{gen0} -> {gens}")
        a = ctx.adv(5)
        ctx.check(f"{n} presses -> advertisement shows the pairing window",
                  bool(a) and a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))
        ctx.check(f"{n} presses -> at most one mode_enter_done line (a dropped line is a ring gap, not a failure)",
                  len(entries) <= 1, str(entries))
        pmx.inject("triple", 50)  # V1: a triple press toggles the window closed; a single click only re-speaks
        time.sleep(6)
        a = ctx.adv(5)
        ctx.check(f"{n} presses -> window closed by the triple press", bool(a) and not a["mentra"].get("pairing"),
                  json.dumps((a or {}).get("mentra")))
    m = enter_pairing(ctx)
    first = ctx.bes(r"mode_enter_done", m)
    g1 = re.search(r"generation=(\d+)", first[-1]) if first else None
    time.sleep(6)
    m2 = ctx.g.mark()
    pmx.inject(pmx.presses(3, 300), 50)
    hit = ctx.bes_wait(r"3-press while pairing, cancel", 15, m2)
    ctx.check("3 presses during a window toggle it closed (no restart)", hit is not None, hit[1] if hit else "")
    ctx.check("no new window entry from that gesture", not ctx.bes(r"mode_enter_done", m2), "")
    time.sleep(4)
    a = ctx.adv(5)
    ctx.check("advertisement pairing flag cleared by the toggle", bool(a) and not a["mentra"].get("pairing"),
              json.dumps((a or {}).get("mentra")))
    time.sleep(6)
    m3 = ctx.g.mark()
    open_window(ctx)
    again = ctx.bes_wait(r"mode_enter_done", 20, m3)
    g2 = re.search(r"generation=(\d+)", again[1]) if again else None
    ctx.check("the next 3 presses open a fresh window (generation +1)",
              bool(g1 and g2) and int(g2.group(1)) > int(g1.group(1)),
              f"{g1.group(1) if g1 else None} -> {g2.group(1) if g2 else None}")
    ctx.check("fresh window with no owner (own=0/0)", again is not None and "own=0/0" in again[1])
    m2 = m3
    time.sleep(35)
    spk = [l for _, l in ctx.g.since(m2) if "hm_spkcode received code=" in l]
    ctx.note(f"spoken code lines after re-entry: {len(spk)}")
    ctx.check("no double speech loop (<=2 codes in 35 s)", len(spk) <= 2, str(len(spk)))
    ctx.check("S22 owner again by pairing", make_s22_owner(ctx))


@case("E3S22")
def e3_s22_reconnect(ctx: Ctx):
    """S22 owner (live link) reconnects with zero action after the glasses reboot; BLE readiness first, adb return is a
    separate informational wait."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    await_live_link(ctx, "s22")
    pm = ctx.p.mark()
    reboot_unit3_android(ctx)
    ctx.check("S22 owner link after ASG reboot (BLE readiness, no adb)", wait_owner_link(ctx, pm, 180) is not None)
    no_owner_loss(ctx, pm)
    adb_return_bench(ctx)


@case("NEW3")
def new3_classic_first(ctx: Ctx):
    """In a window, Classic connects first (Mac), then the iOS app pairs: no commit until the BLE bond."""
    import subprocess

    ctx.check("precondition no owner", r_none(ctx))
    ios.open_pairing_scan()
    m = enter_pairing(ctx)
    proc = subprocess.run(["blueutil", "--connect", ios.glasses_mac()], capture_output=True, text=True, timeout=40)
    ctx.note(f"classic connect rc={proc.returncode} {proc.stderr.strip()[:100]}")
    time.sleep(8)
    ctx.check("window still open after Classic", not ctx.bes(r"window_close|owner committed", m))
    a = ctx.adv(5)
    ctx.check("still advertising pairing", bool(a) and a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))
    im = ctx.i.mark()
    commit, res = ios_pair(ctx)
    ctx.check("BLE pairing then completes", commit is not None and res["success_screen"], str(res["steps"]))
    ctx.check("Success only after pairing_info", ios_success_after_pairing_info(ctx, im))


@case("NEW6IOS")
def new6_ios_abandoned_scan(ctx: Ctx):
    """iOS owner opens Pair glasses, backs out; link drops (ASG reboot); reconnects to the saved glasses."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    ios.home()
    if ios.tap_text(r"^Mentra Live$", 4):
        time.sleep(1)
    ios.home()
    ios.tap_text(r".*Pair (new )?glasses.*|.*Add glasses.*", 4)
    time.sleep(4)
    ctx.ishot("scan_opened")
    ios.tap_text(r"^Back$", 3)
    ios.tap_text(r"^Back$", 3)
    time.sleep(2)
    im = ctx.i.mark()
    ios.bridge(False)
    time.sleep(8)
    ios.bridge(True)
    got = ctx.ios_wait(r"Received glasses_ready|pairing_info confirms owner commit", 120, im)
    ctx.check("auto-reconnects to the saved glasses", got is not None)
    pend = ctx.i.grep(r"pending_device|pending target|manualDiscoveryActive=true", im)
    ctx.check("no pending target left", not pend, str(pend[:2]))


@case("NEW6S22")
def new6_s22_abandoned_scan(ctx: Ctx):
    """S22 owner opens Pair glasses, backs out; link drops (BT toggle); reconnects."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    pmx.app_home()
    pmx.tap_text(r"^Mentra Live$", 4)
    time.sleep(2)
    pmx.psh("input keyevent KEYCODE_BACK")
    pm = ctx.p.mark()
    pmx.phone_bt(False)
    time.sleep(8)
    pmx.phone_bt(True)
    ctx.check("auto-reconnects", wait_owner_link(ctx, pm, 120) is not None)
    no_owner_loss(ctx, pm)


STALE_GESTURE_COPY = r"\b(5|five)\s*(x|times|presses)|hold both|10 s"
GOOD_GESTURE_COPY = r"(3|three)\s*(times|presses)|press.*(3|three)"


def copy_findings(texts: list) -> tuple:
    bad = [x for x in texts if re_s(STALE_GESTURE_COPY, x)]
    good = [x for x in texts if re_s(GOOD_GESTURE_COPY, x)]
    return bad, good


@case("NEW8IOS")
def new8_ios_copy(ctx: Ctx):
    """iOS copy: its own window (iOS owner, 3 presses, nobody pairs: O1) for the popup and Home screenshots, then
    the pairing prep and not-in-pairing-mode screens. All gesture copy says 3 presses. A timeout never shows the
    Pair Again card (that is O4 only)."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    texts = []
    gm = ctx.g.mark()
    res = run_transition(
        ctx, "ios", scenario="timeout",
        trigger=lambda: open_window(ctx, settle=False),
        adv=lambda: ctx.adv(5),
    )
    ios.home()
    ctx.ishot("home_after_timeout")
    card = ios.visible_texts()
    texts += card
    ctx.note(f"home texts after the timeout: {card[:15]}")
    ios.open_pairing_scan()
    t = ios.visible_texts()
    texts += t
    ctx.ishot("scan_or_prep")
    time.sleep(15)
    t2 = ios.visible_texts()
    texts += t2
    ctx.ishot("not_in_pairing_mode")
    ios.tap_text(r"^Back$", 2)
    ctx.note(f"screens: {t[:10]} / {t2[:10]}")
    bad, good = copy_findings(texts)
    ctx.check("no stale gesture copy", not bad, str(bad))
    ctx.note(f"3-press mentions: {good}")
    ctx.check("some screen tells the user to press 3 times", bool(good), str(texts[:12]))
    ctx.check("no Pair Again card after a timeout", not any(re_s(r"^Pair Again$", x) for x in card), str(card[:8]))


@case("NEW8S22")
def new8_s22_copy(ctx: Ctx):
    """S22 copy: its own window (S22 owner, 3 presses, nobody pairs: O1) for the Home screenshot, then the
    scan/prep screens. All gesture copy says 3 presses; a timeout never shows the Pair Again card."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    pmx.app_home()
    res = run_transition(
        ctx, "s22", scenario="timeout",
        trigger=lambda: open_window(ctx, settle=False),
        adv=lambda: ctx.adv(5),
    )
    pmx.app_home()
    ctx.shot("home_after_timeout")
    labels = [n.label for n in pmx.ui_nodes() if n.label]
    ctx.note(f"home labels after the timeout: {labels[:20]}")
    pmx.open_pairing_scan()
    time.sleep(15)
    ctx.shot("s22_scan_or_prep")
    labels2 = [n.label for n in pmx.ui_nodes() if n.label]
    bad, good = copy_findings(labels + labels2)
    ctx.check("no stale gesture copy", not bad, str(bad))
    ctx.check("some screen tells the user to press 3 times", bool(good), str((labels + labels2)[:12]))
    ctx.note(f"labels: {labels2[:20]}")
    ctx.check("no Pair Again card after a timeout", not any(re_s(r"^Pair Again$", x) for x in labels), str(labels[:8]))
    pmx.psh("input keyevent KEYCODE_BACK")


@case("X8")
def x8_race(ctx: Ctx):
    """Both phones on the scan list; one window; both pick the glasses. Exactly one owner; loser fails cleanly."""
    import threading

    ctx.check("precondition no owner", r_none(ctx))
    ios.open_pairing_scan()
    pmx.open_pairing_scan()
    gm, pm, im = ctx.g.mark(), ctx.p.mark(), ctx.i.mark()
    m = enter_pairing(ctx)
    time.sleep(5)
    stamps = {}
    out = {}

    def run_ios():
        stamps["ios"] = time.time()
        out["ios"] = ios.pair(timeout=70, **ios_pair_hooks(ctx, gm))

    def run_s22():
        stamps["s22"] = time.time()
        out["s22"] = pmx.app_pair(timeout=70)

    th = [threading.Thread(target=run_ios), threading.Thread(target=run_s22)]
    for t in th:
        t.start()
    for t in th:
        t.join()
    ctx.note(f"race results: {out}; start delta {abs(stamps['ios'] - stamps['s22']):.2f}s")
    commits = ctx.bes(r"owner committed from ble bond", gm)
    ctx.check("exactly one owner committed", len(commits) == 1, str(commits))
    winner = "s22" if s22_holds_bond() else "ios" if ios.mac_bonded() else None
    ctx.note(f"winner: {winner}")
    loser = "ios" if winner == "s22" else "s22"
    ctx.check("one winner bond, not two", winner is not None and not (s22_holds_bond() and ios.mac_bonded()))
    prompts = 0
    end = time.time() + 60
    while time.time() < end:
        if pmx.ui_find(r"配对请求|Pairing request"):
            prompts += 1
            c = pmx.ui_find(r"^取消$|^Cancel$")
            if c:
                pmx.tap(*c.center)
        time.sleep(5)
    ctx.check("loser shows no repeated prompts", prompts == 0 if loser == "s22" else True, str(prompts))
    ctx.check("loser did not reach Success", not out.get(loser, {}).get("success_screen", False))
    s22_finish_setup()
    ios.finish_setup()


@case("X9")
def x9_back_and_forth(ctx: Ctx):
    """O4_S22_IOS then O4_IOS_S22, three cycles; one bond on the owner, none stale on the other."""
    cycles = 3
    for i in range(cycles):
        for direction in ("to_ios", "to_s22"):
            gm = ctx.g.mark()
            if direction == "to_ios":
                if ios.pair_again_card():
                    ios.pair_again_from_card()
                ios.mac_forget()
                ios.open_pairing_scan()
                open_window(ctx)
                time.sleep(6)
                commit, res = ios_pair(ctx)
                ok = commit is not None and ios.mac_bonded()
            else:
                pmx.app_home()
                clear_s22_card(ctx)
                pmx.open_pairing_scan()
                open_window(ctx)
                time.sleep(6)
                res = pmx.app_pair(timeout=60)
                s22_finish_setup()
                commit = ctx.bes_wait(r"owner committed from ble bond", 30, gm)
                ok = commit is not None and s22_holds_bond()
            time.sleep(8)
            p = own_probe(ctx)
            ctx.check(f"cycle {i + 1} {direction}: owner committed, own=1", ok and p.get("own") == 1,
                      p.get("line", "")[-80:])
            commits = ctx.bes(r"owner committed from ble bond", gm)
            ctx.check(f"cycle {i + 1} {direction}: single commit", len(commits) == 1, str(len(commits)))


@case("NEW7")
def new7_permission_denied(ctx: Ctx):
    """iOS Bluetooth permission denied then restored."""
    ctx.not_testable("the simulator's Bluetooth authorization is supplied by the ImpossiBLE shim, not iOS TCC; "
                     "revoking the permission is not observable by the app")


# ------------------------------------------- ownership transfer v4 (OS-2055): the V6 transition matrix O1..O6
#
# Contract: mentra-live-bes docs/pairing-spec.md "## Ownership transfer v4 (OS-2055)" V1..V8. The firmware flag
# MENTRA_OWNERSHIP_TRANSFER now defaults to 1, so MENTRA_TRANSFER defaults to "on". The flag-off image keeps the legacy
# behavior (forget on entry, single-click cancel, protocol_version 2); only V4OFF runs against it. A v4 case run with
# MENTRA_TRANSFER=off ends NOT_TESTABLE with that reason, and each result row carries "transfer": "on"|"off".
#
# V6 row -> case:
#   O1  timeout                        O1_S22, O1_IOS, O1_BTOFF, O1_GRACE (V4 owner grace + 0x14 refusal inside O1)
#   O2  cancel by triple press         O2_S22, O2_IOS, B11 (single press re-speaks, triple cancels)
#   O3a owner re-pairs with its keys   O3A_S22
#   O3b owner re-pairs after losing    O3B_IOS (the Mac bond is forgotten, then the iOS app pairs again)
#   O4  B takes over                   O4_S22_MAC, O4_S22_IOS, O4_IOS_S22, D5D7 (Pair Again afterwards)
#   O5  reboot                         O5_STEP1, O5_STEP2, O5_STEP3 (debug build, MENTRA_PAIRING_FAULT_INJECT=N),
#                                      O5_WINDOW (coordinator BES power cycle), O5_PRECOMMIT (not injectable)
#   O6  old app on new firmware        O6_MAC (Mac as a bare central: never sends phone_hello)
#   flag-off regression                V4OFF (needs MENTRA_TRANSFER=off)
# Removed with protocol 3 (resolvable stubs, NOT_TESTABLE): T0..T9, D4, D4B, D4FIX, D4BFIX, BTOFF_REJOIN(_LOCKED),
# X5, X6, X10, X11.
#
# Lab limits, handled with the nearest existing helper (and said in each docstring): one Android phone (S22), the iOS
# simulator (Mac radio) and the Mac as a bare BLE central. The Mac stands in for phone B (or for an old app) whenever
# the S22 is phone A. Wire-level facts are searched in the BES ring, the ASG log, the phone log and the iOS log; when no
# log line carries one, the case records a harness gap (OPEN), never a pass.

def fault_inject_step() -> int | None:
    """The commit step the flashed debug BES reboots after (MENTRA_PAIRING_FAULT_INJECT=1|2|3), else None.

    The build flag is compile-time, so the harness cannot set it: the operator declares it here and each O5 case
    verifies the declaration against the `fault inject reboot after commit step N` BES line."""
    raw = os.environ.get(FAULT_ENV, "").strip()
    if not raw:
        return None
    if raw not in ("1", "2", "3"):
        raise ValueError(f"{FAULT_ENV} must be 1, 2 or 3, got {raw!r}")
    return int(raw)


def wire_hits(ctx, pattern: str, gm: int = 0, pm: int = 0, im: int = 0) -> list:
    """[(source, line)] for `pattern` in the BES ring, the ASG log, the phone log and the iOS log."""
    rx = re.compile(pattern)
    hits = [("bes", l) for l in ctx.bes(pattern, gm)]
    hits += [("asg", l) for _, l in ctx.g.since(gm) if rx.search(l)]
    hits += [("phone", l) for l in phone_lines(ctx, pattern, pm)]
    hits += [("ios", l) for _, l in ctx.i.since(im) if rx.search(l)]
    return hits


def wire_fact(ctx, name: str, pattern: str, gm: int = 0, pm: int = 0, im: int = 0) -> bool:
    """A wire message proven by any log source (same fact). No line anywhere: harness gap, not a failure."""
    hits = wire_hits(ctx, pattern, gm, pm, im)
    if hits:
        ctx.check(name, True, f"[{hits[0][0]}] {hits[0][1].strip()[-140:]}")
        return True
    ctx.gap(name, f"no BES/ASG/phone/iOS log line matches /{pattern}/")
    return False


def owner_state(ctx, mark: int = 0) -> tuple | None:
    """(ble, classic) owner record of the newest BES `st=... own=b/c` state line since `mark`."""
    lines = ctx.bes(r"st=\w+ .*own=\d/\d", mark)
    return owner_lost.own_pair(lines[-1]) if lines else None


def answer_while(fn, answer, interval: float = 1.0):
    """Run fn() while a helper thread calls answer() every `interval` s (for example a system sheet tap)."""
    import threading

    stop, answered = threading.Event(), []

    def loop():
        while not stop.is_set():
            try:
                if answer():
                    answered.append(time.time())
            except Exception:  # noqa: BLE001 - best effort, the case checks the outcome
                pass
            stop.wait(interval)

    th = threading.Thread(target=loop, daemon=True)
    th.start()
    try:
        return fn(), len(answered)
    finally:
        stop.set()
        th.join(timeout=10)


def refused(rows: list) -> bool:
    """mac_central rows show no usable link (not connected, or dropped inside 2 s)."""
    return all(not r.get("connected") or r.get("link_seconds", 0) < 2 for r in rows)


def stage_old_owner(ctx, who: str) -> None:
    """Start from R_NONE, then make `who` the owner ('s22' = S22 with a live link; 'mac' = the Mac, BLE-only owner)."""
    ctx.check("precondition ownerless start (R_NONE)", r_none(ctx))
    if who == "s22":
        ctx.check("precondition S22 owner", r_s22(ctx))
        return
    open_window(ctx)
    mac_new_owner(ctx, settle_s=0)
    p = own_probe(ctx)
    ctx.check("precondition Mac owner (own=1, Mac bond)", p.get("own") == 1 and ios.mac_bonded(), str(p.get("line", ""))[-90:])


def cancel_window(ctx, gm: int):
    """One triple press toggles the window closed (V1). A single click only re-speaks the code."""
    pmx.inject("triple", 50)
    hit = ctx.bes_wait(r"3-press while pairing, cancel|window_close reason=", 15, gm)
    ctx.check("window closed by a triple press", hit is not None, hit[1] if hit else "")
    return hit


def wait_link_up(ctx, who: str, timeout: float = 120.0, poll: float = 3.0) -> bool:
    """The previous owner's link comes back with zero action (reads the same log lines as await_live_link)."""
    tap = ctx.p if who == "s22" else ctx.i
    deadline = time.time() + timeout
    while True:
        if link_state(tap.since(0), LINK_UP_RX[who], LINK_DOWN_RX[who]):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(poll)


@case("O3A_S22")
@needs_v4
def o3a_owner_repairs_with_keys(ctx: Ctx):
    """O3a: the S22 owner joins its own window with the keys it already has (it picks the glasses again).

    The owner's latched pair_select plus an encrypt with its own LTK closes the window as paired with the link kept
    (`window_close owner kept`), and no bond changes: no `commit N/3`, no clear_owner, no Classic wipe. The owner
    record stays 1/x, no Pair Again card, no timeout or cancel phrase."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    await_live_link(ctx, "s22")
    before = owner_state(ctx, 0)
    gm = ctx.g.mark()
    open_window(ctx)
    ctx.check("window open", ctx.bes_wait(r"mode_enter_done", 20, gm) is not None)
    pmx.app_home()
    pmx.open_pairing_scan()
    res = pmx.app_pair(timeout=60)
    ctx.note(f"app_pair: {res}")
    kept = ctx.bes_wait(r"window_close owner kept|pairflow window_close paired_owner_kept", 40, gm)
    ctx.check("window closed as paired with the link kept (owner pair_select)", kept is not None,
              kept[1] if kept else "")
    ctx.check("no bond change (no commit steps, no clear_owner)",
              not ctx.bes(r"commit [123]/3|clear_owner|bond_deleted", gm), str(ctx.bes(r"commit [123]/3|clear_owner", gm)[:2]))
    ctx.check("owner record unchanged", owner_state(ctx, gm) in (None, before), f"{before} -> {owner_state(ctx, gm)}")
    wrong = wrong_exit_speech(ctx, gm)
    ctx.check("paired does not speak the timeout or cancel phrase", not wrong, str(wrong))
    s22_finish_setup()
    time.sleep(5)
    ctx.shot("home_after_o3a")
    ctx.check("no Pair Again card", not pair_again_visible_s22())
    a = ctx.adv(5)
    m2 = (a or {}).get("mentra", {}) if a else {}
    ctx.check("adv: OWNER_CHANGED clear", bool(a) and not m2.get("owner_changed"), json.dumps(m2))


@case("O3B_IOS")
@needs_v4
def o3b_owner_repairs_after_losing_keys(ctx: Ctx):
    """O3b: the iOS owner loses its keys (the Mac bond is forgotten), then pairs again inside a fresh window.

    SMP is accepted and committed through commit_bonded_candidate keeping the owner's identity: `pairflow commit
    same_owner`, so there is no Classic wipe (no `commit 2/3`) and OWNER_CHANGED stays clear. Success only after
    pairing_info."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    ios.mac_forget()
    ctx.check("keys lost: Mac bond forgotten", not ios.mac_bonded())
    time.sleep(3)
    ios.open_pairing_scan()
    gm, im = ctx.g.mark(), ctx.i.mark()
    open_window(ctx)
    time.sleep(2)
    commit, res = ios_pair(ctx)
    ctx.check("iOS owner again (Success + pairing_info)",
              commit is not None and bool(res.get("success_screen")), str(res.get("steps")))
    ctx.check("Success only after pairing_info", ios_success_after_pairing_info(ctx, im))
    same = ctx.bes(r"pairflow commit same_owner", gm)
    ctx.check("commit kept the owner's identity (same_owner)", bool(same), str(ctx.bes(r"pairflow commit", gm)[:2]))
    ctx.check("no wipe: no commit steps", not ctx.bes(r"commit [123]/3", gm))
    ctx.check("Mac (iOS) bond created again", ios.mac_bonded())
    a = ctx.adv(5)
    m2 = (a or {}).get("mentra", {}) if a else {}
    ctx.check("adv: OWNER_CHANGED clear", bool(a) and not m2.get("owner_changed"), json.dumps(m2))
    ctx.ishot("home_after_o3b")


def o5_step_case(step: int):
    """O5_STEPn: a Mac takeover on a debug build that reboots BES right after commit step `step`.

    After the BLE delete (step 1 is the commit point) the new owner owns, leftover Classic is cleaned by
    load_owner_from_nv at boot, and the previous owner (the S22) follows O4 through the streak fallback."""

    @needs_v4
    def run(ctx: Ctx):
        declared = fault_inject_step()
        if declared != step:
            ctx.not_testable(f"needs a debug BES built with {FAULT_ENV}={step} (declare it by exporting "
                             f"{FAULT_ENV}={step}; this run declares {declared!r}). The flag is compile-time and "
                             "never in a release build.")
            return
        ctx.check("precondition S22 owner", r_s22(ctx))
        await_live_link(ctx, "s22")
        time.sleep(3)
        ios.mac_forget()
        gm, pm = ctx.g.mark(), ctx.p.mark()
        mac_rows = []

        def b_pairs():
            mac_rows.extend(mac_new_owner(ctx, settle_s=3.0, hold_s=25) or [])

        open_window(ctx, settle=False)
        b_pairs()
        fault = wire_hits(ctx, FAULT_LOG_RX, gm, pm)
        if fault:
            ctx.check(f"debug build rebooted after commit step {step}",
                      any(re.search(FAULT_LOG_RX, l).group(1) == str(step) for _, l in fault),
                      fault[0][1].strip()[-120:])
        else:
            ctx.gap("fault inject line seen", f"no `fault inject reboot after commit step {step}` line (BES ring is "
                                              "cleared by the reboot); the declared build is unverified")
        ok = pmx.wait_glasses_boot(300)
        ctx.check("glasses back after the injected reboot", ok)
        if not ok:
            return
        time.sleep(20)
        p = own_probe(ctx)
        ctx.check("exactly one owner after the reboot (own=1)", p.get("own") == 1, str(p.get("line", ""))[-90:])
        rows = mac_central("--hold", "12", "--read")
        ctx.check("B (the Mac) owns: BLE link holds", any(r.get("link_seconds", 0) >= 5 for r in rows), str(rows[:2]))
        a = ctx.adv(5)
        m2 = (a or {}).get("mentra", {}) if a else {}
        ctx.check("adv: pairing flag clear after boot", bool(a) and not m2.get("pairing"), json.dumps(m2))
        rej = ctx.log_wait(ctx.p, owner_lost.REJECTED_RX.pattern, 240, pm)
        ctx.check("A reaches pairing_rejected (streak fallback, no OWNER_CHANGED bit after the reboot)",
                  rej is not None, rej[1][:160] if rej else "")
        ctx.shot("s22_after_o5")

    run.__doc__ = (f"O5 step {step}: Mac takeover, BES debug build reboots after commit step {step}; exactly one "
                   f"owner (the Mac), A ends on pairing_rejected. Needs {FAULT_ENV}={step}.")
    return run


for _step in (1, 2, 3):
    CASES[f"O5_STEP{_step}"] = o5_step_case(_step)


@case("O5_WINDOW")
@needs_v4
def o5_reboot_during_window(ctx: Ctx):
    """O5 reboot DURING the window: the window is gone, the owner unchanged, A follows O1.

    Resetting BES needs the coordinator's power cycle (an Android reboot does not reset BES): set
    PMX_O5_BES_CYCLED=1 once the coordinator cycled it while this case waited. Without it the interruption is
    unproven and the case ends OPEN."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    await_live_link(ctx, "s22")
    gm = ctx.g.mark()
    open_window(ctx)
    ctx.check("window open", ctx.bes_wait(r"mode_enter_done", 20, gm) is not None)
    if os.environ.get("PMX_O5_BES_CYCLED") != "1":
        ctx.gap("O5 BES was not reset during the window",
                "no harness BES power cycle exists; set PMX_O5_BES_CYCLED=1 after the coordinator cycled BES")
        return
    ok = pmx.wait_glasses_boot(300)
    ctx.check("glasses back after the BES reset", ok)
    time.sleep(20)
    a = ctx.adv(5)
    m2 = (a or {}).get("mentra", {}) if a else {}
    ctx.check("window gone: pairing flag clear, OWNER_CHANGED clear", bool(a) and not m2.get("pairing")
              and not m2.get("owner_changed"), json.dumps(m2))
    p = own_probe(ctx)
    ctx.check("owner unchanged (own=1)", p.get("own") == 1, str(p.get("line", ""))[-90:])
    ctx.check("A follows O1: reconnects with zero action", wait_link_up(ctx, "s22", 180))
    ctx.check("no Pair Again card", not pair_again_visible_s22())


@case("O5_PRECOMMIT")
def o5_reboot_before_ble_delete(ctx: Ctx):
    """O5 reboot during the commit BEFORE the BLE delete (A keeps ownership, B's bond is purged at boot).

    MENTRA_PAIRING_FAULT_INJECT only has points after steps 1, 2 and 3 (step 1 is the commit point), so a reboot
    before the delete cannot be injected in the lab."""
    ctx.not_testable("no fault point exists before commit step 1; the pre-delete reboot cannot be injected "
                     "(debug build points are after steps 1, 2 and 3)")


@case("O6_MAC")
@needs_v4
def o6_old_app_on_new_firmware(ctx: Ctx):
    """O6 with the Mac as a bare BLE central (never sends phone_hello, like an app without pairing_protocol 4).

    Mac owner; 3 presses; the window opens with no `entering_pairing_mode` sent to it (BES logs mode_enter
    phone_before_v4 or no_ble_phone); a triple press cancels; the Mac reconnects after the window and no bond
    changed (the O2 path). The real old app build is not in the lab (one Android, which runs the new app): the
    case records that gap and ends OPEN unless PMX_O6_OLD_APP_SIGNED_OFF=1."""
    stage_old_owner(ctx, "mac")
    gm = ctx.g.mark()
    open_window(ctx)
    ctx.check("window open", ctx.bes_wait(r"mode_enter_done", 20, gm) is not None)
    ctx.check("no entering_pairing_mode for a phone without phone_hello",
              not ctx.bes(r"mode_enter notified_phone", gm), str(ctx.bes(r"pairflow mode_enter", gm)[:2]))
    ctx.check("BES logged the v4-less phone", bool(ctx.bes(r"pairflow mode_enter (phone_before_v4|no_ble_phone)", gm)),
              str(ctx.bes(r"pairflow mode_enter", gm)[:2]))
    time.sleep(6)
    cancel_window(ctx, gm)
    time.sleep(8)
    rows = mac_central("--hold", "20", "--read")
    ctx.check("old owner reconnects after the window (O2 path)", any(r.get("link_seconds", 0) >= 5 for r in rows),
              str(rows[:2]))
    ctx.check("no bond change", not ctx.bes(r"owner committed|clear_owner|commit [123]/3", gm))
    ctx.check("Mac bond kept", ios.mac_bonded())
    if os.environ.get("PMX_O6_OLD_APP_SIGNED_OFF") != "1":
        ctx.gap("O6 real old app build on new firmware",
                "the Mac is not the previous Mentra App: install the old build on a second Android, or set "
                "PMX_O6_OLD_APP_SIGNED_OFF=1 after a manual run")


@case("V4OFF")
def v4_off_flag_off_regression(ctx: Ctx):
    """Flag-OFF regression (run with MENTRA_TRANSFER=off against firmware built without MENTRA_OWNERSHIP_TRANSFER).

    Legacy behavior is unchanged: entering forgets the owner (own=0/0 at mode_enter_done), a single click after the
    grace closes the window, pairing_info protocol_version stays 2, and no v4 wire key (pairing_mode_ended,
    window_id, owner_changed, phone_hello) appears in any BES/ASG/phone/iOS log. Missing anchors (no pairing_info or
    entering_pairing_mode logged, no protocol_version) make the scan meaningless: harness gap, case OPEN."""
    if not require_transfer(ctx, want_on=False):
        return
    stage_old_owner(ctx, "s22")  # fresh pairing in this case's logs: pairing_info on connect
    gm = ctx.g.mark()
    open_window(ctx)
    hit = ctx.bes_wait(r"lxy pair: mode_enter_done", 20, gm)
    ctx.check("window open", hit is not None)
    dump = ctx.bes(r"lxy pair: mode_enter_done", gm)
    ctx.check("legacy forget-on-entry (own=0/0)", bool(dump) and "own=0/0" in dump[-1], dump[-1] if dump else "")
    ctx.check("no v4 retain on entry", not ctx.bes(r"xfer enter, owner retained", gm))
    time.sleep(6)
    pmx.inject("single", 50)
    close = ctx.bes_wait(r"cancel by single click|window_close reason=", 15, gm)
    ctx.check("legacy single click closes the window", close is not None, close[1] if close else "")
    time.sleep(6)
    leaks = wire_hits(ctx, TRANSFER_KEY_RX)
    ctx.check("no v4 wire key in any log", not leaks, str([f"[{s}] {l.strip()[-100:]}" for s, l in leaks[:3]]))
    for name, pat in (("pairing_info", r"pairing_info"), ("entering_pairing_mode", r"entering[_ ]pairing[_ ]mode")):
        if not wire_hits(ctx, pat):
            ctx.gap(f"scan anchor: {name} seen in a log", "absence of the v4 keys proves nothing without it")
    versions = [m.group(1) for _, l in wire_hits(ctx, r"protocol_version") if "pairing_info" in l
                for m in PROTOCOL_VERSION_RX.finditer(l)]
    if not versions:
        ctx.gap("pairing_info protocol_version logged", "no pairing_info line carries protocol_version")
    else:
        ctx.check("pairing_info protocol_version stays 2", set(versions) == {"2"}, str(sorted(set(versions))))


superseded("T0", "V4OFF", "the flag-off regression now scans for the v4 keys")
superseded("T1", "O4_S22_MAC", "there is no confirm step: B just pairs inside the window and the commit wipes A")
superseded("T2", "O4_S22_IOS", "there is no confirm step on iOS either")
superseded("T3", "O2_S22", "cancel is a triple press and the owner is kept without a confirm gate")
superseded("T4", "O1_S22", "the single 120 s window times out and the owner is kept")
superseded("T5", "O1_GRACE", "the old phone gets one 15 s grace and is then refused (no yield, no owner_reclaim)")
superseded("T6", "O5_STEP1", "no confirm gate: a failed bond now ends per the O5 reboot rows")
superseded("T7", "O5_STEP1", "reboot mid-wipe is covered by the debug fault-injection points (O5_STEP1..3)")
superseded("T8", "O4_S22_MAC", "the legacy Classic owner is wiped at the commit (commit 2/3) like any previous owner")
superseded("T9", "O6_MAC", "an old app is not unsupported any more: it follows the O6 row")


def mac_classic_connected(wait_s: float = 8.0) -> bool:
    """Ask the Mac to connect the glasses over Classic (blueutil) and report whether the link came up."""
    import subprocess

    mac = ios.glasses_mac()
    subprocess.run(["blueutil", "--connect", mac], capture_output=True, timeout=30)
    time.sleep(wait_s)
    out = subprocess.run(["blueutil", "--is-connected", mac], capture_output=True, text=True, timeout=15)
    return out.stdout.strip() == "1"


def snapshot_info() -> dict:
    """Snapshot id + manifest sha256 when running from a published harness snapshot, else nulls."""
    m = HERE / "manifest.json"
    if not m.is_file():
        return {"snapshot_id": None, "manifest_sha256": None}
    raw = m.read_bytes()
    try:
        sid = json.loads(raw).get("snapshot_id")
    except ValueError:
        sid = None
    return {"snapshot_id": sid, "manifest_sha256": hashlib.sha256(raw).hexdigest()}


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def acquire_pid_file(run_dir: Path) -> Path:
    """runs/<run>/active.pid: refuse to start when it points at a live process; clean up on exit.
    Stopping a run means stopping exactly this pid, never a pattern kill."""
    pf = run_dir / "active.pid"
    if pf.exists():
        try:
            old = int(pf.read_text().split()[0])
        except (ValueError, IndexError):
            old = None
        if old and old != os.getpid() and pid_alive(old):
            raise SystemExit(f"refusing to start: {pf} points at live process {old} (another run is active)")
    pf.write_text(f"{os.getpid()}\n")

    def cleanup() -> None:
        try:
            if pf.read_text().split()[0] == str(os.getpid()):
                pf.unlink()
        except (OSError, IndexError):
            pass

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    return pf


GUARD_ERRORS = (pmx.Unit3GuardError, pmx.RouteError, ident.IdentityMissing, ios.BridgeNotOwned)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("cases", nargs="+")
    args = ap.parse_args()
    if args.run in PROTECTED_RUNS or re.fullmatch(r"m\d+", args.run):
        print(f"refusing to write into old evidence run {args.run!r}; use --run x2")
        sys.exit(2)
    snap = snapshot_info()
    try:
        snap["transfer"] = transfer_mode()  # on|off firmware under test; every result row carries it
        snap["fault_inject"] = fault_inject_step()  # declared debug-build step (O5), None otherwise
    except ValueError as e:
        print(str(e))
        sys.exit(2)
    if snap["snapshot_id"] is None and os.environ.get("PMX_ALLOW_LIVE") != "1":
        print("refusing to run device cases from the live harness files: run through run_case.py "
              "(immutable snapshot), or set PMX_ALLOW_LIVE=1 for a local dry run")
        sys.exit(2)
    unknown = [c for c in args.cases if c not in CASES]
    if unknown:
        print(f"unknown case(s) {unknown}")
        sys.exit(2)
    run_dir = pmx.RUNS / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    acquire_pid_file(run_dir)
    print(f"snapshot={snap['snapshot_id']} manifest_sha256={snap['manifest_sha256']}", flush=True)
    for cid in args.cases:
        fn = CASES[cid]
        print(f"== {cid}: {fn.__doc__.strip() if fn.__doc__ else ''}", flush=True)
        try:
            ctx = Ctx(run_dir, cid)
        except GUARD_ERRORS as e:
            row = {"case": cid, "t": time.strftime("%H:%M:%S"), "status": "BLOCKED", "reason": str(e)[:600], **snap}
            with open(run_dir / "results.jsonl", "a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(f"== {cid} BLOCKED (fail closed): {e}", flush=True)
            sys.exit(4)
        blocked = None
        try:
            fn(ctx)
        except (PreviousOwnerLinkDown, ios.BenchBlocked) as e:
            ctx.blocked = str(e)
            ctx.note(f"BLOCKED {e}")
            blocked = e
        except GUARD_ERRORS as e:
            blocked = e
            ctx.check("device guard", False, repr(e)[:300])
        except Exception as e:  # noqa: BLE001
            ctx.check("exception", False, repr(e))
        res = ctx.finish()
        row = {"case": cid, "t": time.strftime("%H:%M:%S"), **snap, **res}
        with open(run_dir / "results.jsonl", "a") as fh:
            fh.write(json.dumps(row) + "\n")
        print(f"== {cid} {res['status']}", flush=True)
        if blocked is not None:
            print(f"guard failed mid-case, stopping the run: {blocked}", flush=True)
            sys.exit(5 if isinstance(blocked, PreviousOwnerLinkDown) else 4)
        if ctx.stop_run_reason:
            print(f"verdict recorded; stopping the run: {ctx.stop_run_reason}", flush=True)
            sys.exit(4)


if __name__ == "__main__":
    main()
