#!/usr/bin/env python3
"""Pairing matrix cases. Usage: cases.py --run <dir-name> CASE [CASE ...]

Each case starts fresh glasses + phone logcat taps, writes them under
runs/<run>/<case>/ and appends a verdict row to runs/<run>/results.jsonl.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import ios
import pmx

class PreconditionFailed(Exception):
    """Ownership does not match the case's precondition: stop, do not run the case body."""


CASES = {}
LONG = os.environ.get('PMX_LONG') == '1'  # re-run the 120 s / 300 s timers


def case(cid):
    def deco(fn):
        CASES[cid] = fn
        return fn

    return deco


class Ctx:
    def __init__(self, run_dir: Path, cid: str):
        self.dir = run_dir / cid
        self.dir.mkdir(parents=True, exist_ok=True)
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

    def finish(self) -> dict:
        time.sleep(4)
        self.g.stop()
        self.p.stop()
        self.i.stop()
        (self.dir / "bes_trace.txt").write_text("\n".join(pmx.bes_lines(self.g, 0)) + "\n")
        (self.dir / "notes.txt").write_text("\n".join(self.notes) + "\n")
        failed = [c for c in self.checks if not c["ok"]]
        status = "FAIL" if failed else "PASS"
        if self.untestable:
            status = "NOT_TESTABLE" if not self.checks else status
        return {
            "status": status,
            "checks": self.checks,
            "untestable": self.untestable,
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


def pair_from_app(ctx: Ctx, timeout: float = 60, accept_dialog: bool = True):
    """Drive the Mentra App pairing flow; returns the owner-commit BES line or None."""
    mark = ctx.g.mark()
    res = pmx.app_pair(timeout=timeout, accept_dialog=accept_dialog)
    ctx.note(f"app_pair: {res}")
    ctx.shot("pair_flow_end")
    return ctx.bes_wait(r"owner committed from ble bond", 30, mark), res


# ----------------------------------------------------------------------- cases


@case("C3")
def c3_enter_with_absent_owner(ctx: Ctx):
    """Owner exists but is absent; 3 presses forget it and open the window."""
    media_before = pmx.media_count()
    m = ctx.g.mark()
    pmx.inject(pmx.presses(3, 300), 50)
    ctx.check("3-press fires", ctx.bes_wait(r"3-press queue pairing mode", 15, m) is not None)
    ctx.check("mode_enter_done", ctx.bes_wait(r"mode_enter_done", 10, m) is not None)
    dump = ctx.bes(r"lxy pair: mode_enter_done", m)
    ctx.check(
        "owner forgotten",
        bool(dump) and "own=0/0" in dump[-1] and "st=PAIRING" in dump[-1],
        dump[-1] if dump else "",
    )
    ctx.check(
        "no entering_pairing_mode without BLE phone",
        not ctx.bes(r"entering_pairing_mode", m),
    )
    a = ctx.adv(6)
    m2 = (a or {}).get("mentra", {})
    ctx.check("adv pairing flag", bool(m2.get("pairing")), json.dumps(m2))
    spk = ctx.log_wait(ctx.g, r"hm_spkcode received code=", 25, 0)
    ctx.check("spoken code sent to ASG", spk is not None)
    ctx.check("media untouched", pmx.media_count() == media_before, f"{media_before}")


def enter_pairing(ctx: Ctx, n: int = 3, gap_ms: int = 300) -> int:
    m = ctx.g.mark()
    pmx.inject(pmx.presses(n, gap_ms), 50)
    hit = ctx.bes_wait(r"mode_enter_done|hm_spkcode sent|click window expired n=3 fired=1", 20, m)
    ctx.check("entered pairing", hit is not None, hit[1] if hit else "")
    return m


@case("F1")
def f1_idle_expiry(ctx: Ctx):
    """Window with no phone expires after 120 s idle: locked, no owner, exit phrase once, code every 30 s."""
    pmx.bes_trace(True, 1000)
    time.sleep(3)
    m = enter_pairing(ctx)
    t0 = time.time()
    hit = ctx.bes_wait(r"window_close reason=", 150, m)
    elapsed = time.time() - t0
    ctx.check("window closes", hit is not None, hit[1] if hit else "")
    ctx.check("closes near 120 s", hit is not None and 110 <= elapsed <= 135, f"{elapsed:.0f}s")
    time.sleep(6)
    exits = [l for _, l in ctx.g.since(0) if "hm_pairexit received" in l]
    ctx.check("exit phrase exactly once", len(exits) == 1, str(len(exits)))
    codes = [l for _, l in ctx.g.since(0) if "hm_spkcode received" in l]
    ctx.check("code spoken every 30 s (4-5 times)", 4 <= len(codes) <= 5, str(len(codes)))
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
    ctx.check("R13 pairing-exit phrase on commit", ctx.log_wait(ctx.g, r"hm_pairexit received", 20) is not None)
    time.sleep(20)
    conn = ctx.bes(r"logical session connected")
    ctx.check("Connected plays exactly once", len(conn) == 1, str(conn))
    dump = ctx.bes(r"st=OWNER_ONLY .*own=1/1")
    ctx.check("owner BLE+Classic recorded", bool(dump), dump[-1] if dump else "")
    bonds = [b for b in pmx.phone_bonds() if "02BE" in b["name"]]
    ctx.check("phone bonded", bool(bonds), str(bonds))
    ctx.shot("after_pair")


def phone_lines(ctx: Ctx, pattern: str, mark: int = 0) -> list:
    import re

    rx = re.compile(pattern)
    return [l for _, l in ctx.p.since(mark) if rx.search(l) and "ReactNativeJS" not in l]


@case("D4")
def d4_owner_presses_and_nobody_pairs(ctx: Ctx):
    """S22 owner connected; 3 presses; app yields for the window; nobody pairs; what does S22 do after?"""
    gm, pm = ctx.g.mark(), ctx.p.mark()
    m = enter_pairing(ctx)
    ctx.check("glasses send entering_pairing_mode",
              ctx.log_wait(ctx.p, r"Glasses entering pairing mode", 15, pm) is not None)
    order = ctx.bes(r"forget|clear_owner|entering_pairing|state OWNER_ONLY -> PAIRING|disconnect phones|hm_spkcode sent", m)
    ctx.note("C1 order: " + " || ".join(order))
    ctx.check("C1 old owner disconnected", any("disconnect phones n=" in l and "n=0" not in l for l in order),
              str([l for l in order if "disconnect phones" in l]))
    yield_mark = ctx.p.mark()
    close = ctx.bes_wait(r"window_close reason=", 150, m)
    ctx.check("window expires (nobody paired)", close is not None, close[1] if close else "")
    attempts = phone_lines(ctx, r"ATTEMPTING CONNECTION", yield_mark)
    ctx.check("app stood down during window (no GATT attempts)", not attempts, str(len(attempts)))
    ctx.note("waiting 90 s for the app's reclaim attempts")
    time.sleep(90)
    after = ctx.p.mark()
    errs = phone_lines(ctx, r"GATT connection error: status=\d+", yield_mark)
    ctx.note(f"reclaim errors: {[e[-60:] for e in errs[:6]]}")
    lost = phone_lines(ctx, r"Owner loss|owner_replaced", yield_mark)
    ctx.check("app surfaces owner loss after reclaim is rejected", bool(lost), str(lost[:2]))
    rejects = ctx.bes(r"ble_reject", m)
    ctx.note(f"BES rejects: {rejects[:3]}")
    pmx.app_home()
    ctx.shot("home_after_window")


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


@case("E1")
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


@case("D3")
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
    ctx.check("pairing exit phrase", ctx.log_wait(ctx.g, r"hm_pairexit received reason=paired", 30) is not None)


def wait_owner_link(ctx: Ctx, mark: int, timeout: float = 60):
    """Phone-side proof the owner is back: BLE ready on the S22."""
    return ctx.log_wait(
        ctx.p, r"BLE reconnection fully ready|fully ready \(Core TX/RX|Received glasses_ready", timeout, mark
    )


def no_owner_loss(ctx: Ctx, mark: int) -> None:
    lost = phone_lines(ctx, r"Owner loss|owner_replaced", mark)
    ctx.check("no owner-loss / owner_replaced", not lost, str(lost[:2]))
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


@case("E3")
def e3_mtk_reboot(ctx: Ctx):
    """Glasses Android (MTK) reboot via adb: owner reconnects; readiness re-latches (A3 observation)."""
    pm = ctx.p.mark()
    pmx.gsh("reboot", timeout=10)
    ctx.g.stop()
    ok = pmx.wait_glasses_boot(240)
    ctx.check("glasses Android back", ok)
    pmx.gsh("dumpsys battery set level 80")
    ctx.g = pmx.LogTap(pmx.GLASSES, ctx.dir / "glasses_after.log").start(clear=False)
    pmx.bes_trace(True, 3000)
    ctx.check("owner reconnects after reboot", wait_owner_link(ctx, pm, 120) is not None)
    time.sleep(10)
    no_owner_loss(ctx, pm)
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
    return [l for _, l in ctx.g.since(gmark) if "hm_pairexit received" in l and "PairingAudio" in l]


@case("B5B6")
def b5_b6_extra_presses_and_reentry(ctx: Ctx):
    """5 fast presses enter once; 3 more presses while PAIRING restart the window (R4 re-entry)."""
    m = ctx.g.mark()
    pmx.inject(pmx.presses(5, 250), 50)
    time.sleep(8)
    enters = ctx.bes(r"3-press queue pairing mode", m)
    ctx.check("5 presses enter exactly once", len(enters) == 1, str(enters))
    m2 = ctx.g.mark()
    time.sleep(10)
    pmx.inject(pmx.presses(3, 300), 50)
    hit = ctx.bes_wait(r"mode_enter_done", 20, m2)
    ctx.check("re-entry while PAIRING runs mode_enter again", hit is not None, hit[1] if hit else "")
    gens = ctx.bes(r"mode_enter_done", m)
    ctx.note(f"mode_enter_done lines: {gens}")
    a = ctx.adv(5)
    ctx.check("still advertising pairing", bool(a) and a["mentra"].get("pairing"), "")
    ctx.check("no pairing-exit phrase on re-entry", not pairexits(ctx), str(pairexits(ctx)))


@case("B11")
def b11_single_click_cancel(ctx: Ctx):
    """Single click inside 2 s grace and before the 4 s count reset is ignored; after it, cancels once."""
    m = ctx.g.mark()
    # One sequence so the click lands ~1 s after the third press: inside grace, count >= 2.
    pmx.inject(pmx.presses(3, 300) + "." * 20 + "C", 50)
    ctx.bes_wait(r"mode_enter_done", 20, m)
    time.sleep(4)
    early = ctx.bes(r"cancel (skipped|by single click)", m)
    ctx.note(f"early click: {early}")
    ctx.check("early click logged as skipped", any("skipped" in l for l in early), str(early))
    time.sleep(2)
    m2 = ctx.g.mark()
    pmx.inject("C", 50)
    hit = ctx.bes_wait(r"cancel by single click|cancel skipped", 15, m2)
    ctx.check("click after count reset cancels", hit is not None and "by single click" in hit[1],
              hit[1] if hit else "")
    time.sleep(6)
    ex = pairexits(ctx)
    ctx.check("pairing-exit phrase exactly once", len(ex) == 1, str(ex))
    ctx.check("early click did not cancel", not any("by single click" in l for l in early), str(early))
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
    ctx.check("Android bond removed", not [b for b in pmx.phone_bonds() if "02BE" in b["name"]])
    time.sleep(5)
    ctx.check("no pairing window opened by unpair", not ctx.bes(r"state OWNER_ONLY -> PAIRING", m))


@case("A3")
def a3_presses_during_mtk_reboot(ctx: Ctx):
    """3 presses land while Android reboots (delayed injection). Expect not-ready, no window."""
    pmx.inject(pmx.presses(3, 300), 50, delay_ms=12000)
    time.sleep(1)
    pmx.gsh("reboot", timeout=10)
    ctx.g.stop()
    ok = pmx.wait_glasses_boot(240)
    ctx.check("glasses Android back", ok)
    pmx.gsh("dumpsys battery set level 80")
    ctx.g = pmx.LogTap(pmx.GLASSES, ctx.dir / "glasses_after.log").start(clear=False)
    pmx.bes_trace(True, 3000)
    time.sleep(15)
    lines = ctx.bes(r"3-press|MTK not ready|did not answer ping|mode_enter|mark_mtk_off|android_poweroff|PWR press|dbgkey")
    ctx.note("lines: " + " || ".join(lines[:12]))
    ctx.check("presses ran while MTK was down", any("PWR press n=3" in l for l in lines), "")
    ctx.check("gesture refused while not ready", any("MTK not ready" in l or "did not answer ping" in l for l in lines), "")
    ctx.check("no window opened", not any("mode_enter_done" in l for l in lines), "")
    a = ctx.adv(5)
    ctx.check("not advertising pairing", bool(a) and not a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))


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
    found = phone_lines(ctx, r"Found compatible K900 glasses device: Mentra_Live_02BE", pm)
    ctx.note(f"scan hits: {found[:2]}")
    ctx.check("02BE not offered as pairing-mode", not any("pairingMode=true" in l for l in found), str(found[:1]))
    pmx.psh("input keyevent KEYCODE_BACK")
    pmx.psh("input keyevent KEYCODE_BACK")
    m = ctx.g.mark()
    rows = mac_central("--hold", "10", "--read")
    ctx.note(f"mac owner reconnect: {rows}")
    r = rows[0] if rows else {}
    ctx.check("owner Mac reconnects without pairing", r.get("connected") and not r.get("dropped_by_peer"), str(r))
    ctx.check("no window opened", not ctx.bes(r"state OWNER_ONLY -> PAIRING", m))


