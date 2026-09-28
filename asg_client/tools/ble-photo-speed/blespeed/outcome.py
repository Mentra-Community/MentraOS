"""Per-request outcome tracking for one BLE photo.

The tracker is pure: the caller feeds parsed log events and the current time,
and asks what to do next. It never sleeps or talks to adb.

Captures are strictly sequential, so K900 retry lines (which carry no request
id) are attributed to the one photo whose transfer is in flight.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .logparse import (
    Event,
    PhotoAccepted,
    PhotoError,
    PhotoReceived,
    PipelineFinished,
    TransferGaveUp,
    TransferRetry,
)

SENT = "sent"
BUSY_WAIT = "busy_wait"
FINISHED = "finished"
FAILED = "failed"
TIMEOUT = "timeout"
NOT_RECEIVED = "not_received"

TERMINAL_STATES = (FINISHED, FAILED, TIMEOUT, NOT_RECEIVED)

# Transient rejections: the previous photo's transfer or job has not cleared yet.
RETRYABLE_ERROR_CODES = ("BLE_TRANSFER_BUSY", "CAMERA_BUSY")

# Actions returned to the caller.
WAIT = "wait"
RESEND = "resend"
DONE = "done"


@dataclass(frozen=True)
class TrackerConfig:
    timeout_s: float = 60.0
    receive_timeout_s: float = 10.0
    busy_retry_delay_s: float = 2.0
    max_busy_retries: int = 5


class PhotoTracker:
    """Tracks one take_photo request from the first send to a terminal outcome."""

    def __init__(self, request_id: str, ble_img_id: str, config: Optional[TrackerConfig] = None):
        self.request_id = request_id
        self.ble_img_id = ble_img_id
        self.config = config or TrackerConfig()
        self.state: Optional[str] = None
        self.busy_retries = 0
        self.transfer_retries = 0
        self.failure_reason: Optional[str] = None
        self.result: Optional[PipelineFinished] = None
        self.received = False
        self.sent_at: Optional[float] = None
        self.last_send_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self._resend_at: Optional[float] = None

    @property
    def done(self) -> bool:
        return self.state in TERMINAL_STATES

    def on_sent(self, now: float) -> None:
        if self.done:
            return
        if self.sent_at is None:
            self.sent_at = now
        self.last_send_at = now
        self.received = False
        self.state = SENT
        self._resend_at = None

    def feed(self, event: Optional[Event], now: float) -> str:
        """Apply one parsed event. Returns the next action."""
        if self.done or event is None:
            return self.poll(now)
        if isinstance(event, (PhotoReceived, PhotoAccepted)):
            if event.request_id == self.request_id:
                self.received = True
        elif isinstance(event, PhotoError):
            if event.request_id == self.request_id and self.state == SENT:
                self.received = True
                if event.code in RETRYABLE_ERROR_CODES:
                    return self._busy(event.code, now)
                self._finish(FAILED, now, "photo_error:" + event.code)
        elif isinstance(event, PipelineFinished):
            if event.request_id == self.request_id and self.state == SENT:
                self.received = True
                self.result = event
                if event.success:
                    self._finish(FINISHED, now)
                else:
                    self._finish(FAILED, now, "pipeline_success_false")
        elif isinstance(event, TransferRetry):
            if self.state == SENT and self.received:
                self.transfer_retries += 1
        elif isinstance(event, TransferGaveUp):
            if self.state == SENT and self.received:
                self._finish(FAILED, now, "max_transfer_retries_exceeded")
        return self.poll(now)

    def poll(self, now: float) -> str:
        """Check timers. Returns WAIT, RESEND, or DONE."""
        if self.done:
            return DONE
        if self.state == BUSY_WAIT:
            if self._resend_at is not None and now >= self._resend_at:
                return RESEND
            return WAIT
        if self.state == SENT and self.last_send_at is not None:
            elapsed = now - self.last_send_at
            if not self.received and elapsed >= self.config.receive_timeout_s:
                self._finish(NOT_RECEIVED, now, "no_take_photo_log_after_send")
                return DONE
            if elapsed >= self.config.timeout_s:
                self._finish(TIMEOUT, now, "no_outcome_after_%ds" % int(self.config.timeout_s))
                return DONE
        return WAIT

    def _busy(self, code: str, now: float) -> str:
        if self.busy_retries >= self.config.max_busy_retries:
            self._finish(FAILED, now, "busy_retries_exhausted:" + code)
            return DONE
        self.busy_retries += 1
        self.state = BUSY_WAIT
        self._resend_at = now + self.config.busy_retry_delay_s
        return WAIT

    def _finish(self, state: str, now: float, reason: Optional[str] = None) -> None:
        self.state = state
        self.finished_at = now
        self.failure_reason = reason
