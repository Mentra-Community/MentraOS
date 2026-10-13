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
    """Previous owner phone. Lines and UI facts are scripted relative to the trigger time."""

    platform = "s22"

    def __init__(self, script: list, card_after: float | None = 0.1, prompt_at: float | None = None):
        self.script = sorted(script)  # [(offset_s, line)]
        self.card_after = card_after
        self.prompt_at = prompt_at
        self.trigger_t: float | None = None
        self.dismissed: list = []
        self._prompt_given = False

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

    def poll(self, foreground: bool) -> tuple:
        now = time.time()
        card = self.card_after is not None and self.trigger_t is not None and now >= self.trigger_t + self.card_after
        prompt = None
        if self.prompt_at is not None and self.trigger_t is not None and now >= self.trigger_t + self.prompt_at \
                and not self._prompt_given:
            self._prompt_given = True
            prompt = "配对请求"
        return card, prompt

    def dismiss(self, label: str) -> None:
        self.dismissed.append(label)


NOTICE = "I/Bridge  (1): LIVE: Glasses entering pairing mode — owner lost, no reconnect"
OWNER_LOSS = "I/Bridge  (1): LIVE: Owner loss (entering_pairing_mode) — stopping reconnect, keeping saved glasses"
ATTEMPT = "I/Live    (1): 🔌 🔗 ATTEMPTING CONNECTION to device: CC:E7:DE:E0:02:BE (Mentra_Live_02BE) - Reconnect attempt #0"

BES_PRE_OWNER = "100 | lxy pair: pwr_press st=OWNER_ONLY exp=1 own=1/1 clicks=3/3 fired=1 ind=0 lock=0 generation=1 cand=0 conidx=0"
BES_ENTER = "110 | lxy pair: mode_enter st=OWNER_ONLY exp=1 own=1/1 clicks=3/3 fired=1 ind=0 lock=0 generation=1 cand=0 conidx=0"
BES_ENTER_DONE = "111 | lxy pair: mode_enter_done st=PAIRING exp=1 own=0/0 clicks=3/3 fired=1 ind=1 lock=0 generation=2 cand=0 conidx=255"
BES_COMMIT = "200 | lxy pair: owner committed from ble bond"
BES_OWN1 = "210 | lxy pair: ble_bond st=OWNER_ONLY exp=1 own=1/1 clicks=0/3 fired=0 ind=0 lock=1 generation=2 cand=0 conidx=0"
BES_REJECT = "300 | lxy pair: ble_reject auth=2 st=PAIRING"
BES_CANCEL = "400 | lxy pair: cancel by single click"
BES_CLOSE = "401 | lxy pair: window_close st=PAIRING exp=1 own=0/0 clicks=0/3 fired=0 ind=1 lock=0 generation=2 cand=0 conidx=255"
BES_CLOSE_REASON = "400 | lxy pair: window_close reason=pclk"
