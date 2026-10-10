# Audio reproduction harness (Mentra Live)

Engineering tools to repeatedly exercise and replay Mentra Live cue, capture and I2S bridge
states, recognize audible cue problems in an acoustic recording, and keep enough evidence to
investigate them. Milestone 1 covers the real recording-start cue, `AudioRecord` capture (off,
`MIC`, `VOICE_COMMUNICATION`), bridge-state conditions and capture transitions.

The device side lives in ASG (`com.mentra.asg_client.audio.diag` plus
`AudioReproCommandHandler`). It does nothing unless the gate file exists, so the code can ship
without changing production behavior.

## Safety

- Installing a harness-enabled ASG build on glasses is a device software change. It must be
  signed with the Mentra release key (a `.thirdparty` build is a separate package and does not
  own the bridge), and it needs explicit authorization. `adb uninstall com.mentra.asg_client`
  reverts to the system image copy.
- Nothing here flashes MTK or BES firmware. Reset levels R2 (MTK reboot) and R3 (power cycle)
  need per-block authorization.
- Always address the device explicitly (`--transport-id` preferred). The placeholder serial
  `0123456789ABCDEF` is not unique; pass `--expect-cid` for identity checks.

## Requirements

- Python 3.10+ with `numpy`.
- `adb`; `adb root` on dev images for eMMC CID and `/proc/asound` reads.
- A measurement microphone recorded at 48 kHz / 24-bit with AGC, noise suppression and EQ off,
  fixed 1-2 cm from the speaker port in a quiet room. `run.py` uses `arecord`, `sox`, or macOS
  `ffmpeg`, or any command given with `--record-cmd "... {rate} {channels} {out}"`.

## Workflow

1. **Stage 0, real flows (no install).**

   ```bash
   python3 run.py stage0 --transport-id 3 --expect-cid <CID> --flow video --count 30 \
       --bes-logs --mic "UMIK-1 1.5 cm, jig A" --out runs/
   python3 analyze.py stage0 runs/stage0-video-<stamp>
   ```

2. **Generate a sequence.** All randomness is on the host, so the file replays exactly.

   ```bash
   python3 gen.py --matrix matrices/m1.json --seed 1234 --blocks A --out sequences/m1-a-s1234.json
   ```

   Run block `A` (capture off) first in every session; `B` adds capture transitions with
   interleaved capture-off controls. `--reps-scale 0.1` gives a smoke run.

3. **Run it.**

   ```bash
   python3 run.py sequence --transport-id 3 --expect-cid <CID> \
       --sequence sequences/m1-a-s1234.json --mic "UMIK-1 1.5 cm, jig A" --out runs/
   ```

   The runner checks identity and records provenance, enables the gate, pushes the sequence,
   follows `AUDIO_REPRO` logcat lines, verifies AudioFlinger standby for `af_standby` waits,
   snapshots `dumpsys`/`tinymix` at block boundaries, records audio, pulls the device run
   directory, and writes `run.json`. `--probe` adds the read-only `/proc/asound` probe
   (instrumentation level L1); confirm reproduction rates at L0.

   Control an active run with `python3 run.py control --transport-id 3 pause|resume|abort|status`.

4. **Analyze.**

   ```bash
   python3 analyze.py run runs/<run>
   python3 analyze.py calibrate runs/<run> --cells "off|cold" --out thresholds.json
   python3 analyze.py run runs/<run> --thresholds thresholds.json
   ```

5. **Label blind, then confirm.**

   ```bash
   python3 label.py export runs/<run>   # fill in labels/labels.csv without opening key.json
   python3 label.py import runs/<run>
   ```

   A cue is `confirmed` only when the detectors flagged it and the listener heard low pitch or
   pops. `label-agreement.json` reports detector sensitivity and specificity.

## Sequences

Schema `mentra.audio-repro.sequence/1`. Each operation has an ID and runs once, `delay_ms >= 0`
after its anchor event `<producer>.<event>`, where the producer is `trial` (`trial.start`) or
another operation. To place A before B, anchor B on an event of A.

| Operation | Events it produces |
|---|---|
| `cue` | `exec`, `player_request`, `bridge_open_req` or `bridge_reused` (reason `ready`, `pending`, `external`), `uart_i2s_cmd`, `i2s_ready`, `player_start`, `end` plus `complete`/`stopped`/`cancelled`/`error`, `grace_begin`, `bridge_close` |
| `capture_start` | `exec`, `created`, `start_returned`, `first_frames`, `stop_returned`, `released` |
| `capture_stop` | `exec` (events are reported under the capture's ID) |
| `wait_state` | `satisfied` (`bridge_closed` from trace events; `af_standby` verified by the host) |
| `bes_log_pull` | `exec`, `done` |
| `mark`, `end` | `exec` |

Bridge-session events go to every cue that opened or reused that session, once per event name
and only if they occurred after the cue joined. Prefer anchors that exist on every path
(`player_request`, `player_start`, `complete`, `bridge_close`). A missing anchor cancels its
dependents, marks the trial `anchor_timeout`, and cleanup always runs. Execution later than 5 ms
marks the trial `schedule_miss`; analysis uses measured offsets, not requested delays.

## Outputs

- `runs/<run>/device/events.jsonl`: raw trace, scheduler events, execution records
  (`target_ns`, `post_ns`, `begin_ns`, `end_ns`), anomalies, capture timestamp samples (labeled
  HAL-derived), and AudioManager recording/playback configurations.
- `runs/<run>/device/bes/`: BES trace pulled in the idle gap after each trial.
- `runs/<run>/analysis/`: `cues.jsonl`, `summary.md` (per-cell counts with Wilson 95% intervals),
  and `evidence/<trial>-<op>/` with a ±5 s clip, events, logcat slice and BES delta for every
  suspect.

## Tests

```bash
python3 -m unittest discover -s tests -t .
```

Detector tests inject synthetic faults (rate mismatch, overflow drops, clicks, missing and
repeated segments) and check that level, EQ and clipping are not reported as pitch changes. The
pipeline test runs analysis and blinded labeling end to end on a simulated run.
