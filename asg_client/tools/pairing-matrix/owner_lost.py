#!/usr/bin/env python3
"""R15 `owner_lost_on_notice`: assertions for the previous owner's phone and the glasses.

Plan section 7, implemented once for every case that uses it (D4BFIX, X6, X5, X7A, D4, X10,
X11, D5D7, NEW8 mini-takeover, and the missed-notice variant for BTOFF_REJOIN).

Universal assertions (scenarios takeover / ownerless / cancel), previous owner phone + glasses:
  1. log line `Glasses entering pairing mode — owner lost, no reconnect` on the previous owner's phone
  2. card "In pairing mode" visible within 10 s of the notice
  3. FULL 20 s observation interval from the notice, overlapping new-owner pairing and never
     ended early: no connect attempts, no sheet/prompt, no reconnect log lines.
     The function returns only after the interval ends, so a later intentional "Pair again"
     is always a separate step after it.
  4. glasses side: notice sent, previous owner removed (R4, BES owner record own=0/0 style)

Case-specific:
  takeover   new owner's commit: BES `owner committed from ble bond`, or BES own=1 plus the new
             phone's bond (the caller supplies `new_owner_bond`); iOS Success-after-pairing_info
             stays a case-level check.
  ownerless  (D4/X10, nobody pairs) glasses end ownerless and locked: BES own=0/0 and the
             advertisement pairing flag clear. The 120 s idle close is NOT waited for (F1 covers
             it): one single-click cancel after the interval closes the window.
  cancel     (X11) `cancel by single click`, no owner, hm_pairexit once, pairing flag cleared.
  notice     (D5D7 and other flows that continue with Pair again afterwards) only the universal
             assertions 1-4; no new owner, no close. The caller does the next step after the return.
  missed_notice (BTOFF_REJOIN, the phone returns into an OPEN window) there is no notice. R1: during a window
             non-owners may connect, so no 0x05 reject is required here. Required: the phone's rejection-based
             owner loss (`Owner loss (bond_removed_by_glasses)` / `gatt_auth_status_5`), a BES owner record
             showing the glasses did not admit it (own=0/0 stays, no commit), the card, and the same 20 s quiet
             interval after the loss.
  missed_notice_locked (BTOFF_REJOIN_LOCKED, the window is already closed and the glasses are ownerless) the 0x05
             reject applies (R1/R8): BES `ble_reject auth=N` (connect-time reject) or `encrypt_ltk drop` (a resolvable
             address peer dropped at encryption with disconnect reason 0x05), plus the same phone assertions.

Evidence rule (fact-to-evidence table): sources are interchangeable only for the SAME fact.
A missing BES ring line is backed up only by another source for that fact; otherwise it is
recorded as a harness gap (`ctx.gap`) and the case stays OPEN, never PASS.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

NOTICE_RX = re.compile(r"Glasses entering pairing mode \S+ owner lost, no reconnect")
OWNER_LOSS_RX = re.compile(r"Owner loss \((?P<reason>\w+)\)")
CARD_LABEL = "In pairing mode"
PROMPT_RX_ANDROID = r"配对请求|Pairing request"

# Connect attempts and reconnect logging on the previous owner's phone.
ANDROID_CONNECT_RX = re.compile(r"ATTEMPTING CONNECTION|Connecting to Mentra Live glasses|GATT link connected")
ANDROID_RECONNECT_RX = re.compile(
    r"Reconnect attempt #|Scheduling next reconnect|RECONNECT ABORTED|Reconnect scan (timed out|failed)"
    r"|Max reconnect attempts"
)
IOS_CONNECT_RX = re.compile(r"ImpossiBLE: sent .*type=connect\b|LIVE: Connecting to device")
IOS_RECONNECT_RX = re.compile(
    r"Scheduling reconnection attempt|Reconnection attempt \d+|Reconnection aborted"
    r"|Maximum reconnection attempts"
)

BES_POLL_S = 1.0  # how often the BES ring evidence is re-read while waiting for a fact (tests shrink it)

# BES lines that count as the HCI 0x05 reject of a former owner outside a window (m8_pairing.cpp):
#   `lxy pair: ble_reject auth=N`   connect-time reject (peer classified, or unresolved with no owner)
#   `lxy pair: encrypt_ltk drop`    resolvable-address peer dropped at encryption; the next disconnect reason is 0x05
BES_REJECT_RX = r"ble_reject auth=\d+|encrypt_ltk drop"


# ------------------------------------------------------------------------ results


@dataclass
class Assertion:
    name: str
    ok: bool
    source: str = ""
    detail: str = ""
    gap: bool = False  # proof missing for a BES fact: harness gap, case stays open


@dataclass
class OwnerLostResult:
    scenario: str
    previous_owner: str
    t0: float | None = None
    assertions: list = field(default_factory=list)
    during_value: object = None
    during_error: str | None = None
    card_after_s: float | None = None
    notice_line: str = ""
    probe: object = None
    phone_mark: int = 0
    t_end: float | None = None  # t0 + observe_s
    t_cancel: float | None = None  # wall time of the single click that closed the window (ownerless/cancel)

    @property
    def failed(self) -> list:
        return [a for a in self.assertions if not a.ok and not a.gap]

    @property
    def gaps(self) -> list:
        return [a for a in self.assertions if a.gap]

    @property
    def ok(self) -> bool:
        return not self.failed and not self.gaps


# ------------------------------------------------------------------------ probes


class Probe:
    """The previous owner's phone: logs plus UI. Subclasses wrap the real taps."""

    platform = "?"
    connect_rx = ANDROID_CONNECT_RX
    reconnect_rx = ANDROID_RECONNECT_RX

    def mark(self) -> int:
        raise NotImplementedError

    def lines_since(self, mark: int) -> list:
        raise NotImplementedError

    def poll(self, foreground: bool) -> tuple:
        """One UI sample: (card_visible, prompt_label_or_None)."""
        raise NotImplementedError

    def dismiss(self, label: str) -> None:
        """Clear a prompt so later steps are not blocked (still counted as a failure)."""


