"""USB cap measured from the reboot request, and phase-interval union. No devices."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cases


class UnionTests(unittest.TestCase):
    def test_overlap_counts_once_and_gaps_add(self):
        self.assertEqual(cases.union_duration([(0, 10), (5, 12)]), 12)
        self.assertEqual(cases.union_duration([(0, 10), (12, 14)]), 12)
        self.assertEqual(cases.union_duration([]), 0)
        self.assertEqual(cases.union_duration([(3, 3)]), 0)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def time(self):
        return self.now

    def sleep(self, s):
        self.now += s


class UsbBudgetTests(unittest.TestCase):
    def ctx(self, t_reboot):
        from tests.helpers import FakeCtx
        c = FakeCtx()
        c.t_reboot = t_reboot
        c.dir = Path(tempfile.mkdtemp())
        c.g = mock.Mock()
        return c

    def test_already_back_adds_no_wait(self):
        clock = Clock(1100.0)  # 100 s after the reboot request
        seen = {}

        def wait(timeout, poll, **kw):
            seen["timeout"] = timeout
            seen["poll"] = poll
            return 0.0

        c = self.ctx(1000.0)
        with mock.patch.object(cases, "time", clock), \
                mock.patch.object(cases.pmx, "wait_unit3_return", wait), \
                mock.patch.object(cases.pmx, "wait_glasses_boot", lambda timeout=300: True), \
                mock.patch.object(cases.pmx, "assert_unit3", lambda: {"role": "unit3"}), \
                mock.patch.object(cases.pmx, "gsh", lambda *a, **k: ""), \
                mock.patch.object(cases.pmx, "bes_trace", lambda *a, **k: None), \
                mock.patch.object(cases.pmx, "LogTap", mock.Mock()):
            cases.pmx.LogTap.return_value.start.return_value = c.g
            ok = cases.adb_return_bench(c)
        self.assertTrue(ok)
        self.assertEqual(seen["timeout"], 140.0)  # 240 - 100, not a fresh 240
        self.assertEqual(seen["poll"], 5)
        self.assertEqual(c.blocked, "")
        self.assertFalse(any(b["bench"] == "usb return over the 3 min budget" for b in c.bench))

    def test_no_usb_at_the_cap_blocks(self):
        clock = Clock(1000.0 + 240)

        def wait(timeout, poll, **kw):
            self.assertEqual(timeout, 0)
            return None

        c = self.ctx(1000.0)
        with mock.patch.object(cases, "time", clock), \
                mock.patch.object(cases.pmx, "wait_unit3_return", wait):
            ok = cases.adb_return_bench(c)
        self.assertFalse(ok)
        self.assertEqual(c.blocked, "unit3 USB not back within 4 min of the reboot")
        self.assertTrue(c.stop_run_reason)

    def test_return_after_three_minutes_is_a_note_not_a_block(self):
        clock = Clock(1000.0 + 200)

        def wait(timeout, poll, **kw):
            return 0.0

        c = self.ctx(1000.0)
        with mock.patch.object(cases, "time", clock), \
                mock.patch.object(cases.pmx, "wait_unit3_return", wait), \
                mock.patch.object(cases.pmx, "wait_glasses_boot", lambda timeout=300: True), \
                mock.patch.object(cases.pmx, "assert_unit3", lambda: {"role": "unit3"}), \
                mock.patch.object(cases.pmx, "gsh", lambda *a, **k: ""), \
                mock.patch.object(cases.pmx, "bes_trace", lambda *a, **k: None), \
                mock.patch.object(cases.pmx, "LogTap", mock.Mock()):
            cases.pmx.LogTap.return_value.start.return_value = c.g
            ok = cases.adb_return_bench(c)
        self.assertTrue(ok)
        self.assertEqual(c.blocked, "")
        self.assertTrue(any(b["bench"] == "usb return over the 3 min budget" for b in c.bench))
