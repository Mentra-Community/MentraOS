#!/usr/bin/env python3
"""v4 `window_transition`: what the previous owner (A) and the glasses do across ONE pairing window.

OS-2055, pairing-spec "Ownership transfer v4" V1-V8, transition matrix V6 rows O1, O2 and O4. The older
`owner_lost_on_notice` (R15: owner forgotten at entry, "In pairing mode" card within 10 s, a 20 s quiet interval, a
single-click cancel) encoded the removed behavior and is gone. This module keeps its probes, its observer thread and
its evidence helpers (`prove_any`, the BES owner-record parsers) and observes the new contract instead.

Scenarios (A owned the glasses and was connected when the gesture was made):

  timeout   O1  nobody pairs. BES `window_close reason=timeout` near 120 s (no 300 s cap), `hm_pairexit timeout`
                ("Pairing mode ended. No new phone paired." once), advertisement pairing flag and OWNER_CHANGED
                clear, no bond change (owner record untouched, no commit), and A: pairing_mode -> normal ->
                reconnects with zero action, never Pair Again.
  cancel    O2  one triple press (the toggle) closes the window: `3-press while pairing, cancel`, reason=toggle,
                `hm_pairexit cancelled` ("Pairing cancelled." once); the same A-side outcome as O1.
  takeover  O4  B pairs inside the window (`during`). BES commits B (V2 steps 1/3, 2/3, 3/3 in order,
                `pairflow commit replace_owner`), `hm_pairexit paired` (or skipped when Connected follows),
                OWNER_CHANGED set in the advertisement; A: pairing_mode -> pairing_rejected, the Pair Again card
                (and nothing else), no connect attempt after the stand-down, never connected again.

Universal assertions on A's phone (every scenario):
  1. the SDK moved to `pairing_mode` (`PAIRFLOW: pairing_state ... state=pairing_mode(window=N`).
  2. the popup "Your glasses are in pairing mode" showed exactly once for that window.
  3. while paused (from pairing_mode to the first normal/rejected state): no connect attempt, no reconnect
     line, no Pair Again, no system sheet, no pairing_rejected.
  4. none of the removed signals (owner_replaced, Owner loss, confirm_replace_owner, awaiting_confirm,
     retained_owner_link, owner_reclaim) ever shows up.
  5. glasses: the retained owner is never cleared at entry (BES `xfer enter, owner retained`, own != 0/0).

Evidence rule (fact-to-evidence table): sources are interchangeable only for the SAME fact. A missing BES ring line
is backed up only by another source for that fact; otherwise it is recorded as a harness gap (`ctx.gap`) and the case
stays OPEN, never PASS.

The BES owner-record parsers at the bottom (`owner_removal_transitions`, `owner_removal_proof`) prove the REMOVED
forget-on-entry behavior of flag-off firmware. They stay only so readjudicate.py can still re-judge old runs.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

# ------------------------------------------------------------------ phone log markers

# Both SDKs log every public-state change as `PAIRFLOW: pairing_state source=... state=<describe>`.
PAIRING_MODE_RX = re.compile(r"PAIRFLOW: pairing_state\b.*state=pairing_mode\(window=(?P<window>\d+)")
NORMAL_RX = re.compile(r"PAIRFLOW: pairing_state\b.*state=normal\b")
REJECTED_RX = re.compile(r"PAIRFLOW: pairing_state\b.*state=pairing_rejected\b")
STATE_CHANGE_RX = re.compile(r"PAIRFLOW: pairing_state\b.*state=(?P<state>normal|pairing_mode|pairing_rejected)")
PAUSED_RX = re.compile(r"connectDefault deferred .*pairing_mode")

# Signals of the removed protocol-3 / R15 behavior. They must never appear in a v4 run.
REMOVED_SIGNAL_RX = re.compile(
    r"owner_replaced|Owner loss \(|owner lost, no reconnect|confirm_replace_owner|awaiting_confirm"
    r"|retained_owner_link|owner_reclaim"
)

POPUP_TITLE = "Your glasses are in pairing mode"
PAIR_AGAIN_LABEL = "Pair Again"
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

# A live link to the owner: readiness / heartbeat lines, and the lines that say it is gone.
LINK_UP_RX = {
    "s22": re.compile(r"Received pong response - connection healthy|BLE reconnection fully ready"
                      r"|Received glasses_ready message"),
    "ios": re.compile(r"Received pong response - connection healthy|Received glasses_ready message"
                      r"|pairing_info confirms owner commit"),
}
LINK_DOWN_RX = {
    "s22": re.compile(r"Disconnected from GATT server|Disconnecting from Mentra Live glasses"
                      r"|MAN: Device disconnected"),
    "ios": re.compile(r"Disconnected from GATT server|disconnect\(\) -Disconnecting"),
}

BES_POLL_S = 1.0  # how often the BES ring evidence is re-read while waiting for a fact (tests shrink it)

# BES lines that count as the HCI 0x05 reject of a former owner outside a window (m8_pairing.cpp).
BES_REJECT_RX = r"ble_reject auth=\d+|encrypt_ltk drop"
# BES lines that count as the owner's refusal inside a window: 0x14 after the one 15 s grace.
BES_OWNER_REFUSED_RX = r"owner refused conidx=\d+|ble_reject retained owner, grace used"

WINDOW_MS = 120_000
TIMEOUT_CLOSE_RANGE_S = (110.0, 135.0)  # 120 s window, 30 s bounded deferral only for a non-owner bond


# ------------------------------------------------------------------------ results


@dataclass
class Assertion:
    name: str
    ok: bool
    source: str = ""
    detail: str = ""
    gap: bool = False  # proof missing for a BES fact: harness gap, case stays open


@dataclass
class TransitionResult:
    scenario: str
    previous_owner: str
    t_trigger: float | None = None
    t0: float | None = None  # stamp of the phone's pairing_mode state line
    window_id: int | None = None
    t_resume: float | None = None  # first normal / pairing_rejected line after t0
    t_rejected: float | None = None
    t_close: float | None = None  # wall time at which the BES close line was seen
    assertions: list = field(default_factory=list)
    during_value: object = None
    during_error: str | None = None
    popup_count: int = 0
    probe: object = None
    phone_mark: int = 0
    notice_line: str = ""

    @property
    def failed(self) -> list:
        return [a for a in self.assertions if not a.ok and not a.gap]

    @property
    def gaps(self) -> list:
        return [a for a in self.assertions if a.gap]

    @property
    def ok(self) -> bool:
        return not self.failed and not self.gaps


@dataclass
class UiSample:
    popup: bool = False
    pair_again: bool = False
    prompt: str | None = None  # a system pairing sheet or similar: never expected on the previous owner


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

    def sample(self, foreground: bool) -> UiSample:
        """One UI sample."""
        raise NotImplementedError

    def dismiss_popup(self) -> None:
        """Answer the pairing-mode popup with its one OK button."""

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

    def sample(self, foreground: bool) -> UiSample:
        import pmx

        if foreground:
            pmx.app_home()
        nodes = pmx.ui_nodes()
        prompt = pmx.ui_find(PROMPT_RX_ANDROID, nodes)
        return UiSample(
            popup=pmx.ui_find(rf"^{re.escape(POPUP_TITLE)}$", nodes) is not None,
            pair_again=pmx.ui_find(rf"^{PAIR_AGAIN_LABEL}$", nodes) is not None,
            prompt=prompt.label if prompt else None,
        )

    def dismiss_popup(self) -> None:
        import pmx

        ok = pmx.ui_find(r"^OK$")
        if ok:
            pmx.tap(*ok.center)

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

    def sample(self, foreground: bool) -> UiSample:
        import ios

        alert = ios.alert_text()
        sheet = ios.mac_sheet()
        if foreground and not alert:
            ios.home()
        label = None if alert and POPUP_TITLE in alert else (alert or (f"mac sheet: {sheet}" if sheet else None))
        return UiSample(
            popup=bool(alert) and POPUP_TITLE in alert or ios.find(rf"^{re.escape(POPUP_TITLE)}$") is not None,
            pair_again=ios.find(rf"^{PAIR_AGAIN_LABEL}$") is not None,
            prompt=label,
        )

    def dismiss_popup(self) -> None:
        import ios

        ios.handle_alert(("OK",))

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


def phone_lines_in_interval(lines: list, start: float, end: float, settle_s: float = 0.5) -> list:
    """(stamp, line) inside [start + settle, end], without the state/stand-down lines themselves."""
    out = []
    for stamp, line in lines:
        if stamp < start + settle_s or stamp > end:
            continue
        if "ReactNativeJS" in line or re.search(r"blocked|deferred|paused", line):
            continue
        if STATE_CHANGE_RX.search(line):
            continue
        out.append((stamp, line))
    return out


def scan_interval(probe: Probe, mark: int, start: float, end: float, settle_s: float = 0.5) -> dict:
    lines = phone_lines_in_interval(probe.lines_since(mark), start, end, settle_s)
    return {
        "connects": [l for _, l in lines if probe.connect_rx.search(l)],
        "reconnects": [l for _, l in lines if probe.reconnect_rx.search(l)],
    }


def first_stamp(lines: list, rx: re.Pattern, after: float | None = None):
    """(stamp, line) of the first non-RN line matching rx (strictly after `after` when given), else None."""
    for stamp, line in lines:
        if "ReactNativeJS" in line:
            continue
        if after is not None and stamp <= after:
            continue
        if rx.search(line):
            return stamp, line
    return None


# --------------------------------------------------------------------------- observer


class Observer(threading.Thread):
    """Background UI sampling on the previous owner's phone: popup count, Pair Again timing, prompts."""

    def __init__(self, probe: Probe, clock=time, poll_s: float = 2.0, max_s: float = 400.0):
        super().__init__(daemon=True)
        self.probe, self.clock, self.poll_s, self.max_s = probe, clock, poll_s, max_s
        self.stop_flag = threading.Event()
        self.popups: list = []  # rising edges of the popup (timestamps)
        self.pair_again: list = []  # (timestamp, visible) samples
        self.prompts: list = []
        self.errors: list = []
        self.blocked_exc = None
        self.polls = 0
        self._popup_up = False

    def run(self) -> None:
        end = self.clock.time() + self.max_s
        while self.clock.time() < end and not self.stop_flag.is_set():
            ts = self.clock.time()
            try:
                s = self.probe.sample(foreground=self.polls == 0)
                self.polls += 1
                if s.popup and not self._popup_up:
                    self.popups.append(ts)
                    self.probe.dismiss_popup()
                self._popup_up = s.popup
                self.pair_again.append((ts, s.pair_again))
                if s.prompt:
                    self.prompts.append((ts, s.prompt))
                    self.probe.dismiss(s.prompt)
            except Exception as exc:  # noqa: BLE001
                if exc.__class__.__name__ == "BenchBlocked":
                    self.blocked_exc = exc
                    self.stop_flag.set()
                    return
                self.errors.append(repr(exc)[:160])
            self.stop_flag.wait(self.poll_s)

    def stop(self) -> None:
        self.stop_flag.set()

    def first_pair_again(self, after: float = 0.0):
        for ts, seen in self.pair_again:
            if seen and ts >= after:
                return ts
        return None


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


