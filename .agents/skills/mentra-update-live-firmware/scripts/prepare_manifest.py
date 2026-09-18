#!/usr/bin/env python3
"""Prepare a firmware manifest from already verified local feed snapshots."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version(value):
    match = re.fullmatch(r"MentraLive_(\d{8})(?:\.(\d+))?", value or "")
    require(match is not None, f"Invalid MTK version: {value!r}")
    return int(match[1]), int(match[2] or 0)


def artifact(entry):
    url = urlsplit(entry.get("url", ""))
    require(url.scheme == "https" and url.hostname and not url.username
            and not url.password and not url.fragment
            and not re.search(r"\s", entry.get("url", "")), "Invalid artifact HTTPS URL")
    require(re.fullmatch(r"[0-9a-fA-F]{64}", entry.get("sha256", "")),
            "Invalid artifact SHA-256")
    require(type(entry.get("size")) is int and entry["size"] > 0,
            "Artifact must declare a positive byte size")


def index_patches(entries):
    indexed = {}
    for entry in entries:
        start, end = entry["start_firmware"], entry["end_firmware"]
        require(version(start) < version(end), f"Not an upgrade: {start} -> {end}")
        require(start not in indexed, f"Duplicate patch source: {start}")
        indexed[start] = entry
    return indexed


def reaches(indexed, target):
    for start in indexed:
        cursor, visited = start, set()
        while cursor in indexed:
            require(cursor not in visited, f"Cycle from {start}")
            visited.add(cursor)
            cursor = indexed[cursor]["end_firmware"]
        require(cursor == target, f"Path from {start} ends at {cursor}, expected {target}")


def production_target(production):
    indexed = index_patches(production.get("mtk_patches", []))
    full = production.get("mtk_full_ota")
    if full:
        target = full["end_firmware"]
    else:
        terminals = {p["end_firmware"] for p in indexed.values()} - set(indexed)
        require(len(terminals) == 1, "Production MTK baseline is ambiguous")
        target = terminals.pop()
    version(target)
    reaches(indexed, target)
    return target, indexed


def prepare(current, production=None, mtk=None, bes=None):
    require(mtk is not None or bes is not None, "Select at least one feed")
    result = deepcopy(current)
    if mtk is not None:
        require(production is not None, "MTK update requires a released production manifest")
        baseline, released = production_target(production)
        indexed = index_patches(result.get("mtk_patches", []))
        for start, entry in released.items():
            require(indexed.get(start) == entry,
                    f"Released production patch differs or is missing in current manifest: {start}")
        full = mtk["mtk_full_ota"]
        target = full["end_firmware"]
        artifact(full)
        require(mtk.get("target_firmware", target) == target, "MTK feed targets disagree")
        require(version(target) >= version(baseline), "Latest MTK is older than production")
        previous_full = current.get("mtk_full_ota")
        if previous_full:
            require(version(target) >= version(previous_full["end_firmware"]),
                    "Latest MTK regresses the current full-OTA target")
        patches = result.setdefault("mtk_patches", [])
        if version(target) > version(baseline):
            candidates = [p for p in mtk.get("mtk_patches", [])
                          if p.get("start_firmware") == baseline
                          and p.get("end_firmware") == target]
            require(len(candidates) == 1,
                    f"Need exactly one published upgrade {baseline} -> {target}; found {len(candidates)}")
            artifact(candidates[0])
            replacement = {k: candidates[0][k] for k in
                           ("start_firmware", "end_firmware", "url", "sha256", "size")}
            if baseline in indexed:
                patches[patches.index(indexed[baseline])] = replacement
            else:
                patches.insert(0, replacement)
        result["mtk_full_ota"] = {k: full[k] for k in ("end_firmware", "url", "sha256", "size")}
        reaches(index_patches(patches), target)
    if bes is not None:
        artifact(bes)
        parts = bes.get("version", "").split(".")
        require(len(parts) == 4 and all(re.fullmatch(r"\d{1,3}", p)
                and int(p) <= 255 for p in parts), "Invalid BES version")
        dest = result.setdefault("bes_firmware", {})
        for key in ("version", "url", "sha256"):
            dest[key] = bes[key]
        if "size" in dest:
            dest["size"] = bes["size"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("current", "production", "mtk-latest", "bes-latest", "output"):
        parser.add_argument("--" + name, type=Path, required=name in ("current", "output"))
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text()) if p else None
    try:
        result = prepare(read(args.current), read(args.production),
                         read(args.mtk_latest), read(args.bes_latest))
    except (ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Cannot prepare manifest: {error}\n")
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Prepared {args.output}; verify provenance/artifacts and review before committing.")


if __name__ == "__main__":
    main()
