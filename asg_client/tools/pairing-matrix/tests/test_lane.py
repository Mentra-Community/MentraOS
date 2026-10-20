"""Opt-in glasses lanes: unit2 routing, guard, run files and identity. No adb, no devices.

The default (no --lane, no PMX_LANE) must stay exactly the unit3 path."""

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers  # noqa: F401  (sets sys.path)
from tests.test_unit3_guard import HEADER, PHONE, UNIT1, UNIT2, UNIT3, fake_run
import ident
import pmx
import run_case
import snapshot


class LaneTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        lab = root / "lab-units"
        lab.write_text("#!/bin/sh\n")
        self.unit3_dir, self.unit2_dir = root / "unit3", root / "unit2"
        for d in (self.unit3_dir, self.unit2_dir):
            d.mkdir()
            (d / "adb").write_text("#!/bin/sh\necho \"args:$* serial:${ANDROID_SERIAL-unset} path0:${PATH%%:*}\"\n")
            (d / "adb").chmod(0o755)
        self.runs = root / "runs"
        self.saved_env = dict(os.environ)
        self.saved = (pmx.LAB_UNITS, pmx.UNIT3_DIR, pmx.UNIT2_DIR, ident.unit3_cid)
        pmx.LAB_UNITS, pmx.UNIT3_DIR, pmx.UNIT2_DIR = lab, self.unit3_dir, self.unit2_dir
        ident.unit3_cid = lambda: ""
        for k in ("PMX_LANE", "PMX_RUN", "ANDROID_SERIAL", "PMX_GLASSES_NAME", "PMX_GLASSES_CODE",
                  "PMX_GLASSES_MAC", "PMX_UNIT2_GLASSES_CODE", "PMX_UNIT2_CID", "PMX_UNIT3_CID"):
            os.environ.pop(k, None)
        os.environ["PMX_RUNS_DIR"] = str(self.runs)
        ident.reset()
        self.addCleanup(self._restore)

    def _restore(self):
        pmx.LAB_UNITS, pmx.UNIT3_DIR, pmx.UNIT2_DIR, ident.unit3_cid = self.saved
        os.environ.clear()
        os.environ.update(self.saved_env)
        ident.reset()

    def lane(self, name="unit2"):
        os.environ["PMX_LANE"] = name
        ident.reset()


class NoLaneIsUnit3Tests(LaneTestBase):
    def test_no_lane_assert_unit3_still_requires_exactly_one_unit3_row_and_the_unit3_wrapper(self):
        self.assertEqual(ident.lane(), "")
        row = pmx.assert_unit3(fake_run(HEADER + UNIT1 + UNIT2 + UNIT3 + PHONE))
        self.assertEqual(row["role"], "unit3")
        with self.assertRaisesRegex(pmx.Unit3GuardError, "exactly one unit3 row.*found 0"):
            pmx.assert_unit3(fake_run(HEADER + UNIT2))  # a unit2-only table is not unit3
        with self.assertRaisesRegex(pmx.Unit3GuardError, "found 2"):
            pmx.assert_unit3(fake_run(HEADER + UNIT3 + UNIT3.replace("usb:1-1", "usb:1-3")))
        self.assertEqual(pmx.adb_argv(pmx.GLASSES, "shell", "ls"), [str(self.unit3_dir / "adb"), "shell", "ls"])
        self.assertTrue(pmx._clean_env(pmx.GLASSES)["PATH"].startswith(str(self.unit3_dir) + os.pathsep))
        self.assertNotIn("ANDROID_SERIAL", pmx._clean_env(pmx.GLASSES))

    def test_no_lane_keeps_run_files_under_the_run_dir_and_default_wait(self):
        self.assertEqual(ident.run_name(), "x2")
        self.assertEqual(ident.run_json_path(), self.runs / "x2" / "run.json")
        defaults = pmx.wait_unit3_return.__defaults__
        self.assertEqual(defaults[:2], (1200, 15))

    def test_no_lane_wait_unit3_return_ignores_unit2_rows(self):
        clk = mock.Mock()
        t = {"now": 0.0}
        clk.time = lambda: t["now"]
        clk.sleep = lambda s: t.__setitem__("now", t["now"] + s)
        self.assertIsNone(pmx.wait_unit3_return(30, 15, run=fake_run(HEADER + UNIT2), clock=clk))

    def test_unit3_alias_and_blank_lane_are_the_default(self):
        for v in ("", "unit3", " UNIT3 "):
            self.assertEqual(ident.lane_of({"PMX_LANE": v}), "")

    def test_unknown_lane_is_rejected(self):
        with self.assertRaises(ident.LaneError):
            ident.lane_of({"PMX_LANE": "unit9"})


