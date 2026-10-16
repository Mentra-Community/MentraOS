"""assert_unit3 and the adb routing rules, with fakes (no adb, no devices)."""

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from tests import helpers  # noqa: F401  (sets sys.path)
import ident
import pmx

HEADER = "transport  usb        role    serial            cid\n"
UNIT3 = "5          usb:1-1    unit3   0123456789ABCDEF  1501003458364b4d4203b71dcc5eb7b3\n"
UNIT1 = "3          usb:0-1.3  unit1   ML395018B         1501003458364b4d4203ce25cc3d2831\n"
UNIT2 = "4          usb:2-1    unit2   0123456789ABCDEF  90014a68423861503e0300c12f4d5747\n"
PHONE = "7          usb:1-2    other   RFCT31GXXQJ       \n"


def fake_run(stdout="", returncode=0, stderr=""):
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)

    run.calls = calls
    return run


class Unit3GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        lab = Path(self.tmp.name) / "lab-units"
        lab.write_text("#!/bin/sh\n")
        self._old = pmx.LAB_UNITS
        pmx.LAB_UNITS = lab
        self.addCleanup(setattr, pmx, "LAB_UNITS", self._old)
        self._old_cid = ident.unit3_cid
        ident.unit3_cid = lambda: ""
        self.addCleanup(setattr, ident, "unit3_cid", self._old_cid)

    def test_exactly_one_unit3_row_passes_and_returns_it(self):
        run = fake_run(HEADER + UNIT1 + UNIT2 + UNIT3 + PHONE)
        row = pmx.assert_unit3(run)
        self.assertEqual(row["role"], "unit3")
        self.assertEqual(row["cid"], "1501003458364b4d4203b71dcc5eb7b3")
        self.assertEqual(pmx.LAST_UNIT3["usb"], "usb:1-1")
        argv, kwargs = run.calls[0]
        self.assertEqual(argv, [str(pmx.LAB_UNITS)])  # lab-units only
        self.assertNotIn("ANDROID_SERIAL", kwargs["env"])

    def test_no_unit3_row_fails_closed(self):
        with self.assertRaisesRegex(pmx.Unit3GuardError, "exactly one unit3 row.*found 0"):
            pmx.assert_unit3(fake_run(HEADER + UNIT1 + UNIT2))

    def test_empty_output_fails_closed(self):
        with self.assertRaises(pmx.Unit3GuardError):
            pmx.assert_unit3(fake_run(""))

    def test_two_unit3_rows_fail_closed(self):
        with self.assertRaisesRegex(pmx.Unit3GuardError, "found 2"):
            pmx.assert_unit3(fake_run(HEADER + UNIT3 + UNIT3.replace("usb:1-1", "usb:1-3")))

    def test_nonzero_exit_fails_closed_even_with_a_row(self):
        with self.assertRaises(pmx.Unit3GuardError):
            pmx.assert_unit3(fake_run(HEADER + UNIT3, returncode=1))

    def test_missing_lab_units_fails_closed(self):
        pmx.LAB_UNITS = Path(self.tmp.name) / "nope"
        with self.assertRaisesRegex(pmx.Unit3GuardError, "lab-units not found"):
            pmx.assert_unit3(fake_run(HEADER + UNIT3))

    def test_run_failure_fails_closed(self):
        def boom(*a, **k):
            raise subprocess.TimeoutExpired("lab-units", 120)

        with self.assertRaises(pmx.Unit3GuardError):
            pmx.assert_unit3(boom)

    def test_recorded_cid_must_match(self):
        ident.unit3_cid = lambda: "deadbeef"
        with self.assertRaisesRegex(pmx.Unit3GuardError, "does not match"):
            pmx.assert_unit3(fake_run(HEADER + UNIT3))
        ident.unit3_cid = lambda: "1501003458364b4d4203b71dcc5eb7b3"
        self.assertEqual(pmx.assert_unit3(fake_run(HEADER + UNIT3))["role"], "unit3")

    def test_unread_and_other_roles_are_not_unit3(self):
        rows = pmx.parse_lab_units(HEADER + "9  usb:3-1  unread  ?  ?\n" + UNIT1)
        self.assertEqual([r["role"] for r in rows], ["unread", "unit1"])


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.unit3 = root / "unit3"
        self.unit3.mkdir()
        self.wrapper = self.unit3 / "adb"
        self.wrapper.write_text(
            "#!/bin/sh\necho \"args:$* serial:${ANDROID_SERIAL-unset} path0:${PATH%%:*}\"\n")
        self.wrapper.chmod(self.wrapper.stat().st_mode | stat.S_IXUSR)
        self.phone_adb = root / "tools" / "adb"
        self.phone_adb.parent.mkdir()
        self.phone_adb.write_text("#!/bin/sh\necho \"phone args:$*\"\n")
        self.phone_adb.chmod(self.phone_adb.stat().st_mode | stat.S_IXUSR)
        self.saved = (pmx.UNIT3_DIR, pmx.LAB_BIN, dict(os.environ))
        pmx.UNIT3_DIR = self.unit3
        pmx.LAB_BIN = root / "labbin"
        os.environ["ANDROID_SERIAL"] = "SHOULD-NOT-LEAK"
        os.environ.pop("PMX_PHONE_ADB", None)
        self.addCleanup(self._restore)

    def _restore(self):
        pmx.UNIT3_DIR, pmx.LAB_BIN, env = self.saved
        os.environ.clear()
        os.environ.update(env)

    def test_glasses_argv_is_the_wrapper_with_no_serial_flags(self):
        self.assertEqual(pmx.adb_argv(pmx.GLASSES, "shell", "ls"), [str(self.wrapper), "shell", "ls"])

    def test_glasses_calls_reject_serial_and_transport_flags(self):
        for flag in ("-s", "-t", "-d", "-e"):
            with self.assertRaises(pmx.RouteError):
                pmx.adb_argv(pmx.GLASSES, flag, "X", "shell")

    def test_glasses_call_runs_with_wrapper_dir_first_and_no_android_serial(self):
        out = pmx.adb(pmx.GLASSES, "shell", "true")
        self.assertIn("args:shell true", out)
        self.assertIn("serial:unset", out)
        self.assertIn(f"path0:{self.unit3}", out)

    def test_missing_wrapper_refuses(self):
        self.wrapper.unlink()
        with self.assertRaisesRegex(pmx.RouteError, "wrapper missing"):
            pmx.adb_argv(pmx.GLASSES, "get-state")

    def test_raw_serial_routes_are_rejected(self):
        with self.assertRaisesRegex(pmx.RouteError, "unknown adb route"):
            pmx.adb_argv("0123456789ABCDEF", "shell", "ls")
        with self.assertRaises(pmx.RouteError):
            pmx.adb_argv("RFCT31GXXQJ", "shell", "ls")

    def test_phone_refused_when_pmx_phone_adb_unset(self):
        with self.assertRaisesRegex(pmx.RouteError, "PMX_PHONE_ADB is not set"):
            pmx.adb_argv(pmx.PHONE, "shell", "ls")
        with self.assertRaises(pmx.RouteError):
            pmx.psh("ls")

    def test_phone_argv_uses_the_configured_binary_with_the_s22_serial(self):
        os.environ["PMX_PHONE_ADB"] = str(self.phone_adb)
        self.assertEqual(pmx.adb_argv(pmx.PHONE, "shell", "ls"),
                         [str(self.phone_adb), "-s", "RFCT31GXXQJ", "shell", "ls"])
        self.assertIn("phone args:-s RFCT31GXXQJ shell ls", pmx.adb(pmx.PHONE, "shell", "ls"))

    def test_phone_never_uses_the_unit3_wrapper_or_a_lab_dir_binary(self):
        os.environ["PMX_PHONE_ADB"] = str(self.wrapper)
        pmx.LAB_BIN = self.unit3.parent
        with self.assertRaisesRegex(pmx.RouteError, "lab-unit wrapper"):
            pmx.adb_argv(pmx.PHONE, "shell", "ls")

    def test_phone_refuses_the_shared_system_adb(self):
        fake = Path(self.tmp.name) / "homebrew" / "bin" / "adb"
        fake.parent.mkdir(parents=True)
        fake.write_text("#!/bin/sh\n")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        os.environ["PMX_PHONE_ADB"] = str(fake)
        with self.assertRaisesRegex(pmx.RouteError, "shared system adb"):
            pmx.adb_argv(pmx.PHONE, "shell", "ls")

    def test_phone_refuses_a_non_executable_path(self):
        os.environ["PMX_PHONE_ADB"] = str(Path(self.tmp.name) / "missing-adb")
        with self.assertRaisesRegex(pmx.RouteError, "not an executable"):
            pmx.adb_argv(pmx.PHONE, "shell", "ls")

    def test_logtap_uses_the_route_not_a_serial(self):
        os.environ["PMX_PHONE_ADB"] = str(self.phone_adb)
        argv = pmx.adb_argv(pmx.GLASSES, "logcat", "-v", "time")
        self.assertEqual(argv[0], str(self.wrapper))
        self.assertNotIn("-s", argv)
        self.assertNotIn("-t", argv)

    def test_no_hardcoded_glasses_serial_or_homebrew_adb_in_harness_sources(self):
        root = Path(pmx.HERE)
        for name in ("pmx.py", "ios.py", "cases.py", "mac_central.py", "watch.py", "owner_lost.py", "run_case.py",
                     "snapshot.py", "ble_scan.py"):
            text = (root / name).read_text()
            self.assertNotIn("0123456789ABCDEF", text, name)
            self.assertNotIn("/opt/homebrew", text, name)
            self.assertNotIn("pkill", text.replace("never pkill", ""), name)
            self.assertNotIn("killall", text, name)
            self.assertIsNone(re.search(r'\[\s*"adb"', text), f"{name}: bare adb argv")
            self.assertNotIn('"-s", GLASSES', text, name)


if __name__ == "__main__":
    unittest.main()
