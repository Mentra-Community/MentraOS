"""Fakes shared by the offline harness tests. No device, no adb, no simulator."""

from __future__ import annotations

import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import owner_lost  # noqa: E402


class FakeG:
    """Glasses tap: BES ring lines plus ASG logcat lines."""

    def __init__(self):
        self.bes_lines: list = []
        self.log_lines: list = []
        self.mark_at: int | None = None  # set to split the ring into before/after the gesture

    def mark(self) -> int:
        # default: every scripted BES line arrives "after the mark", like lines logged after the gesture
        return 0 if self.mark_at is None else self.mark_at

    def since(self, mark: int) -> list:
        return [(time.time(), l) for l in self.log_lines]

    def stop(self) -> None:
        pass


class FakeCtx:
    def __init__(self, bes_lines: list | None = None, log_lines: list | None = None):
        self.g = FakeG()
        self.g.bes_lines = list(bes_lines or [])
        self.g.log_lines = list(log_lines or [])
        self.checks: list = []
        self.gaps: list = []
        self.notes: list = []
        self.bench: list = []
        self.phases: list = []
        self._phase_open: dict = {}
        self.invalid = ""
        self.stop_run_reason = ""
        self.blocked = ""

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
        self.bench.append({"bench": name, "ok": bool(ok), "detail": detail})

    def bes(self, pattern: str = "", mark: int = 0) -> list:
        import re

        rx = re.compile(pattern) if pattern else None
        return [l for l in self.g.bes_lines[mark:] if rx is None or rx.search(l)]

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"check": name, "ok": bool(ok), "detail": detail})
        return ok

    def gap(self, name: str, detail: str = "") -> None:
        self.gaps.append({"gap": name, "detail": detail})

    def note(self, msg: str) -> None:
        self.notes.append(msg)

    def failed(self) -> list:
        return [c["check"] for c in self.checks if not c["ok"]]

    def ok_names(self) -> list:
        return [c["check"] for c in self.checks if c["ok"]]


class FakeProbe(owner_lost.Probe):
    """Previous owner phone. Lines and UI facts are scripted relative to the trigger time.

    popup_at / popup_again_at   when the "Your glasses are in pairing mode" popup appears (it stays until dismissed)
    pair_again_at               from this offset on the Pair Again card is visible (never when None)
    prompt_at                   a system pairing sheet appears once
    """

    platform = "s22"

    def __init__(self, script: list, popup_at: float | None = 0.1, pair_again_at: float | None = None,
                 prompt_at: float | None = None, popup_again_at: float | None = None):
        self.script = sorted(script)  # [(offset_s, line)]
        self.popup_at = popup_at
        self.popup_again_at = popup_again_at
        self.pair_again_at = pair_again_at
        self.prompt_at = prompt_at
        self.trigger_t: float | None = None
        self.dismissed: list = []
        self.popups_dismissed = 0
        self._prompt_given = False
        self._popup_hidden_until = 0.0

    def fire(self) -> None:
        self.trigger_t = time.time()

    def mark(self) -> int:
        return 0

    def lines_since(self, mark: int) -> list:
        if self.trigger_t is None:
            return []
        now = time.time()
        out = [(self.trigger_t + off, line) for off, line in self.script if self.trigger_t + off <= now]
        return out[mark:]

    def _at(self, offset: float | None) -> bool:
        return offset is not None and self.trigger_t is not None and time.time() >= self.trigger_t + offset

    def sample(self, foreground: bool) -> owner_lost.UiSample:
        popup = self._at(self.popup_at) and self.popups_dismissed == 0
        if self._at(self.popup_again_at) and self.popups_dismissed == 1:
            popup = True
        prompt = None
        if self._at(self.prompt_at) and not self._prompt_given:
            self._prompt_given = True
            prompt = "配对请求"
        return owner_lost.UiSample(popup=popup, pair_again=self._at(self.pair_again_at), prompt=prompt)

    def dismiss_popup(self) -> None:
        self.popups_dismissed += 1

    def dismiss(self, label: str) -> None:
        self.dismissed.append(label)


def pairing_mode_line(window: int = 7) -> str:
    return (f"I/Bridge  (1): PAIRFLOW: pairing_state source=android "
            f"state=pairing_mode(window={window},endsAtMs=1700000120000)")


PAIRING_MODE = pairing_mode_line()
NORMAL = "I/Bridge  (1): PAIRFLOW: pairing_state source=android state=normal"
REJECTED = "I/Bridge  (1): PAIRFLOW: pairing_state source=android state=pairing_rejected"
LINK_UP = "I/Bridge  (1): Received pong response - connection healthy"
ATTEMPT = "I/Live    (1): 🔌 🔗 ATTEMPTING CONNECTION to device: CC:E7:DE:E0:02:BE (Mentra_Live_02BE) - Reconnect attempt #0"
REMOVED_OWNER_LOSS = "I/Bridge  (1): LIVE: Owner loss (entering_pairing_mode) — stopping reconnect, keeping saved glasses"

# BES ring lines (m8_pairing.cpp log strings)
BES_XFER_ENTER = "50 | lxy pair: xfer enter, owner retained, classic snapshot=1"
BES_MODE_ENTER = "51 | lxy pairflow mode_enter notified_phone retained_owner"
BES_ENTER_DONE = "111 | lxy pair: mode_enter_done st=PAIRING exp=1 own=1/1 clicks=3/3 fired=1 ind=1 lock=0 generation=2 cand=0 conidx=0"
BES_ENTER_DONE_FORGOT = BES_ENTER_DONE.replace("own=1/1", "own=0/0")
BES_TOGGLE = "300 | lxy pair: 3-press while pairing, cancel"
BES_CLOSE_TOGGLE = "301 | lxy pair: window_close reason=toggle"
BES_CLOSE_TIMEOUT = "400 | lxy pair: window_close reason=timeout"
BES_CLOSE_DUMP = "401 | lxy pair: window_close st=OWNER_ONLY exp=1 own=1/1 clicks=0/3 fired=0 ind=0 lock=1 generation=2 cand=0 conidx=0"
BES_PAIREXIT_TIMEOUT = "402 | lxy pair hm_pairexit sent reason=timeout uart=1"
BES_PAIREXIT_CANCELLED = "302 | lxy pair hm_pairexit sent reason=cancelled uart=1"
BES_PAIREXIT_PAIRED = "205 | lxy pair hm_pairexit sent reason=paired uart=1"
BES_FLOW_REPLACE = "198 | lxy pairflow commit replace_owner classic_saved"
BES_COMMIT_STEPS = ["200 | lxy pair: commit 1/3 delete previous owner ble",
                    "201 | lxy pair: commit 2/3 delete entry-snapshot classic",
                    "202 | lxy pair: commit 3/3 drop other live links"]
BES_COMMITTED = "199 | lxy pair: owner committed from ble bond"
BES_OWN1_B = "210 | lxy pair: ble_bond st=OWNER_ONLY exp=1 own=1/1 clicks=0/3 fired=0 ind=0 lock=1 generation=2 cand=0 conidx=0"
LOG_PAIREXIT_TIMEOUT = "I/PairingAudio: hm_pairexit received reason=timeout"
LOG_PAIREXIT_CANCELLED = "I/PairingAudio: hm_pairexit received reason=cancelled"
LOG_PAIREXIT_PAIRED = "I/PairingAudio: hm_pairexit received reason=paired"
