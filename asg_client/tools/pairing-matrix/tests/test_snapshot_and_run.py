"""Snapshots, the active.pid guard, per-case dirs and the bridge ownership rule."""

import os
import shutil
import signal
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers  # noqa: F401
import cases
import ios
import snapshot


def rmtree_force(path):
    for p in Path(path).rglob("*"):
        try:
            p.chmod(p.stat().st_mode | stat.S_IWUSR | stat.S_IXUSR)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(rmtree_force, self.tmp)
        self.old = os.environ.get("PMX_RUNS_DIR")
        os.environ["PMX_RUNS_DIR"] = self.tmp
        self.addCleanup(self._restore)

    def _restore(self):
        if self.old is None:
            os.environ.pop("PMX_RUNS_DIR", None)
        else:
            os.environ["PMX_RUNS_DIR"] = self.old

    def test_publish_copies_files_writes_manifest_and_current(self):
        out = snapshot.publish("x2")
        self.assertEqual(out["snapshot_id"], 1)
        d = Path(out["dir"])
        self.assertEqual(d.name, "harness-snapshot-1")
        for name in snapshot.HARNESS_FILES:
            self.assertEqual((d / name).read_bytes(), (snapshot.HERE / name).read_bytes())
        self.assertEqual(snapshot.current_id(Path(self.tmp) / "x2"), 1)
        self.assertEqual(snapshot.verify("x2")["manifest_sha256"], out["manifest_sha256"])
        self.assertFalse(os.access(d / "cases.py", os.W_OK))  # read-only

    def test_second_publish_increments_and_leaves_the_first_untouched(self):
        a = snapshot.publish("x2")
        b = snapshot.publish("x2")
        self.assertEqual(b["snapshot_id"], 2)
        self.assertEqual(snapshot.current_id(Path(self.tmp) / "x2"), 2)
        self.assertEqual(snapshot.verify("x2", 1)["manifest_sha256"], a["manifest_sha256"])

    def test_verify_detects_tampering(self):
        out = snapshot.publish("x2")
        f = Path(out["dir"]) / "pmx.py"
        f.chmod(0o644)
        f.write_text(f.read_text() + "\n# edit\n")
        with self.assertRaises(SystemExit):
            snapshot.verify("x2")

    def test_protected_runs_refused(self):
        for run in ("x1", "m3", "baseline"):
            with self.assertRaises(SystemExit):
                snapshot.publish(run)

    def test_cases_reads_the_snapshot_id_and_manifest_hash_from_manifest_json(self):
        out = snapshot.publish("x2")
        d = Path(out["dir"])
        with mock.patch.object(cases, "HERE", d):
            info = cases.snapshot_info()
        self.assertEqual(info, {"snapshot_id": 1, "manifest_sha256": out["manifest_sha256"]})
        with mock.patch.object(cases, "HERE", Path(self.tmp)):
            self.assertEqual(cases.snapshot_info(), {"snapshot_id": None, "manifest_sha256": None})


class PidFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_refuses_when_pid_file_points_at_a_live_process(self):
        (self.tmp / "active.pid").write_text(f"{os.getppid()}\n")  # the parent is alive and is not us
        with self.assertRaises(SystemExit) as cm:
            cases.acquire_pid_file(self.tmp)
        self.assertIn("live process", str(cm.exception))
        self.assertEqual((self.tmp / "active.pid").read_text().strip(), str(os.getppid()))

    def test_stale_pid_is_replaced_and_cleaned_on_exit(self):
        (self.tmp / "active.pid").write_text("2999999\n")
        with mock.patch("atexit.register") as reg, mock.patch("signal.signal"):
            pf = cases.acquire_pid_file(self.tmp)
        self.assertEqual(pf.read_text().strip(), str(os.getpid()))
        cleanup = reg.call_args[0][0]
        cleanup()
        self.assertFalse(pf.exists())

    def test_cleanup_does_not_remove_another_runs_pid_file(self):
        with mock.patch("atexit.register") as reg, mock.patch("signal.signal"):
            pf = cases.acquire_pid_file(self.tmp)
        pf.write_text("1\n")
        reg.call_args[0][0]()
        self.assertTrue(pf.exists())

    def test_fresh_case_dir_never_overwrites_existing_evidence(self):
        d1 = cases.fresh_case_dir(self.tmp, "X6")
        self.assertEqual(d1.name, "X6")
        (d1 / "notes.txt").write_text("evidence")
        d2 = cases.fresh_case_dir(self.tmp, "X6")
        self.assertEqual(d2.name, "X6__rerun2")
        self.assertEqual((d1 / "notes.txt").read_text(), "evidence")

    def test_old_evidence_runs_are_protected(self):
        self.assertTrue({"x1", "m1", "m2", "m3", "m4", "baseline"} <= cases.PROTECTED_RUNS)


class BridgeOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.pidfile = self.tmp / "bridge.pid"
        patches = [mock.patch.object(ios, "BRIDGE_PID_FILE", self.pidfile),
                   mock.patch.object(ios, "bridge_pids", return_value=[4242]),
                   mock.patch.object(ios, "_pid_is_bridge", return_value=True),
                   mock.patch.object(ios.time, "sleep"),
                   mock.patch.dict(os.environ, {"PMX_BRIDGE_OWNED": ""})]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_foreign_bridge_is_never_killed(self):
        with mock.patch.object(ios.os, "kill") as kill:
            with self.assertRaises(ios.BridgeNotOwned):
                ios.bridge(False)
        kill.assert_not_called()

    def test_recorded_pid_is_signalled_by_pid(self):
        self.pidfile.write_text("4242\n")
        with mock.patch.object(ios.os, "kill") as kill:
            ios.bridge(False)
        kill.assert_called_once_with(4242, signal.SIGTERM)
        self.assertFalse(self.pidfile.exists())

    def test_owned_flag_signals_the_explicit_pids(self):
        with mock.patch.dict(os.environ, {"PMX_BRIDGE_OWNED": "1"}), mock.patch.object(ios.os, "kill") as kill:
            ios.bridge(False)
        kill.assert_called_once_with(4242, signal.SIGTERM)

    def test_stop_with_nothing_running_is_a_noop(self):
        with mock.patch.object(ios, "bridge_pids", return_value=[]), mock.patch.object(ios.os, "kill") as kill:
            ios.bridge(False)
        kill.assert_not_called()


class ModuleImportTests(unittest.TestCase):
    def test_all_cases_register_and_have_docstrings(self):
        self.assertTrue(cases.CASES)
        for cid, fn in cases.CASES.items():
            self.assertTrue(fn.__doc__, cid)

    def test_step_one_cases_exist(self):
        for cid in ("D4BFIX", "X6", "X5", "X7A"):
            self.assertIn(cid, cases.CASES)

    def test_step_two_cases_exist(self):
        for cid in ("D4", "D4B", "D4FIX", "D5D7", "BTOFF_REJOIN", "X10", "X11", "X3", "X4", "G3", "E3", "A5", "B5B6",
                    "NEW3", "NEW5", "NEW6IOS", "NEW6S22", "NEW8IOS", "NEW8S22", "X8", "X9", "D3", "D3MAC", "E1MAC",
                    "X2", "NEW7"):
            self.assertIn(cid, cases.CASES)

    def test_no_duplicate_case_ids(self):
        import re
        text = (Path(cases.__file__)).read_text()
        ids = re.findall(r'^@case\("([^"]+)"\)', text, re.M)
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        self.assertEqual(dupes, [])

    def test_yield_based_assertions_are_gone(self):
        text = Path(cases.__file__).read_text()
        for needle in ("yield 300000ms", "Pairing yield ended", "ios_auth_fail", "PMX_LONG", "ios_owner_loss_after_yield",
                       "LONG ="):
            self.assertNotIn(needle, text.replace('"yield 300000ms" and', ''), needle)

    def test_not_testable_cases_stay_explicit(self):
        import re
        text = Path(cases.__file__).read_text()
        for cid in ("X2", "D3", "NEW7"):
            body = text[text.index(f'@case("{cid}")'):]
            body = body[:body.index("\n\n\n")]
            self.assertIn("not_testable", body, cid)
        self.assertNotIn("not_testable", text[text.index('@case("E3")'):text.index('@case("B8")')])


if __name__ == "__main__":
    unittest.main()
