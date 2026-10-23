"""osascript retry, BenchBlocked, and simulator-advert freshness. No Mac UI, no BLE."""

import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

import ios


def _ok(stdout="", returncode=0):
    return SimpleNamespace(stdout=stdout, stderr="", returncode=returncode)


class OsascriptTests(unittest.TestCase):
    def test_success_does_not_restart_system_events(self):
        seen = []

        def run(argv, **kw):
            seen.append(argv[0])
            return _ok("Connection Request")

        r = ios.osascript("tell application \"System Events\" to return 1", runner=run, sleeper=lambda s: None)
        self.assertEqual(r.stdout, "Connection Request")
        self.assertEqual(seen, ["osascript"])

    def test_one_timeout_restarts_system_events_and_retries(self):
        seen = []
        killed = []

        def run(argv, **kw):
            seen.append(argv[0])
            if argv[0] == "pgrep":
                return _ok("12345")
            if argv[0] == "osascript" and seen.count("osascript") == 1:
                raise subprocess.TimeoutExpired(argv, 8)
            return _ok("sheet")

        with mock.patch.object(ios.os, "kill", lambda pid, sig: killed.append(pid)):
            r = ios.osascript("x", runner=run, sleeper=lambda s: None)
        self.assertEqual(r.stdout, "sheet")
        self.assertEqual(seen, ["osascript", "pgrep", "osascript"])
        self.assertEqual(killed, [12345])

    def test_second_timeout_is_bench_blocked(self):
        def run(argv, **kw):
            if argv[0] == "pgrep":
                return _ok("9")
            raise subprocess.TimeoutExpired(argv, 8)

        with mock.patch.object(ios.os, "kill", lambda pid, sig: None):
            with self.assertRaises(ios.BenchBlocked):
                ios.osascript("x", runner=run, sleeper=lambda s: None)


class MacSheetTests(unittest.TestCase):
    def setUp(self):
        self._real = ios.osascript

    def tearDown(self):
        ios.osascript = self._real

    def test_no_window_returns_none(self):
        ios.osascript = lambda *a, **k: _ok("")
        self.assertIsNone(ios.mac_sheet())

    def test_click_reports_return_code(self):
        ios.osascript = lambda *a, **k: _ok(returncode=0)
        self.assertTrue(ios.mac_sheet_click("Connect"))
        ios.osascript = lambda *a, **k: _ok(returncode=1)
        self.assertFalse(ios.mac_sheet_click("Cancel"))


class AdvertFreshTests(unittest.TestCase):
    def test_missing_or_old_advert_is_stale(self):
        self.assertFalse(ios.advert_is_fresh(None, now=100))
        self.assertFalse(ios.advert_is_fresh({"name": "Mentra Live"}, now=100))
        self.assertFalse(ios.advert_is_fresh({"last_seen": 70}, max_age_s=20, now=100))
        self.assertTrue(ios.advert_is_fresh({"last_seen": 90}, max_age_s=20, now=100))

    def test_require_fresh_advert_blocks_when_stale(self):
        with self.assertRaises(ios.BenchBlocked):
            ios.require_fresh_advert(adv_fn=lambda seconds=4: None)
        adv = ios.require_fresh_advert(adv_fn=lambda seconds=4: {"last_seen": ios.time.time()})
        self.assertIn("last_seen", adv)
