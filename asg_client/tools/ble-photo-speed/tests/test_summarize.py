import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import support
from support import FIXTURES

import summarize

RUNS = FIXTURES / "runs"


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = summarize.main([str(a) for a in argv])
    return code, out.getvalue(), err.getvalue()


class SummarizeGoldenTest(unittest.TestCase):
    def test_table_matches_golden(self):
        code, out, _ = run([RUNS])
        self.assertEqual(0, code)
        self.assertEqual(support.fixture_text("summarize_golden.txt"), out)

    def test_json_matches_golden(self):
        code, out, _ = run([RUNS, "--json"])
        self.assertEqual(0, code)
        self.assertEqual(json.loads(support.fixture_text("summarize_golden.json")), json.loads(out))

    def test_golden_numbers_by_hand(self):
        report = json.loads(run([RUNS, "--json"])[1])
        # iphone15 A: 9 finished e2e values, lowest 350 KB / 4.8 s = 72.92 -> p10 (rank 1).
        self.assertEqual(72.92, report["floor"]["per_phone_p10_kbps"]["iphone15"])
        # pixel8 A: lowest 200 KB / 2.5 s = 80.0.
        self.assertEqual(80.0, report["floor"]["per_phone_p10_kbps"]["pixel8"])
        # 72.92 * 0.8 = 58.3 -> 55; D: 200 KB / 4.0 s = 50 -> 40.
        self.assertEqual(55, report["floor"]["floor_kbps"])
        self.assertEqual("iphone15", report["floor"]["limiting_phone"])
        self.assertEqual(40, report["loaded_condition_d"]["floor_kbps"])
        cells = {(c["phone"], c["condition"]): c for c in report["cells"]}
        self.assertTrue(cells[("iphone15", "A")]["flagged"])      # 1 timeout in 10
        self.assertEqual(9, cells[("iphone15", "A")]["succeeded"])
        self.assertEqual(1, cells[("pixel8", "A")]["retried"])
        legs = {l["phone"]: l for l in report["legs"]}
        self.assertEqual("radio_limited", legs["iphone15"]["verdict"])
        self.assertEqual(6.0, legs["iphone15"]["drain_slope_ms_per_kb"])
        self.assertEqual("serial_limited", legs["pixel8"]["verdict"])
        aborted = [r for r in report["runs"] if r["aborted"]]
        self.assertEqual(1, len(aborted))
        self.assertEqual(460800, aborted[0]["uart_baud"])

    def test_exclude_b_and_margin_flags(self):
        report = json.loads(run([RUNS, "--json", "--exclude-b", "--margin", "0.9", "--step", "1"])[1])
        self.assertEqual(["A", "C"], report["floor"]["conditions"])
        self.assertEqual(65, report["floor"]["floor_kbps"])  # 72.92 * 0.9 = 65.6 -> 65

    def test_single_run_dir_argument(self):
        code, out, _ = run([RUNS / "20260928T081000Z-pixel8-A-medium", "--json"])
        self.assertEqual(0, code)
        report = json.loads(out)
        self.assertEqual(["pixel8"], [c["phone"] for c in report["cells"]])
        self.assertEqual(60, report["floor"]["floor_kbps"])  # 80 * 0.8 = 64 -> 60


class SummarizeErrorsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def copy_run(self, name="20260928T081000Z-pixel8-A-medium"):
        dest = self.root / name
        shutil.copytree(RUNS / name, dest)
        return dest

    def test_empty_directory(self):
        code, out, err = run([self.root])
        self.assertEqual(2, code)
        self.assertEqual("", out)
        self.assertIn("no run directories with results.csv", err)

    def test_missing_columns(self):
        run_dir = self.copy_run()
        (run_dir / "results.csv").write_text("run_id,phone\nx,y\n")
        code, _, err = run([self.root])
        self.assertEqual(2, code)
        self.assertIn("missing columns", err)
        self.assertIn("results.csv", err)

    def test_bad_value_reports_line_number(self):
        run_dir = self.copy_run()
        lines = (run_dir / "results.csv").read_text().splitlines()
        lines[3] = lines[3].replace(",finished,", ",finished,,notanint,", 1)
        (run_dir / "results.csv").write_text("\n".join(lines) + "\n")
        code, _, err = run([self.root])
        self.assertEqual(2, code)
        self.assertIn("results.csv:4", err)

    def test_invalid_provenance_json(self):
        run_dir = self.copy_run()
        (run_dir / "provenance.json").write_text("{not json")
        code, _, err = run([self.root])
        self.assertEqual(2, code)
        self.assertIn("invalid JSON", err)

    def test_missing_provenance_is_tolerated(self):
        run_dir = self.copy_run()
        (run_dir / "provenance.json").unlink()
        code, out, _ = run([self.root, "--json"])
        self.assertEqual(0, code)
        self.assertEqual("unknown", json.loads(out)["runs"][0]["transport"])

    def test_header_only_results(self):
        run_dir = self.copy_run()
        header = (run_dir / "results.csv").read_text().splitlines()[0]
        (run_dir / "results.csv").write_text(header + "\n")
        code, out, _ = run([self.root])
        self.assertEqual(0, code)
        self.assertIn("0 measured photos", out)
        self.assertIn("Speed floor (conditions A+B+C, p10 x 0.80, rounded down to 5 KB/s): -", out)


if __name__ == "__main__":
    unittest.main()
