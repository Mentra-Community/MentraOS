import io
import tempfile
import unittest
from pathlib import Path

import support  # noqa: F401 - sets sys.path
from blespeed.logparse import parse_pipeline_finished
from blespeed.outcome import PhotoTracker
from blespeed.results import COLUMNS, PhotoRow, ResultsFormatError, read_rows, row_from_tracker, write_rows

LINE = (
    "⏱️ [BLE PHOTO] PIPELINE FINISHED | requestId=r1 | bleImgId=I000000001 | success=true"
    " | payload=204800 bytes (200.0KB) | uart_tx=2300ms | transfer_speed=87.0KB/s"
    " | phone_confirm=2500ms | phone_ack_wait=200ms | last_packet_to_phone_ack=150ms"
)


class ResultsTest(unittest.TestCase):
    def test_row_from_finished_tracker(self):
        tracker = PhotoTracker("r1", "I000000001")
        tracker.on_sent(10.0)
        tracker.feed(parse_pipeline_finished(LINE), 13.25)
        row = row_from_tracker(tracker, run_id="run", phone="p", phone_os="ios", condition="A",
                               size="medium", index=1, warmup=False, transport="l2cap")
        self.assertEqual("finished", row.outcome)
        self.assertEqual(80.0, row.e2e_kbps)
        self.assertEqual(3.25, row.elapsed_s)
        self.assertEqual(150, row.last_packet_to_phone_ack_ms)
        self.assertTrue(row.ok)

    def test_row_from_unsent_tracker(self):
        row = row_from_tracker(PhotoTracker("r", "I1"), run_id="run", phone="p", phone_os="ios",
                               condition="A", size="max", index=2, warmup=True, transport="")
        self.assertEqual("", row.outcome)
        self.assertIsNone(row.elapsed_s)
        self.assertFalse(row.ok)

    def test_round_trip(self):
        rows = [
            PhotoRow("run", "p", "android", "B", "max", 0, True, "r0", "I0", "finished",
                     payload_bytes=1, e2e_kbps=1.5, transfer_speed_kbps=2.25),
            PhotoRow("run", "p", "android", "B", "max", 1, False, "r1", "I1", "timeout",
                     failure_reason="no_outcome_after_60s", busy_retries=2),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "results.csv"
            with path.open("w", newline="") as handle:
                write_rows(handle, rows)
            self.assertEqual(rows, read_rows(path))
            self.assertEqual(",".join(COLUMNS), path.read_text().splitlines()[0])

    def test_bad_warmup_value(self):
        buf = io.StringIO()
        write_rows(buf, [PhotoRow("run", "p", "ios", "A", "max", 0, False, "r", "I", "finished")])
        text = buf.getvalue().replace(",False,", ",maybe,")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "results.csv"
            path.write_text(text)
            with self.assertRaisesRegex(ResultsFormatError, "warmup"):
                read_rows(path)


if __name__ == "__main__":
    unittest.main()