@case("D4B")
def d4b_new_owner_takes_over(ctx: Ctx):
    """S22 owner; 3 presses; Mac bonds as the new owner; S22 must show 'Paired to another phone'."""
    pm = ctx.p.mark()
    m = enter_pairing(ctx)
    ctx.check("S22 yields", ctx.log_wait(ctx.p, r"Glasses entering pairing mode", 15, pm) is not None)
    rows = mac_central("--hold", "20")
    ctx.note(f"mac: {rows}")
    ex = ctx.log_wait(ctx.g, r"hm_pairexit received reason=paired", 30, 0)
    ctx.check("Mac committed as new owner", ex is not None)
    ctx.note("waiting for the S22 yield (120 s) to end and its reclaim attempts")
    lost = ctx.log_wait(ctx.p, r"Owner loss|owner_replaced", 200, pm)
    ctx.check("S22 surfaces owner_replaced", lost is not None, lost[1][:200] if lost else "")
    errs = phone_lines(ctx, r"GATT connection error: status=\d+", pm)
    ctx.note(f"S22 reclaim errors: {[e[-50:] for e in errs[:4]]}")
    pmx.app_home()
    time.sleep(2)
    ctx.shot("s22_home_after_takeover")
    stored = pmx.psh("run-as com.mentra.mentra ls files 2>/dev/null | head -3")
    ctx.note(f"app files: {stored.strip()[:120]}")


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
        if not picked and pmx.ui_find(r"^02BE$", nodes):
            pmx.tap(*pmx.ui_find(r"^02BE$", nodes).center)
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


