"""Cell statistics, the proposed speed floor, and the limiting-leg heuristic.

Definitions (kept explicit so results are reproducible by hand):
- KB is 1024 bytes, matching BlePhotoTimingLog.
- p10 is nearest-rank: sort ascending, take element ceil(0.10 * n) (1-based).
- median is the usual middle value (mean of the two middle values for even n).
- A cell is flagged when its failure rate is strictly greater than 5%.
- Floor = min over phones of p10(e2e) pooled across the floor conditions,
  times the margin (0.8), rounded down to a multiple of 5 KB/s.
"""

from __future__ import annotations

import math
import statistics
from collections import OrderedDict
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .results import PhotoRow

FAILURE_FLAG_RATE = 0.05
FLOOR_CONDITIONS = ("A", "B", "C")
FLOOR_MARGIN = 0.8
FLOOR_STEP_KBPS = 5

# Radio-leg heuristic: drain time (last serial ACK -> phone confirm) growing faster than this
# per KB of payload means the phone link, not the glasses' serial link, is holding bytes back.
RADIO_SLOPE_MS_PER_KB = 2.0
# Serial-link speeds within this fraction of the cross-phone median count as "matching".
UART_MATCH_TOLERANCE = 0.15
MIN_POINTS_FOR_SLOPE = 5


def percentile_nearest_rank(values: Sequence[float], pct: float) -> float:
    if not values:
        raise ValueError("percentile of empty sequence")
    if not 0 < pct <= 100:
        raise ValueError("pct must be in (0, 100]")
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]


@dataclass(frozen=True)
class Distribution:
    n: int
    median: float
    p10: float
    minimum: float
    maximum: float

    @staticmethod
    def of(values: Sequence[float]) -> Optional["Distribution"]:
        if not values:
            return None
        return Distribution(len(values), statistics.median(values),
                            percentile_nearest_rank(values, 10), min(values), max(values))

    def as_dict(self) -> Dict[str, float]:
        return {"n": self.n, "median": round(self.median, 2), "p10": round(self.p10, 2),
                "min": round(self.minimum, 2), "max": round(self.maximum, 2)}


CellKey = Tuple[str, str, str]  # (phone, condition, size)


@dataclass(frozen=True)
class CellStats:
    phone: str
    phone_os: str
    condition: str
    size: str
    attempted: int
    succeeded: int
    failed: int
    retried: int
    e2e: Optional[Distribution]
    uart: Optional[Distribution]
    drain: Optional[Distribution]
    mean_payload_kb: Optional[float]

    @property
    def failure_rate(self) -> float:
        return self.failed / self.attempted if self.attempted else 0.0

    @property
    def flagged(self) -> bool:
        return self.failure_rate > FAILURE_FLAG_RATE


def measured_rows(rows: Sequence[PhotoRow]) -> List[PhotoRow]:
    """Rows that were real attempts (warm-ups excluded)."""
    return [r for r in rows if not r.warmup]


def cell_stats(rows: Sequence[PhotoRow]) -> List[CellStats]:
    groups: "OrderedDict[CellKey, List[PhotoRow]]" = OrderedDict()
    for row in measured_rows(rows):
        groups.setdefault((row.phone, row.condition, row.size), []).append(row)
    cells = []
    for (phone, condition, size), members in groups.items():
        ok = [r for r in members if r.ok]
        payloads = [r.payload_bytes / 1024.0 for r in ok if r.payload_bytes]
        cells.append(CellStats(
            phone=phone,
            phone_os=members[0].phone_os,
            condition=condition,
            size=size,
            attempted=len(members),
            succeeded=len(ok),
            failed=len(members) - len(ok),
            retried=sum(1 for r in members if r.transfer_retries or r.busy_retries),
            e2e=Distribution.of([r.e2e_kbps for r in ok]),
            uart=Distribution.of([r.transfer_speed_kbps for r in ok
                                  if r.transfer_speed_kbps is not None]),
            drain=Distribution.of([float(r.last_packet_to_phone_ack_ms) for r in ok
                                   if r.last_packet_to_phone_ack_ms is not None]),
            mean_payload_kb=statistics.mean(payloads) if payloads else None,
        ))
    return cells