def pairexit_count(ctx, gm: int) -> int:
    return len([1 for _, l in ctx.g.since(gm) if "hm_pairexit received" in l and "PairingAudio" in l])


def commit_steps(lines: list) -> list:
    """The V2 commit step numbers (1, 2, 3) in ring order from `lxy pair: commit N/3 ...` lines."""
    return [int(m.group(1)) for l in lines for m in [re.search(r"lxy pair: commit (\d)/3", l)] if m]


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


# ----------------------------------------------------------------------- main entry

CLOSE_FACTS = {
    # scenario: (BES window_close line, hm_pairexit reason, advertisement OWNER_CHANGED expected)
    "timeout": (r"window_close reason=timeout", "timeout", False),
    "cancel": (r"window_close reason=toggle", "cancelled", False),
}


def window_transition(
    ctx,
    previous_owner: str,
    *,
    scenario: str = "timeout",
    trigger: Callable[[], object],
    during: Callable[[], object] | None = None,
    probe: Probe | None = None,
    new_owner_bond: Callable[[], bool] | None = None,
    notice_timeout: float = 15.0,
    cancel_at_s: float = 6.0,
    close_timeout: float = 150.0,
    resume_timeout: float = 45.0,
    reconnect_timeout: float = 120.0,
    rejection_timeout: float = 120.0,
    card_s: float = 10.0,
    post_quiet_s: float = 20.0,
    settle_s: float = 0.5,
    ui_poll_s: float = 2.0,
    bes_timeout: float = 15.0,
    live_link: Callable[[], object] | None = None,
    adv: Callable[[], dict | None] | None = None,
    inject_cancel: Callable[[], object] | None = None,
    clock=time,
) -> TransitionResult:
    """Run one v4 window observation. See the module docstring for the assertion set.

    previous_owner  's22' or 'ios': the phone that held the glasses (live link) before the gesture.
    scenario        'timeout' (O1) | 'cancel' (O2) | 'takeover' (O4).
    live_link       optional callable run BEFORE the gesture; raises to block the case when A has no live link.
    trigger         performs the one 3-press gesture (never retried); must not sleep long.
    during          takeover: runs right after the notice (B pairing); overlaps A's paused interval.
    new_owner_bond  takeover only: True when B holds its bond (own=1 + bond evidence).
    cancel_at_s     cancel only: seconds after the phone's pairing_mode line for the triple press.
    close_timeout   timeout only: how long to wait for the BES close line (120 s + 30 s deferral cap).
    adv             callable returning the decoded `mentra` advertisement dict (or None).
    inject_cancel   the toggle gesture (default: one triple press through pmx.inject).
    """
    if scenario not in ("timeout", "cancel", "takeover"):
        raise ValueError(f"unknown scenario {scenario!r}")
    probe = probe or make_probe(ctx, previous_owner)
    res = TransitionResult(scenario=scenario, previous_owner=previous_owner)
    gm, pm = ctx.g.mark(), probe.mark()
    res.probe, res.phone_mark = probe, pm

    def add(name: str, ok: bool, source: str = "", detail: str = "", gap: bool = False) -> Assertion:
        a = Assertion(name, bool(ok), source, detail, gap)
        res.assertions.append(a)
        return a

    # ---- trigger and t0 --------------------------------------------------------------
    if live_link is not None:
        live_link()
        gm, pm = ctx.g.mark(), probe.mark()
        res.phone_mark = pm
    res.t_trigger = clock.time()
    trigger()
    hit = _wait_phone(probe, pm, PAIRING_MODE_RX, notice_timeout, clock)
    res.t0 = hit[0] if hit else None
    res.notice_line = hit[1] if hit else ""
    if hit:
        res.window_id = int(PAIRING_MODE_RX.search(hit[1]).group("window"))
    add("1 SDK state pairing_mode on the previous owner's phone", bool(hit), "phone",
        hit[1][-140:] if hit else f"no `state=pairing_mode(window=` line within {notice_timeout:.0f} s: STOP and "
        "investigate whether this phone received entering_pairing_mode (phone_hello declared protocol 4?)")
    t0 = res.t0 if res.t0 is not None else clock.time()

    obs = Observer(probe, clock, poll_s=ui_poll_s)
    obs.start()

    # ---- scenario body ------------------------------------------------------------------
    if during is not None:
        try:
            res.during_value = during()
        except Exception as exc:  # noqa: BLE001
            res.during_error = repr(exc)[:300]

    if scenario == "cancel":
        wait = t0 + cancel_at_s - clock.time()
        if wait > 0:
            clock.sleep(wait)
        _cancel_gesture(inject_cancel)
        res.t_close = clock.time()
        bes_pat = CLOSE_FACTS["cancel"][0]
        hit_close = prove_any([("bes", lambda: first(ctx.bes(bes_pat, gm)))], bes_timeout, clock=clock)
    elif scenario == "timeout":
        hit_close = prove_any([("bes", lambda: first(ctx.bes(CLOSE_FACTS["timeout"][0], gm)))], close_timeout,
                              clock=clock)
        res.t_close = clock.time()
    else:  # takeover: the commit closes the window
        hit_close = prove_any([
            ("bes", lambda: first(ctx.bes(r"owner committed from ble bond", gm))),
            ("bes own=1 + new phone bond",
             lambda: (first(_after_entry(ctx, gm, r"st=\w+ .*own=1/\d"))
                      if new_owner_bond and new_owner_bond() else None)),
        ], bes_timeout, clock=clock)
        res.t_close = clock.time()

    # ---- A's phone: resume (normal) or stand-down (pairing_rejected) -------------------------
    wait_s = rejection_timeout if scenario == "takeover" else resume_timeout
    resume = _wait_phone(probe, pm, re.compile(NORMAL_RX.pattern + "|" + REJECTED_RX.pattern), wait_s, clock,
                         after=t0)
    if resume is not None:
        res.t_resume = resume[0]
    if scenario == "takeover":
        rej = resume if resume is not None and REJECTED_RX.search(resume[1]) else _wait_phone(
            probe, pm, REJECTED_RX, rejection_timeout, clock, after=t0)
        res.t_rejected = rej[0] if rej else None
        if rej and res.t_resume is None:
            res.t_resume = rej[0]
    reconnect = None
    if scenario in ("timeout", "cancel") and res.t_resume is not None:
        reconnect = _wait_phone(probe, pm, LINK_UP_RX[previous_owner], reconnect_timeout, clock, after=res.t_resume)
    if scenario == "takeover" and res.t_rejected is not None:
        quiet_end = res.t_rejected + post_quiet_s
        wait = quiet_end - clock.time()
        if wait > 0:
            clock.sleep(wait)
    obs.stop()
    obs.join(timeout=60)
    if obs.blocked_exc is not None:
        raise obs.blocked_exc
    res.popup_count = len(obs.popups)

    # ---- phone-side assertions ------------------------------------------------------
    if res.during_error:
        add("new-owner/during action completed", False, "harness", res.during_error)
    if obs.errors:
        ctx.note(f"observer UI errors (non-fatal): {obs.errors[:3]}")
    add("2 popup 'Your glasses are in pairing mode' shown exactly once for the window", len(obs.popups) == 1,
        "phone UI", f"{len(obs.popups)} sighting(s) in {obs.polls} polls")
    paused_end = res.t_resume if res.t_resume is not None else clock.time()
    scan = scan_interval(probe, pm, t0, paused_end, settle_s)
    quiet = f"paused interval {paused_end - t0:.0f} s from the pairing_mode line"
    add("3a no connect attempts while paused", not scan["connects"], "phone log",
        str([c[-110:] for c in scan["connects"][:3]]) or quiet)
    add("3b no reconnect log lines while paused", not scan["reconnects"], "phone log",
        str([c[-110:] for c in scan["reconnects"][:3]]) or quiet)
    add("3c no sheet/prompt on the previous owner", not obs.prompts, "phone UI",
        str(obs.prompts[:2]) if obs.prompts else quiet)
    early_card = [ts for ts, seen in obs.pair_again if seen and ts < paused_end]
    add("3d no Pair Again while paused (reconnecting card only)", not early_card, "phone UI",
        f"Pair Again seen at +{early_card[0] - t0:.1f}s" if early_card else quiet)
    add("4 no removed signal (owner_replaced, Owner loss, confirm_replace_owner, awaiting_confirm, "
        "retained_owner_link, owner_reclaim)",
        not [l for _, l in probe.lines_since(pm) if REMOVED_SIGNAL_RX.search(l)], "phone log",
        str([l[-100:] for _, l in probe.lines_since(pm) if REMOVED_SIGNAL_RX.search(l)][:2]))

    if scenario in ("timeout", "cancel"):
        add("5 SDK resumed to normal (flag cleared, pairing_mode_ended or endsAtMs)", res.t_resume is not None
            and bool(NORMAL_RX.search(resume[1])), "phone",
            resume[1][-120:] if resume else f"no `state=normal` line within {resume_timeout:.0f} s of the close")
        add("5 A reconnected with zero action", reconnect is not None, "phone",
            reconnect[1][-120:] if reconnect else f"no link-up line within {reconnect_timeout:.0f} s of normal")
        add("5 never rejected (no Pair Again, no pairing_rejected)",
            not any(REJECTED_RX.search(l) for _, l in probe.lines_since(pm)) and
            not [ts for ts, seen in obs.pair_again if seen], "phone UI+log", "")
    else:
        add("5 A's SDK reached pairing_rejected", res.t_rejected is not None, "phone",
            f"+{res.t_rejected - t0:.1f}s after pairing_mode" if res.t_rejected else
            f"no `state=pairing_rejected` line within {rejection_timeout:.0f} s (bit path: one verification "
            "reconnect; fallback: three-strike auth streak)")
        card = obs.first_pair_again(res.t_rejected) if res.t_rejected is not None else None
        add("5 Pair Again card within 10 s of the rejection", card is not None and card - res.t_rejected <= card_s,
            "phone UI", f"first seen {card - res.t_rejected:.1f}s after pairing_rejected" if card is not None
            else f"not seen in {obs.polls} polls")
        if res.t_rejected is not None:
            post = scan_interval(probe, pm, res.t_rejected, res.t_rejected + post_quiet_s, settle_s)
            add(f"5 stood down: no connect attempt for {post_quiet_s:.0f} s after pairing_rejected",
                not post["connects"], "phone log", str([c[-110:] for c in post["connects"][:3]]))
            up = first_stamp(probe.lines_since(pm), LINK_UP_RX[previous_owner], after=res.t_rejected)
            add("5 A never shows connected again", up is None, "phone log", up[1][-110:] if up else "")

    # ---- glasses-side facts ---------------------------------------------------------
    _glasses_assertions(ctx, res, add, gm, scenario, hit_close, new_owner_bond=new_owner_bond,
                        bes_timeout=bes_timeout, clock=clock, adv=adv)

    for a in res.assertions:
        if a.gap:
            ctx.gap(f"V6 {a.name}", a.detail)
        else:
            ctx.check(f"V6 {a.name}", a.ok, f"[{a.source}] {a.detail}".strip())
    return res