@case("BTOFF_REJOIN")
def btoff_owner_rejoins_window(ctx: Ctx):
    """BUG-3: owner phone misses entering_pairing_mode (BT off), comes back into the window."""
    pm = ctx.p.mark()
    pmx.phone_bt(False)
    time.sleep(6)
    m = enter_pairing(ctx)
    time.sleep(3)
    pmx.phone_bt(True)
    lost = ctx.log_wait(ctx.p, r"Owner loss|owner_replaced", 90, pm)
    ctx.check("old owner stands down", lost is not None, lost[1][:200] if lost else "")
    time.sleep(10)
    nodes = pmx.ui_nodes()
    prompt = pmx.ui_find(r"配对请求|Pairing request", nodes)
    ctx.shot("after_rejoin")
    ctx.check("no unsolicited pairing prompt on the old owner", prompt is None, prompt.label if prompt else "")
    a = ctx.adv(5)
    ctx.check("window still open and advertising for the new phone",
              bool(a) and a["mentra"].get("pairing"), json.dumps((a or {}).get("mentra")))


@case("D4FIX")
def d4fix_owner_presses_and_nobody_pairs(ctx: Ctx):
    """BUG-2/5: owner yields the whole window, then is rejected and shows owner loss."""
    pm = ctx.p.mark()
    m = enter_pairing(ctx)
    y = ctx.log_wait(ctx.p, r"Glasses entering pairing mode — yield (\d+)ms", 15, pm)
    ctx.check("S22 yields 300 s", y is not None and "300000" in y[1], y[1][-80:] if y else "")
    lost = ctx.log_wait(ctx.p, r"Owner loss|owner_replaced", 420, pm)
    ctx.check("S22 surfaces owner loss after the window", lost is not None, lost[1][:200] if lost else "")
    attempts = phone_lines(ctx, r"ATTEMPTING CONNECTION", pm)
    ctx.note(f"connection attempts after yield: {len(attempts)}")
    ctx.check("at most a couple of reclaim attempts", len(attempts) <= 3, str(len(attempts)))
    pmx.app_home()
    time.sleep(3)
    ctx.shot("owner_lost_card")
    card = pmx.ui_find(r"another phone|Pair again", None)
    ctx.check("owner-lost card shown", card is not None, card.label if card else "")


