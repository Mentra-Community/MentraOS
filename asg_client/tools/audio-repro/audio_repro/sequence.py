"""Sequence schema helpers and validation.

The rules mirror ``ReproValidator`` on the device so a generated sequence is rejected on the
host before it is pushed. Keep the two in sync.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, Iterable, List, Optional

SCHEMA = "mentra.audio-repro.sequence/1"
OP_TYPES = {
    "cue",
    "capture_start",
    "capture_stop",
    "wait_state",
    "bes_log_pull",
    "mark",
    "end",
    "stop_playback",
}
SUPPORTED_CAPTURE_SOURCES = {"MIC", "VOICE_COMMUNICATION"}
FAULT_CAPTURE_SOURCES = {"DEFAULT", "CAMCORDER", "VOICE_RECOGNITION"}
WAIT_STATES = {"bridge_closed", "af_standby"}
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def op(op_id: str, op_type: str, anchor: str, delay_ms: int = 0, **params: Any) -> Dict[str, Any]:
    """Build one anchored operation."""
    item: Dict[str, Any] = {"id": op_id, "op": op_type, "at": {"anchor": anchor, "delay_ms": int(delay_ms)}}
    timeout = params.pop("timeout_ms", None)
    if timeout is not None:
        item["timeout_ms"] = int(timeout)
    item.update(params)
    return item


def cleanup(op_type: str, **params: Any) -> Dict[str, Any]:
    item: Dict[str, Any] = {"op": op_type}
    item.update(params)
    return item


def _anchor_parts(anchor: str) -> Optional[tuple]:
    if not isinstance(anchor, str) or "." not in anchor:
        return None
    producer, event = anchor.split(".", 1)
    if not producer or not event:
        return None
    return producer, event


def validate_trial(trial: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    tid = trial.get("id", "")
    if not tid:
        errors.append("trial id is empty")
    ops = trial.get("ops") or []
    if not ops:
        errors.append(f"{tid}: no operations")
    trial_class = trial.get("class", "supported")
    fault = trial_class == "fault_injection"
    if trial_class not in ("supported", "fault_injection"):
        errors.append(f"{tid}: unknown class {trial_class}")

    by_id: Dict[str, Dict[str, Any]] = {}
    for item in ops:
        oid = item.get("id", "")
        if not oid or "." in oid or oid == "trial":
            errors.append(f"{tid}: invalid op id '{oid}'")
            continue
        if oid in by_id:
            errors.append(f"{tid}: duplicate op id {oid}")
        by_id[oid] = item

    ends = 0
    captures = 0
    for item in ops:
        oid = item.get("id", "")
        where = f"{tid}/{oid}: "
        kind = item.get("op")
        if kind not in OP_TYPES:
            errors.append(where + f"unknown op type {kind}")
            continue
        at = item.get("at") or {}
        delay = at.get("delay_ms", 0)
        if not isinstance(delay, int) or delay < 0:
            errors.append(where + "negative delay")
        if item.get("timeout_ms", 0) < 0:
            errors.append(where + "negative timeout")
        parts = _anchor_parts(at.get("anchor", ""))
        if parts is None:
            errors.append(where + f"anchor must be <producer>.<event>, got '{at.get('anchor', '')}'")
        else:
            producer, _ = parts
            if producer == "trial":
                if at.get("anchor") != "trial.start":
                    errors.append(where + "only trial.start is a trial anchor")
            elif producer == oid:
                errors.append(where + "anchored on itself")
            elif producer not in by_id:
                errors.append(where + f"anchor producer {producer} is not an op in this trial")
        if kind == "end":
            ends += 1
        elif kind == "capture_start":
            captures += 1
            source = item.get("source", "")
            if not (source in SUPPORTED_CAPTURE_SOURCES or (fault and source in FAULT_CAPTURE_SOURCES)):
                errors.append(where + f"capture source not allowed: {source}")
            rate = item.get("rate", 48000)
            if not 8000 <= rate <= 48000:
                errors.append(where + f"capture rate out of range: {rate}")
            if item.get("ch", 1) not in (1, 2):
                errors.append(where + "capture ch must be 1 or 2")
        elif kind == "capture_stop":
            target = by_id.get(item.get("capture", ""))
            if not target or target.get("op") != "capture_start":
                errors.append(where + "capture must name a capture_start op")
        elif kind == "wait_state":
            if item.get("state") not in WAIT_STATES:
                errors.append(where + f"unknown wait state {item.get('state')}")
        elif kind == "stop_playback" and not fault:
            errors.append(where + "stop_playback is cleanup-only")
    if ends != 1:
        errors.append(f"{tid}: expected exactly one end op, found {ends}")
    if not fault and captures > 1:
        errors.append(f"{tid}: supported trials allow at most one capture")

    for item in ops:
        seen = set()
        cursor: Optional[Dict[str, Any]] = item
        while cursor is not None:
            if cursor.get("id") in seen:
                errors.append(f"{tid}: anchor cycle through {item.get('id')}")
                break
            seen.add(cursor.get("id"))
            parts = _anchor_parts((cursor.get("at") or {}).get("anchor", ""))
            cursor = by_id.get(parts[0]) if parts else None

    for index, item in enumerate(trial.get("cleanup") or []):
        where = f"{tid}/cleanup{index}: "
        if item.get("op") not in ("capture_stop", "stop_playback"):
            errors.append(where + "cleanup allows only capture_stop and stop_playback")
        if item.get("at"):
            errors.append(where + "cleanup ops run immediately; no anchor")
        if item.get("op") == "capture_stop":
            target = by_id.get(item.get("capture", ""))
            if not target or target.get("op") != "capture_start":
                errors.append(where + "capture must name a capture_start op")
    return errors


def validate_sequence(sequence: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    if sequence.get("schema") != SCHEMA:
        errors.append(f"unsupported schema '{sequence.get('schema')}'")
    if not RUN_ID_RE.match(str(sequence.get("run_id", ""))):
        errors.append("run_id must be 1-64 characters of [A-Za-z0-9._-]")
    trials = sequence.get("trials") or []
    if not trials:
        errors.append("no trials")
    ids = set()
    for trial in trials:
        if trial.get("id") in ids:
            errors.append(f"duplicate trial id {trial.get('id')}")
        ids.add(trial.get("id"))
        errors.extend(validate_trial(trial))
    return errors


def canonical_bytes(sequence: Dict[str, Any]) -> bytes:
    """Stable serialization; the file written to disk is exactly these bytes."""
    return (json.dumps(sequence, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cue_ops(trial: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    return (item for item in trial.get("ops", []) if item.get("op") == "cue")
