import json
import tempfile
import unittest
from pathlib import Path

from tests import helpers  # noqa: F401
import ident


class IdentityTests(unittest.TestCase):
    def test_old_identity_formats_are_unchanged(self):
        i = ident.build(env={"PMX_GLASSES_NAME": "Mentra_Live_02BE", "PMX_GLASSES_MAC": "CC:E7:DE:E0:02:BE"}, run_json={})
        self.assertEqual(i.name, "Mentra_Live_02BE")
        self.assertEqual(i.code, "02BE")
        self.assertEqual(i.mac_dash, "cc-e7-de-e0-02-be")  # old ios.GLASSES_MAC
        self.assertEqual(i.mac_colon, "CC:E7:DE:E0:02:BE")
        self.assertEqual(i.hfp_flag, "/tmp/sim-hfp-02BE")  # old ios.HFP_FLAG

    def test_run_json_keys(self):
        i = ident.build(env={}, run_json={"glasses_name": "Mentra_Live_A1B2", "glasses_code": "a1b2",
                                          "glasses_mac": "aa-bb-cc-dd-a1-b2"})
        self.assertEqual((i.name, i.code, i.mac_dash, i.hfp_flag),
                         ("Mentra_Live_A1B2", "A1B2", "aa-bb-cc-dd-a1-b2", "/tmp/sim-hfp-A1B2"))

    def test_env_wins_over_run_json(self):
        i = ident.build(env={"PMX_GLASSES_CODE": "FFFF"}, run_json={"glasses_name": "Mentra_Live_0001"})
        self.assertEqual(i.code, "FFFF")
        self.assertEqual(i.name, "Mentra_Live_0001")

    def test_code_derived_from_name_and_name_from_code(self):
        self.assertEqual(ident.build(env={}, run_json={"glasses_name": "Mentra_Live_BEEF"}).code, "BEEF")
        self.assertEqual(ident.build(env={}, run_json={"glasses_code": "beef"}).name, "Mentra_Live_BEEF")

    def test_missing_identity_fails_closed(self):
        with self.assertRaises(ident.IdentityMissing):
            ident.build(env={}, run_json={})

    def test_mac_is_required_only_when_asked(self):
        i = ident.build(env={}, run_json={"glasses_code": "02BE"})
        self.assertEqual(i.mac, "")
        with self.assertRaises(ident.IdentityMissing):
            i.mac_dash

    def test_bad_mac_rejected(self):
        with self.assertRaises(ident.IdentityMissing):
            ident.build(env={"PMX_GLASSES_CODE": "02BE", "PMX_GLASSES_MAC": "12:34"}, run_json={})

    def test_reads_run_json_from_the_runs_dir(self):
        import os

        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "x2").mkdir()
            (Path(d) / "x2" / "run.json").write_text(json.dumps({"glasses_code": "9999", "unit3_cid": "ABC"}))
            old = dict(os.environ)
            os.environ["PMX_RUNS_DIR"] = d
            os.environ["PMX_RUN"] = "x2"
            for k in ("PMX_GLASSES_NAME", "PMX_GLASSES_CODE", "PMX_GLASSES_MAC", "PMX_UNIT3_CID"):
                os.environ.pop(k, None)
            try:
                ident.reset()
                self.assertEqual(ident.code(), "9999")
                self.assertEqual(ident.unit3_cid(), "abc")
                self.assertTrue(ident.is_glasses_name("Mentra_Live_9999"))
                self.assertFalse(ident.is_glasses_name("Mentra_Live_02BE"))
            finally:
                os.environ.clear()
                os.environ.update(old)
                ident.reset()


if __name__ == "__main__":
    unittest.main()
