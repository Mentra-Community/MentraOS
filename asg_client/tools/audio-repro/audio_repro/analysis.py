"""Run analysis: device events + acoustic recording -> per-cue measurements and evidence.

Outcomes are ``normal`` or ``suspect`` here; ``confirmed`` requires listener agreement and is
applied from labels (see label.py). BES overflow lines are indicators correlated by trial, not
proof. Attribution labels are not assigned here.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np

from .detectors import CueMetrics, Reference, Thresholds, analyze_cue, make_reference, rms_envelope
from .wavio import read_wav, resample, write_wav

DEFAULT_CUE = Path(__file__).resolve().parents[3] / "app" / "src" / "main" / "assets" / "recording_start.wav"
OVERFLOW_RE = re.compile(r"\[I2S-PCM\] overflow")
STOP_RE = re.compile(r"\[I2S-PCM\] stop rx=(\d+) played=(\d+) dropped=(\d+) queued=(\d+)")
LOGCAT_TIME_RE = re.compile(r"^\s*(\d+\.\d+)\s")


@dataclass
class Trial:
    trial_id: str
    meta: Dict[str, Any] = field(default_factory=dict)
    start_ns: Optional[int] = None
    end: Dict[str, Any] = field(default_factory=dict)
    events: Dict[str, Tuple[int, Dict[str, Any]]] = field(default_factory=dict)
    execs: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    anomalies: List[Dict[str, Any]] = field(default_factory=list)
    lines: List[Dict[str, Any]] = field(default_factory=list)


def wilson(successes: int, n: int, z: float = 1.96) -> Tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def load_events(path: Path) -> Dict[str, Trial]:
    trials: Dict[str, Trial] = {}
    if not path.exists():
        return trials
    for raw in path.read_text().splitlines():
        if not raw.strip():
            continue
        line = json.loads(raw)
        trial_id = line.get("trial")
        if not trial_id:
            continue
        trial = trials.setdefault(trial_id, Trial(trial_id))
        trial.lines.append(line)
        kind = line.get("k")
        if kind == "trial_meta":
            trial.meta = line
        elif kind == "trial_start":
            trial.start_ns = line["ns"]
        elif kind == "trial_end":
            trial.end = line
        elif kind == "event":
            trial.events.setdefault(line["key"], (line["ns"], line.get("f") or {}))
        elif kind == "exec":
            trial.execs.setdefault(line["op"], line)
        elif kind == "anomaly":
            trial.anomalies.append(line)
    return trials


def host_minus_device_ns(sync_path: Path) -> Optional[int]:
    """Low-percentile (host receive - device emit) over harness lines carrying mono_ns."""
    if not sync_path.exists():
        return None
    deltas = []
    for raw in sync_path.read_text().splitlines():
        entry = json.loads(raw)
        mono = entry.get("fields", {}).get("mono_ns")
        if mono and mono.isdigit():
            deltas.append(entry["host_ns"] - int(mono))
    if not deltas:
        return None
    return int(np.percentile(deltas, 5))


def theil_sen(x: np.ndarray, y: np.ndarray) -> Tuple[float, float]:
    if len(x) < 2:
        return (float(np.median(y)) if len(y) else 0.0), 0.0
    if len(x) > 400:
        index = np.linspace(0, len(x) - 1, 400).astype(int)
        x, y = x[index], y[index]
    i, j = np.triu_indices(len(x), 1)
    dx = x[j] - x[i]
    ok = np.abs(dx) > 1e-6
    slope = float(np.median((y[j] - y[i])[ok] / dx[ok])) if ok.any() else 0.0
    intercept = float(np.median(y - slope * x))
    return intercept, slope


def locate(recording: np.ndarray, rate: int, ref: Reference, center_s: float, before_s: float, after_s: float):
    """Best match of the reference envelope near ``center_s``: (onset_s, correlation)."""
    start = max(0, int((center_s - before_s) * rate))
    stop = min(len(recording), int((center_s + after_s) * rate))
    if stop - start < int(0.1 * rate):
        return None, 0.0
    env = rms_envelope(recording[start:stop], rate, 0.005, 0.001)
    template = ref.envelope[: int((ref.offset_s - ref.onset_s) * 1000) + 1]
    if len(env) <= len(template) or len(template) < 20:
        return None, 0.0
    windows = np.lib.stride_tricks.sliding_window_view(env, len(template))
    t_norm = template / (np.linalg.norm(template) + 1e-20)
    norms = np.linalg.norm(windows, axis=1) + 1e-20
    scores = windows @ t_norm / norms
    best = int(np.argmax(scores))
    return start / rate + best * 0.001, float(scores[best])


def bes_indicators(run_dir: Path, trial_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """Per-trial BES trace lines that are new relative to the previous pull."""
    out: Dict[str, Dict[str, Any]] = {}
    previous: set = set()
    for trial_id in trial_ids:
        files = sorted((run_dir / "device" / "bes").glob(f"{trial_id}-*.txt"))
        if not files:
            continue
        lines = files[-1].read_text(errors="replace").splitlines()
        new = [line for line in lines if line not in previous]
        previous = set(lines)
        stops = [tuple(int(v) for v in m.groups()) for m in (STOP_RE.search(line) for line in new) if m]
        out[trial_id] = {
            "file": str(files[-1].relative_to(run_dir)),
            "new_lines": len(new),
            "overflow_lines": sum(1 for line in new if OVERFLOW_RE.search(line)),
            "stop_summaries": [dict(zip(("rx", "played", "dropped", "queued"), s)) for s in stops],
            "delta": new,
        }
    return out


def cue_record(trial: Trial, op_id: str, sequence_trial: Dict[str, Any]) -> Dict[str, Any]:
    ev = trial.events

    def ns(name: str) -> Optional[int]:
        item = ev.get(f"{op_id}.{name}")
        return item[0] if item else None

    if f"{op_id}.bridge_open_req" in ev:
        bridge = "open"
    elif f"{op_id}.bridge_reused" in ev:
        bridge = "reused:" + str(ev[f"{op_id}.bridge_reused"][1].get("reason"))
    else:
        bridge = "none"
    end = ev.get(f"{op_id}.end")
    record: Dict[str, Any] = {
        "trial": trial.trial_id,
        "op": op_id,
        "block": trial.meta.get("block", sequence_trial.get("block")),
        "cell": trial.meta.get("cell", sequence_trial.get("cell")),
        "target": op_id in sequence_trial.get("target", []),
        "bridge": bridge,
        "expected_bridge": sequence_trial.get("expect", {}).get(op_id),
        "end_reason": end[1].get("reason") if end else None,
        "ns": {name: ns(name) for name in ("exec", "player_request", "uart_i2s_cmd", "i2s_ready", "player_start", "end", "bridge_close")},
        "outcome_trial": trial.end.get("outcome"),
        "flags_trial": trial.end.get("flags", []),
    }
    record["bridge_mismatch"] = bool(record["expected_bridge"] and record["expected_bridge"] != bridge)
    start = record["ns"]["player_start"]
    capture_ids = {item["id"] for item in sequence_trial.get("ops", []) if item.get("op") == "capture_start"}
    captures: Dict[str, Dict[str, Any]] = {}
    for key, (value, _) in ev.items():
        producer, _, name = key.partition(".")
        if producer in capture_ids and name in ("created", "start_returned", "first_frames", "stop_returned", "released", "read_error"):
            captures.setdefault(producer, {})[name] = value
    for capture_id, times in captures.items():
        if start is not None:
            times["offset_ms_vs_player_start"] = {k: round((v - start) / 1e6, 2) for k, v in times.items() if isinstance(v, int)}
    record["captures"] = captures
    return record


def analyze_run(run_dir: Path, cue_path: Path = DEFAULT_CUE, thresholds: Optional[Thresholds] = None,
                clip_seconds: float = 5.0) -> Dict[str, Any]:
    thresholds = thresholds or Thresholds()
    run = json.loads((run_dir / "run.json").read_text())
    sequence = json.loads((run_dir / "sequence.json").read_text())
    seq_trials = {t["id"]: t for t in sequence["trials"]}
    trials = load_events(run_dir / "device" / "events.jsonl")
    offset = host_minus_device_ns(run_dir / "host_sync.jsonl")
    recording_path = run_dir / "recording.wav"
    analysis_dir = run_dir / "analysis"
    analysis_dir.mkdir(exist_ok=True)

    recording, rate = (read_wav(recording_path) if recording_path.exists() else (None, 48000))
    ref_samples, ref_rate = read_wav(cue_path)
    ref = make_reference(resample(ref_samples, ref_rate, rate), rate)
    rec_start = run.get("acoustic", {}).get("host_start_after_ns")

    records: List[Dict[str, Any]] = []
    ordered = [t for t in sequence["trials"] if t["id"] in trials]
    for seq_trial in ordered:
        trial = trials[seq_trial["id"]]
        for op in seq_trial["ops"]:
            if op["op"] == "cue":
                records.append(cue_record(trial, op["id"], seq_trial))

    def rec_time(device_ns: Optional[int]) -> Optional[float]:
        if device_ns is None or offset is None or rec_start is None:
            return None
        return (device_ns + offset - rec_start) / 1e9

    if recording is not None:
        pairs = []
        for record in records:
            expected = rec_time(record["ns"]["player_start"])
            if expected is None or record["end_reason"] != "complete":
                continue
            found, score = locate(recording, rate, ref, expected, 0.5, 1.5)
            record["coarse"] = {"expected_s": expected, "found_s": found, "score": score}
            if found is not None and score >= 0.8:
                pairs.append((expected, found - expected))
        intercept, slope = theil_sen(np.array([p[0] for p in pairs]), np.array([p[1] for p in pairs])) if pairs else (0.0, 0.0)
        mapping = {"intercept_s": intercept, "slope": slope, "pairs": len(pairs)}
        predicted_all = []
        for record in records:
            expected = rec_time(record["ns"]["player_start"])
            record["predicted_s"] = None if expected is None else expected + intercept + slope * expected
            predicted_all.append(record["predicted_s"])
        for index, record in enumerate(records):
            predicted = record["predicted_s"]
            if predicted is None:
                record["metrics"] = None
                record["outcome"] = (
                    "not_evaluated:" + str(record["end_reason"]) if record["end_reason"] != "complete" else "unmapped"
                )
                continue
            later = [p for p in predicted_all[index + 1:] if p is not None and p > predicted]
            window_end = predicted + (ref.offset_s - ref.onset_s) * 1.5 + 0.4
            if later:
                window_end = min(window_end, later[0] - 0.05)
            start = max(0, int((predicted - 0.25) * rate))
            segment = recording[start:int(window_end * rate)]
            metrics: CueMetrics = analyze_cue(segment, rate, ref, thresholds)
            record["metrics"] = metrics.to_dict()
            if metrics.found:
                onset = start / rate + metrics.onset_s
                record["onset_s"] = onset
                record["latency_residual_ms"] = round((onset - predicted) * 1000, 2)
            if record["end_reason"] != "complete":
                record["outcome"] = "not_evaluated:" + str(record["end_reason"])
            else:
                record["outcome"] = "suspect" if metrics.symptoms else "normal"
    else:
        mapping = {"error": "no recording"}
        for record in records:
            record["metrics"] = None
            record["outcome"] = "no_audio"

    indicators = bes_indicators(run_dir, [t["id"] for t in ordered])
    for record in records:
        info = indicators.get(record["trial"])
        record["bes"] = None if not info else {k: v for k, v in info.items() if k != "delta"}
        if info and info["overflow_lines"] and record["outcome"] == "normal":
            record["indicator_only"] = True

    for record in records:
        if record.get("outcome") == "suspect" or record.get("indicator_only"):
            write_evidence(run_dir, analysis_dir, record, trials[record["trial"]], recording, rate, indicators, clip_seconds)

    with (analysis_dir / "cues.jsonl").open("w") as handle:
        for record in records:
            handle.write(json.dumps(record, default=_json_default) + "\n")
    summary = summarize(records, trials)
    summary["clock_mapping"] = mapping
    summary["host_minus_device_ns"] = offset
    summary["thresholds"] = thresholds.__dict__
    (analysis_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=_json_default))
    (analysis_dir / "summary.md").write_text(render_summary(summary))
    return summary


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(type(value))


def write_evidence(run_dir: Path, analysis_dir: Path, record: Dict[str, Any], trial: Trial,
                   recording: Optional[np.ndarray], rate: int, indicators: Dict[str, Dict[str, Any]],
                   clip_seconds: float) -> None:
    folder = analysis_dir / "evidence" / f"{record['trial']}-{record['op']}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "cue.json").write_text(json.dumps(record, indent=2, default=_json_default))
    with (folder / "events.jsonl").open("w") as handle:
        for line in trial.lines:
            handle.write(json.dumps(line) + "\n")
    center = record.get("onset_s") or record.get("predicted_s")
    if recording is not None and center is not None:
        start = max(0, int((center - clip_seconds) * rate))
        write_wav(folder / "clip.wav", recording[start:int((center + clip_seconds) * rate)], rate)
    info = indicators.get(record["trial"])
    if info:
        (folder / "bes-delta.txt").write_text("\n".join(info["delta"]) + "\n")
    logcat = run_dir / "logcat.txt"
    if logcat.exists() and trial.start_ns and trial.end.get("ns"):
        lo = trial.start_ns / 1e9 - clip_seconds
        hi = trial.end["ns"] / 1e9 + clip_seconds
        kept = []
        with logcat.open(errors="replace") as handle:
            for line in handle:
                match = LOGCAT_TIME_RE.match(line)
                if match and lo <= float(match.group(1)) <= hi:
                    kept.append(line)
        (folder / "logcat.txt").write_text("".join(kept))


def summarize(records: List[Dict[str, Any]], trials: Dict[str, Trial]) -> Dict[str, Any]:
    cells: Dict[str, Dict[str, Any]] = {}
    for record in records:
        if not record["target"]:
            continue
        cell = cells.setdefault(record["cell"], {"n": 0, "suspect": 0, "confirmed": 0, "not_evaluated": 0,
                                                  "bridge_mismatch": 0, "indicator_only": 0, "symptoms": {}})
        outcome = record.get("outcome", "")
        if outcome in ("normal", "suspect", "confirmed"):
            cell["n"] += 1
        else:
            cell["not_evaluated"] += 1
        if outcome in ("suspect", "confirmed"):
            cell["suspect"] += 1
        if record.get("label_confirmed"):
            cell["confirmed"] += 1
        if record["bridge_mismatch"]:
            cell["bridge_mismatch"] += 1
        if record.get("indicator_only"):
            cell["indicator_only"] += 1
        for symptom in (record.get("metrics") or {}).get("symptoms", []) or []:
            cell["symptoms"][symptom] = cell["symptoms"].get(symptom, 0) + 1
    for cell in cells.values():
        cell["suspect_ci95"] = wilson(cell["suspect"], cell["n"])
        cell["confirmed_ci95"] = wilson(cell["confirmed"], cell["n"])
    outcomes: Dict[str, int] = {}
    flags: Dict[str, int] = {}
    for trial in trials.values():
        outcomes[trial.end.get("outcome", "unfinished")] = outcomes.get(trial.end.get("outcome", "unfinished"), 0) + 1
        for flag in trial.end.get("flags", []):
            flags[flag] = flags.get(flag, 0) + 1
    return {"cells": cells, "trial_outcomes": outcomes, "trial_flags": flags, "cues": len(records)}


def render_summary(summary: Dict[str, Any]) -> str:
    lines = [
        "# Audio repro summary",
        "",
        "Target cues per cell. `suspect` means a detector or indicator fired; `confirmed` requires listener agreement.",
        "",
        "| cell | n | suspect | suspect 95% CI | confirmed | confirmed 95% CI | bridge mismatch | not evaluated | symptoms |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for name, cell in sorted(summary["cells"].items()):
        s_lo, s_hi = cell["suspect_ci95"]
        c_lo, c_hi = cell["confirmed_ci95"]
        symptoms = ", ".join(f"{k}:{v}" for k, v in sorted(cell["symptoms"].items())) or "-"
        lines.append(
            f"| {name} | {cell['n']} | {cell['suspect']} | {s_lo:.3f}-{s_hi:.3f} | {cell['confirmed']} | "
            f"{c_lo:.3f}-{c_hi:.3f} | {cell['bridge_mismatch']} | {cell['not_evaluated']} | {symptoms} |"
        )
    lines += ["", f"Trial outcomes: {summary['trial_outcomes']}", f"Trial flags: {summary['trial_flags']}", ""]
    return "\n".join(lines)


def scan_stage0(run_dir: Path, cue_path: Path = DEFAULT_CUE, thresholds: Optional[Thresholds] = None,
                window_s: float = 15.0, min_score: float = 0.8) -> Dict[str, Any]:
    """Stage 0: find the start cue after each host flow start and measure it."""
    thresholds = thresholds or Thresholds()
    run = json.loads((run_dir / "run.json").read_text())
    recording, rate = read_wav(run_dir / "recording.wav")
    ref_samples, ref_rate = read_wav(cue_path)
    ref = make_reference(resample(ref_samples, ref_rate, rate), rate)
    rec_start = run["acoustic"]["host_start_after_ns"]
    records = []
    for raw in (run_dir / "host_events.jsonl").read_text().splitlines():
        event = json.loads(raw)
        if event["kind"] != "flow_start":
            continue
        t0 = (event["host_ns"] - rec_start) / 1e9
        found, score = locate(recording, rate, ref, t0, 0.0, window_s)
        record: Dict[str, Any] = {"index": event["index"], "flow_start_s": t0, "found_s": found, "score": score}
        if found is not None and score >= min_score:
            start = max(0, int((found - 0.25) * rate))
            metrics = analyze_cue(recording[start:int((found + 1.2) * rate)], rate, ref, thresholds)
            record["metrics"] = metrics.to_dict()
            record["outcome"] = "suspect" if metrics.symptoms else "normal"
        else:
            record["outcome"] = "cue_not_found"
        records.append(record)
    analysis_dir = run_dir / "analysis"
    analysis_dir.mkdir(exist_ok=True)
    with (analysis_dir / "stage0.jsonl").open("w") as handle:
        for record in records:
            handle.write(json.dumps(record, default=_json_default) + "\n")
    evaluated = [r for r in records if r["outcome"] in ("normal", "suspect")]
    suspects = sum(1 for r in evaluated if r["outcome"] == "suspect")
    summary = {"flows": len(records), "evaluated": len(evaluated), "suspect": suspects,
               "suspect_ci95": wilson(suspects, len(evaluated)),
               "not_found": sum(1 for r in records if r["outcome"] == "cue_not_found")}
    (analysis_dir / "stage0-summary.json").write_text(json.dumps(summary, indent=2))
    return summary
