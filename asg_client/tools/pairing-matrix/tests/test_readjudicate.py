import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tests import helpers  # noqa: F401
from tests.test_owner_removal import D4BFIX, st
import readjudicate

GAP = {"gap": readjudicate.GAP_NAME, "detail": "x"}


class ReadjudicateTests(unittest.TestCase):
    def setUp(self):
        self.runs = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.runs, True)

    def case(self, name, trace, status="OPEN", gaps=(GAP,), failed=()):
        d = self.runs / name
        d.mkdir()
        (d / "bes_trace.txt").write_text("\n".join(trace) + "\n")
        checks = [{"check": "ok one", "ok": True, "detail": ""}] + [{"check": c, "ok": False, "detail": ""} for c in failed]
        row = {"case": name.split("__")[0], "status": status, "checks": checks, "gaps": list(gaps), "dir": str(d),
               "snapshot_id": 3, "manifest_sha256": "abc"}
        with open(self.runs / "results.jsonl", "a") as fh:
            fh.write(json.dumps(row) + "\n")
        return d

    def test_open_case_with_only_that_gap_is_upgraded_and_results_are_untouched(self):
        d = self.case("D4BFIX", D4BFIX)
        before = (self.runs / "results.jsonl").read_text()
        row, msg = readjudicate.adjudicate(d)
        self.assertEqual(row["status"], "PASS")
        self.assertTrue(row["readjudicated"])
        self.assertEqual(row["original_status"], "OPEN")
        self.assertEqual(row["reason"], "harness proof rule fix (snapshot 4)")
        self.assertEqual(len(row["evidence"]), 2)
        self.assertEqual((self.runs / "results.jsonl").read_text(), before)

    def test_cli_appends_one_row_and_is_idempotent(self):
        d = self.case("D4BFIX", D4BFIX)
        import sys
        from unittest import mock

        for _ in range(2):
            with mock.patch.object(sys, "argv", ["readjudicate.py", str(d)]):
                readjudicate.main()
        rows = [json.loads(l) for l in (self.runs / "readjudications.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "PASS")

    def test_trace_without_the_transition_stays_open(self):
        d = self.case("X6", [st("pwr_press", "OWNER_ONLY", "1/1", 3), st("ble_connect", "PAIRING", "0/0", 3)])
        row, msg = readjudicate.adjudicate(d)
        self.assertEqual(row["status"], "OPEN")
        self.assertTrue(msg.startswith("GAP"))

    def test_other_gap_or_failure_blocks_the_upgrade(self):
        d = self.case("X5", D4BFIX, gaps=(GAP, {"gap": "R15 5 new owner committed", "detail": ""}))
        self.assertIsNone(readjudicate.adjudicate(d)[0])
        d = self.case("X10", D4BFIX, failed=("R15 3a no connect attempts for 20 s",))
        self.assertIsNone(readjudicate.adjudicate(d)[0])

    def test_only_open_cases_are_eligible(self):
        for status in ("FAIL", "PASS"):
            d = self.case(f"C{status}", D4BFIX, status=status)
            self.assertIsNone(readjudicate.adjudicate(d)[0])

    def test_rerun_dir_matches_its_own_row(self):
        self.case("D4", D4BFIX, status="FAIL")
        d = self.case("D4__rerun2", D4BFIX)
        row, _ = readjudicate.adjudicate(d)
        self.assertEqual(row["status"], "PASS")

    def test_newest_transition_is_used(self):
        older = [st("pwr_press", "OWNER_ONLY", "1/1", 3), st("ble_connect", "PAIRING", "0/0", 4),
                 st("session_up", "OWNER_ONLY", "1/1", 4)]
        newer = [st("pwr_press", "OWNER_ONLY", "1/1", 4, 99), st("ble_connect", "PAIRING", "0/0", 5, 100)]
        d = self.case("D4", older + newer)
        row, _ = readjudicate.adjudicate(d)
        self.assertIn("generation=5", row["evidence"][1])


if __name__ == "__main__":
    unittest.main()
