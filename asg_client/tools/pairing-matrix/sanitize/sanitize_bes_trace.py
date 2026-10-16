#!/usr/bin/env python3
"""Sanitize a raw Mentra Live BES UART trace so it can be shared.

    python3 sanitize_bes_trace.py INPUT [-o OUTPUT] [--check]

The BES firmware prints key material with DUMP8 ("%02x " per byte, one dump per
line, no tick prefix). This tool replaces every run of >= 8 consecutive hex
bytes with "[REDACTED nN bytes]" (for example "[REDACTED n16 bytes]"):

  * on any line that carries a key-material label (tmpLinkKey, tmpLtk, ltk, irk,
    link key, randnb, rand, ediv, "save link key", CTKD) and on the hex-dump
    continuation lines that follow it. A continuation line is redacted whole
    unless it is exactly 6 bytes (a Bluetooth device address);
  * on every other line, so a key printed under an unexpected label still goes.

Runs of 6 bytes (device addresses) stay visible: address correlation is the
evidence. Fail closed: the summary on stderr counts redactions only (never
content), and --check exits 1 if the OUTPUT still holds a run of >= 8 hex bytes
(the OUTPUT file is deleted in that case).

Without -o the sanitized text goes to stdout. With --check and without -o
nothing is written: INPUT itself is checked, which validates an already
sanitized file before it is shared.

Exit codes: 0 ok, 1 --check found a residual run, 2 usage or I/O error.
Python 3, standard library only.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass

MIN_RUN_BYTES = 8  # >= this many consecutive bytes is key-sized and always redacted
ADDR_BYTES = 6  # a Bluetooth device address; kept visible

_BYTE = r"(?:0[xX])?[0-9a-fA-F]{2}"
# Separator between bytes: space(s) or tab, or a colon / dash / comma with optional spaces.
_SEP = r"(?:[ \t]*[:\-,][ \t]*|[ \t]+)"
_BYTE_RE = re.compile(rf"(?<![0-9A-Za-z]){_BYTE}(?![0-9A-Za-z])")
# A run of >= 2 separated bytes; the caller counts and decides.
_RUN_RE = re.compile(rf"(?<![0-9A-Za-z]){_BYTE}(?:{_SEP}{_BYTE})+(?![0-9A-Za-z])")
# Hex with no separators: 16+ digits is >= 8 bytes. Keep fail-closed for %08x style prints.
_CONTIG_RE = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{16,}(?![0-9A-Za-z])")

_LABEL_RE = re.compile(
    r"tmplinkkey|tmpltk|ltk|irk|link[ _-]?key|randnb|rand|ediv|save link key|ctkd",
    re.IGNORECASE,
)

# Prefixes that precede the payload of a dump line.
_PREFIXES = (
    re.compile(r"^\s*\d+/[A-Z]/\S+\s+/\s+\d+ \| "),  # reassembled mh_logs ring line
    re.compile(r"^\s*\d+ \| "),  # tick prefix: "200 | ..."
    re.compile(r"^\s*\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\S+\s*:\s*"),  # adb logcat -v time
    re.compile(r'^.*?"line":"'),  # pmx bes_trace_log envelope
)
_SUFFIX_RE = re.compile(r'"\}\s*$')


def _count_bytes(run: str) -> int:
    return len(_BYTE_RE.findall(run))


@dataclass
class Stats:
    lines: int = 0
    redactions: int = 0
    bytes_redacted: int = 0
    labelled_lines_hit: int = 0
    continuation_lines_hit: int = 0
    unlabelled_lines_hit: int = 0
    short_continuations: int = 0
    addresses_kept: int = 0
    labelled_lines: int = 0

    def summary(self) -> str:
        return (
            f"sanitize: {self.lines} lines, {self.redactions} redactions "
            f"({self.bytes_redacted} bytes): labelled lines {self.labelled_lines_hit}, "
            f"continuation lines {self.continuation_lines_hit} "
            f"(short {self.short_continuations}), unlabelled lines {self.unlabelled_lines_hit}; "
            f"6-byte addresses kept {self.addresses_kept}; "
            f"key-label lines seen {self.labelled_lines}"
        )


def _marker(n_bytes: int) -> str:
    return f"[REDACTED n{n_bytes} bytes]"


def _redact_runs(text: str) -> tuple[str, int, int]:
    """Replace every >= 8 byte run. Returns (text, runs_replaced, bytes_replaced)."""
    runs = 0
    total = 0

    def sep_sub(m: re.Match) -> str:
        nonlocal runs, total
        n = _count_bytes(m.group(0))
        if n >= MIN_RUN_BYTES:
            runs += 1
            total += n
            return _marker(n)
        return m.group(0)

    def contig_sub(m: re.Match) -> str:
        nonlocal runs, total
        n = len(m.group(0)) // 2
        runs += 1
        total += n
        return _marker(n)

    text = _RUN_RE.sub(sep_sub, text)
    text = _CONTIG_RE.sub(contig_sub, text)
    return text, runs, total


def _payload(line: str) -> str:
    """Strip known envelopes so a dump line can be recognised as 'hex only'."""
    s = line
    for rx in _PREFIXES:
        s2 = rx.sub("", s, count=1)
        if s2 != s:
            s = s2
            break
    return _SUFFIX_RE.sub("", s).strip()


def _is_hex_only(line: str) -> bool:
    p = _payload(line)
    if not p:
        return False
    rest = _RUN_RE.sub("", p)
    rest = _BYTE_RE.sub("", rest)
    rest = _CONTIG_RE.sub("", rest)
    return rest.strip(" \t:,-") == "" and bool(_BYTE_RE.search(p) or _CONTIG_RE.search(p))


def _redact_whole_dump(line: str) -> tuple[str, int, int]:
    """Redact every byte token on a hex-only continuation line in key context."""
    p = _payload(line)
    n = _count_bytes(p) + sum(len(m.group(0)) // 2 for m in _CONTIG_RE.finditer(p))
    start = line.find(p) if p else 0
    head = line[:start] if start >= 0 else ""
    tail_start = start + len(p)
    tail = line[tail_start:]
    return f"{head}{_marker(n)}{tail}", 1, n


def sanitize_lines(lines: list[str]) -> tuple[list[str], Stats]:
    stats = Stats()
    out: list[str] = []
    key_ctx = False
    for raw in lines:
        stats.lines += 1
        body = raw.rstrip("\r\n")
        eol = raw[len(body):]
        labelled = bool(_LABEL_RE.search(body))
        if labelled:
            stats.labelled_lines += 1
        hex_only = _is_hex_only(body)

        if key_ctx and hex_only and not labelled:
            n_tokens = _count_bytes(_payload(body)) + sum(
                len(m.group(0)) // 2 for m in _CONTIG_RE.finditer(_payload(body))
            )
            if n_tokens == ADDR_BYTES:
                stats.addresses_kept += 1
                out.append(body + eol)
                continue
            new, runs, nbytes = _redact_whole_dump(body)
            stats.redactions += runs
            stats.bytes_redacted += nbytes
            stats.continuation_lines_hit += 1
            if n_tokens < MIN_RUN_BYTES:
                stats.short_continuations += 1
            out.append(new + eol)
            continue

        new, runs, nbytes = _redact_runs(body)
        if runs:
            stats.redactions += runs
            stats.bytes_redacted += nbytes
            if labelled:
                stats.labelled_lines_hit += 1
            else:
                stats.unlabelled_lines_hit += 1
        for m in _RUN_RE.finditer(new):
            if _count_bytes(m.group(0)) == ADDR_BYTES:
                stats.addresses_kept += 1
        out.append(new + eol)

        if labelled:
            key_ctx = True
        elif hex_only or not body.strip():
            pass  # a dump line or blank line keeps the context alive
        else:
            key_ctx = False
    return out, stats


def residual_runs(lines: list[str]) -> list[int]:
    """1-based numbers of lines that still hold a run of >= 8 hex bytes."""
    bad = []
    for i, line in enumerate(lines, 1):
        _, runs, _ = _redact_runs(line)
        if runs:
            bad.append(i)
    return bad


def _read(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read().splitlines(keepends=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Redact key material from a raw BES UART trace.")
    ap.add_argument("input", metavar="INPUT", help="raw BES trace (stays local)")
    ap.add_argument("-o", "--output", metavar="OUTPUT", help="sanitized copy (default: stdout)")
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if OUTPUT still contains a run of >= 8 hex bytes (with no -o: check INPUT)",
    )
    args = ap.parse_args(argv)

    try:
        lines = _read(args.input)
    except OSError as e:
        print(f"sanitize: cannot read {args.input}: {e.strerror}", file=sys.stderr)
        return 2

    if args.check and not args.output:
        bad = residual_runs(lines)
        print(f"sanitize --check: {len(lines)} lines, {len(bad)} with a run of >= {MIN_RUN_BYTES} hex bytes", file=sys.stderr)
        if bad:
            print(f"sanitize --check: FAIL, lines {_fmt_lines(bad)}", file=sys.stderr)
            return 1
        print("sanitize --check: PASS", file=sys.stderr)
        return 0

    if args.output and os.path.exists(args.output) and os.path.samefile(args.input, args.output):
        print("sanitize: OUTPUT is the same file as INPUT; refusing to overwrite the raw trace", file=sys.stderr)
        return 2

    clean, stats = sanitize_lines(lines)
    print(stats.summary(), file=sys.stderr)

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8", newline="") as fh:
                fh.writelines(clean)
        except OSError as e:
            print(f"sanitize: cannot write {args.output}: {e.strerror}", file=sys.stderr)
            return 2
    else:
        sys.stdout.writelines(clean)

    if args.check:
        try:
            written = _read(args.output)
        except OSError as e:
            print(f"sanitize --check: cannot re-read {args.output}: {e.strerror}", file=sys.stderr)
            return 2
        bad = residual_runs(written)
        if bad:
            try:
                os.remove(args.output)
            except OSError:
                pass
            print(
                f"sanitize --check: FAIL, lines {_fmt_lines(bad)} still hold a run of >= {MIN_RUN_BYTES} hex bytes; "
                f"{args.output} deleted",
                file=sys.stderr,
            )
            return 1
        print("sanitize --check: PASS", file=sys.stderr)
    return 0


def _fmt_lines(nums: list[int], limit: int = 20) -> str:
    shown = ",".join(str(n) for n in nums[:limit])
    return shown + (f",... (+{len(nums) - limit} more)" if len(nums) > limit else "")


if __name__ == "__main__":
    sys.exit(main())