# ----------------------------------------------------------------------------- helpers


def _cancel_gesture(inject_cancel) -> None:
    """The toggle: one triple press (a single press only re-speaks the code)."""
    if inject_cancel is not None:
        inject_cancel()
        return
    import pmx

    pmx.inject("triple", 50)


def _after_entry(ctx, gm: int, pattern: str) -> list:
    """BES lines matching `pattern` that come after the first mode_enter_done since `gm`."""
    seen, out = False, []
    rx = re.compile(pattern)
    for line in ctx.bes("", gm):
        if "mode_enter_done" in line:
            seen = True
            continue
        if seen and rx.search(line):
            out.append(line)
    return out


bes_after_entry = _after_entry  # name kept for the cases that import it


def _wait_phone(probe: Probe, mark: int, rx: re.Pattern, timeout: float, clock=time, after: float | None = None):
    deadline = clock.time() + timeout
    while True:
        hit = first_stamp(probe.lines_since(mark), rx, after=after)
        if hit:
            return hit
        if clock.time() >= deadline:
            return None
        clock.sleep(0.25)


def _glasses_assertions(ctx, res, add, gm, scenario, hit_close, *, new_owner_bond, bes_timeout, clock, adv) -> None:
    # Fact: the glasses opened the window WITHOUT forgetting the owner (V2). BES only.
    entry = first(ctx.bes(r"xfer enter, owner retained", gm))
    after = ctx.bes(r"mode_enter_done .*own=\d/\d", gm)
    post = own_pair(after[-1]) if after else None
    if entry and (post is None or post != (0, 0)):
        add("6 window entry kept the owner (xfer enter, owner retained, own != 0/0)", True, "bes",
            f"{entry.strip()} / {after[-1].strip() if after else 'no mode_enter_done dump'}")
    elif post == (0, 0):
        add("6 window entry kept the owner (xfer enter, owner retained, own != 0/0)", False, "bes",
            f"owner forgotten at entry: {after[-1]}")
    else:
        add("6 window entry kept the owner (xfer enter, owner retained, own != 0/0)", False, "-",
            "HARNESS GAP: no `xfer enter, owner retained` line in the BES ring; the phone log and the "
            "advertisement cannot prove BES kept the record", gap=True)

    mode = first(ctx.bes(r"pairflow mode_enter \S+", gm))
    if mode:
        add("6 BES told the phone (mode_enter notified_phone retained_owner)",
            "notified_phone" in mode and "retained_owner" in mode, "bes", mode.strip())

    if scenario in ("timeout", "cancel"):
        bes_pat, wire_reason, _ = CLOSE_FACTS[scenario]
        add(f"7 BES closed the window ({bes_pat})", bool(hit_close), "bes",
            hit_close[1] if hit_close else f"no `{bes_pat}` line")
        if scenario == "timeout" and res.t_trigger and res.t_close:
            elapsed = res.t_close - res.t_trigger
            lo, hi = TIMEOUT_CLOSE_RANGE_S
            add("7 closes near 120 s (one window, no 300 s cap)", hit_close is not None and lo <= elapsed <= hi,
                "bes+wall clock", f"{elapsed:.0f} s after the gesture")
        if scenario == "cancel":
            add("7 triple press toggled the window (`3-press while pairing, cancel`)",
                bool(ctx.bes(r"3-press while pairing, cancel", gm)), "bes", "")
        sent = first(ctx.bes(rf"hm_pairexit sent reason={wire_reason}", gm))
        count = pairexit_count(ctx, gm)
        add(f"7 hm_pairexit reason={wire_reason} exactly once", count == 1 or (count == 0 and bool(sent)), "asg log",
            f"{count} received line(s); bes: {sent.strip() if sent else 'none'}")
        # The owner record is untouched: no commit, no clear_owner, no wipe step, own != 0/0 at the close.
        bad = ctx.bes(r"owner committed|clear_owner|commit [123]/3|bond_deleted", gm)
        add("8 no bond change (no commit, clear_owner or wipe step)", not bad, "bes", str(bad[:2]))
        closing = ctx.bes(r"window_close st=\w+ .*own=\d/\d", gm)
        last = own_pair(closing[-1]) if closing else None
        if last is None:
            add("8 owner record kept at the close (own != 0/0)", False, "-",
                "HARNESS GAP: no `window_close st=... own=` dump in the BES ring", gap=True)
        else:
            add("8 owner record kept at the close (own != 0/0)", last != (0, 0), "bes", closing[-1].strip())
        _adv_assertions(res, add, adv, pairing=False, owner_changed=False)
    else:
        add("7 new owner committed (BES)", bool(hit_close), hit_close[0] if hit_close else "-",
            hit_close[1] if hit_close else "no `owner committed from ble bond` and no own=1 + bond for B")
        steps = commit_steps(ctx.bes(r"lxy pair: commit \d/3", gm))
        add("8 commit steps 1/3, 2/3, 3/3 in order (delete A's BLE first = the commit point)", steps == [1, 2, 3],
            "bes", str(steps))
        flow = first(ctx.bes(r"pairflow commit replace_owner", gm))
        add("8 pairflow commit replace_owner", bool(flow), "bes", flow.strip() if flow else "")
        exit_line = first(ctx.bes(r"hm_pairexit sent reason=paired|hm_pairexit skipped, connected follows", gm))
        add("8 closed as paired (hm_pairexit paired, or skipped because Connected follows)", bool(exit_line), "bes",
            exit_line.strip() if exit_line else "")
        _adv_assertions(res, add, adv, pairing=False, owner_changed=True)


