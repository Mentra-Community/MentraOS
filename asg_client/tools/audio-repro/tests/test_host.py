import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from audio_repro.device import PLACEHOLDER_SERIAL, audio_flinger_standby, check_identity  # noqa: E402
from audio_repro.generator import generate  # noqa: E402
from audio_repro.logcat import parse_harness_line  # noqa: E402
from audio_repro.sequence import canonical_bytes, validate_sequence, validate_trial  # noqa: E402

MATRIX = json.loads((ROOT / "matrices" / "m1.json").read_text())


class GeneratorTest(unittest.TestCase):
    def test_same_inputs_give_identical_bytes(self):
        a = canonical_bytes(generate(MATRIX, 1234, reps_scale=0.2, git_sha="x"))
        b = canonical_bytes(generate(MATRIX, 1234, reps_scale=0.2, git_sha="x"))
        self.assertEqual(a, b)
        c = canonical_bytes(generate(MATRIX, 1235, reps_scale=0.2, git_sha="x"))
        self.assertNotEqual(a, c)

    def test_full_matrix_is_valid_and_balanced(self):
        sequence = generate(MATRIX, 1, git_sha="x")
        self.assertEqual(validate_sequence(sequence), [])
        block_a = [t for t in sequence["trials"] if t["block"] == "A"]
        for index in range(0, len(block_a), 4):
            self.assertEqual(sorted(t["cell"] for t in block_a[index:index + 4]),
                             ["off|cold", "off|join_pending", "off|reopen", "off|reuse"])
        block_b = [t for t in sequence["trials"] if t["block"] == "B"]
        cells = {t["cell"] for t in block_b}
        self.assertIn("off|control|cold", cells)
        self.assertIn("VOICE_COMMUNICATION|start_during+100|reuse", cells)

    def test_anchors_never_need_negative_delays(self):
        sequence = generate(MATRIX, 9, git_sha="x")
        for trial in sequence["trials"]:
            for op in trial["ops"]:
                self.assertGreaterEqual(op["at"]["delay_ms"], 0)

    def test_block_boundaries_get_room_for_snapshots(self):
        sequence = generate(MATRIX, 9, reps_scale=0.1, git_sha="x")
        trials = sequence["trials"]
        firsts = [b for a, b in zip(trials, trials[1:]) if a["block"] != b["block"]]
        self.assertTrue(firsts)
        self.assertTrue(all(t["pre_delay_ms"] >= 4000 for t in firsts))

    def test_repetition_chain_anchors_on_player_request(self):
        sequence = generate(MATRIX, 3, blocks=["Arep"], git_sha="x")
        chain = sequence["trials"][0]["ops"]
        cues = [op for op in chain if op["op"] == "cue"]
        self.assertEqual(len(cues), 25)
        self.assertTrue(all(op["at"]["anchor"].endswith(".player_request") for op in cues[1:]))


class ValidationTest(unittest.TestCase):
    def setUp(self):
        self.trial = copy.deepcopy(generate(MATRIX, 5, blocks=["B"], reps_scale=0.1, git_sha="x")["trials"][0])

    def test_rejects_unknown_producer_and_cycles(self):
        trial = copy.deepcopy(self.trial)
        trial["ops"][1]["at"]["anchor"] = "zz.complete"
        self.assertTrue(any("zz is not an op" in e for e in validate_trial(trial)))
        trial = copy.deepcopy(self.trial)
        trial["ops"][0]["at"]["anchor"] = trial["ops"][1]["id"] + ".complete"
        self.assertTrue(any("anchor cycle" in e for e in validate_trial(trial)))

    def test_rejects_disallowed_capture_source_in_supported_trials(self):
        trials = generate(MATRIX, 5, blocks=["B"], git_sha="x")["trials"]
        trial = copy.deepcopy(next(t for t in trials if any(op["op"] == "capture_start" for op in t["ops"])))
        for op in trial["ops"]:
            if op["op"] == "capture_start":
                op["source"] = "CAMCORDER"
        self.assertTrue(any("capture source not allowed" in e for e in validate_trial(trial)))
        trial["class"] = "fault_injection"
        self.assertFalse(any("capture source" in e for e in validate_trial(trial)))


class ParsingTest(unittest.TestCase):
    def test_parses_harness_logcat_lines(self):
        line = "  1234.567  4321  4400 I AudioRepro: AUDIO_REPRO run=m1-s1 await trial=A-0001 key=w0.satisfied state=af_standby mono_ns=99"
        parsed = parse_harness_line(line)
        self.assertEqual(parsed.kind, "await")
        self.assertEqual(parsed.fields["key"], "w0.satisfied")
        self.assertEqual(parsed.fields["run"], "m1-s1")
        rejected = parse_harness_line("E AudioRepro: AUDIO_REPRO run_rejected reason=invalid detail=x")
        self.assertEqual(rejected.kind, "run_rejected")
        self.assertIsNone(parse_harness_line("I Other: nothing"))

    def test_audio_flinger_standby_requires_every_output(self):
        self.assertTrue(audio_flinger_standby("Output thread 1\n  Standby: yes\nOutput thread 2\n  Standby: yes\n"))
        self.assertFalse(audio_flinger_standby("Output thread 1\n  Standby: yes\nOutput thread 2\n  Standby: no\n"))
        self.assertIsNone(audio_flinger_standby("no threads"))

    def test_placeholder_serial_requires_a_cid(self):
        info = {"ro.serialno": PLACEHOLDER_SERIAL, "emmc_cid": "abc", "ro.custom.ota.version": "v1"}
        self.assertTrue(check_identity(info, None, None, None))
        self.assertEqual(check_identity(info, None, "abc", "v1"), [])
        self.assertTrue(check_identity(info, None, "abd", None))


if __name__ == "__main__":
    unittest.main()