class AndroidProbe(Probe):
    platform = "s22"
    connect_rx = ANDROID_CONNECT_RX
    reconnect_rx = ANDROID_RECONNECT_RX

    def __init__(self, ctx):
        self.tap = ctx.p

    def mark(self) -> int:
        return self.tap.mark()

    def lines_since(self, mark: int) -> list:
        return self.tap.since(mark)

    def poll(self, foreground: bool) -> tuple:
        import pmx

        if foreground:
            pmx.app_home()
        nodes = pmx.ui_nodes()
        card = pmx.ui_find(rf"^{CARD_LABEL}$", nodes) is not None
        prompt = pmx.ui_find(PROMPT_RX_ANDROID, nodes)
        return card, (prompt.label if prompt else None)

    def dismiss(self, label: str) -> None:
        import pmx

        cancel = pmx.ui_find(r"^取消$|^Cancel$")
        if cancel:
            pmx.tap(*cancel.center)


class IosProbe(Probe):
    platform = "ios"
    connect_rx = IOS_CONNECT_RX
    reconnect_rx = IOS_RECONNECT_RX

    def __init__(self, ctx):
        self.tap = ctx.i

    def mark(self) -> int:
        return self.tap.mark()

    def lines_since(self, mark: int) -> list:
        return self.tap.since(mark)

    def poll(self, foreground: bool) -> tuple:
        import ios

        card = ios.owner_lost_card() if foreground else (ios.find(r".*In pairing mode.*") is not None)
        alert = ios.alert_text()
        sheet = ios.mac_sheet()
        label = alert or (f"mac sheet: {sheet}" if sheet else None)
        return card, label

    def dismiss(self, label: str) -> None:
        import ios

        if label.startswith("mac sheet"):
            ios.mac_sheet_click("Cancel")
        else:
            ios.handle_alert(("Cancel", "Not Now", "OK"))


def make_probe(ctx, previous_owner: str) -> Probe:
    if previous_owner == "s22":
        return AndroidProbe(ctx)
    if previous_owner == "ios":
        return IosProbe(ctx)
    raise ValueError(f"previous_owner must be 's22' or 'ios', got {previous_owner!r}")


