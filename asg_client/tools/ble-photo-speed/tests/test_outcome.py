import unittest

import support  # noqa: F401 - sets sys.path
from blespeed.logparse import (
    PhotoAccepted,
    PhotoError,
    PhotoReceived,
    PipelineFinished,
    TransferGaveUp,
    TransferRetry,
)
from blespeed.outcome import (
    BUSY_WAIT,
    DONE,
    FAILED,
    FINISHED,
    NOT_RECEIVED,
    RESEND,
    SENT,
    TIMEOUT,
    WAIT,
    PhotoTracker,
    TrackerConfig,
)

RID = "bspd-t-Amed-001"


def finished(rid=RID, success=True):
    return PipelineFinished(request_id=rid, ble_img_id="I000000001", success=success,
                            payload_bytes=204800, phone_confirm_ms=2500, uart_tx_ms=2300)


class TrackerTest(unittest.TestCase):
    def setUp(self):
        self.config = TrackerConfig(timeout_s=60, receive_timeout_s=10, busy_retry_delay_s=2,
                                    max_busy_retries=5)
        self.t = PhotoTracker(RID, "I000000001", self.config)
        self.t.on_sent(0.0)

    def test_happy_path(self):
        self.assertEqual(WAIT, self.t.feed(PhotoReceived(RID), 0.1))
        self.assertEqual(WAIT, self.t.feed(PhotoAccepted(RID), 0.2))
        self.assertEqual(DONE, self.t.feed(finished(), 3.0))
        self.assertEqual(FINISHED, self.t.state)
        self.assertEqual(3.0, self.t.finished_at)
        self.assertEqual(0, self.t.busy_retries)
        self.assertIsNone(self.t.failure_reason)

    def test_busy_then_finished(self):
        self.assertEqual(WAIT, self.t.feed(PhotoError(RID, "BLE_TRANSFER_BUSY", "busy"), 0.2))
        self.assertEqual(BUSY_WAIT, self.t.state)
        self.assertEqual(WAIT, self.t.poll(2.1))
        self.assertEqual(RESEND, self.t.poll(2.2))
        self.t.on_sent(2.2)
        self.assertEqual(SENT, self.t.state)
        self.assertEqual(DONE, self.t.feed(finished(), 5.0))
        self.assertEqual(FINISHED, self.t.state)
        self.assertEqual(1, self.t.busy_retries)
        self.assertEqual(0.0, self.t.sent_at)
        self.assertEqual(2.2, self.t.last_send_at)

    def test_camera_busy_is_retryable(self):
        self.t.feed(PhotoError(RID, "CAMERA_BUSY", "job in flight"), 0.2)
        self.assertEqual(BUSY_WAIT, self.t.state)

    def test_busy_five_retries_then_failed(self):
        now = 0.0
        for attempt in range(5):
            self.assertEqual(WAIT, self.t.feed(PhotoError(RID, "BLE_TRANSFER_BUSY", "busy"), now + 0.1))
            now += 2.1
            self.assertEqual(RESEND, self.t.poll(now))
            self.t.on_sent(now)
        self.assertEqual(DONE, self.t.feed(PhotoError(RID, "BLE_TRANSFER_BUSY", "busy"), now + 0.1))
        self.assertEqual(FAILED, self.t.state)
        self.assertEqual(5, self.t.busy_retries)
        self.assertEqual("busy_retries_exhausted:BLE_TRANSFER_BUSY", self.t.failure_reason)

    def test_non_retryable_error_fails(self):
        self.assertEqual(DONE, self.t.feed(PhotoError(RID, "BATTERY_LOW", "low"), 0.2))
        self.assertEqual(FAILED, self.t.state)
        self.assertEqual("photo_error:BATTERY_LOW", self.t.failure_reason)

    def test_timeout_after_received(self):
        self.t.feed(PhotoReceived(RID), 0.1)
        self.assertEqual(WAIT, self.t.poll(59.9))
        self.assertEqual(DONE, self.t.poll(60.0))
        self.assertEqual(TIMEOUT, self.t.state)
        self.assertEqual("no_outcome_after_60s", self.t.failure_reason)

    def test_not_received_detects_dropped_broadcast(self):
        self.assertEqual(WAIT, self.t.poll(9.9))
        self.assertEqual(DONE, self.t.poll(10.0))
        self.assertEqual(NOT_RECEIVED, self.t.state)

    def test_late_finish_after_timeout_is_ignored(self):
        self.t.feed(PhotoReceived(RID), 0.1)
        self.t.poll(61.0)
        self.assertEqual(DONE, self.t.feed(finished(), 62.0))
        self.assertEqual(TIMEOUT, self.t.state)
        self.assertIsNone(self.t.result)

    def test_internal_transfer_retry_then_success(self):
        self.t.feed(PhotoReceived(RID), 0.1)
        self.t.feed(TransferRetry(), 2.0)
        self.assertEqual(DONE, self.t.feed(finished(), 6.0))
        self.assertEqual(FINISHED, self.t.state)
        self.assertEqual(1, self.t.transfer_retries)

    def test_transfer_retry_before_our_request_is_seen_is_not_counted(self):
        self.t.feed(TransferRetry(), 0.05)
        self.assertEqual(0, self.t.transfer_retries)

    def test_transfer_gave_up_fails(self):
        self.t.feed(PhotoReceived(RID), 0.1)
        self.assertEqual(DONE, self.t.feed(TransferGaveUp(3), 20.0))
        self.assertEqual("max_transfer_retries_exceeded", self.t.failure_reason)

    def test_pipeline_success_false_fails_but_keeps_fields(self):
        self.assertEqual(DONE, self.t.feed(finished(success=False), 5.0))
        self.assertEqual(FAILED, self.t.state)
        self.assertEqual("pipeline_success_false", self.t.failure_reason)
        self.assertEqual(204800, self.t.result.payload_bytes)

    def test_other_request_lines_are_ignored(self):
        other = "bspd-t-Amed-999"
        self.t.feed(PhotoReceived(other), 0.1)
        self.assertFalse(self.t.received)
        self.assertEqual(WAIT, self.t.feed(PhotoError(other, "BATTERY_LOW", "x"), 0.2))
        self.assertEqual(WAIT, self.t.feed(finished(rid=other), 0.3))
        self.assertEqual(SENT, self.t.state)

    def test_duplicate_finished_line_is_idempotent(self):
        self.t.feed(finished(), 3.0)
        first = self.t.result
        self.assertEqual(DONE, self.t.feed(finished(), 3.5))
        self.assertIs(first, self.t.result)
        self.assertEqual(3.0, self.t.finished_at)

    def test_none_event_just_polls(self):
        self.assertEqual(WAIT, self.t.feed(None, 1.0))
        self.assertEqual(DONE, self.t.feed(None, 10.0))

    def test_error_while_waiting_to_resend_is_ignored(self):
        self.t.feed(PhotoError(RID, "BLE_TRANSFER_BUSY", "busy"), 0.2)
        self.assertEqual(WAIT, self.t.feed(PhotoError(RID, "BATTERY_LOW", "x"), 0.5))
        self.assertEqual(BUSY_WAIT, self.t.state)


if __name__ == "__main__":
    unittest.main()