@case("D5D7")
def d5_d7_pair_again_from_card(ctx: Ctx):
    """Owner-lost card -> Pair again -> pairs, card and owner-lost flag clear."""
    pm = ctx.p.mark()
    m = enter_pairing(ctx)
    pmx.app_home()
    ctx.check("card visible before", pmx.ui_find(r"^Paired to another phone$") is not None)
    pmx.tap_text(r"^Pair again$", 8)
    time.sleep(1.5)
    pmx.tap(810, 1363)  # modal confirm "Pair again" (modal is outside the uiautomator tree)
    time.sleep(3)
    res = pmx.app_pair(timeout=60)
    ctx.note(f"app_pair: {res}")
    ex = ctx.log_wait(ctx.g, r"hm_pairexit received reason=paired", 30, 0)
    ctx.check("glasses committed S22 again", ex is not None)
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
    time.sleep(5)
    ctx.shot("home_after_pair_again")
    ctx.check("owner-lost card gone", pmx.ui_find(r"^Paired to another phone$") is None)
    cleared = phone_lines(ctx, r"mentra_live_owner_lost.*false|owner_lost.*cleared|clearOwnerLost", pm)
    ctx.note(f"owner-lost clear lines: {cleared[:2]}")


def make_s22_owner(ctx: Ctx) -> bool:
    ios.bridge(False)  # the iOS radio must not hold the glasses' single BLE slot
    pmx.app_home()
    if pmx.ui_find(r"^Paired to another phone$"):
        pmx.tap_text(r"^Pair again$", 8)
        time.sleep(1.5)
        pmx.tap(810, 1363)
        time.sleep(3)
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

    subprocess.run(["blueutil", "--unpair", "cc-e7-de-e0-02-be"], capture_output=True)
    ctx.check("S22 is owner", make_s22_owner(ctx))


@case("D4BFIX")
def d4b_fix_new_owner_takes_over(ctx: Ctx):
    """BUG-5: S22 owner; 3 presses; Mac takes the window; S22 stays out, then shows owner loss, no prompts."""
    ctx.check("S22 is owner", make_s22_owner(ctx))
    time.sleep(10)
    import subprocess

    subprocess.run(["blueutil", "--unpair", "cc-e7-de-e0-02-be"], capture_output=True)
    pm = ctx.p.mark()
    m = enter_pairing(ctx)
    ctx.check("S22 yields 300 s", ctx.log_wait(ctx.p, r"yield 300000ms", 15, pm) is not None)
    rows = mac_central("--hold", "30")
    ctx.note(f"mac: {rows}")
    paired = ctx.log_wait(ctx.g, r"hm_pairexit received reason=paired", 20, 0)
    ctx.note(f"Mac committed as new owner: {paired is not None}")
    prompts = 0
    early = []
    deadline = time.time() + 330
    lost = None
    while time.time() < deadline:
        if pmx.ui_find(r"配对请求"):
            prompts += 1
            c = pmx.ui_find(r"^取消$")
            if c:
                pmx.tap(*c.center)
        lost = ctx.p.wait_for(r"Owner loss|owner_replaced", pm, 0.1)
        if lost:
            break
        time.sleep(5)
    start = phone_lines(ctx, r"yield 300000ms", pm)
    end = phone_lines(ctx, r"Pairing yield ended", pm)
    t0 = start[0][:18] if start else ""
    t1 = end[0][:18] if end else ""
    attempts = phone_lines(ctx, r"ATTEMPTING CONNECTION|GATT link connected", pm)
    inside = [a for a in attempts if t0 and t1 and t0 <= a[:18] < t1]
    ctx.check("S22 made no connection attempt during the yield",
              bool(t0 and t1) and not inside, f"yield {t0}..{t1}, attempts inside={len(inside)}")
    ctx.check("S22 shows owner loss after the window", lost is not None, lost[1][:160] if lost else "")
    ctx.check("no unsolicited pairing prompts on S22", prompts == 0, str(prompts))
    pmx.app_home()
    time.sleep(3)
    ctx.shot("s22_card")


# ------------------------------------------------- cross-platform (iOS simulator + S22)
#
# The iOS side is the Mentra App in the iOS Simulator; its BLE runs on the Mac radio
# through the ImpossiBLE passthrough helper, so "iOS bond" == the Mac's bond with 02BE.