# ------------------------------------------------------------------ interval scanning


def phone_lines_in_interval(lines: list, t0: float, observe_s: float, settle_s: float = 0.5) -> list:
    """(stamp, line) inside [t0 + settle, t0 + observe_s], without the stand-down lines themselves."""
    out = []
    for stamp, line in lines:
        if stamp < t0 + settle_s or stamp > t0 + observe_s:
            continue
        if "ReactNativeJS" in line or "blocked" in line:
            continue
        if NOTICE_RX.search(line) or OWNER_LOSS_RX.search(line):
            continue
        out.append((stamp, line))
    return out


def scan_interval(probe: Probe, mark: int, t0: float, observe_s: float, settle_s: float = 0.5) -> dict:
    lines = phone_lines_in_interval(probe.lines_since(mark), t0, observe_s, settle_s)
    return {
        "connects": [l for _, l in lines if probe.connect_rx.search(l)],
        "reconnects": [l for _, l in lines if probe.reconnect_rx.search(l)],
    }


# --------------------------------------------------------------------------- observer


class Observer(threading.Thread):
    """Background UI sampling on the previous owner's phone: card timing and prompts."""

    def __init__(self, probe: Probe, t0: float, observe_s: float, clock=time, poll_s: float = 0.5):
        super().__init__(daemon=True)
        self.probe, self.t0, self.observe_s, self.clock, self.poll_s = probe, t0, observe_s, clock, poll_s
        self.stop_flag = threading.Event()
        self.card_ts: float | None = None
        self.prompts: list = []
        self.errors: list = []
        self.blocked_exc = None
        self.polls = 0

    def run(self) -> None:
        end = self.t0 + self.observe_s
        while self.clock.time() < end and not self.stop_flag.is_set():
            ts = self.clock.time()
            try:
                card, prompt = self.probe.poll(foreground=self.polls >= 1 and self.card_ts is None)
                self.polls += 1
                if card and self.card_ts is None:
                    self.card_ts = ts
                if prompt:
                    self.prompts.append((ts, prompt))
                    self.probe.dismiss(prompt)
            except Exception as exc:  # noqa: BLE001
                if exc.__class__.__name__ == "BenchBlocked":
                    self.blocked_exc = exc
                    self.stop_flag.set()
                    return
                self.errors.append(repr(exc)[:160])
            self.stop_flag.wait(self.poll_s)

    def stop(self) -> None:
        self.stop_flag.set()


# --------------------------------------------------------------------- BES evidence


def first(lines: list) -> str | None:
    return lines[0] if lines else None


def prove_any(evidences: list, timeout: float, poll: float | None = None, clock=time) -> tuple | None:
    """evidences: [(source, fn)] with fn() -> detail str or None. Same fact only. Returns (source, detail)."""
    poll = BES_POLL_S if poll is None else poll
    deadline = clock.time() + timeout
    while True:
        for source, fn in evidences:
            detail = fn()
            if detail:
                return source, detail
        if clock.time() >= deadline:
            return None
        clock.sleep(poll)


def own_pair(line: str) -> tuple | None:
    m = re.search(r"own=(\d)/(\d)", line)
    return (int(m.group(1)), int(m.group(2))) if m else None


def bes_after_entry(ctx, gm: int, pattern: str) -> list:
    """BES lines matching `pattern` that come after the first mode_enter_done since `gm`.

    Lines before it carry the PREVIOUS owner's record (own=1/1) and must not count as the new owner.
    """
    seen, out = False, []
    rx = re.compile(pattern)
    for line in ctx.bes("", gm):
        if "mode_enter_done" in line:
            seen = True
            continue
        if seen and rx.search(line):
            out.append(line)
    return out


LXY_STATE_RX = re.compile(r"lxy pair: (?P<tag>\w+) st=(?P<st>\w+) .*?own=(?P<b>\d)/(?P<c>\d) .*?generation=(?P<gen>\d+)")


