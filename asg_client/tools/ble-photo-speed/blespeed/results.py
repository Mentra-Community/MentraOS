"""results.csv schema shared by run_cell.py and summarize.py."""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import IO, Iterable, List, Optional

from .outcome import PhotoTracker


@dataclass
class PhotoRow:
    run_id: str
    phone: str
    phone_os: str
    condition: str
    size: str
    index: int
    warmup: bool
    request_id: str
    ble_img_id: str
    outcome: str
    failure_reason: str = ""
    busy_retries: int = 0
    transfer_retries: int = 0
    payload_bytes: Optional[int] = None
    uart_tx_ms: Optional[int] = None
    transfer_speed_kbps: Optional[float] = None
    phone_confirm_ms: Optional[int] = None
    phone_ack_wait_ms: Optional[int] = None
    last_packet_to_phone_ack_ms: Optional[int] = None
    e2e_kbps: Optional[float] = None
    transport: str = ""
    elapsed_s: Optional[float] = None

    @property
    def ok(self) -> bool:
        """Counts toward speed stats: finished, not warm-up, and both e2e inputs present."""
        return self.outcome == "finished" and not self.warmup and self.e2e_kbps is not None


COLUMNS = [f.name for f in fields(PhotoRow)]
_INT_COLUMNS = {"index", "busy_retries", "transfer_retries", "payload_bytes", "uart_tx_ms",
                "phone_confirm_ms", "phone_ack_wait_ms", "last_packet_to_phone_ack_ms"}
_FLOAT_COLUMNS = {"transfer_speed_kbps", "e2e_kbps", "elapsed_s"}


class ResultsFormatError(ValueError):
    pass


def row_from_tracker(tracker: PhotoTracker, *, run_id: str, phone: str, phone_os: str,
                     condition: str, size: str, index: int, warmup: bool,
                     transport: str) -> PhotoRow:
    result = tracker.result
    elapsed = None
    if tracker.sent_at is not None and tracker.finished_at is not None:
        elapsed = round(tracker.finished_at - tracker.sent_at, 3)
    row = PhotoRow(
        run_id=run_id, phone=phone, phone_os=phone_os, condition=condition, size=size,
        index=index, warmup=warmup, request_id=tracker.request_id,
        ble_img_id=tracker.ble_img_id, outcome=tracker.state or "",
        failure_reason=tracker.failure_reason or "", busy_retries=tracker.busy_retries,
        transfer_retries=tracker.transfer_retries, transport=transport, elapsed_s=elapsed,
    )
    if result is not None:
        row.payload_bytes = result.payload_bytes
        row.uart_tx_ms = result.uart_tx_ms
        row.transfer_speed_kbps = result.transfer_speed_kbps
        row.phone_confirm_ms = result.phone_confirm_ms
        row.phone_ack_wait_ms = result.phone_ack_wait_ms
        row.last_packet_to_phone_ack_ms = result.last_packet_to_phone_ack_ms
        e2e = result.e2e_kbps
        row.e2e_kbps = round(e2e, 2) if e2e is not None else None
    return row


def write_rows(handle: IO[str], rows: Iterable[PhotoRow], header: bool = True) -> None:
    writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
    if header:
        writer.writeheader()
    for row in rows:
        values = asdict(row)
        writer.writerow({k: ("" if v is None else v) for k, v in values.items()})


def _convert(column: str, value: str):
    if value == "":
        return None if column in _INT_COLUMNS | _FLOAT_COLUMNS else ""
    if column in _INT_COLUMNS:
        return int(value)
    if column in _FLOAT_COLUMNS:
        return float(value)
    if column == "warmup":
        if value not in ("True", "False"):
            raise ValueError("warmup must be True or False")
        return value == "True"
    return value


def read_rows(path: Path) -> List[PhotoRow]:
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise ResultsFormatError("%s: missing columns: %s" % (path, ", ".join(missing)))
        rows = []
        for line_no, raw in enumerate(reader, start=2):
            try:
                rows.append(PhotoRow(**{c: _convert(c, raw[c]) for c in COLUMNS}))
            except (TypeError, ValueError) as e:
                raise ResultsFormatError("%s:%d: %s" % (path, line_no, e)) from e
        return rows
