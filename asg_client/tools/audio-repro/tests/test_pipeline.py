"""End-to-end offline check of analysis and labeling on a simulated run directory."""

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from audio_repro import synthetic  # noqa: E402
from audio_repro.analysis import DEFAULT_CUE, analyze_run  # noqa: E402
from audio_repro.generator import generate  # noqa: E402
from audio_repro.sequence import canonical_bytes  # noqa: E402
from audio_repro.wavio import read_wav, resample, write_wav  # noqa: E402

RATE = 48000
OFFSET_NS = 5_000_000_000_000  # host monotonic minus device monotonic
REC_START_NS = OFFSET_NS + 10_000_000_000  # recorder starts 10 s after device t=0 (host view)
ACOUSTIC_LATENCY_S = 0.085

MATRIX = {
    "name": "pipe",
    "settings": {"pre_delay_ms": [700, 700], "bes_log_pull": True},
    "blocks": [{"id": "A", "type": "conditions", "conditions": ["cold", "reopen", "reuse", "join_pending"], "reps": 3}],
}


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / "run"
        (self.run / "device" / "bes").mkdir(parents=True)
        samples, rate = read_wav(DEFAULT_CUE)
        self.cue = resample(samples, rate, RATE)

    def tearDown(self):
        self.tmp.cleanup()

    def _simulate(self, faults):
        sequence = generate(MATRIX, 11, git_sha="test")
        (self.run / "sequence.json").write_bytes(canonical_bytes(sequence))
        (self.run / "run.json").write_text(json.dumps({"acoustic": {"host_start_after_ns": REC_START_NS}}))
        total_s = 12 + 4 * len(sequence["trials"])
        recording = np.zeros(int(total_s * RATE))
        events, sync = [], []
        bes_history = []
        rng = np.random.default_rng(5)
        t = 12_000_000_000
        for trial in sequence["trials"]:
            tid = trial["id"]
            events.append({"k": "trial_meta", "trial": tid, "ns": t, "block": trial["block"], "cell": trial["cell"]})
            events.append({"k": "trial_start", "trial": tid, "ns": t})
            sync.append({"host_ns": t + OFFSET_NS + int(rng.integers(20, 60)) * 1_000_000,
                         "kind": "trial_start", "fields": {"trial": tid, "mono_ns": str(t)}})
            cues = [op for op in trial["ops"] if op["op"] == "cue"]
            request_id = 1000 + len(events)
            cursor = t + 200_000_000
            for index, op in enumerate(cues):
                oid = op["id"]
                replaced = trial["cell"] == "off|join_pending" and oid == "q0"
                expected = trial["expect"][oid]

                def ev(name, ns, **fields):
                    events.append({"k": "event", "trial": tid, "ns": ns, "key": f"{oid}.{name}", "f": fields})

                ev("exec", cursor)
                ev("player_request", cursor + 100_000, token=index + 1)
                if expected == "open":
                    ev("bridge_open_req", cursor + 200_000, request_id=request_id)
                else:
                    ev("bridge_reused", cursor + 200_000, reason=expected.split(":")[1], request_id=request_id)
                if replaced:
                    ev("end", cursor + 1_000_000, reason="stopped")
                    ev("stopped", cursor + 1_000_000, reason="stopped")
                    cursor += 2_000_000
                    continue
                start = cursor + 60_000_000
                ev("player_start", start, token=index + 1)
                ev("end", start + 600_000_000, reason="complete")
                ev("complete", start + 600_000_000, reason="complete")
                ev("bridge_close", start + 1_350_000_000, request_id=request_id)
                sound = self.cue
                fault = faults.get((tid, oid))
                if fault == "overflow":
                    dropped = synthetic.overflow_drops(self.cue, 512, 41, 64, 40, 1)
                    sound = synthetic.rate_mismatch_stretch(dropped, 44100, 48000)
                elif fault == "click":
                    sound = synthetic.insert_click(self.cue, RATE, 0.12, 0.35)
                at = (start + OFFSET_NS - REC_START_NS) / 1e9 + ACOUSTIC_LATENCY_S + rng.normal(0, 0.003)
                i = int(at * RATE)
                recording[i:i + len(sound)] += sound * 0.5
                cursor = start + 1_500_000_000
            if any(k[0] == tid and v == "overflow" for k, v in faults.items()):
                bes_history.append(f"[{tid}] [I2S-PCM] overflow queued=12000 incoming=4096 dropped=328 total=328")
            bes_history.append(f"[{tid}] [I2S-PCM] stop rx=1000 played=900 dropped=0 queued=0 peak_q31=1 volume=15")
            (self.run / "device" / "bes" / f"{tid}-b1.txt").write_text("\n".join(bes_history) + "\n")
            end_ns = cursor + 500_000_000
            events.append({"k": "trial_end", "trial": tid, "ns": end_ns, "outcome": "completed", "flags": []})
            sync.append({"host_ns": end_ns + OFFSET_NS + int(rng.integers(20, 60)) * 1_000_000,
                         "kind": "trial_end", "fields": {"trial": tid, "mono_ns": str(end_ns)}})
            t = end_ns + 700_000_000
        recording = synthetic.speaker(recording, RATE, noise_db=-62)
        write_wav(self.run / "recording.wav", recording, RATE)
        (self.run / "device" / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
        (self.run / "host_sync.jsonl").write_text("\n".join(json.dumps(s) for s in sync) + "\n")
        (self.run / "logcat.txt").write_text("")
        return sequence

    def test_detects_injected_faults_and_classifies_bridges(self):
        sequence = self._simulate({})
        trials = [t["id"] for t in sequence["trials"]]
        reuse = next(t for t in sequence["trials"] if t["cell"] == "off|reuse")["id"]
        cold = next(t for t in sequence["trials"] if t["cell"] == "off|cold")["id"]
        self._simulate({(reuse, "q1"): "overflow", (cold, "q0"): "click"})
        summary = analyze_run(self.run)
        rows = [json.loads(line) for line in (self.run / "analysis" / "cues.jsonl").read_text().splitlines()]
        suspects = {(r["trial"], r["op"]) for r in rows if r["outcome"] == "suspect"}
        self.assertEqual(suspects, {(reuse, "q1"), (cold, "q0")})
        overflow = next(r for r in rows if (r["trial"], r["op"]) == (reuse, "q1"))
        self.assertIn("pitch_low", overflow["metrics"]["symptoms"])
        self.assertEqual(overflow["bes"]["overflow_lines"], 1)
        self.assertFalse(any(r["bridge_mismatch"] for r in rows))
        joined = [r for r in rows if r["cell"] == "off|join_pending" and r["op"] == "q0"]
        self.assertTrue(all(r["outcome"] == "not_evaluated:stopped" for r in joined))
        self.assertTrue((self.run / "analysis" / "evidence" / f"{reuse}-q1" / "clip.wav").exists())
        self.assertTrue((self.run / "analysis" / "evidence" / f"{reuse}-q1" / "bes-delta.txt").exists())
        self.assertEqual(summary["cells"]["off|reuse"]["suspect"], 1)
        self.assertEqual(summary["cells"]["off|reuse"]["n"], 3)
        self.assertLess(abs(summary["clock_mapping"]["intercept_s"] - ACOUSTIC_LATENCY_S), 0.02)
        self.assertEqual(len(trials), 12)

        exported = json.loads(subprocess.check_output(
            [sys.executable, str(ROOT / "label.py"), "export", str(self.run), "--seed", "3"], text=True))
        self.assertEqual(exported["suspects"], 2)
        key = json.loads((self.run / "labels" / "key.json").read_text())
        with (self.run / "labels" / "labels.csv").open() as handle:
            rows_csv = list(csv.DictReader(handle))
        for row in rows_csv:
            entry = key[row["clip"]]
            row["low_pitch"] = "y" if (entry["trial"], entry["op"]) == (reuse, "q1") else "n"
            row["pops"] = "y" if (entry["trial"], entry["op"]) == (cold, "q0") else "n"
        with (self.run / "labels" / "labels.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["clip", "low_pitch", "pops", "other", "notes"])
            writer.writeheader()
            writer.writerows(rows_csv)
        agreement = json.loads(subprocess.check_output(
            [sys.executable, str(ROOT / "label.py"), "import", str(self.run)], text=True))
        self.assertEqual(agreement["sensitivity"], 1.0)
        self.assertEqual(agreement["specificity"], 1.0)
        labeled = (self.run / "analysis" / "summary-labeled.md").read_text()
        self.assertIn("off|reuse", labeled)


if __name__ == "__main__":
    unittest.main()