def owner_removal_transitions(lines: list) -> list:
    """BES owner-record proof that the previous owner was removed, from lines of ONE event, in ring order.

    Returns [(pre_line, proof_line)]: pre_line is the newest `lxy pair:` state line with own>=1 seen so far (the
    previous owner), proof_line is the next state line with st=PAIRING, own=0/0 and a window generation GREATER than
    pre_line's (generation increments on window entry, so it belongs to the same entry). Order is the ring's output
    order, not the tick (ticks can glitch). Lines before the pre-entry owner line never count, and a
    st=PAIRING own=0/0 line with the same generation as the owner line is an earlier window. The advertisement, the
    card and phone logs are never evidence for this fact.
    """
    out, pre = [], None
    for line in lines:
        m = LXY_STATE_RX.search(line)
        if not m:
            continue
        own = (int(m.group("b")), int(m.group("c")))
        gen = int(m.group("gen"))
        if own != (0, 0):
            pre = (line, gen)
        elif pre is not None and m.group("st") == "PAIRING" and gen > pre[1]:
            out.append((pre[0], line))
            pre = None
    return out


def owner_removal_proof(all_lines: list, post_lines: list | None = None, newest: bool = False):
    """Shared by the live path and readjudicate.py. `all_lines` is the whole ring since the case started (so the
    pre-entry owner record that R_S22/own_probe logged is there even though it predates the presses);
    `post_lines` the ring since the presses. Only a transition whose PROOF line is after the presses counts, so a
    transition from an earlier window (setup pairing) never proves this event. Returns (pre_line, proof_line)|None.
    First matching transition live; newest=True for a post-mortem over a whole trace."""
    post = set(post_lines) if post_lines is not None else None
    found = [t for t in owner_removal_transitions(all_lines) if post is None or t[1] in post]
    if not found:
        return None
    return found[-1] if newest else found[0]


def pairexit_count(ctx, gm: int) -> int:
    return len([1 for _, l in ctx.g.since(gm) if "hm_pairexit received" in l and "PairingAudio" in l])


# ----------------------------------------------------------------------- main entry


def record_window(ctx, name: str, start: float, end: float, required: float) -> None:
    """Record a required observation window. Shorter than `required` makes the case INVALID, never a pass."""
    actual = end - start
    ctx.note(f"window {name}: {actual:.2f}s required {required:.0f}s")
    phases = getattr(ctx, "phases", None)
    if isinstance(phases, list):
        phases.append({"phase": f"window_{name}", "start": start, "end": end, "required_s": required})
    if actual + 0.05 < required:
        msg = f"{name} ran {actual:.2f}s, required {required:.0f}s"
        mark = getattr(ctx, "mark_invalid", None)
        if mark:
            mark(msg)
        else:
            ctx.check(f"window {name} full length", False, msg)


