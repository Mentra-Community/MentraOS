"""Label the phone's file transport (L2CAP CoC vs GATT) from its logs.

Both phones log through ``Bridge.log`` with the same ``LIVE: L2CAP: ...``
messages (iOS NSLog via idevicesyslog, Android logcat):
- ``LIVE: L2CAP: channel open (PSM 0xC9)``
- ``LIVE: L2CAP: channel closed`` (iOS appends ``; using GATT fallback``)
- ``LIVE: L2CAP: unavailable, staying on GATT (...)``
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, List, Optional

L2CAP = "l2cap"
GATT = "gatt"
GATT_AFTER_CLOSE = "gatt_after_close"
L2CAP_THEN_CLOSED = "l2cap_then_closed"
UNKNOWN = "unknown"

_OPEN_RE = re.compile(r"LIVE: L2CAP: channel open")
_CLOSED_RE = re.compile(r"LIVE: L2CAP: channel closed")
_GATT_RE = re.compile(r"LIVE: L2CAP: unavailable, staying on GATT")
# Android routes Bridge.log through ReactNativeJS as "'CORE:', 'LIVE: ...'", so stop at quotes.
_FILE_DONE_RE = re.compile(r"(?:LIVE: )?📦 File transfer complete: (?P<name>[^\s'\"]+)")
_RATE_RE = re.compile(r"📊 Transfer rate: (?P<bps>\d+) bytes/sec")

# Lines worth keeping from a full phone log stream.
_KEEP_MARKERS = ("LIVE:", "Transfer rate", "BLE photo transfer", "File transfer")


def keep_phone_line(line: str) -> bool:
    return any(marker in line for marker in _KEEP_MARKERS)


@dataclass
class TransportTracker:
    """Live transport state while a session runs, plus a session-level summary."""

    current: str = UNKNOWN
    opens: int = 0
    closes: int = 0
    gatt_fallbacks: int = 0
    first_open_line: Optional[str] = None
    files_completed: List[str] = field(default_factory=list)
    phone_rates_bps: List[int] = field(default_factory=list)

    def feed(self, line: str) -> None:
        if not line:
            return
        if _OPEN_RE.search(line):
            self.opens += 1
            self.current = L2CAP
            if self.first_open_line is None:
                self.first_open_line = line.strip()
        elif _CLOSED_RE.search(line):
            self.closes += 1
            if self.current == L2CAP:
                self.current = GATT_AFTER_CLOSE
        elif _GATT_RE.search(line):
            self.gatt_fallbacks += 1
            if self.current != L2CAP:
                self.current = GATT
        else:
            match = _FILE_DONE_RE.search(line)
            if match:
                self.files_completed.append(match.group("name"))
                return
            match = _RATE_RE.search(line)
            if match:
                self.phone_rates_bps.append(int(match.group("bps")))

    @property
    def session_label(self) -> str:
        if self.opens and self.closes:
            return L2CAP_THEN_CLOSED
        if self.opens:
            return L2CAP
        if self.gatt_fallbacks:
            return GATT
        return UNKNOWN

    @property
    def l2cap_ready_or_gatt(self) -> bool:
        """True once the phone has settled on a transport."""
        return self.current in (L2CAP, GATT)


def label_phone_log(lines: Iterable[str]) -> TransportTracker:
    tracker = TransportTracker()
    for line in lines:
        tracker.feed(line)
    return tracker