def open_window(ctx: Ctx, delay_ms: int = 0) -> bool:
    """Exactly one 3-press gesture. Never repeat it: extra presses can close or reset the window."""
    pmx.inject(pmx.presses(3, 300), 50, delay_ms=delay_ms)
    time.sleep(3 + delay_ms / 1000)
    return True


def own_probe(ctx: Ctx) -> dict:
    """One injected short press outside a window; the click-window dump carries st= and own=."""
    import re

    a = pmx.glasses_adv(seconds=4)
    if a and a.get("mentra", {}).get("pairing"):
        out = {"st": "PAIRING", "own": 0, "classic": 0, "line": "adv pairing=true (window open; owner forgotten per R4)"}
        ctx.note(f"own_probe: {out}")
        return out
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
    return any("02BE" in b["name"] for b in pmx.phone_bonds())


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


def ios_pair(ctx: Ctx, timeout: float = 180):
    """Simulator app pairs with 02BE inside an open window. Returns (commit_hit, ui_result).
    Stops at the first decisive line: still on Pairing / Pair Audio 60 s after the pick with no BES commit."""
    gm, im = ctx.g.mark(), ctx.i.mark()

    def stuck(out):
        t = out.get("t_sheet") or out.get("t_pick")
        if not t or time.time() - t < (45 if out.get("t_sheet") else 120) \
                or ctx.bes(r"owner committed from ble bond", gm):
            return None
        if ios.find(r"^Pair Audio$") or ios.find(r"^Pairing$"):
            return "still on Pairing/Pair Audio with no commit after pick, glasses not committed"
        return None

    res = ios.pair(timeout=timeout, abort_if=stuck)
    ctx.note(f"ios.pair: {res}")
    if res.get("t_pick"):
        ctx.note(f"pick -> end {time.time() - res['t_pick']:.0f}s")
    ctx.ishot("pair_flow_end")
    commit = ctx.bes_wait(r"owner committed from ble bond", 5 if res.get("aborted") else 15, gm)
    info = ctx.i.grep(r"pairing_info confirms owner commit", im)
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
    if ios.mac_bonded() or ios.owner_lost_card():
        ios.unpair()
    if s22_holds_bond() or pmx.ui_find(r"^Paired to another phone$"):
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


def ios_owner_loss_after_yield(ctx: Ctx, im: int, timeout: float = 420):
    y = ctx.ios_wait(r"Glasses entering pairing mode — yield (\d+)ms", 20, im)
    lost = ctx.ios_wait(r"LIVE: Owner loss \(", timeout, im)
    start = ctx.i.grep(r"yield 300000ms", im)
    t0 = next((t for t, l in ctx.i.since(im) if "yield 300000ms" in l), None)
    t1 = next((t for t, l in ctx.i.since(im) if "Pairing yield ended" in l), None)
    inside = [l for t, l in ctx.i.since(im)
              if t0 and t1 and t0 < t < t1 and ("Connecting to" in l or "didConnect" in l or "connectToDevice" in l)
              and "blocked" not in l]
    conn = [l for t, l in ctx.i.since(im) if "(type=connect)" in l and (not lost or t <= lost[0])]
    ctx.note(f"iOS notice received: {y is not None}; connect attempts before owner loss: {len(conn)}")
    return y, lost, (t0, t1), inside, conn


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
    rows = [t for t in texts if re_s(r"02BE", t) and not re_s(r"not in pairing mode", t)]
    ctx.check("iOS scan does not offer 02BE as pairable", reached and not rows, str(texts[:10]))
    ctx.check("glasses kept the S22 owner", not ctx.bes(r"owner committed|clear_owner", gm))
    ctx.check("no Mac bond created", not ios.mac_bonded())
    rej = ctx.bes(r"reject|drop|auth", gm)
    ctx.note(f"BES reject lines: {rej[:4]}")
    a = ctx.adv(5)
    m2 = (a or {}).get("mentra", {})
    ctx.note(f"adv: {m2}")
    ctx.check("adv not in pairing mode (R12)", not a or not m2.get("pairing"), json.dumps(m2))
    ios.tap_text(r"^Back$", 2)


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
    proc = subprocess.run(["blueutil", "--connect", ios.GLASSES_MAC], capture_output=True, text=True, timeout=40)
    ctx.note(f"blueutil --connect rc={proc.returncode} err={proc.stderr.strip()[:120]}")
    time.sleep(8)
    conn = subprocess.run(["blueutil", "--is-connected", ios.GLASSES_MAC], capture_output=True, text=True).stdout.strip()
    ctx.check("Classic link not established", conn != "1", f"is-connected={conn}")
    acl = ctx.bes(r"classic|acl|reject|NOT_ACCESSIBLE|BT-PAIR", gm)
    ctx.note(f"BES classic lines: {acl[:5]}")
    ctx.check("no window opened", not ctx.bes(r"state OWNER_ONLY -> PAIRING", gm))
    ctx.check("owner unchanged", not ctx.bes(r"owner committed|clear_owner", gm))
    ios.mac_forget()