def owner_lost_on_notice(
    ctx,
    previous_owner: str,
    *,
    scenario: str = "takeover",
    trigger: Callable[[], object],
    during: Callable[[], object] | None = None,
    probe: Probe | None = None,
    new_owner_bond: Callable[[], bool] | None = None,
    observe_s: float = 20.0,
    card_s: float = 10.0,
    notice_timeout: float = 15.0,
    rejection_timeout: float = 90.0,
    settle_s: float = 0.5,
    ui_poll_s: float = 0.5,
    bes_timeout: float = 15.0,
    close_window: str = "cancel",
    live_link: Callable[[], object] | None = None,
    cancel_at_s: float | None = None,
    adv: Callable[[], dict | None] | None = None,
    inject_click: Callable[[], object] | None = None,
    clock=time,
) -> OwnerLostResult:
    """Run one R15 owner-lost observation. See the module docstring for the assertion set.

    previous_owner  's22' or 'ios': the phone that held the glasses before the gesture.
    scenario        'takeover' | 'ownerless' | 'cancel' | 'notice' | 'missed_notice' | 'missed_notice_locked'.
    live_link       optional callable run BEFORE the gesture (not for the missed-notice scenarios, whose phone is
                    offline on purpose); it raises to block the case when the previous owner has no live link.
    trigger         performs the gesture / reconnect (one 3-press gesture, never retried); must not
                    sleep long, the interval is measured from the phone's notice line.
    during          runs right after the notice, overlapping the interval (the new owner pairing).
    new_owner_bond  takeover only: True when the new phone holds its bond (own=1 + bond evidence).
    close_window    ownerless only: 'cancel' (one single click after the interval) or 'none'.
    cancel_at_s     seconds after the notice for the single click (cancel scenario default 6.0,
                    ownerless default observe_s + 1.0).
    adv             callable returning the decoded `mentra` advertisement dict (or None).
    """
    if scenario not in ("takeover", "ownerless", "cancel", "missed_notice", "missed_notice_locked", "notice"):
        raise ValueError(f"unknown scenario {scenario!r}")
    probe = probe or make_probe(ctx, previous_owner)
    res = OwnerLostResult(scenario=scenario, previous_owner=previous_owner)
    gm, pm = ctx.g.mark(), probe.mark()
    res.probe, res.phone_mark = probe, pm

    def add(name: str, ok: bool, source: str = "", detail: str = "", gap: bool = False) -> Assertion:
        a = Assertion(name, bool(ok), source, detail, gap)
        res.assertions.append(a)
        return a

    missed = scenario in ("missed_notice", "missed_notice_locked")
    # ---- trigger and t0 --------------------------------------------------------------
    if live_link is not None and not missed:
        live_link()
        gm, pm = ctx.g.mark(), probe.mark()
        res.phone_mark = pm
    trigger()
    if missed:
        hit = _wait_phone(probe, pm, OWNER_LOSS_RX, rejection_timeout, clock)
        res.t0 = hit[0] if hit else None
        res.notice_line = hit[1] if hit else ""
        reason = (OWNER_LOSS_RX.search(hit[1]).group("reason") if hit else "")
        add("phone rejection-based owner loss (no notice)", bool(hit) and reason != "entering_pairing_mode",
            "phone", hit[1][-160:] if hit else "no `Owner loss (...)` line after the reconnect")
        notice_seen = [l for _, l in probe.lines_since(pm) if NOTICE_RX.search(l)]
        add("scenario valid: no entering_pairing_mode notice was received", not notice_seen, "phone",
            notice_seen[0][-120:] if notice_seen else "")
    else:
        hit = _wait_phone(probe, pm, NOTICE_RX, notice_timeout, clock)
        res.t0 = hit[0] if hit else None
        res.notice_line = hit[1] if hit else ""
        add("1 notice log line on previous owner phone", bool(hit), "phone",
            hit[1][-140:] if hit else f"no `owner lost, no reconnect` line within {notice_timeout:.0f} s: "
            "STOP and investigate whether this phone received entering_pairing_mode")
    t0 = res.t0 if res.t0 is not None else clock.time()
    res.t_end = t0 + observe_s

    # ---- overlapping observation ----------------------------------------------------
    obs = Observer(probe, t0, observe_s, clock, poll_s=ui_poll_s)
    obs.start()
    cancel_done = None
    if scenario in ("cancel", "ownerless") and (scenario == "cancel" or close_window == "cancel"):
        at = cancel_at_s if cancel_at_s is not None else (6.0 if scenario == "cancel" else observe_s + 1.0)
    else:
        at = None

    if during is not None:
        try:
            res.during_value = during()
        except Exception as exc:  # noqa: BLE001
            res.during_error = repr(exc)[:300]

    if at is not None:
        wait = t0 + at - clock.time()
        if at <= observe_s and wait > 0:
            clock.sleep(wait)
        if at <= observe_s:
            cancel_done = _single_click(ctx, inject_click)
            res.t_cancel = clock.time()

    remaining = t0 + observe_s - clock.time()
    if remaining > 0:
        clock.sleep(remaining)
    record_window(ctx, "quiet", t0, clock.time(), observe_s)
    obs.stop()
    obs.join(timeout=60)
    if obs.blocked_exc is not None:
        raise obs.blocked_exc
    if at is not None and at > observe_s:
        wait = t0 + at - clock.time()
        if wait > 0:
            clock.sleep(wait)
        cancel_done = _single_click(ctx, inject_click)
        res.t_cancel = clock.time()

    # ---- phone-side assertions ------------------------------------------------------
    if res.during_error:
        add("new-owner/during action completed", False, "harness", res.during_error)
    if obs.errors:
        ctx.note(f"observer UI errors (non-fatal): {obs.errors[:3]}")
    if obs.card_ts is not None:
        res.card_after_s = obs.card_ts - t0
    add("2 card 'In pairing mode' within 10 s",
        obs.card_ts is not None and res.card_after_s <= card_s, "phone UI",
        f"first seen {res.card_after_s:.1f}s after t0 (UI poll start time; {obs.polls} polls)"
        if obs.card_ts is not None else f"not seen in {obs.polls} polls over {observe_s:.0f} s")
    scan = scan_interval(probe, pm, t0, observe_s, settle_s)
    quiet = f"interval {observe_s:.0f} s from t0"
    add("3a no connect attempts for 20 s", not scan["connects"], "phone log",
        str([c[-110:] for c in scan["connects"][:3]]) or quiet)
    add("3b no sheet/prompt for 20 s", not obs.prompts, "phone UI",
        str(obs.prompts[:2]) if obs.prompts else quiet)
    add("3c no reconnect log lines for 20 s", not scan["reconnects"], "phone log",
        str([c[-110:] for c in scan["reconnects"][:3]]) or quiet)

    # ---- glasses-side facts ---------------------------------------------------------
    _glasses_assertions(ctx, res, add, gm, scenario, notice_seen=bool(res.notice_line) and not missed,
                        new_owner_bond=new_owner_bond, bes_timeout=bes_timeout, clock=clock, adv=adv,
                        close_window=close_window, cancel_done=cancel_done)

    for a in res.assertions:
        if a.gap:
            ctx.gap(f"R15 {a.name}", a.detail)
        else:
            ctx.check(f"R15 {a.name}", a.ok, f"[{a.source}] {a.detail}".strip())
    return res


