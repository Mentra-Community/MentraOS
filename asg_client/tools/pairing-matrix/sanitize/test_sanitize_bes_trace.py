"""Tests for sanitize_bes_trace.py. Synthetic bytes only: never paste a real key here.

Run from asg_client/tools/pairing-matrix:

    python3 -m unittest discover -s sanitize -p 'test_*.py'
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sanitize_bes_trace as s  # noqa: E402

B16 = "00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff"
B16_HEAD = "00 11 22 33 44 55 66 77"
B16_TAIL = "88 99 aa bb cc dd ee ff"
ADDR = "11 22 33 44 55 66"


def clean(text):
    out, stats = s.sanitize_lines(text.splitlines(keepends=True))
    return "".join(out), stats


def has_run(text):
    return bool(s.residual_runs(text.splitlines(keepends=True)))


class RedactionTests(unittest.TestCase):
    def test_ltk_dump_redacted(self):
        out, st = clean(f"200 | NV LTK:\n{B16} \n")
        self.assertIn("[REDACTED n16 bytes]", out)
        self.assertNotIn("00 11 22", out)
        self.assertNotIn("ee ff", out)
        self.assertFalse(has_run(out))
        self.assertEqual(st.continuation_lines_hit, 1)

    def test_irk_dump_redacted_and_following_address_kept(self):
        out, _ = clean(f"210 | peer irk\n{B16} \n{ADDR} \n220 | next event\n")
        self.assertIn("[REDACTED n16 bytes]", out)
        self.assertIn(ADDR, out)
        self.assertNotIn("88 99", out)
        self.assertIn("220 | next event", out)

    def test_link_key_across_continuation_lines(self):
        text = f"300 | save link key tmpLinkKey:\n{B16_HEAD} \n{B16_TAIL} \n310 | done\n"
        out, st = clean(text)
        self.assertEqual(out.count("[REDACTED n8 bytes]"), 2)
        self.assertFalse(has_run(out))
        self.assertNotIn("00 11", out)
        self.assertNotIn("88 99", out)
        self.assertIn("310 | done", out)
        self.assertEqual(st.continuation_lines_hit, 2)

    def test_short_key_fragments_in_key_context_redacted(self):
        # a ring split can cut a dump into pieces under 8 bytes; they must not leak
        text = "linkKey:\n00 11 22 33 \n44 55 66 77 88 99 \n"
        out, st = clean(text)
        self.assertNotIn("00 11", out)
        self.assertIn("44 55 66 77 88 99", out)  # exactly 6 bytes: kept as an address
        self.assertEqual(st.short_continuations, 1)  # the 4-byte piece; the 6-byte line is an address

    def test_six_byte_address_preserved(self):
        line = f"110 | peer addr {ADDR} conidx=0\n"
        out, st = clean(line)
        self.assertEqual(out, line)
        self.assertEqual(st.redactions, 0)
        self.assertEqual(st.addresses_kept, 1)

    def test_address_preserved_on_label_line(self):
        line = f"irk addr {ADDR}\n"
        out, _ = clean(line)
        self.assertEqual(out, line)

    def test_eight_plus_run_on_unlabelled_line(self):
        out, st = clean(f"400 | some unrelated dump {B16} end\n")
        self.assertEqual(out, "400 | some unrelated dump [REDACTED n16 bytes] end\n")
        self.assertEqual(st.unlabelled_lines_hit, 1)

    def test_exactly_eight_bytes_redacted_and_seven_kept(self):
        out, _ = clean(f"x {B16_HEAD} y\n")
        self.assertEqual(out, "x [REDACTED n8 bytes] y\n")
        seven = "00 11 22 33 44 55 66"
        out, _ = clean(f"x {seven} y\n")
        self.assertEqual(out, f"x {seven} y\n")

    def test_0x_prefixed_form(self):
        out, _ = clean("500 | ble_irk 0x00 0x11 0x22 0x33 0x44 0x55 0x66 0x77 0x88 0x99 0xaa 0xbb \n")
        self.assertIn("[REDACTED n12 bytes]", out)
        self.assertFalse(has_run(out))
        self.assertNotIn("0x00", out)

    def test_colon_separated_form(self):
        out, _ = clean("600 | blob 00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff end\n")
        self.assertEqual(out, "600 | blob [REDACTED n16 bytes] end\n")
        mac = "cc:e7:de:e0:02:be"  # synthetic device address in colon form
        out, _ = clean(f"addr {mac}\n")
        self.assertEqual(out, f"addr {mac}\n")

    def test_contiguous_hex_redacted(self):
        out, _ = clean("keydump 00112233445566778899aabbccddeeff\n")
        self.assertEqual(out, "keydump [REDACTED n16 bytes]\n")

    def test_case_insensitive_labels(self):
        for label in ("TMPLTK:", "TmpLinkKey:", "RANDNB", "Ediv", "CTKD key"):
            out, _ = clean(f"{label}\n{B16}\n")
            self.assertNotIn("00 11", out, label)

    def test_continuation_context_ends_at_a_normal_line(self):
        out, _ = clean(f"irk\n{B16}\nplain text line\n{ADDR}\n")
        self.assertEqual(out.splitlines()[-1], ADDR)

    def test_logcat_json_envelope(self):
        line = 'D/AsgClient( 1): layer=bes_trace_log x "line":"' + B16 + ' "}\n'
        out, _ = clean("D/AsgClient( 1): layer=bes_trace_log x \"line\":\"NV LTK:\"}\n" + line)
        self.assertNotIn("00 11", out)
        self.assertTrue(out.rstrip().endswith('"}'))

    def test_line_endings_preserved(self):
        out, _ = clean(f"a\r\nirk\r\n{B16}\r\nb")
        self.assertEqual(out.count("\r\n"), 3)
        self.assertTrue(out.endswith("b"))

    def test_idempotent(self):
        text = (
            f"NV LTK:\n{B16} \npeer irk\n{B16} \n{ADDR} \nsave link key\n{B16_HEAD} \n{B16_TAIL} \n"
            f"x 0x00 0x11 0x22 0x33 0x44 0x55 0x66 0x77 y\nz 00:11:22:33:44:55:66:77:88 q\n{ADDR}\n"
        )
        once, _ = clean(text)
        twice, st = clean(once)
        self.assertEqual(once, twice)
        self.assertEqual(st.redactions, 0)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.raw = self.dir / "raw.txt"
        self.raw.write_text(f"200 | NV LTK:\n{B16} \n210 | peer {ADDR} ok\n")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            rc = s.main([str(a) for a in args])
        return rc, out.getvalue(), err.getvalue()

    def test_writes_output_and_summary_on_stderr(self):
        dst = self.dir / "clean.txt"
        rc, out, err = self.run_cli(self.raw, "-o", dst, "--check")
        self.assertEqual(rc, 0)
        text = dst.read_text()
        self.assertIn("[REDACTED n16 bytes]", text)
        self.assertIn(ADDR, text)
        self.assertNotIn("00 11", text)
        self.assertIn("1 redactions", err)
        self.assertIn("PASS", err)
        self.assertNotIn("00 11", err)  # the summary never carries content
        self.assertIn("00 11", self.raw.read_text())  # raw input untouched

    def test_stdout_when_no_output(self):
        rc, out, err = self.run_cli(self.raw)
        self.assertEqual(rc, 0)
        self.assertIn("[REDACTED n16 bytes]", out)

    def test_check_passes_on_clean_file(self):
        dst = self.dir / "clean.txt"
        self.run_cli(self.raw, "-o", dst)
        rc, _, err = self.run_cli(dst, "--check")
        self.assertEqual(rc, 0)
        self.assertIn("PASS", err)

    def test_check_fails_on_raw_file(self):
        rc, out, err = self.run_cli(self.raw, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("FAIL", err)
        self.assertEqual(out, "")
        self.assertNotIn("00 11", err)

    def test_check_fails_and_deletes_output_when_sanitizer_leaks(self):
        dst = self.dir / "clean.txt"
        with mock.patch.object(s, "sanitize_lines", lambda lines: (list(lines), s.Stats())):
            rc, _, err = self.run_cli(self.raw, "-o", dst, "--check")
        self.assertEqual(rc, 1)
        self.assertIn("FAIL", err)
        self.assertFalse(dst.exists())

    def test_refuses_to_overwrite_input(self):
        rc, _, err = self.run_cli(self.raw, "-o", self.raw)
        self.assertEqual(rc, 2)
        self.assertIn("00 11", self.raw.read_text())

    def test_missing_input(self):
        rc, _, err = self.run_cli(self.dir / "nope.txt")
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