def _adv_assertions(res, add, adv, *, pairing: bool, owner_changed: bool) -> None:
    a = adv() if adv else None
    m = (a or {}).get("mentra", {}) if a else {}
    if not a:
        add("9 advertisement pairing flag clear", False, "-",
            "HARNESS GAP: glasses advertisement not seen; BES window_close cannot prove the flag", gap=True)
        return
    add("9 advertisement pairing flag clear", bool(m.get("pairing")) == pairing, "adv", str(m))
    add(f"9 advertisement OWNER_CHANGED {'set' if owner_changed else 'clear'}",
        bool(m.get("owner_changed")) == owner_changed, "adv", str(m))
    if res.window_id is not None and m.get("window_id") is not None:
        add("9 advertisement window_id matches the phone's window", m.get("window_id") == res.window_id, "adv",
            f"adv {m.get('window_id')} / phone {res.window_id}")


def observe_quiet(ctx, res: TransitionResult, seconds: float = 30.0, ui_poll_s: float = 3.0, settle_s: float = 0.5,
                  clock=time) -> TransitionResult:
    """After a takeover (A is in pairing_rejected): watch A for `seconds` more. The stand-down must hold: no connect
    attempt, no reconnect line, no sheet, and the Pair Again card stays. Longer-term no-reclaim stays covered by
    the BT-off rejoin and reboot cases."""
    probe = res.probe
    start = res.t_rejected or res.t_close or clock.time()
    end = clock.time() + seconds
    prompts, card_last, polls = [], None, 0
    while clock.time() < end:
        s = probe.sample(foreground=False)
        polls += 1
        card_last = s.pair_again
        if s.prompt:
            prompts.append((clock.time(), s.prompt))
            probe.dismiss(s.prompt)
        left = end - clock.time()
        if left > 0:
            clock.sleep(min(ui_poll_s, left))
    record_window(ctx, "post_rejection", end - seconds, clock.time(), seconds)
    scan = scan_interval(probe, res.phone_mark, start, clock.time(), settle_s)
    out = [
        Assertion(f"10a no connect attempts for {seconds:.0f} s after the stand-down", not scan["connects"],
                  "phone log", str([c[-110:] for c in scan["connects"][:3]])),
        Assertion(f"10b no reconnect log lines for {seconds:.0f} s after the stand-down", not scan["reconnects"],
                  "phone log", str([c[-110:] for c in scan["reconnects"][:3]])),
        Assertion(f"10c no sheet/prompt for {seconds:.0f} s after the stand-down", not prompts, "phone UI",
                  str(prompts[:2])),
        Assertion("10d Pair Again card still shown", bool(card_last), "phone UI", f"{polls} polls"),
    ]
    for a in out:
        ctx.check(f"V6 {a.name}", a.ok, f"[{a.source}] {a.detail}".strip())
    res.assertions.extend(out)
    return res


# ------------------------------------------------- legacy (flag-off) owner-record proof
#
# Flag-off firmware keeps forget-on-entry: pairing-mode entry deletes the previous owner (own>=1 -> own=0/0 with a
# greater window generation). v4 never does that, so no live case asserts it any more; readjudicate.py still uses
# these parsers to re-judge the old R15 rows in runs/x2.

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
    """Shared by readjudicate.py. `all_lines` is the whole ring since the case started; `post_lines` the ring since the
    presses. Only a transition whose PROOF line is after the presses counts. Returns (pre_line, proof_line)|None.
    First matching transition live; newest=True for a post-mortem over a whole trace."""
    post = set(post_lines) if post_lines is not None else None
    found = [t for t in owner_removal_transitions(all_lines) if post is None or t[1] in post]
    if not found:
        return None
    return found[-1] if newest else found[0]