def observe_after_close(ctx, res: OwnerLostResult, seconds: float = 30.0, ui_poll_s: float = 3.0,
                        settle_s: float = 0.5, clock=time) -> OwnerLostResult:
    """After the window was closed (ownerless/cancel), watch the previous owner for `seconds` more.

    The old D4FIX waited out a 300 s yield to see whether the phone reclaimed; R15 has no yield, so the
    equivalent is: after the window is gone the phone still makes no connect attempt, no reconnect line, no
    prompt, and the card stays. Longer-term no-reclaim stays covered by BTOFF_REJOIN, X3 and G3.
    """
    probe = res.probe
    start = res.t_cancel or res.t_end or clock.time()
    end = start + seconds
    prompts, card_last, polls = [], None, 0
    while clock.time() < end:
        card, prompt = probe.poll(foreground=False)
        polls += 1
        card_last = card
        if prompt:
            prompts.append((clock.time(), prompt))
            probe.dismiss(prompt)
        left = end - clock.time()
        if left > 0:
            clock.sleep(min(ui_poll_s, left))
    record_window(ctx, "post_close", start, clock.time(), seconds)
    scan = scan_interval(probe, res.phone_mark, start, seconds, settle_s)
    out = [
        Assertion(f"7a no connect attempts for {seconds:.0f} s after the window closed", not scan["connects"],
                  "phone log", str([c[-110:] for c in scan["connects"][:3]])),
        Assertion(f"7b no reconnect log lines for {seconds:.0f} s after the window closed", not scan["reconnects"],
                  "phone log", str([c[-110:] for c in scan["reconnects"][:3]])),
        Assertion(f"7c no sheet/prompt for {seconds:.0f} s after the window closed", not prompts, "phone UI",
                  str(prompts[:2])),
        Assertion("7d card still shown after the window closed", bool(card_last), "phone UI", f"{polls} polls"),
    ]
    for a in out:
        ctx.check(f"R15 {a.name}", a.ok, f"[{a.source}] {a.detail}".strip())
    res.assertions.extend(out)
    return res


# ----------------------------------------------------------------------------- helpers


