"""Parse glasses logcat lines emitted by the ASG BLE photo pipeline.

Every parser takes one raw line (any logcat prefix format) and returns an event
object or ``None``. Parsers never raise on malformed input.

Formats mirror asg_client sources:
- ``BlePhotoTimingLog.pipelineDone`` / ``appendSizeAndSpeed``: PIPELINE FINISHED
- ``BlePhotoTimingLog`` step lines: ``⏱️ [BLE PHOTO] <CATEGORY>: <message>``
- ``MediaCaptureService.sendPhotoErrorResponse``: SENDING PHOTO ERROR
- ``PhotoCommandHandler``: PHOTO PIPELINE [ASG 2/3] / [ASG 3/3]
- ``K900BluetoothManager``: phone-reported failure retry and max-retries abort
- ``BesUartTransportCoordinator`` / ``SerialPortBridge``: negotiated UART baud
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, Optional, Union

# Log timestamps: "09-28 16:53:16.322" (threadtime) or "2026-07-17 16:53:16.322" (Studio).
_TIMESTAMP_RE = re.compile(r"^\s*((?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})")

_PIPELINE_RE = re.compile(r"\[BLE PHOTO\] PIPELINE FINISHED(?P<body>.*)$")
_STEP_RE = re.compile(r"\[BLE PHOTO\] (?P<category>[A-Z][A-Z_ ]*[A-Z]): (?P<message>.*)$")
_PHOTO_ERROR_RE = re.compile(
    r"SENDING PHOTO ERROR: (?P<code>[A-Z0-9_]+) - (?P<message>.*) for requestId: (?P<rid>\S+)\s*$"
)
_RECEIVED_RE = re.compile(r"PHOTO PIPELINE \[ASG 2/3\] PhotoCommandHandler\.handleTakePhoto requestId=(?P<rid>\S+)")
_ACCEPTED_RE = re.compile(r"PHOTO PIPELINE \[ASG 3/3\] Capture accepted requestId=(?P<rid>\S+)")
_TRANSFER_RETRY_RE = re.compile(r"Phone reported failure - need to retry transfer")
_TRANSFER_GAVE_UP_RE = re.compile(r"Max retries exceeded \((?P<max>\d+)\) - giving up on transfer")
_BAUD_READY_RE = re.compile(r"UART link ready at (?P<kind>fast|rendezvous) baud (?P<baud>\d+)")
_BAUD_OPENED_RE = re.compile(r"Serial port opened at (?P<baud>\d+) baud")
_BES_FW_RE = re.compile(
    r"BES firmware version cached successfully: (?P<version>\S+)"
    r"|Caching BES firmware version: (?P<version2>\S+)"
)

_LEADING_INT_RE = re.compile(r"^-?\d+")
_LEADING_FLOAT_RE = re.compile(r"^-?\d+(?:\.\d+)?")


@dataclass(frozen=True)
class PipelineFinished:
    """One ``PIPELINE FINISHED`` line. Missing numeric fields and ``-1`` are ``None``."""

    request_id: str
    ble_img_id: Optional[str]
    success: bool
    total_ms: Optional[int] = None
    payload_bytes: Optional[int] = None
    original_bytes: Optional[int] = None
    uart_tx_ms: Optional[int] = None
    transfer_speed_kbps: Optional[float] = None
    phone_confirm_ms: Optional[int] = None
    phone_ack_wait_ms: Optional[int] = None
    last_packet_to_phone_ack_ms: Optional[int] = None
    camera_ms: Optional[int] = None
    compress_ms: Optional[int] = None
    extra: Dict[str, str] = field(default_factory=dict)

    @property
    def e2e_kbps(self) -> Optional[float]:
        """Payload KB (1024 bytes) per second from transfer start to phone confirmation."""
        if not self.payload_bytes or not self.phone_confirm_ms:
            return None
        return self.payload_bytes / 1024.0 / (self.phone_confirm_ms / 1000.0)


@dataclass(frozen=True)
class PhotoError:
    request_id: str
    code: str
    message: str


@dataclass(frozen=True)
class PhotoReceived:
    request_id: str


@dataclass(frozen=True)
class PhotoAccepted:
    request_id: str


@dataclass(frozen=True)
class TransferRetry:
    """K900 restarts the file from packet 0 after the phone reported transfer_complete:false."""


@dataclass(frozen=True)
class TransferGaveUp:
    max_retries: int


@dataclass(frozen=True)
class BaudChange:
    baud: int
    source: str


@dataclass(frozen=True)
class BesFirmware:
    version: str


@dataclass(frozen=True)
class BlePhotoStep:
    category: str
    message: str


Event = Union[
    PipelineFinished,
    PhotoError,
    PhotoReceived,
    PhotoAccepted,
    TransferRetry,
    TransferGaveUp,
    BaudChange,
    BesFirmware,
    BlePhotoStep,
]


def line_timestamp(line: str) -> Optional[str]:
    """Return the logcat timestamp prefix of ``line``, if it has one."""
    match = _TIMESTAMP_RE.match(line or "")
    return match.group(1) if match else None


def _leading_int(value: str) -> Optional[int]:
    match = _LEADING_INT_RE.match(value.strip())
    if not match:
        return None
    number = int(match.group(0))
    return None if number < 0 else number


def _leading_float(value: str) -> Optional[float]:
    match = _LEADING_FLOAT_RE.match(value.strip())
    if not match:
        return None
    number = float(match.group(0))
    return None if number < 0 else number


def _key_values(body: str) -> Dict[str, str]:
    """Split ``| k=v | k=v, k2=v2`` into a dict; the last duplicate key wins."""
    values: Dict[str, str] = {}
    for segment in body.split("|"):
        for part in segment.split(", "):
            key, sep, value = part.strip().partition("=")
            if sep and key and " " not in key:
                values[key] = value.strip()
    return values


_INT_FIELDS = {
    "total": "total_ms",
    "payload": "payload_bytes",
    "original": "original_bytes",
    "uart_tx": "uart_tx_ms",
    "phone_confirm": "phone_confirm_ms",
    "phone_ack_wait": "phone_ack_wait_ms",
    "last_packet_to_phone_ack": "last_packet_to_phone_ack_ms",
    "camera": "camera_ms",
    "compress": "compress_ms",
}
_KNOWN_KEYS = set(_INT_FIELDS) | {"requestId", "bleImgId", "success", "transfer_speed"}


def parse_pipeline_finished(line: str) -> Optional[PipelineFinished]:
    match = _PIPELINE_RE.search(line or "")
    if not match:
        return None
    values = _key_values(match.group("body"))
    request_id = values.get("requestId")
    success = values.get("success")
    if not request_id or success not in ("true", "false"):
        return None
    ints = {attr: _leading_int(values[key]) for key, attr in _INT_FIELDS.items() if key in values}
    speed = _leading_float(values["transfer_speed"]) if "transfer_speed" in values else None
    return PipelineFinished(
        request_id=request_id,
        ble_img_id=values.get("bleImgId") or None,
        success=success == "true",
        transfer_speed_kbps=speed,
        extra={k: v for k, v in values.items() if k not in _KNOWN_KEYS},
        **ints,
    )


def parse_line(line: str) -> Optional[Event]:
    """Return the first recognised event on ``line``, or ``None``."""
    if not line:
        return None
    try:
        return _parse_line(line)
    except (ValueError, TypeError):
        return None


def _parse_line(line: str) -> Optional[Event]:
    if "PIPELINE FINISHED" in line:
        return parse_pipeline_finished(line)
    match = _PHOTO_ERROR_RE.search(line)
    if match:
        return PhotoError(match.group("rid"), match.group("code"), match.group("message").strip())
    match = _RECEIVED_RE.search(line)
    if match:
        return PhotoReceived(match.group("rid"))
    match = _ACCEPTED_RE.search(line)
    if match:
        return PhotoAccepted(match.group("rid"))
    if _TRANSFER_RETRY_RE.search(line):
        return TransferRetry()
    match = _TRANSFER_GAVE_UP_RE.search(line)
    if match:
        return TransferGaveUp(int(match.group("max")))
    match = _BAUD_READY_RE.search(line)
    if match:
        return BaudChange(int(match.group("baud")), "link_ready_" + match.group("kind"))
    match = _BAUD_OPENED_RE.search(line)
    if match:
        return BaudChange(int(match.group("baud")), "serial_opened")
    match = _BES_FW_RE.search(line)
    if match:
        return BesFirmware(match.group("version") or match.group("version2"))
    match = _STEP_RE.search(line)
    if match:
        return BlePhotoStep(match.group("category"), match.group("message").strip())
    return None


@dataclass
class GlassesState:
    """Latest provenance facts seen in a glasses log."""

    baud: Optional[int] = None
    baud_source: Optional[str] = None
    bes_firmware: Optional[str] = None
    timing_logs_observed: bool = False

    def feed(self, event: Optional[Event]) -> None:
        if isinstance(event, BaudChange):
            self.baud = event.baud
            self.baud_source = event.source
        elif isinstance(event, BesFirmware):
            self.bes_firmware = event.version
        elif isinstance(event, (PipelineFinished, BlePhotoStep)):
            self.timing_logs_observed = True


def scan_glasses_log(text: str) -> GlassesState:
    state = GlassesState()
    for line in (text or "").splitlines():
        state.feed(parse_line(line))
    return state