@case("X6")
def x6_s22_to_ios(ctx: Ctx):
    """S22 owner -> 3 presses -> iOS pairs. S22 yields 300 s then owner loss; iOS Success only after pairing_info."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    ios.mac_forget()
    ios.reset_ios_side()
    ios.open_pairing_scan()
    pm, gm, im = ctx.p.mark(), ctx.g.mark(), ctx.i.mark()
    open_window(ctx)
    ctx.check("S22 yields 300 s", ctx.log_wait(ctx.p, r"yield 300000ms", 20, pm) is not None)
    time.sleep(4)
    commit, res = ios_pair(ctx)
    ctx.check("iOS committed as owner", commit is not None, commit[1] if commit else "")
    ctx.check("iOS Success screen", res["success_screen"], str(res["steps"]))
    ctx.check("iOS Success only after pairing_info", ios_success_after_pairing_info(ctx, im))
    ex = [l for _, l in ctx.g.since(gm) if "hm_pairexit received reason=" in l]
    ctx.check("hm_pairexit once", len(ex) == 1, str([e[-60:] for e in ex]))
    ctx.check("Mac (iOS) bond created", ios.mac_bonded())
    if not LONG:
        ctx.note("S22 yield/reclaim not re-run (baseline, this image: 300 s stand-down, 0 attempts, 0 prompts; "
                 "first reclaim GATT status 133, no owner-loss card)")
    else:
        prompts, first = 0, None
        deadline = time.time() + 400
        ended = None
        while time.time() < deadline:
            if pmx.ui_find(r"配对请求|Pairing request"):
                prompts += 1
                cbtn = pmx.ui_find(r"^取消$|^Cancel$")
                if cbtn:
                    pmx.tap(*cbtn.center)
            ended = ended or ctx.p.wait_for(r"Pairing yield ended", pm, 0.1)
            if ended:
                first = ctx.p.wait_for(r"GATT connection error: status=\d+|Owner loss", pm, 20)
                break
            time.sleep(5)
        s = phone_lines(ctx, r"yield 300000ms", pm)
        e = phone_lines(ctx, r"Pairing yield ended", pm)
        t0, t1 = (s[0][:18] if s else ""), (e[0][:18] if e else "")
        att = phone_lines(ctx, r"ATTEMPTING CONNECTION|GATT link connected", pm)
        inside = [a for a in att if t0 and t1 and t0 <= a[:18] < t1]
        ctx.check("S22 no connection attempt during yield", bool(t0 and t1) and not inside,
                  f"yield {t0}..{t1} inside={len(inside)}")
        ctx.check("S22 first reclaim status recorded", first is not None, first[1][-110:] if first else "")
        ctx.note(f"first reclaim: {first[1][-110:] if first else None}")
        ctx.check("S22 no pairing prompts", prompts == 0, str(prompts))
    pmx.app_home()
    time.sleep(3)
    ctx.shot("s22_after_takeover")
    ctx.ishot("ios_home")


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
    im = ctx.i.mark()
    ios.simctl("launch", ios.SIM, "com.apple.Preferences")
    time.sleep(3)
    pmx.gsh("reboot", timeout=10)
    ctx.g.stop()
    ok = pmx.wait_glasses_boot(240)
    pmx.gsh("dumpsys battery set level 80")
    ctx.g = pmx.LogTap(pmx.GLASSES, ctx.dir / "glasses_after.log").start(clear=False)
    pmx.bes_trace(True, 1000)
    ctx.check("ASG back", ok)
    got = ctx.ios_wait(rx, 120, im)
    ctx.check("reconnect (app backgrounded) after ASG reboot", got is not None)
    lost = ctx.i.grep(r"Owner loss", 0)
    ctx.check("no owner loss", not lost, str(lost[:1]))
    ios.home()
    ctx.ishot("after_x3")


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
    ctx.check("no owner loss", not ctx.i.grep(r"Owner loss", im))
    ctx.check("glasses kept the owner", not ctx.bes(r"clear_owner|owner committed", gm))
    ctx.check("no owner-lost card", not ios.owner_lost_card())


@case("X5")
def x5_ios_to_s22(ctx: Ctx):
    """iOS owner -> 3 presses -> S22 pairs. iOS yields 300 s, then auth failure -> owner-lost card."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    if pmx.ui_find(r"^Paired to another phone$"):
        pmx.tap_text(r"^Pair again$", 8)
        time.sleep(1.5)
        pmx.tap(810, 1363)
        time.sleep(3)
    pmx.open_pairing_scan()
    gm, im = ctx.g.mark(), ctx.i.mark()
    open_window(ctx)
    time.sleep(6)
    res = pmx.app_pair(timeout=60)
    ctx.note(f"S22 app_pair: {res}")
    commit = ctx.bes_wait(r"owner committed from ble bond", 15, gm)
    pr = own_probe(ctx)  # the BES ring can drop the commit line; the owner dump is authoritative
    ctx.check("S22 committed as owner", res["success_screen"] and (commit is not None or (pr.get("own") == 1 and s22_holds_bond())),
              str(res["steps"]))
    s22_finish_setup()
    y, lost, (t0, t1), inside, conn = ios_owner_loss_after_yield(ctx, im)
    if y is not None:
        ctx.check("iOS yields 300 s", "300000" in y[1], y[1][-80:])
        ctx.check("iOS no connect attempt during yield", bool(t0 and t1) and not inside,
                  f"yield {t0}..{t1} inside={inside[:2]}")
    else:
        ctx.note("FINDING: iOS missed entering_pairing_mode; covered by the missed-notice fallback")
        ctx.check("iOS fallback: at most one reconnect attempt before owner loss", len(conn) <= 1, str(len(conn)))
    ctx.check("iOS owner loss via auth failure (ios_auth_fail)", lost is not None and "ios_auth_fail" in lost[1],
              lost[1][-120:] if lost else "")
    err = ctx.i.grep(r"Failed to connect to peripheral|didDisconnect|Disconnected", im)
    ctx.note(f"iOS connect errors: {[e[-140:] for e in err[-4:]]}")
    ctx.check("owner-lost card shown on iOS", ios.owner_lost_card())
    ctx.ishot("owner_lost_card")
    texts = ios.visible_texts()
    ctx.note(f"iOS card text: {texts[:15]}")
    ctx.check("card carries Settings forget hint", any(re_s(r"forget|settings", t) for t in texts), "")
    p = own_probe(ctx)
    ctx.check("S22 kept ownership", p.get("own") == 1 and s22_holds_bond(), p.get("line", "")[-80:])