def _wait_phone(probe: Probe, mark: int, rx: re.Pattern, timeout: float, clock=time):
    deadline = clock.time() + timeout
    seen = mark
    while True:
        chunk = probe.lines_since(seen)
        seen += len(chunk)
        for stamp, line in chunk:
            if "ReactNativeJS" in line:
                continue
            if rx.search(line):
                return stamp, line
        if clock.time() >= deadline:
            return None
        clock.sleep(0.25)


def _single_click(ctx, inject_click) -> bool:
    if inject_click is not None:
        inject_click()
        return True
    import pmx

    pmx.inject("C", 50)
    return True


def _glasses_assertions(ctx, res, add, gm, scenario, *, notice_seen, new_owner_bond, bes_timeout, clock, adv,
                        close_window, cancel_done) -> None:
    # Fact: notice was sent by the glasses (BES line, or the phone's received-notice line). Not the card.
    if scenario not in ("missed_notice", "missed_notice_locked"):
        bes_notice = first(ctx.bes(r"entering_pairing_mode", gm))
        if bes_notice:
            add("4a glasses sent entering_pairing_mode", True, "bes", bes_notice)
        elif notice_seen:
            add("4a glasses sent entering_pairing_mode", True, "phone received-notice line",
                "BES ring has no entering_pairing_mode trace; the phone's received-notice line proves the same fact")
        else:
            add("4a glasses sent entering_pairing_mode", False, "-", "neither BES nor the phone shows the notice")

        # Fact: previous owner removed (R4). BES only: phone log and advertisement cannot prove it.
        before = ctx.bes(r"(pwr_press|mode_enter|click_window_end) st=\w+ .*own=\d/\d", gm)
        after = ctx.bes(r"mode_enter_done .*own=\d/\d", gm)
        pre = own_pair(before[0]) if before else None
        post = own_pair(after[-1]) if after else None
        deleted = ctx.bes(r"clear_owner|bond_deleted|bond.*delet", gm)
        if post is not None and post != (0, 0):
            add("4b previous owner removed (R4)", False, "bes", f"owner still recorded after entry: {after[-1]}")
        elif post == (0, 0) and pre is not None and pre != (0, 0):
            add("4b previous owner removed (R4)", True, "bes", f"own={pre[0]}/{pre[1]} -> own=0/0: {after[-1]}")
        elif deleted:
            add("4b previous owner removed (R4)", True, "bes bond deletion", deleted[0])
        elif owner_removal_proof(ctx.bes("", 0), ctx.bes("", gm)):
            pre_line, proof_line = owner_removal_proof(ctx.bes("", 0), ctx.bes("", gm))
            add("4b previous owner removed (R4)", True, "bes owner record (generation advanced)",
                f"{pre_line}  =>  {proof_line}")
        elif post == (0, 0):
            add("4b previous owner removed (R4)", False, "bes",
                f"own=0/0 after entry but no pre-entry owner record in the ring (pre={pre}); the glasses may "
                "not have held this phone as owner", gap=False)
        else:
            add("4b previous owner removed (R4)", False, "-",
                "HARNESS GAP: no BES owner record (mode_enter_done) and no bond-deletion line; phone log and "
                "advertisement cannot prove BES erased ownership", gap=True)

    if scenario == "takeover":
        hit = prove_any([
            ("bes", lambda: first(ctx.bes(r"owner committed from ble bond", gm))),
            ("bes own=1 + new phone bond",
             lambda: (first(bes_after_entry(ctx, gm, r"st=\w+ .*own=1/\d"))
                      if new_owner_bond and new_owner_bond() else None)),
        ], bes_timeout, clock=clock)
        if hit:
            add("5 new owner committed", True, hit[0], hit[1])
        else:
            add("5 new owner committed", False, "-",
                "HARNESS GAP: no BES `owner committed from ble bond` and no own=1 + bond for the new phone; "
                "UI Success or advertisement cannot prove a BES commit", gap=True)

    if scenario in ("ownerless", "cancel"):
        _close_and_ownerless(ctx, res, add, gm, scenario, bes_timeout, clock, adv, close_window, cancel_done)

    if scenario == "missed_notice_locked":
        hit = prove_any([("bes", lambda: first(ctx.bes(BES_REJECT_RX, gm)))], bes_timeout, clock=clock)
        if hit:
            add("4 glasses rejected the reconnect (HCI 0x05: ble_reject / encrypt_ltk drop)", True, "bes", hit[1])
        else:
            add("4 glasses rejected the reconnect (HCI 0x05: ble_reject / encrypt_ltk drop)", False, "-",
                "HARNESS GAP: no BES `ble_reject auth=N` and no `encrypt_ltk drop` line; the phone's owner-loss log "
                "alone does not prove the glasses rejected it", gap=True)
    elif scenario == "missed_notice":
        # Window open (R1: non-owners may connect): the glasses must simply not admit it as owner.
        def not_admitted():
            lines = ctx.bes("", gm)
            if any(own_pair(l) not in (None, (0, 0)) for l in lines if LXY_STATE_RX.search(l)) or \
                    any("owner committed" in l for l in lines):
                return "ADMITTED"
            zero = [l for l in lines if LXY_STATE_RX.search(l) and own_pair(l) == (0, 0)]
            return zero[-1] if zero else None

        hit = prove_any([("bes", not_admitted)], bes_timeout, clock=clock)
        if hit and hit[1] == "ADMITTED":
            add("4 glasses did not admit the returning phone as owner (own=0/0 stays)", False, "bes",
                "a BES owner record shows an owner after the phone returned")
        elif hit:
            add("4 glasses did not admit the returning phone as owner (own=0/0 stays)", True, "bes", hit[1])
        else:
            add("4 glasses did not admit the returning phone as owner (own=0/0 stays)", False, "-",
                "HARNESS GAP: no BES owner record after the phone returned (own=0/0 or otherwise); the phone's "
                "owner-loss log cannot prove what the glasses recorded", gap=True)
        rej = first(ctx.bes(BES_REJECT_RX, gm))
        if rej:
            res.assertions[-1].detail += f" (also rejected: {rej.strip()[:60]})"