class Unit2LaneTests(LaneTestBase):
    def setUp(self):
        super().setUp()
        self.lane()

    def test_unit2_guard_rejects_a_unit3_only_lab_units_table(self):
        with self.assertRaisesRegex(pmx.LaneGuardError, "exactly one unit2 row.*found 0"):
            pmx.assert_unit3(fake_run(HEADER + UNIT3 + PHONE))
        with self.assertRaises(pmx.Unit3GuardError):  # existing handlers still catch it
            pmx.assert_lane_unit("unit2", fake_run(HEADER + UNIT3))

    def test_unit2_guard_passes_with_exactly_one_unit2_row_even_next_to_unit3(self):
        row = pmx.assert_unit3(fake_run(HEADER + UNIT1 + UNIT2 + UNIT3 + PHONE))
        self.assertEqual(row["role"], "unit2")
        self.assertEqual(pmx.LAST_UNIT3["role"], "unit2")

    def test_unit2_guard_rejects_zero_two_nonzero_exit_and_empty(self):
        with self.assertRaises(pmx.LaneGuardError):
            pmx.assert_lane_unit("unit2", fake_run(HEADER + UNIT1))
        with self.assertRaisesRegex(pmx.LaneGuardError, "found 2"):
            pmx.assert_lane_unit("unit2", fake_run(HEADER + UNIT2 + UNIT2.replace("usb:2-1", "usb:2-3")))
        with self.assertRaises(pmx.LaneGuardError):
            pmx.assert_lane_unit("unit2", fake_run(HEADER + UNIT2, returncode=1))
        with self.assertRaises(pmx.LaneGuardError):
            pmx.assert_lane_unit("unit2", fake_run(""))

    def test_unit2_guard_checks_the_recorded_lane_cid(self):
        os.environ["PMX_UNIT2_CID"] = "deadbeef"
        with self.assertRaisesRegex(pmx.LaneGuardError, "does not match"):
            pmx.assert_unit3(fake_run(HEADER + UNIT2))
        os.environ["PMX_UNIT2_CID"] = "90014a68423861503e0300c12f4d5747"
        self.assertEqual(pmx.assert_unit3(fake_run(HEADER + UNIT2))["role"], "unit2")

    def test_missing_lab_units_fails_closed(self):
        pmx.LAB_UNITS = Path(self.tmp.name) / "nope"
        with self.assertRaisesRegex(pmx.LaneGuardError, "lab-units not found"):
            pmx.assert_unit3(fake_run(HEADER + UNIT2))

    def test_glasses_adb_is_the_unit2_wrapper_with_no_serial_and_no_system_adb(self):
        os.environ["ANDROID_SERIAL"] = "SHOULD-NOT-LEAK"
        self.assertEqual(pmx.adb_argv(pmx.GLASSES, "shell", "ls"), [str(self.unit2_dir / "adb"), "shell", "ls"])
        for flag in ("-s", "-t", "-d", "-e"):
            with self.assertRaises(pmx.RouteError):
                pmx.adb_argv(pmx.GLASSES, flag, "X", "shell")
        out = pmx.adb(pmx.GLASSES, "shell", "true")
        self.assertIn("serial:unset", out)
        self.assertIn(f"path0:{self.unit2_dir}", out)
        self.assertNotIn("homebrew", pmx.adb_argv(pmx.GLASSES, "devices")[0])

    def test_missing_unit2_wrapper_refuses_and_never_falls_back_to_unit3(self):
        (self.unit2_dir / "adb").unlink()
        with self.assertRaisesRegex(pmx.RouteError, "unit2 adb wrapper missing"):
            pmx.adb_argv(pmx.GLASSES, "get-state")

    def test_unit2_bin_default_comes_from_the_lab_bin_and_is_overridable(self):
        import subprocess
        import sys

        code = "import pmx; print(pmx.UNIT2_DIR)"
        base = {k: v for k, v in os.environ.items() if k not in ("PMX_UNIT2_BIN", "PMX_LAB_BIN", "PMX_LANE")}
        run = lambda extra: subprocess.run([sys.executable, "-c", code], cwd=str(pmx.HERE), env={**base, **extra},
                                           capture_output=True, text=True).stdout.strip()
        self.assertEqual(run({}), "/Users/mentra/Documents/MentraApps/os-1988/bin/unit2")
        self.assertEqual(run({"PMX_UNIT2_BIN": "/tmp/elsewhere/unit2"}), "/tmp/elsewhere/unit2")

    def test_wait_return_counts_only_unit2_rows(self):
        t = {"now": 0.0}
        clk = mock.Mock()
        clk.time = lambda: t["now"]
        clk.sleep = lambda s: t.__setitem__("now", t["now"] + s)
        self.assertIsNone(pmx.wait_unit3_return(30, 15, run=fake_run(HEADER + UNIT3), clock=clk))
        t["now"] = 0.0
        self.assertEqual(pmx.wait_unit3_return(30, 15, run=fake_run(HEADER + UNIT2), clock=clk), 0.0)
        with self.assertRaisesRegex(pmx.Unit3GuardError, "unit2 rows"):
            pmx.wait_unit3_return(30, 15, run=fake_run(HEADER + UNIT2 + UNIT2), clock=clk)

    def test_run_files_live_under_the_lane_dir_not_the_unit3_run(self):
        self.assertEqual(ident.run_name(), "x2/lanes/unit2")
        self.assertEqual(ident.run_json_path(), self.runs / "x2" / "lanes" / "unit2" / "run.json")
        self.assertEqual(ident.base_run_name(), "x2")
        # idempotent: a child that already got the lane path does not nest it
        os.environ["PMX_RUN"] = "x2/lanes/unit2"
        self.assertEqual(ident.run_name(), "x2/lanes/unit2")
        self.assertEqual(ident.base_run_name(), "x2")

    def test_identity_comes_from_the_lane_run_json_not_the_unit3_one(self):
        (self.runs / "x2" / "lanes" / "unit2").mkdir(parents=True)
        (self.runs / "x2" / "run.json").write_text(json.dumps(
            {"glasses_name": "Mentra_Live_02BE", "glasses_mac": "CC:E7:DE:E0:02:BE"}))
        (self.runs / "x2" / "lanes" / "unit2" / "run.json").write_text(json.dumps(
            {"glasses_name": "Mentra_Live_A1B2", "glasses_mac": "11:22:33:44:A1:B2"}))
        ident.reset()
        i = ident.get()
        self.assertEqual((i.name, i.code, i.mac), ("Mentra_Live_A1B2", "A1B2", "11:22:33:44:A1:B2"))
        self.assertEqual(i.hfp_flag, "/tmp/sim-hfp-A1B2")
        self.assertFalse(ident.is_glasses_name("Mentra_Live_02BE"))

    def test_unit3_env_identity_does_not_leak_into_the_lane(self):
        (self.runs / "x2" / "lanes" / "unit2").mkdir(parents=True)
        (self.runs / "x2" / "lanes" / "unit2" / "run.json").write_text(json.dumps({"glasses_code": "A1B2"}))
        os.environ["PMX_GLASSES_CODE"] = "02BE"
        ident.reset()
        self.assertEqual(ident.code(), "A1B2")
        os.environ["PMX_UNIT2_GLASSES_CODE"] = "C3D4"  # lane-scoped override is allowed
        ident.reset()
        self.assertEqual(ident.code(), "C3D4")

    def test_lane_identity_missing_fails_closed_even_when_the_unit3_run_json_exists(self):
        (self.runs / "x2").mkdir(parents=True)
        (self.runs / "x2" / "run.json").write_text(json.dumps({"glasses_code": "02BE"}))
        ident.reset()
        with self.assertRaises(ident.IdentityMissing):
            ident.get()

    def test_lane_cid_reads_the_lane_run_json(self):
        (self.runs / "x2" / "lanes" / "unit2").mkdir(parents=True)
        (self.runs / "x2" / "lanes" / "unit2" / "run.json").write_text(json.dumps({"glasses_cid": "ABC"}))
        self.assertEqual(ident.lane_cid(), "abc")


