#!/usr/bin/env python3
"""Glasses identity for the pairing matrix: one source for name, code and MAC.

Nothing in the harness may hardcode a glasses name, code or MAC. Values come from
the environment or from the run's run.json (written by the coordinator after
reading unit3):

    PMX_GLASSES_NAME / PMX_GLASSES_CODE / PMX_GLASSES_MAC       (env, wins)
    runs/<run>/run.json  keys glasses_name, glasses_code, glasses_mac

The run directory is PMX_RUN (default "x2") under PMX_RUNS_DIR (default: the
runs/ dir next to this file; a harness snapshot sets PMX_RUNS_DIR so it still
reads the live run.json).

Optional lane (opt-in, off by default): PMX_LANE=unit2 (run_case.py --lane unit2) points everything at a second
glasses unit. The lane's run dir is runs/<run>/lanes/<lane>/ and holds its OWN run.json, active.pid and results.jsonl;
identity then comes only from that run.json (or PMX_<LANE>_GLASSES_NAME/CODE/MAC), never from the unit3 run.json or
the generic PMX_GLASSES_* variables. With no lane everything below is exactly the unit3 behaviour.

Formats derived from the one identity:
    name       Mentra_Live_02BE
    code       02BE
    mac        CC:E7:DE:E0:02:BE        (Android / BLE address form)
    mac_dash   cc-e7-de-e0-02-be        (blueutil / Mac form)
    hfp_flag   /tmp/sim-hfp-02BE        (simulator HFP flag file)

Fails closed: asking for a value that is not configured raises IdentityMissing.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_KEYS = {
    "name": "PMX_GLASSES_NAME",
    "code": "PMX_GLASSES_CODE",
    "mac": "PMX_GLASSES_MAC",
}
JSON_KEYS = {
    "name": "glasses_name",
    "code": "glasses_code",
    "mac": "glasses_mac",
}


class IdentityMissing(RuntimeError):
    """The glasses identity is not configured; refuse to run device commands."""


def runs_dir() -> Path:
    return Path(os.environ.get("PMX_RUNS_DIR") or (HERE / "runs"))


LANES = ("unit2",)  # opt-in lanes; unit3 is the default and has no lane name


class LaneError(RuntimeError):
    """PMX_LANE / --lane named a lane the harness does not know."""


def lane_of(env: dict | None = None) -> str:
    """The active lane ('' = the default unit3 path). 'unit3' is accepted as an alias for the default."""
    env = os.environ if env is None else env
    raw = (env.get("PMX_LANE") or "").strip().lower()
    if raw in ("", "unit3"):
        return ""
    if raw not in LANES:
        raise LaneError(f"unknown lane {raw!r}: use one of {LANES} (or leave PMX_LANE unset for unit3)")
    return raw


def lane() -> str:
    return lane_of()


def lane_run_name(run: str, lane_name: str) -> str:
    """runs/<run>/lanes/<lane>: idempotent, so a child that already got the lane path does not nest it."""
    if not lane_name:
        return run
    suffix = f"lanes/{lane_name}"
    return run if run == suffix or run.endswith("/" + suffix) else f"{run}/{suffix}"


def base_run_name() -> str:
    """The run name without any lane suffix (the unit3 run that owns snapshots)."""
    run = os.environ.get("PMX_RUN", "x2")
    return re.sub(r"/lanes/[^/]+$", "", run)


def run_name() -> str:
    return lane_run_name(os.environ.get("PMX_RUN", "x2"), lane())


def run_json_path() -> Path:
    return runs_dir() / run_name() / "run.json"


def normalize_mac(raw: str) -> str:
    """Accept any of aa:bb:.., AA-BB-.., aabbcc.. and return AA:BB:CC:DD:EE:FF."""
    digits = re.sub(r"[^0-9A-Fa-f]", "", raw or "")
    if len(digits) != 12:
        raise IdentityMissing(f"glasses MAC is not 6 bytes: {raw!r}")
    return ":".join(digits[i : i + 2] for i in range(0, 12, 2)).upper()


def code_from_name(name: str) -> str | None:
    m = re.search(r"_([0-9A-Fa-f]{4})$", name or "")
    return m.group(1).upper() if m else None


@dataclass(frozen=True)
class Identity:
    name: str
    code: str
    mac: str  # may be "" when only name/code are known

    @property
    def mac_colon(self) -> str:
        if not self.mac:
            raise IdentityMissing("glasses MAC is not configured (PMX_GLASSES_MAC / run.json glasses_mac)")
        return normalize_mac(self.mac)

    @property
    def mac_dash(self) -> str:
        return self.mac_colon.lower().replace(":", "-")

    @property
    def hfp_flag(self) -> str:
        return f"/tmp/sim-hfp-{self.code}"


_cache: Identity | None = None


def _read_run_json() -> dict:
    path = run_json_path()
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def env_key(key: str, lane_name: str = "") -> str:
    """Env var for one identity field: PMX_GLASSES_* by default, PMX_<LANE>_GLASSES_* in a lane."""
    base = ENV_KEYS[key]
    return base.replace("PMX_", f"PMX_{lane_name.upper()}_", 1) if lane_name else base


def build(env: dict | None = None, run_json: dict | None = None) -> Identity:
    env = os.environ if env is None else env
    data = _read_run_json() if run_json is None else run_json
    lane_name = lane_of(env)

    def pick(key: str) -> str:
        return (env.get(env_key(key, lane_name)) or data.get(JSON_KEYS[key]) or "").strip()

    name, code, mac = pick("name"), pick("code"), pick("mac")
    if not code and name:
        code = code_from_name(name) or ""
    if not name and code:
        name = f"Mentra_Live_{code.upper()}"
    if not name or not code:
        raise IdentityMissing(
            "glasses identity not configured: set PMX_GLASSES_NAME/PMX_GLASSES_CODE/PMX_GLASSES_MAC or add "
            f"glasses_name / glasses_code / glasses_mac to {run_json_path()}"
        )
    return Identity(name=name, code=code.upper(), mac=normalize_mac(mac) if mac else "")


def get() -> Identity:
    global _cache
    if _cache is None:
        _cache = build()
    return _cache


def reset() -> None:
    """Drop the cached identity (tests, or after run.json was rewritten)."""
    global _cache
    _cache = None


def set_for_tests(identity: Identity | None) -> None:
    global _cache
    _cache = identity


# Convenience accessors used throughout the harness.
def name() -> str:
    return get().name


def code() -> str:
    return get().code


def mac() -> str:
    return get().mac_colon


def mac_dash() -> str:
    return get().mac_dash


def hfp_flag() -> str:
    return get().hfp_flag


def is_glasses_name(text: str) -> bool:
    """True when a Bluetooth/UI name belongs to the configured glasses (matches the old `"02BE" in name`)."""
    return code().lower() in (text or "").lower()


def lane_cid() -> str:
    """Expected eMMC cid for the active lane's unit (env PMX_<LANE>_CID, lane run.json glasses_cid / cid); ''."""
    lane_name = lane()
    data = _read_run_json()
    raw = os.environ.get(f"PMX_{lane_name.upper()}_CID") or data.get("glasses_cid") or data.get("cid") or ""
    return str(raw).strip().lower()


def unit3_cid() -> str:
    """Expected eMMC cid for unit3 (env PMX_UNIT3_CID, run.json glasses_cid / unit3_cid / cid); '' when not recorded."""
    data = _read_run_json()
    raw = os.environ.get("PMX_UNIT3_CID") or data.get("glasses_cid") or data.get("unit3_cid") or data.get("cid") or ""
    return str(raw).strip().lower()


if __name__ == "__main__":
    ident = get()
    print(json.dumps({"name": ident.name, "code": ident.code, "mac": ident.mac,
                      "mac_dash": ident.mac_dash if ident.mac else "", "hfp_flag": ident.hfp_flag}, indent=2))