def _close_and_ownerless(ctx, res, add, gm, scenario, bes_timeout, clock, adv, close_window, cancel_done) -> None:
    if scenario == "cancel":
        hit = prove_any([("bes", lambda: first(ctx.bes(r"cancel by single click", gm)))], bes_timeout, clock=clock)
        add("6 cancel by single click", bool(hit), "bes", hit[1] if hit else "no `cancel by single click` line")
        count = pairexit_count(ctx, gm)
        add("6 hm_pairexit exactly once", count == 1, "glasses log", str(count))
    elif close_window == "cancel":
        hit = prove_any([("bes", lambda: first(ctx.bes(r"window_close reason=", gm)))], bes_timeout, clock=clock)
        add("6 window closed by one single click (idle close is F1)", bool(hit), "bes",
            hit[1] if hit else "no window_close after the single click")
    else:
        add("6 ownerless locked", False, "-",
            "HARNESS GAP: close_window='none': the window is still open, adv pairing flag cannot be clear",
            gap=True)
        return

    owner = ctx.bes(r"window_close st=\w+ .*own=\d/\d|click_window_end st=\w+ .*own=\d/\d", gm)
    owner_last = own_pair(owner[-1]) if owner else None
    if owner_last == (0, 0):
        add("6 BES ownerless (own=0/0)", True, "bes", owner[-1])
    elif owner_last is not None:
        add("6 BES ownerless (own=0/0)", False, "bes", f"owner recorded: {owner[-1]}")
    else:
        add("6 BES ownerless (own=0/0)", False, "-", "HARNESS GAP: no BES owner record after the close", gap=True)
    a = adv() if adv else None
    m = (a or {}).get("mentra", {}) if a else {}
    if not a:
        add("6 adv pairing flag clear", False, "-",
            "HARNESS GAP: glasses advertisement not seen; BES window_close cannot prove the flag", gap=True)
    else:
        add("6 adv pairing flag clear", not m.get("pairing"), "adv", str(m))