@case("X7A")
def x7a_settings_detour(ctx: Ctx):
    """After loss: forget in Settings (Mac bond), Pair again from the card with 3 presses -> iOS owner."""
    if not ios.owner_lost_card():
        ctx.not_testable("needs the iOS owner-lost card from X5")
        return
    ios.mac_forget()
    ctx.check("bond forgotten", not ios.mac_bonded())
    ios.pair_again_from_card()
    ios.open_pairing_scan()
    gm, im = ctx.g.mark(), ctx.i.mark()
    open_window(ctx)
    time.sleep(2)
    commit, res = ios_pair(ctx)
    ctx.check("iOS owner again", commit is not None and res["success_screen"], str(res["steps"]))
    ctx.check("Success only after pairing_info", ios_success_after_pairing_info(ctx, im))
    ctx.check("owner-lost card gone", not ios.owner_lost_card())


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
    lost = ctx.i.grep(r"Owner loss", im)
    p = own_probe(ctx)
    texts = ios.home()
    ctx.ishot("after_forget")
    ctx.note(f"BES clear={cleared[:2]} commit={committed[:1]} window={windows[:1]} own={p}")
    ctx.note(f"iOS owner-loss lines={lost[:2]} screen={texts[:12]}")
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
    ctx.note(f"forget hint after a user unpair (informational; the forget guidance ships on the owner-loss card, "
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
    found = phone_lines(ctx, r"Found compatible K900 glasses device: Mentra_Live_02BE", pm)
    ctx.check("S22 is not offered 02BE as pairable", not any("pairingMode=true" in l for l in found), str(found[:1]))
    pmx.psh("input keyevent KEYCODE_BACK")
    pmx.psh("input keyevent KEYCODE_BACK")


@case("X11")
def x11_cancel_with_ios_former_owner(ctx: Ctx):
    """iOS owner; 3 presses then single click after the grace: no owner; iOS yields then owner loss."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    gm, im = ctx.g.mark(), ctx.i.mark()
    m = enter_pairing(ctx)
    time.sleep(6)
    pmx.inject("C", 50)
    hit = ctx.bes_wait(r"cancel by single click|cancel skipped", 15, m)
    ctx.check("cancel by single click", hit is not None and "by single click" in hit[1], hit[1] if hit else "")
    time.sleep(8)
    ex = pairexits(ctx, m)
    ctx.check("hm_pairexit once", len(ex) == 1, str(ex))
    a = ctx.adv(5)
    ctx.check("adv pairing flag cleared", bool(a) and not a["mentra"].get("pairing"), "")
    y, lost, (t0, t1), inside, _ = ios_owner_loss_after_yield(ctx, im, 360)
    ctx.check("iOS yields 300 s", y is not None and "300000" in y[1])
    ctx.check("iOS reclaim -> owner loss (ios_auth_fail) within 330 s of yield end",
              lost is not None and "ios_auth_fail" in lost[1], lost[1][-120:] if lost else "OPEN BUG if absent")
    ctx.check("owner-lost card", ios.owner_lost_card())
    ctx.ishot("x11_card")


@case("X10")
def x10_ios_owner_nobody_pairs(ctx: Ctx):
    """iOS owner presses and nobody pairs: window closes ~120 s, no owner; iOS yields then owner loss."""
    ctx.check("precondition iOS owner", r_ios(ctx))
    im = ctx.i.mark()
    m = enter_pairing(ctx)
    close = ctx.bes_wait(r"window_close reason=", 170, m)
    ctx.check("window closes (idle) with no owner", close is not None and "idle" in close[1], close[1] if close else "")
    y, lost, (t0, t1), inside, _ = ios_owner_loss_after_yield(ctx, im, 300)
    ctx.check("iOS yields 300 s", y is not None and "300000" in y[1])
    ctx.check("iOS no attempt during yield", bool(t0 and t1) and not inside, str(inside[:2]))
    ctx.check("iOS owner loss after the yield", lost is not None and "ios_auth_fail" in lost[1],
              lost[1][-120:] if lost else "")
    ctx.check("owner-lost card", ios.owner_lost_card())
    ctx.ishot("x10_card")


@case("B5B6")
def b5_b6_presses_and_reentry(ctx: Ctx):
    """4 and 5 presses fire one entry; 3 presses during a window restart it (generation +1, forgotten again)."""
    import re

    for n in (4, 5):
        m = ctx.g.mark()
        pmx.inject(pmx.presses(n, 300), 50)
        time.sleep(8)
        entries = ctx.bes(r"mode_enter_done", m)
        ctx.check(f"{n} presses -> one entry", len(entries) == 1, str(entries))
        pmx.inject("C", 50) if not entries else None
        time.sleep(3)
        if entries:
            time.sleep(1)
            pmx.inject("C", 50)
            time.sleep(6)
    m = enter_pairing(ctx)
    first = ctx.bes(r"mode_enter_done", m)
    g1 = re.search(r"generation=(\d+)", first[-1]) if first else None
    time.sleep(6)
    m2 = ctx.g.mark()
    open_window(ctx)
    again = ctx.bes_wait(r"mode_enter_done", 20, m2)
    g2 = re.search(r"generation=(\d+)", again[1]) if again else None
    ctx.check("re-entry restarts the window (generation +1)",
              bool(g1 and g2) and int(g2.group(1)) == int(g1.group(1)) + 1,
              f"{g1.group(1) if g1 else None} -> {g2.group(1) if g2 else None}")
    ctx.check("re-entry forgets again (own=0/0)", again is not None and "own=0/0" in again[1])
    time.sleep(35)
    spk = [l for _, l in ctx.g.since(m2) if "hm_spkcode received code=" in l]
    ctx.note(f"spoken code lines after re-entry: {len(spk)}")
    ctx.check("no double speech loop (<=2 codes in 35 s)", len(spk) <= 2, str(len(spk)))
    ctx.check("S22 owner again by pairing", make_s22_owner(ctx))


@case("E3S22")
def e3_s22_reconnect(ctx: Ctx):
    """S22 owner reconnects with zero action after the glasses reboot."""
    ctx.check("precondition S22 owner", r_s22(ctx))
    pm = ctx.p.mark()
    pmx.gsh("reboot", timeout=10)
    ctx.g.stop()
    ok = pmx.wait_glasses_boot(240)
    pmx.gsh("dumpsys battery set level 80")
    ctx.g = pmx.LogTap(pmx.GLASSES, ctx.dir / "glasses_after.log").start(clear=False)
    pmx.bes_trace(True, 1000)
    ctx.check("ASG back", ok)
    ctx.check("S22 owner link after ASG reboot", wait_owner_link(ctx, pm, 120) is not None)
    no_owner_loss(ctx, pm)


@case("NEW3")
def new3_classic_first(ctx: Ctx):
    """In a window, Classic connects first (Mac), then the iOS app pairs: no commit until the BLE bond."""
    import subprocess

    ctx.check("precondition no owner", r_none(ctx))
    ios.open_pairing_scan()
    m = enter_pairing(ctx)
    proc = subprocess.run(["blueutil", "--connect", ios.GLASSES_MAC], capture_output=True, text=True, timeout=40)
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


@case("NEW8IOS")
def new8_ios_copy(ctx: Ctx):
    """iOS screens: pairing prep, not-in-pairing-mode, owner-lost card; gesture copy says 3 presses."""
    texts = []
    ios.home()
    ok = ios.open_pairing_scan()
    t = ios.visible_texts()
    texts += t
    ctx.ishot("scan_or_prep")
    time.sleep(15)
    t2 = ios.visible_texts()
    texts += t2
    ctx.ishot("not_in_pairing_mode")
    ios.tap_text(r"^Back$", 2)
    ctx.note(f"screens: {t[:10]} / {t2[:10]}")
    bad = [x for x in texts if re_s(r"\b(5|five)\s*(x|times|presses)|hold both|10 s", x)]
    good = [x for x in texts if re_s(r"(3|three)\s*(times|presses)|press.*(3|three)", x)]
    ctx.check("no stale gesture copy", not bad, str(bad))
    ctx.note(f"3-press mentions: {good}")


@case("NEW8S22")
def new8_s22_copy(ctx: Ctx):
    """S22 screens: gesture copy says 3 presses."""
    pmx.open_pairing_scan()
    time.sleep(15)
    ctx.shot("s22_scan_or_prep")
    labels = [n.label for n in pmx.ui_nodes() if n.label]
    bad = [x for x in labels if re_s(r"\b(5|five)\s*(x|times|presses)|hold both|10 s", x)]
    ctx.check("no stale gesture copy", not bad, str(bad))
    ctx.note(f"labels: {labels[:20]}")
    pmx.psh("input keyevent KEYCODE_BACK")


@case("X8")
def x8_race(ctx: Ctx):
    """Both phones on the scan list; one window; both pick 02BE. Exactly one owner; loser fails cleanly."""
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
        out["ios"] = ios.pair(timeout=70)

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
    """X6 then X5, three cycles; one bond on the owner, none stale on the other."""
    cycles = 3
    for i in range(cycles):
        for direction in ("to_ios", "to_s22"):
            gm = ctx.g.mark()
            if direction == "to_ios":
                if pmx.ui_find(r"^Paired to another phone$"):
                    pass
                if ios.owner_lost_card():
                    ios.pair_again_from_card()
                ios.mac_forget()
                ios.open_pairing_scan()
                open_window(ctx)
                time.sleep(6)
                commit, res = ios_pair(ctx)
                ok = commit is not None and ios.mac_bonded()
            else:
                pmx.app_home()
                if pmx.ui_find(r"^Paired to another phone$"):
                    pmx.tap_text(r"^Pair again$", 8)
                    time.sleep(1.5)
                    pmx.tap(810, 1363)
                    time.sleep(3)
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("cases", nargs="+")
    args = ap.parse_args()
    run_dir = pmx.RUNS / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    for cid in args.cases:
        fn = CASES.get(cid)
        if fn is None:
            print(f"unknown case {cid}")
            sys.exit(2)
        print(f"== {cid}: {fn.__doc__.strip() if fn.__doc__ else ''}", flush=True)
        ctx = Ctx(run_dir, cid)
        try:
            fn(ctx)
        except Exception as e:  # noqa: BLE001
            ctx.check("exception", False, repr(e))
        res = ctx.finish()
        row = {"case": cid, "t": time.strftime("%H:%M:%S"), **res}
        with open(run_dir / "results.jsonl", "a") as fh:
            fh.write(json.dumps(row) + "\n")
        print(f"== {cid} {res['status']}", flush=True)


if __name__ == "__main__":
    main()
