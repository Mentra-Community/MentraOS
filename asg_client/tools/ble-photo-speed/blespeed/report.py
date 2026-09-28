"""Load run directories and render the per-cell table, floor, and leg verdicts."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from .results import PhotoRow, ResultsFormatError, read_rows
from .stats import (
    FLOOR_CONDITIONS,
    FLOOR_MARGIN,
    FLOOR_STEP_KBPS,
    CellStats,
    cell_stats,
    leg_verdicts,
    measured_rows,
    speed_floor,
)


@dataclass
class RunData:
    run_dir: Path
    rows: List[PhotoRow]
    provenance: Dict[str, object]


def find_run_dirs(paths: Sequence[Path]) -> List[Path]:
    found: List[Path] = []
    for path in paths:
        if (path / "results.csv").is_file():
            found.append(path)
        elif path.is_dir():
            found.extend(sorted(p.parent for p in path.glob("*/results.csv")))
    return found


def load_runs(paths: Sequence[Path]) -> List[RunData]:
    run_dirs = find_run_dirs(paths)
    if not run_dirs:
        raise ResultsFormatError("no run directories with results.csv under: %s"
                                 % ", ".join(str(p) for p in paths))
    runs = []
    for run_dir in run_dirs:
        provenance: Dict[str, object] = {}
        prov_path = run_dir / "provenance.json"
        if prov_path.is_file():
            try:
                provenance = json.loads(prov_path.read_text())
            except json.JSONDecodeError as e:
                raise ResultsFormatError("%s: invalid JSON: %s" % (prov_path, e)) from e
        runs.append(RunData(run_dir, read_rows(run_dir / "results.csv"), provenance))
    return runs


def _fmt(value: Optional[float], width: int, digits: int = 1) -> str:
    return ("-" if value is None else "%.*f" % (digits, value)).rjust(width)


def _cell_dict(cell: CellStats) -> Dict[str, object]:
    return {
        "phone": cell.phone, "phone_os": cell.phone_os, "condition": cell.condition,
        "size": cell.size, "attempted": cell.attempted, "succeeded": cell.succeeded,
        "failed": cell.failed, "retried": cell.retried,
        "failure_rate": round(cell.failure_rate, 4), "flagged": cell.flagged,
        "e2e_kbps": cell.e2e.as_dict() if cell.e2e else None,
        "uart_kbps": cell.uart.as_dict() if cell.uart else None,
        "drain_ms": cell.drain.as_dict() if cell.drain else None,
        "mean_payload_kb": round(cell.mean_payload_kb, 1) if cell.mean_payload_kb else None,
    }


def build_report(runs: Sequence[RunData], exclude_b: bool = False,
                 margin: float = FLOOR_MARGIN, step: int = FLOOR_STEP_KBPS) -> Dict[str, object]:
    rows = [row for run in runs for row in run.rows]
    cells = cell_stats(rows)
    floor = speed_floor(rows, FLOOR_CONDITIONS, exclude_b=exclude_b, margin=margin, step=step)
    loaded = speed_floor(rows, ("D",), margin=margin, step=step)
    legs = leg_verdicts(measured_rows(rows))
    run_entries = []
    for run in runs:
        transport = run.provenance.get("transport") or {}
        glasses = run.provenance.get("glasses") or {}
        run_entries.append({
            "run_id": run.provenance.get("run_id") or run.run_dir.name,
            "transport": transport.get("session_label", "unknown") if isinstance(transport, dict)
            else "unknown",
            "uart_baud": glasses.get("uart_baud") if isinstance(glasses, dict) else None,
            "aborted": run.provenance.get("aborted"),
            "photos": len(measured_rows(run.rows)),
        })
    return {
        "runs": run_entries,
        "cells": [_cell_dict(c) for c in cells],
        "floor": {
            "floor_kbps": floor.floor_kbps, "limiting_phone": floor.limiting_phone,
            "per_phone_p10_kbps": {k: round(v, 2) for k, v in floor.per_phone_p10.items()},
            "conditions": list(floor.conditions), "margin": margin, "step_kbps": step,
        },
        "loaded_condition_d": {
            "floor_kbps": loaded.floor_kbps, "limiting_phone": loaded.limiting_phone,
            "per_phone_p10_kbps": {k: round(v, 2) for k, v in loaded.per_phone_p10.items()},
        },
        "legs": [{
            "phone": v.phone,
            "drain_slope_ms_per_kb": None if v.drain_slope_ms_per_kb is None
            else round(v.drain_slope_ms_per_kb, 3),
            "uart_median_kbps": None if v.uart_median_kbps is None
            else round(v.uart_median_kbps, 2),
            "uart_matches_others": v.uart_matches_others,
            "verdict": v.verdict,
        } for v in legs],
    }


def render_text(report: Dict[str, object]) -> str:
    out: List[str] = []
    runs = report["runs"]
    cells = report["cells"]
    assert isinstance(runs, list) and isinstance(cells, list)
    out.append("BLE photo speed summary: %d runs, %d measured photos"
               % (len(runs), sum(r["photos"] for r in runs)))
    out.append("")
    header = ("phone".ljust(14) + "os".ljust(8) + "cond".ljust(5) + "size".ljust(7)
              + "n".rjust(4) + "ok".rjust(4) + "fail%".rjust(7) + "retry".rjust(6)
              + "e2e_med".rjust(9) + "e2e_p10".rjust(9) + "e2e_min".rjust(9)
              + "uart_med".rjust(10) + "drain_ms".rjust(10) + "payloadKB".rjust(11) + "  flag")
    out.append(header)
    out.append("-" * len(header))
    for cell in cells:
        e2e = cell["e2e_kbps"] or {}
        uart = cell["uart_kbps"] or {}
        drain = cell["drain_ms"] or {}
        out.append(
            str(cell["phone"]).ljust(14) + str(cell["phone_os"]).ljust(8)
            + str(cell["condition"]).ljust(5) + str(cell["size"]).ljust(7)
            + str(cell["attempted"]).rjust(4) + str(cell["succeeded"]).rjust(4)
            + ("%.1f%%" % (100 * cell["failure_rate"])).rjust(7) + str(cell["retried"]).rjust(6)
            + _fmt(e2e.get("median"), 9) + _fmt(e2e.get("p10"), 9) + _fmt(e2e.get("min"), 9)
            + _fmt(uart.get("median"), 10) + _fmt(drain.get("median"), 10, 0)
            + _fmt(cell["mean_payload_kb"], 11) + ("  FLAG" if cell["flagged"] else ""))
    floor = report["floor"]
    loaded = report["loaded_condition_d"]
    assert isinstance(floor, dict) and isinstance(loaded, dict)
    out.append("")
    out.append("Speed floor (conditions %s, p10 x %.2f, rounded down to %d KB/s): %s"
               % ("+".join(floor["conditions"]), floor["margin"], floor["step_kbps"],
                  "-" if floor["floor_kbps"] is None else "%d KB/s" % floor["floor_kbps"]))
    if floor["limiting_phone"]:
        out.append("  limiting phone: %s" % floor["limiting_phone"])
    for phone, p10 in floor["per_phone_p10_kbps"].items():
        out.append("  p10 %-12s %.2f KB/s" % (phone, p10))
    out.append("Loaded (condition D): %s" % (
        "-" if loaded["floor_kbps"] is None else "%d KB/s" % loaded["floor_kbps"]))
    out.append("")
    out.append("Limiting leg:")
    for leg in report["legs"]:
        out.append("  %-14s %-18s drain slope %s ms/KB, uart median %s KB/s" % (
            leg["phone"], leg["verdict"],
            "-" if leg["drain_slope_ms_per_kb"] is None else "%.3f" % leg["drain_slope_ms_per_kb"],
            "-" if leg["uart_median_kbps"] is None else "%.2f" % leg["uart_median_kbps"]))
    out.append("")
    out.append("Runs:")
    for run in runs:
        out.append("  %s transport=%s baud=%s photos=%d%s" % (
            run["run_id"], run["transport"], run["uart_baud"], run["photos"],
            " ABORTED: %s" % run["aborted"] if run["aborted"] else ""))
    return "\n".join(out) + "\n"