@dataclass(frozen=True)
class FloorResult:
    floor_kbps: Optional[int]
    limiting_phone: Optional[str]
    per_phone_p10: Dict[str, float]
    conditions: Tuple[str, ...]


def speed_floor(rows: Sequence[PhotoRow], conditions: Sequence[str] = FLOOR_CONDITIONS,
                exclude_b: bool = False, margin: float = FLOOR_MARGIN,
                step: int = FLOOR_STEP_KBPS) -> FloorResult:
    used = tuple(c for c in conditions if not (exclude_b and c == "B"))
    per_phone: "OrderedDict[str, List[float]]" = OrderedDict()
    for row in rows:
        if row.ok and row.condition in used:
            per_phone.setdefault(row.phone, []).append(row.e2e_kbps)
    p10s = {phone: percentile_nearest_rank(values, 10) for phone, values in per_phone.items()}
    if not p10s:
        return FloorResult(None, None, {}, used)
    limiting = min(p10s, key=lambda phone: p10s[phone])
    # Round the margin product first so float noise (e.g. 62.5 * 0.8 = 49.999...) can't drop a step.
    scaled = round(p10s[limiting] * margin, 6)
    floor = int(math.floor(scaled / step) * step)
    return FloorResult(floor, limiting, p10s, used)


def least_squares_slope(xs: Sequence[float], ys: Sequence[float]) -> Optional[float]:
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    mean_x = statistics.mean(xs)
    mean_y = statistics.mean(ys)
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom


@dataclass(frozen=True)
class LegVerdict:
    phone: str
    drain_slope_ms_per_kb: Optional[float]
    uart_median_kbps: Optional[float]
    uart_matches_others: Optional[bool]
    verdict: str  # "radio_limited", "serial_limited", "mixed", or "insufficient_data"


def leg_verdicts(rows: Sequence[PhotoRow],
                 conditions: Optional[Sequence[str]] = FLOOR_CONDITIONS) -> List[LegVerdict]:
    """Per-phone limiting-leg verdict. Loaded condition D is left out by default because
    concurrent audio shifts drain time independently of payload size."""
    per_phone: "OrderedDict[str, List[PhotoRow]]" = OrderedDict()
    for row in rows:
        if row.ok and (conditions is None or row.condition in conditions):
            per_phone.setdefault(row.phone, []).append(row)
    uart_medians: Dict[str, Optional[float]] = {}
    for phone, members in per_phone.items():
        speeds = [r.transfer_speed_kbps for r in members if r.transfer_speed_kbps is not None]
        uart_medians[phone] = statistics.median(speeds) if speeds else None
    known = [v for v in uart_medians.values() if v is not None]
    overall = statistics.median(known) if known else None

    verdicts = []
    for phone, members in per_phone.items():
        points = [(r.payload_bytes / 1024.0, float(r.last_packet_to_phone_ack_ms)) for r in members
                  if r.payload_bytes and r.last_packet_to_phone_ack_ms is not None]
        slope = None
        if len(points) >= MIN_POINTS_FOR_SLOPE:
            slope = least_squares_slope([p[0] for p in points], [p[1] for p in points])
        uart = uart_medians[phone]
        matches = None
        if uart is not None and overall:
            matches = abs(uart - overall) / overall <= UART_MATCH_TOLERANCE
        if slope is None:
            verdict = "insufficient_data"
        elif slope <= RADIO_SLOPE_MS_PER_KB:
            verdict = "serial_limited"
        elif matches is False:
            # Drain grows with payload but this phone's serial leg also differs: not separable.
            verdict = "mixed"
        else:
            verdict = "radio_limited"
        verdicts.append(LegVerdict(phone, slope, uart, matches, verdict))
    return verdicts