class RunCaseLaneTests(LaneTestBase):
    def publish(self, lane_aware: bool):
        run_dir = self.runs / "x2"
        snap = run_dir / "harness-snapshot-1"
        snap.mkdir(parents=True)
        files = {}
        import hashlib
        for name in ("pmx.py", "ident.py", "cases.py"):
            text = "# PMX_LANE assert_lane_unit\n" if lane_aware else "# old\n"
            (snap / name).write_text(text)
            files[name] = hashlib.sha256(text.encode()).hexdigest()
        (snap / "manifest.json").write_text(json.dumps({"snapshot_id": 1, "files": files}))
        (run_dir / "harness-snapshot-current").write_text("1\n")
        self.addCleanup(lambda: [p.chmod(0o755) for p in snap.iterdir()])

    def run_main(self, argv, env=None):
        captured = {}

        def fake_exec(py, cmd, e):
            captured.update(py=py, cmd=cmd, env=e)
            raise SystemExit(0)

        with mock.patch("sys.argv", ["run_case.py", *argv]), mock.patch("os.execve", fake_exec), \
                mock.patch("os.chdir"), mock.patch.dict(os.environ, env or {}):
            with self.assertRaises(SystemExit) as cm:
                run_case.main()
        return captured, cm.exception.code

    def test_no_lane_execs_the_snapshot_exactly_as_before(self):
        self.publish(lane_aware=False)
        got, code = self.run_main(["--run", "x2", "A3"])
        self.assertEqual(code, 0)
        self.assertEqual(got["cmd"][1:], ["cases.py", "--run", "x2", "A3"])
        self.assertEqual(got["env"]["PMX_RUN"], "x2")
        self.assertNotIn("PMX_LANE", got["env"])
        self.assertNotIn("ANDROID_SERIAL", got["env"])
        self.assertEqual(got["env"]["PMX_RUNS_DIR"], str(self.runs))

    def test_lane_unit2_runs_cases_in_the_lane_run_dir_and_drops_unit3_identity(self):
        self.publish(lane_aware=True)
        env = {"PMX_GLASSES_CODE": "02BE", "PMX_GLASSES_MAC": "CC:E7:DE:E0:02:BE", "PMX_UNIT3_CID": "abc"}
        got, code = self.run_main(["--run", "x2", "--lane", "unit2", "A3"], env)
        self.assertEqual(code, 0)
        self.assertEqual(got["cmd"][1:], ["cases.py", "--run", "x2/lanes/unit2", "A3"])
        self.assertEqual(got["env"]["PMX_LANE"], "unit2")
        self.assertEqual(got["env"]["PMX_RUN"], "x2/lanes/unit2")
        for k in ("PMX_GLASSES_CODE", "PMX_GLASSES_MAC", "PMX_UNIT3_CID", "ANDROID_SERIAL"):
            self.assertNotIn(k, got["env"])

    def test_pmx_lane_env_is_the_same_as_the_flag(self):
        self.publish(lane_aware=True)
        got, _ = self.run_main(["--run", "x2", "A3"], {"PMX_LANE": "unit2"})
        self.assertEqual(got["cmd"][1:], ["cases.py", "--run", "x2/lanes/unit2", "A3"])

    def test_lane_refuses_a_snapshot_that_does_not_know_lanes(self):
        self.publish(lane_aware=False)  # like snapshot 10: would silently drive unit3
        with mock.patch("sys.argv", ["run_case.py", "--run", "x2", "--lane", "unit2", "A3"]), \
                mock.patch("os.execve") as ex:
            with self.assertRaisesRegex(SystemExit, "does not support --lane unit2"):
                run_case.main()
        ex.assert_not_called()

    def test_unknown_lane_is_refused(self):
        self.publish(lane_aware=True)
        with mock.patch("sys.argv", ["run_case.py", "--run", "x2", "--lane", "unit9", "A3"]), \
                mock.patch("os.execve") as ex:
            with self.assertRaisesRegex(SystemExit, "unknown lane"):
                run_case.main()
        ex.assert_not_called()

    def test_supports_lane_checks_the_snapshot_files(self):
        self.publish(lane_aware=True)
        self.assertTrue(snapshot.supports_lane({"dir": str(self.runs / "x2" / "harness-snapshot-1")}))
        self.assertFalse(snapshot.supports_lane({"dir": str(self.runs / "nope")}))


if __name__ == "__main__":
    unittest.main()
