import datetime
import unittest

import cases

DOWN = cases.LINK_DOWN_RX["s22"]
FRESH = cases.LINK_FRESH_RX["s22"]
NOW = datetime.datetime(2026, 10, 13, 11, 20, 30, 0)


def rssi(ts):
    return (0, f"10-13 {ts} 20266 20266 I Bridge  : LIVE: \U0001F4F6 RSSI: -44 dBm")


class LinkFreshTest(unittest.TestCase):
    def test_recent_rssi_is_live(self):
        self.assertTrue(cases.link_fresh([rssi("11:20:24.100")], FRESH, DOWN, now=NOW))

    def test_stale_rssi_is_not_live(self):
        self.assertFalse(cases.link_fresh([rssi("11:19:00.000")], FRESH, DOWN, now=NOW))

    def test_disconnect_after_rssi_cancels_it(self):
        lines = [
            rssi("11:20:24.100"),
            (0, "10-13 11:20:25.000 20266 20266 I Bridge  : LIVE: Disconnected from GATT server"),
        ]
        self.assertFalse(cases.link_fresh(lines, FRESH, DOWN, now=NOW))

    def test_rssi_after_disconnect_counts_again(self):
        lines = [
            (0, "10-13 11:20:10.000 20266 20266 I Bridge  : LIVE: Disconnected from GATT server"),
            rssi("11:20:27.000"),
        ]
        self.assertTrue(cases.link_fresh(lines, FRESH, DOWN, now=NOW))

    def test_react_native_duplicate_is_ignored(self):
        dup = (0, "10-13 11:20:28.000 20266 21840 I ReactNativeJS: '[native:android]', 'LIVE: \U0001F4F6 RSSI: -44 dBm'")
        self.assertFalse(cases.link_fresh([dup], FRESH, DOWN, now=NOW))

    def test_unparseable_timestamp_never_counts(self):
        self.assertFalse(cases.link_fresh([(0, "LIVE: \U0001F4F6 RSSI: -44 dBm")], FRESH, DOWN, now=NOW))

    def test_no_lines(self):
        self.assertFalse(cases.link_fresh([], FRESH, DOWN, now=NOW))


class SpeedupGateTest(unittest.TestCase):
    def test_off_by_default_and_on_only_with_flag(self):
        import os
        old = os.environ.pop("PMX_BENCH_SPEEDUPS", None)
        try:
            self.assertFalse(cases.bench_speedups())
            os.environ["PMX_BENCH_SPEEDUPS"] = "1"
            self.assertTrue(cases.bench_speedups())
            os.environ["PMX_BENCH_SPEEDUPS"] = "0"
            self.assertFalse(cases.bench_speedups())
        finally:
            os.environ.pop("PMX_BENCH_SPEEDUPS", None)
            if old is not None:
                os.environ["PMX_BENCH_SPEEDUPS"] = old


if __name__ == "__main__":
    unittest.main()
