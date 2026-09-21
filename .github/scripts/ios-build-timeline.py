#!/usr/bin/env python3
"""Summarise an xcodebuild timeline (epoch-stamped log) as markdown.

Input lines look like ``1789800000.1 CompileC /path/... (in target 'X' from
project 'Y')`` (see ios-xcodebuild-attempt.sh). xcodebuild prints a line when
a task *starts*; there is no end marker, so windows below are first-start to
last-start per target/task type and are upper bounds on scheduling, not
CPU time. Use them to see what ran late and what ran alone, not to compute
utilisation.

Usage: ios-build-timeline.py <timeline> [<memory-samples>] [--top N]
"""
from __future__ import annotations

import re
import sys
from collections import OrderedDict

TASK_RE = re.compile(
    r"^(?P<ts>\d+(?:\.\d+)?) (?P<task>[A-Z][A-Za-z]+) .*?\(in target '(?P<target>[^']+)' from project '(?P<project>[^']+)'\)"
)
TASK_TYPES = {
    "CompileC",
    "SwiftCompile",
    "SwiftDriver",
    "SwiftEmitModule",
    "Ld",
    "Libtool",
    "PhaseScriptExecution",
    "ScanDependencies",
    "CompileAssetCatalogVariant",
    "GenerateDSYMFile",
    "CodeSign",
    "CopySwiftLibs",
    "ProcessInfoPlistFile",
    "CpResource",
    "Copy",
}


def fmt(seconds: float) -> str:
    seconds = int(round(seconds))
    return f"{seconds // 60}m {seconds % 60:02d}s"


def parse_timeline(path: str):
    first_ts = None
    last_ts = None
    targets: "OrderedDict[str, dict]" = OrderedDict()
    tasks: "OrderedDict[str, dict]" = OrderedDict()
    starts = []  # (ts, task, target)
    with open(path, errors="replace") as fh:
        for line in fh:
            m = re.match(r"^(\d+(?:\.\d+)?) ", line)
            if not m:
                continue
            ts = float(m.group(1))
            first_ts = ts if first_ts is None else first_ts
            last_ts = ts
            tm = TASK_RE.match(line)
            if not tm or tm.group("task") not in TASK_TYPES:
                continue
            task, target = tm.group("task"), tm.group("target")
            starts.append((ts, task, target))
            t = targets.setdefault(target, {"first": ts, "last": ts, "count": 0, "tasks": {}})
            t["last"] = ts
            t["count"] += 1
            t["tasks"][task] = t["tasks"].get(task, 0) + 1
            k = tasks.setdefault(task, {"first": ts, "last": ts, "count": 0})
            k["last"] = ts
            k["count"] += 1
    return first_ts, last_ts, targets, tasks, starts


def parse_memory(path: str):
    """Return (min_free_pct, max_pageouts_delta, samples)."""
    free = []
    pageouts = []
    try:
        with open(path) as fh:
            for line in fh:
                m = re.search(r"free percentage:\s*(\d+)%", line)
                if m:
                    free.append(int(m.group(1)))
                p = re.search(r"Pageouts=(\d+)", line)
                if p:
                    pageouts.append(int(p.group(1)))
    except OSError:
        return None
    if not free:
        return None
    delta = (pageouts[-1] - pageouts[0]) if len(pageouts) >= 2 else 0
    return min(free), delta, len(free)


def render(timeline_path: str, memory_path: str | None, top: int) -> str:
    first_ts, last_ts, targets, tasks, starts = parse_timeline(timeline_path)
    out = []
    if first_ts is None or not starts:
        return "_No timestamped task lines found in the timeline._\n"
    total = last_ts - first_ts
    out.append(f"Wall clock covered by the log: **{fmt(total)}** ({len(starts)} task starts, {len(targets)} targets).")
    out.append("")
    out.append("Task-type windows (first start → last start; upper bounds, not CPU time):")
    out.append("")
    out.append("| Task type | Starts | First | Last | Window |")
    out.append("| --- | ---: | ---: | ---: | ---: |")
    for task, k in sorted(tasks.items(), key=lambda kv: kv[1]["first"]):
        out.append(
            f"| {task} | {k['count']} | {fmt(k['first'] - first_ts)} | {fmt(k['last'] - first_ts)} | {fmt(k['last'] - k['first'])} |"
        )
    out.append("")
    out.append(f"Targets by scheduling window (top {top}):")
    out.append("")
    out.append("| Target | Tasks | First start | Last start | Window |")
    out.append("| --- | ---: | ---: | ---: | ---: |")
    by_window = sorted(targets.items(), key=lambda kv: kv[1]["last"] - kv[1]["first"], reverse=True)[:top]
    for name, t in by_window:
        out.append(f"| {name} | {t['count']} | {fmt(t['first'] - first_ts)} | {fmt(t['last'] - first_ts)} | {fmt(t['last'] - t['first'])} |")
    out.append("")
    out.append("Tail of the build (last 8 targets to start a task):")
    out.append("")
    tail = sorted(targets.items(), key=lambda kv: kv[1]["first"])[-8:]
    for name, t in tail:
        kinds = ", ".join(f"{k}×{v}" for k, v in sorted(t["tasks"].items(), key=lambda kv: -kv[1])[:3])
        out.append(f"- {fmt(t['first'] - first_ts)} → {fmt(t['last'] - first_ts)}  `{name}` ({kinds})")
    # Silent stretches: gaps between consecutive task starts.
    gaps = []
    for (a_ts, a_task, a_target), (b_ts, _, _) in zip(starts, starts[1:]):
        if b_ts - a_ts >= 20:
            gaps.append((b_ts - a_ts, a_ts - first_ts, a_task, a_target))
    if gaps:
        out.append("")
        out.append("Stretches of ≥20 s with no new task start (last task started before the gap):")
        out.append("")
        for gap, at, task, target in sorted(gaps, reverse=True)[:6]:
            out.append(f"- {fmt(gap)} starting at {fmt(at)} after `{task}` in `{target}`")
    if memory_path:
        mem = parse_memory(memory_path)
        if mem:
            min_free, pageouts, n = mem
            out.append("")
            out.append(
                f"Memory during the build ({n} samples, 10 s apart): minimum free **{min_free}%**, pageouts during build **{pageouts}**."
            )
    out.append("")
    return "\n".join(out)


def main(argv: list[str]) -> int:
    top = 12
    args = [a for a in argv if not a.startswith("--top")]
    for a in argv:
        if a.startswith("--top="):
            top = int(a.split("=", 1)[1])
    if not args:
        print(__doc__)
        return 2
    timeline = args[0]
    memory = args[1] if len(args) > 1 else None
    sys.stdout.write(render(timeline, memory, top))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
