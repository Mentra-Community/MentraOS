import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audio_repro import synthetic  # noqa: E402
from audio_repro.detectors import Thresholds, analyze_cue, make_reference  # noqa: E402
from audio_repro.wavio import read_wav, resample  # noqa: E402

ASSET = Path(__file__).resolve().parents[3] / "app" / "src" / "main" / "assets" / "recording_start.wav"
RATE = 48000


class DetectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        samples, rate = read_wav(ASSET)
        cls.cue = resample(samples, rate, RATE)
        cls.ref = make_reference(cls.cue, RATE)
        cls.thresholds = Thresholds()

    def measure(self, cue):
        return analyze_cue(synthetic.speaker(synthetic.place(cue, RATE), RATE), RATE, self.ref, self.thresholds)

    def test_reference_is_a_single_tone(self):
        self.assertAlmostEqual(self.ref.frequency, 1102.5, delta=2.0)
        self.assertGreater(self.ref.tonal_fraction, 0.8)

    def test_clean_cue_has_no_symptoms(self):
        m = self.measure(self.cue)
        self.assertTrue(m.found)
        self.assertAlmostEqual(m.pitch_factor, 1.0, delta=0.003)
        self.assertAlmostEqual(m.duration_ratio, 1.0, delta=0.03)
        self.assertEqual(m.symptoms, [])

    def test_content_consumed_slowly_lowers_pitch_and_stretches_time(self):
        slowed = synthetic.rate_mismatch_stretch(self.cue, 44100, 48000)
        m = self.measure(slowed)
        self.assertAlmostEqual(m.pitch_factor, 44100 / 48000, delta=0.004)
        self.assertAlmostEqual(m.time_scale_decay, 48000 / 44100, delta=0.04)
        self.assertIn("pitch_low", m.symptoms)
        self.assertIn("duration_long", m.symptoms)
        self.assertNotIn("discontinuity", m.symptoms)

    def test_overflow_drops_lower_pitch_without_full_stretch_and_are_discontinuous(self):
        dropped = synthetic.overflow_drops(self.cue, burst=512, drop=41, ramp=64, jitter=40, seed=3)
        played = synthetic.rate_mismatch_stretch(dropped, 44100, 48000)
        m = self.measure(played)
        self.assertAlmostEqual(m.pitch_factor, 44100 / 48000, delta=0.006)
        self.assertLess(abs(m.duration_ratio - 1.0), 0.05)
        self.assertIn("pitch_low", m.symptoms)
        self.assertIn("discontinuity", m.symptoms)
        self.assertGreaterEqual(len(m.phase_jumps) + len(m.residual_spikes) + len(m.transients), 3)

    def test_click_is_detected(self):
        m = self.measure(synthetic.insert_click(self.cue, RATE, 0.15, 0.3))
        self.assertIn("discontinuity", m.symptoms)
        self.assertTrue(any(abs(t - 0.35) < 0.01 for t in m.transients + m.residual_spikes))
        self.assertNotIn("pitch_low", m.symptoms)

    def test_missing_segment_is_detected(self):
        m = self.measure(synthetic.remove_segment(self.cue, RATE, 0.12, 0.0123))
        self.assertIn("discontinuity", m.symptoms)

    def test_repeated_segment_is_detected(self):
        m = self.measure(synthetic.repeat_segment(self.cue, RATE, 0.1, 0.0071))
        self.assertIn("discontinuity", m.symptoms)

    def test_level_eq_and_clipping_are_not_pitch(self):
        for name, cue in (
            ("gain", synthetic.gain(self.cue, -9.0)),
            ("bass", synthetic.low_shelf(self.cue, RATE, 9.0)),
            ("clip", synthetic.clip(self.cue, 0.3)),
        ):
            with self.subTest(name=name):
                m = self.measure(cue)
                self.assertAlmostEqual(m.pitch_factor, 1.0, delta=0.003)
                self.assertNotIn("pitch_low", m.symptoms)
                self.assertNotIn("pitch_high", m.symptoms)
        clean = self.measure(self.cue)
        clipped = self.measure(synthetic.clip(self.cue, 0.3))
        self.assertGreater(clipped.thd_db, clean.thd_db + 10.0)
        self.assertIn("distortion", clipped.symptoms)
        self.assertNotIn("discontinuity", clipped.symptoms)
        quiet = self.measure(synthetic.gain(self.cue, -20.0))
        self.assertAlmostEqual(quiet.duration_ratio, 1.0, delta=0.03)

    def test_absent_cue_is_reported(self):
        silence = np.random.default_rng(1).normal(0, 1e-4, RATE)
        m = analyze_cue(silence, RATE, self.ref, self.thresholds)
        self.assertFalse(m.found)
        self.assertEqual(m.symptoms, ["missing_cue"])


if __name__ == "__main__":
    unittest.main()
