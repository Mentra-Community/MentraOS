"""Seeded generation of concrete, replayable sequences from a matrix.

All randomness is drawn from one ``random.Random(seed)`` on the host, in a fixed order, so the
same matrix, seed, block selection and generator version produce byte-identical output. The
device never randomizes anything.
"""

from __future__ import annotations

import math
import random
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .sequence import SCHEMA, canonical_bytes, cleanup, op, sha256, validate_sequence

GENERATOR_VERSION = "1"
CUE_ASSET = "recording_start.wav"


def _git_sha(path: Path) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _cue(op_id: str, anchor: str, delay_ms: int = 0) -> Dict[str, Any]:
    return op(op_id, "cue", anchor, delay_ms, asset=CUE_ASSET)


def _prelude(bridge: str, standby_timeout_ms: int) -> Dict[str, Any]:
    """Cold trials wait for a host-verified AudioFlinger standby; others for a closed bridge."""
    if bridge == "cold":
        return op("w0", "wait_state", "trial.start", 0, state="af_standby", timeout_ms=standby_timeout_ms)
    return op("w0", "wait_state", "trial.start", 0, state="bridge_closed")


def _finish(ops: List[Dict[str, Any]], last_cue: str, settings: Dict[str, Any]) -> None:
    """End after the last cue's bridge closes, optionally pulling BES logs in that idle gap."""
    end_delay = int(settings.get("end_after_close_ms", 300))
    if settings.get("bes_log_pull", True):
        ops.append(op("b1", "bes_log_pull", f"{last_cue}.bridge_close", 100))
        end_delay = max(end_delay, int(settings.get("bes_log_settle_ms", 3000)))
    ops.append(op("e1", "end", f"{last_cue}.bridge_close", end_delay))


def _trial(
    trial_id: str,
    block: str,
    cell: str,
    ops: List[Dict[str, Any]],
    expect: Dict[str, str],
    target: Sequence[str],
    rng: random.Random,
    settings: Dict[str, Any],
    cleanup_ops: Optional[List[Dict[str, Any]]] = None,
    max_ms: Optional[int] = None,
) -> Dict[str, Any]:
    jitter = settings.get("pre_delay_ms", [700, 1700])
    trial: Dict[str, Any] = {
        "id": trial_id,
        "block": block,
        "cell": cell,
        "class": "supported",
        "reset": "R0",
        "pre_delay_ms": rng.randint(int(jitter[0]), int(jitter[1])),
        "expect": expect,
        "target": list(target),
        "ops": ops,
    }
    if cleanup_ops:
        trial["cleanup"] = cleanup_ops
    if max_ms:
        trial["max_ms"] = int(max_ms)
    return trial


def block_a_trial(condition: str, trial_id: str, block: str, rng: random.Random, settings: Dict[str, Any]) -> Dict[str, Any]:
    standby = int(settings.get("standby_timeout_ms", 30000))
    if condition == "cold":
        ops = [_prelude("cold", standby), _cue("q0", "w0.satisfied")]
        _finish(ops, "q0", settings)
        return _trial(trial_id, block, "off|cold", ops, {"q0": "open"}, ["q0"], rng, settings)
    ops = [_prelude("warm", standby), _cue("q0", "w0.satisfied")]
    if condition == "reopen":
        ops.append(_cue("q1", "q0.bridge_close", int(settings.get("reopen_delay_ms", 100))))
        expect = {"q0": "open", "q1": "open"}
    elif condition == "reuse":
        ops.append(_cue("q1", "q0.complete", int(settings.get("reuse_delay_ms", 300))))
        expect = {"q0": "open", "q1": "reused:ready"}
    elif condition == "join_pending":
        ops.append(_cue("q1", "q0.bridge_open_req", 0))
        expect = {"q0": "open", "q1": "reused:pending"}
    else:
        raise ValueError(f"unknown block A condition {condition}")
    _finish(ops, "q1", settings)
    return _trial(trial_id, block, f"off|{condition}", ops, expect, ["q1"], rng, settings)


