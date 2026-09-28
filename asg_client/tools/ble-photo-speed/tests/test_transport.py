import unittest

import support  # noqa: F401 - sets sys.path
from blespeed.transport import (
    GATT,
    GATT_AFTER_CLOSE,
    L2CAP,
    L2CAP_THEN_CLOSED,
    UNKNOWN,
    TransportTracker,
    keep_phone_line,
    label_phone_log,
)


class TransportTest(unittest.TestCase):
    def test_android_l2cap_via_react_native_js(self):
        tracker = label_phone_log(support.fixture_lines("phone_android_l2cap.txt"))
        self.assertEqual(L2CAP, tracker.session_label)
        self.assertEqual(L2CAP, tracker.current)
        self.assertEqual(1, tracker.opens)
        self.assertIn("16:00:08.352", tracker.first_open_line)
        self.assertEqual(["I085113629.avif"], tracker.files_completed)

    def test_ios_open_then_closed(self):
        tracker = TransportTracker()
        lines = support.fixture_lines("phone_ios_closed.txt")
        labels = []
        for line in lines:
            tracker.feed(line)
            labels.append(tracker.current)
        self.assertEqual([UNKNOWN, L2CAP, L2CAP, L2CAP, GATT_AFTER_CLOSE, GATT_AFTER_CLOSE], labels)
        self.assertEqual(L2CAP_THEN_CLOSED, tracker.session_label)
        self.assertEqual([81234], tracker.phone_rates_bps)
        self.assertEqual(2, len(tracker.files_completed))

    def test_gatt_fallback(self):
        tracker = label_phone_log(support.fixture_lines("phone_android_gatt.txt"))
        self.assertEqual(GATT, tracker.session_label)
        self.assertEqual(GATT, tracker.current)
        self.assertTrue(tracker.l2cap_ready_or_gatt)

    def test_no_l2cap_lines(self):
        tracker = label_phone_log(["random", "LIVE: something else", ""])
        self.assertEqual(UNKNOWN, tracker.session_label)
        self.assertFalse(tracker.l2cap_ready_or_gatt)

    def test_multiple_opens(self):
        tracker = label_phone_log([
            "LIVE: L2CAP: channel open (PSM 0xC9)",
            "LIVE: L2CAP: channel closed",
            "LIVE: L2CAP: channel open (PSM 0xC9)",
        ])
        self.assertEqual(2, tracker.opens)
        self.assertEqual(L2CAP, tracker.current)
        self.assertEqual(L2CAP_THEN_CLOSED, tracker.session_label)

    def test_gatt_line_after_open_does_not_downgrade(self):
        tracker = label_phone_log(["LIVE: L2CAP: channel open (PSM 0xC9)",
                                   "LIVE: L2CAP: unavailable, staying on GATT (stale)"])
        self.assertEqual(L2CAP, tracker.current)

    def test_keep_filter(self):
        self.assertTrue(keep_phone_line("x LIVE: L2CAP: channel open"))
        self.assertTrue(keep_phone_line("📊 Transfer rate: 1 bytes/sec"))
        self.assertFalse(keep_phone_line("kernel: wifi scan"))


if __name__ == "__main__":
    unittest.main()