def repetition_trials(block: str, spec: Dict[str, Any], rng: random.Random, settings: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Consecutive production cues with seeded gaps; short gaps exercise the replace path.

    Each cue is anchored on the previous cue's ``player_request``, which occurs on every path
    (including a replaced player that never started), so the chain cannot stall.
    """
    total = int(spec.get("cues", 100))
    chunk = int(spec.get("chunk", 25))
    low, high = spec.get("gap_ms", [0, 5000])
    trials = []
    index = 0
    for chunk_index in range(math.ceil(total / chunk)):
        count = min(chunk, total - index)
        ops = [_prelude("warm", 0), _cue("q0", "w0.satisfied")]
        gaps = []
        for i in range(1, count):
            gap = rng.randint(int(low), int(high))
            gaps.append(gap)
            ops.append(_cue(f"q{i}", f"q{i - 1}.player_request", gap))
        last = f"q{count - 1}"
        _finish(ops, last, settings)
        trial_id = f"{block}-{chunk_index + 1:03d}"
        max_ms = sum(gaps) + 30000
        trials.append(
            _trial(
                trial_id,
                block,
                "off|repetition",
                ops,
                {"q0": "open"},
                [f"q{i}" for i in range(count)],
                rng,
                settings,
                max_ms=max_ms,
            )
        )
        index += count
    return trials


def _capture_op(capture: Dict[str, Any], anchor: str, delay_ms: int) -> Dict[str, Any]:
    return op(
        "c1",
        "capture_start",
        anchor,
        delay_ms,
        source=capture["source"],
        rate=int(capture.get("rate", 48000)),
        ch=int(capture.get("ch", 1)),
    )


def block_b_trial(
    capture: Optional[Dict[str, Any]],
    transition: str,
    delay: int,
    bridge: str,
    trial_id: str,
    block: str,
    rng: random.Random,
    settings: Dict[str, Any],
) -> Dict[str, Any]:
    standby = int(settings.get("standby_timeout_ms", 30000))
    reuse_delay = int(settings.get("reuse_delay_ms", 300))
    stop_after = int(settings.get("capture_stop_after_complete_ms", 500))
    ops: List[Dict[str, Any]] = [_prelude(bridge, standby)]
    start = "w0.satisfied"
    expect = {"q1": "open" if bridge == "cold" else "reused:ready"}
    if bridge == "reuse":
        expect["q0"] = "open"

    if capture is None:
        if bridge == "cold":
            ops.append(_cue("q1", start))
        else:
            ops += [_cue("q0", start), _cue("q1", "q0.complete", reuse_delay)]
        _finish(ops, "q1", settings)
        return _trial(trial_id, block, f"off|control|{bridge}", ops, expect, ["q1"], rng, settings)

    stop = op("s1", "capture_stop", "q1.complete", stop_after, capture="c1")
    if transition == "steady":
        if bridge == "cold":
            ops += [_capture_op(capture, start, 0), _cue("q1", "c1.first_frames", 2000)]
        else:
            ops += [
                _capture_op(capture, start, 0),
                _cue("q0", "c1.first_frames", 1500),
                _cue("q1", "q0.complete", reuse_delay),
            ]
    elif transition == "start_before":
        if bridge == "cold":
            ops += [_capture_op(capture, start, 0), _cue("q1", "c1.start_returned", delay)]
        else:
            ops += [
                _cue("q0", start),
                _capture_op(capture, "q0.complete", max(0, reuse_delay - delay)),
                _cue("q1", "c1.start_returned", delay),
            ]
    elif transition == "start_during":
        if bridge == "cold":
            ops += [_cue("q1", start)]
        else:
            ops += [_cue("q0", start), _cue("q1", "q0.complete", reuse_delay)]
        ops.append(_capture_op(capture, "q1.player_start", delay))
    elif transition == "stop_during":
        if bridge == "cold":
            ops += [_capture_op(capture, start, 0), _cue("q1", "c1.first_frames", 1000)]
        else:
            ops += [
                _capture_op(capture, start, 0),
                _cue("q0", "c1.first_frames", 500),
                _cue("q1", "q0.complete", reuse_delay),
            ]
        stop = op("s1", "capture_stop", "q1.player_start", delay, capture="c1")
    else:
        raise ValueError(f"unknown transition {transition}")
    ops.append(stop)
    _finish(ops, "q1", settings)
    label = transition if transition == "steady" else f"{transition}+{delay}"
    cell = f"{capture['source']}|{label}|{bridge}"
    return _trial(
        trial_id,
        block,
        cell,
        ops,
        expect,
        ["q1"],
        rng,
        settings,
        cleanup_ops=[cleanup("capture_stop", capture="c1")],
    )


def _block_b_cells(spec: Dict[str, Any]) -> List[tuple]:
    cells = []
    for capture in spec["captures"]:
        for transition, delays in spec["transitions"].items():
            for delay in delays or [0]:
                for bridge in spec["bridge"]:
                    cells.append((capture, transition, int(delay), bridge))
    return cells


def generate(
    matrix: Dict[str, Any],
    seed: int,
    blocks: Optional[Sequence[str]] = None,
    reps_scale: float = 1.0,
    run_id: Optional[str] = None,
    matrix_sha: str = "",
    git_sha: Optional[str] = None,
) -> Dict[str, Any]:
    rng = random.Random(seed)
    settings = dict(matrix.get("settings", {}))
    selected = list(blocks) if blocks else [b["id"] for b in matrix["blocks"]]
    trials: List[Dict[str, Any]] = []
    for spec in matrix["blocks"]:
        block = spec["id"]
        if block not in selected:
            continue
        kind = spec["type"]
        reps = max(1, int(round(int(spec.get("reps", 1)) * reps_scale)))
        if kind == "conditions":
            counter = 0
            for _ in range(reps):
                round_conditions = list(spec["conditions"])
                rng.shuffle(round_conditions)
                for condition in round_conditions:
                    counter += 1
                    trials.append(block_a_trial(condition, f"{block}-{counter:04d}", block, rng, settings))
        elif kind == "repetition":
            trials.extend(repetition_trials(block, spec, rng, settings))
        elif kind == "capture_transitions":
            cells = _block_b_cells(spec)
            control_every = max(1, int(spec.get("control_every", 4)))
            controls_per_bridge = max(1, math.ceil(len(cells) / control_every / len(spec["bridge"])))
            counter = 0
            for _ in range(reps):
                round_cells: List[tuple] = list(cells)
                for bridge in spec["bridge"]:
                    round_cells += [(None, "control", 0, bridge)] * controls_per_bridge
                rng.shuffle(round_cells)
                for capture, transition, delay, bridge in round_cells:
                    counter += 1
                    trials.append(
                        block_b_trial(capture, transition, delay, bridge, f"{block}-{counter:04d}", block, rng, settings)
                    )
        else:
            raise ValueError(f"unknown block type {kind}")

    boundary_delay = int(settings.get("block_boundary_pre_delay_ms", 4000))
    for previous, trial in zip(trials, trials[1:]):
        if trial["block"] != previous["block"]:
            trial["pre_delay_ms"] = max(trial["pre_delay_ms"], boundary_delay)

    name = matrix.get("name", "matrix")
    sequence = {
        "schema": SCHEMA,
        "run_id": run_id or f"{name}-s{seed}",
        "seed": seed,
        "generator": {
            "name": "gen.py",
            "version": GENERATOR_VERSION,
            "git": git_sha if git_sha is not None else _git_sha(Path(__file__).resolve().parent),
            "matrix": name,
            "matrix_sha256": matrix_sha,
            "blocks": selected,
            "reps_scale": reps_scale,
        },
        "defaults": dict(matrix.get("defaults", {})),
        "trials": trials,
    }
    errors = validate_sequence(sequence)
    if errors:
        raise ValueError("generated sequence is invalid:\n" + "\n".join(errors))
    return sequence


def write(sequence: Dict[str, Any], path: Path) -> str:
    data = canonical_bytes(sequence)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return sha256(data)
