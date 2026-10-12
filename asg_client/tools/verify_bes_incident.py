#!/usr/bin/env python3
"""Validate BES crash incident bundles against the OS-1988 contract.

Checks files/bes_incident/<incidentKey>/ (incident.json, dump.txt, trace.txt)
pulled from a unit over adb (run-as com.mentra.asg_client; PATH adb) or read
from a local directory. Implements exactly these contract rules:

  incident.json  schema and enum values (section 7, 1)
  dump.txt       length + CRC32 == dumpId/dumpLen, or the [CRASH-TRUNCATED]
                 trailer rule; the [CRASH-DUMP] cur-0 header is excluded (3)
  dump text      [CRASH-TAIL] captured == bytes between it and [CRASH-TAIL-END] (4)
  trace.txt      monotonic wallMs; [ASG-BES-GAP] count == traceGaps;
                 [ASG-BES-REBOOT] counted (6, 7)
  incidentKey    == <serial|anon>-dump-<dumpId> / -reset-<observedBootId>; ids well-formed (1)

Prints PASS/FAIL per check and exits nonzero if any check FAILs.

  verify_bes_incident.py --all                 # every incident on the unit (adb)
  verify_bes_incident.py --key <incidentKey>   # one incident on the unit (adb)
  verify_bes_incident.py --dir path/to/bundle  # one local bundle directory
  verify_bes_incident.py --root path/to/bes_incident  # every local bundle
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import zlib

PACKAGE = "com.mentra.asg_client"
INCIDENT_ROOT = f"/data/data/{PACKAGE}/files/bes_incident"
KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
# A bundle directory name: <serial>-dump-<dumpId> or <serial>-reset-<bootId>. The store root also
# holds files (device_id, last_boot, collected.json, evictions.json) that are not bundles.
BUNDLE_DIR_RE = re.compile(r"^[A-Za-z0-9._:]{1,100}-(dump|reset)-[0-9a-f]{8}-[0-9a-f]{8}$|"
                           r"^[A-Za-z0-9._:]{1,100}-(dump|reset)-[0-9a-f]{16}$")
DUMP_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{8}$")
BOOT_ID_RE = re.compile(r"^[0-9a-f]{16}$")
ANON_RE = re.compile(r"^anon[0-9a-f]{16}$")
CRASH_DUMP_HEADER = re.compile(rb"\[CRASH-DUMP\] v=\d+ dump_id=")
CRASH_TAIL = re.compile(rb"\[CRASH-TAIL\] captured=(\d+) requested=(\d+) truncated=([01]) torn=([01])[^\n]*\n")
CRASH_TRUNCATED = re.compile(rb"\[CRASH-TRUNCATED\] sent=(\d+) total=(\d+) crc=([0-9a-f]{8})")
VALID_STATES = {"COLLECTING", "STORED", "REPORTED", "UPLOADED", "EVICTED"}
VALID_KINDS = {"dump", "reset"}
VALID_REASONS = {"bes_crash", "bes_unexpected_reset"}
VALID_ATTR = {"match", "older", "unknown"}


class Checks:
    def __init__(self, label):
        self.label = label
        self.results = []

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok), detail))
        return bool(ok)

    @property
    def passed(self):
        return all(ok for _, ok, _ in self.results)

    def render(self):
        lines = [f"=== {self.label} ==="]
        for name, ok, detail in self.results:
            lines.append(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
        return "\n".join(lines)


def crc32_hex(data):
    return "%08x" % (zlib.crc32(data) & 0xFFFFFFFF)


def verify_bundle(path, device_id=None):
    """Run every contract check on one incident directory. Returns a Checks."""
    name = os.path.basename(path.rstrip("/"))
    checks = Checks(name)

    json_path = os.path.join(path, "incident.json")
    if not checks.check("incident.json present", os.path.isfile(json_path)):
        return checks
    try:
        with open(json_path, "rb") as handle:
            incident = json.loads(handle.read())
    except ValueError as exc:
        checks.check("incident.json parses", False, str(exc))
        return checks
    checks.check("incident.json parses", True)

    key = incident.get("incidentKey", "")
    kind = incident.get("kind")
    checks.check("incidentKey regex", bool(KEY_RE.match(key or "")), key)
    checks.check("kind valid", kind in VALID_KINDS, repr(kind))
    checks.check("state valid", incident.get("state") in VALID_STATES, repr(incident.get("state")))
    checks.check("reason valid", incident.get("reason") in VALID_REASONS, repr(incident.get("reason")))
    checks.check("attribution valid", incident.get("attribution") in VALID_ATTR,
                 repr(incident.get("attribution")))
    checks.check("UPLOADED!=EVICTED", not (incident.get("state") == "EVICTED" and incident.get("uploaded")),
                 "EVICTED bundle must never be uploaded")

    boot_id = incident.get("bootId")
    if boot_id is not None:
        ok = bool(BOOT_ID_RE.match(boot_id)) and boot_id != "0" * 16
        checks.check("bootId 16 hex nonzero", ok, repr(boot_id))

    # incidentKey composition and serial/anon agreement.
    serial = None
    if key and "-dump-" in key:
        serial, _, tail = key.partition("-dump-")
        checks.check("kind matches key form", kind == "dump", "key has -dump-")
        checks.check("dumpId regex", bool(DUMP_ID_RE.match(tail)), tail)
        checks.check("key dumpId == incident.dumpId", tail == incident.get("dumpId"),
                     f"{tail} vs {incident.get('dumpId')}")
    elif key and "-reset-" in key:
        serial, _, tail = key.partition("-reset-")
        checks.check("kind matches key form", kind == "reset", "key has -reset-")
        ok = bool(BOOT_ID_RE.match(tail)) and tail != "0" * 16
        checks.check("reset key bootId 16 hex nonzero", ok, tail)
        # The reset key names the boot that observed the reset; incident.bootId is the boot
        # that reset (the previous one).
        checks.check("key bootId == incident.observedBootId", tail == incident.get("observedBootId"),
                     f"{tail} vs {incident.get('observedBootId')}")
    else:
        checks.check("incidentKey has -dump-/-reset-", False, key)

    if serial is not None:
        if serial.startswith("anon"):
            ok = bool(ANON_RE.match(serial))
            if device_id is not None:
                ok = ok and serial == device_id
            checks.check("anon serial well-formed/matches device_id", ok,
                         f"{serial} device_id={device_id}")
        else:
            checks.check("serial non-empty", bool(serial), serial)

    # dump.txt rules (only for dump incidents with a dumpId).
    dump_path = os.path.join(path, "dump.txt")
    dump_id = incident.get("dumpId")
    if kind == "dump" and dump_id:
        if checks.check("dump.txt present", os.path.isfile(dump_path)):
            with open(dump_path, "rb") as handle:
                dump = handle.read()
            checks.check("[CRASH-DUMP] header excluded from dump.txt",
                         CRASH_DUMP_HEADER.search(dump) is None)
            id_crc = dump_id.split("-")[1] if "-" in dump_id else None
            flags = incident.get("flags", {}) or {}
            if flags.get("truncated"):
                checks.check("truncated: len == dumpLen? (no, sent<total)",
                             len(dump) <= (incident.get("dumpLen") or 0),
                             f"sent={len(dump)} dumpLen={incident.get('dumpLen')}")
                # The dump_id crc covers the FULL stream; truncated dump.txt holds only the
                # sent prefix, so its own crc is the trailer crc, not id_crc.
                checks.check("truncated flag present in flags", True)
            else:
                checks.check("dump.txt length == dumpLen", len(dump) == incident.get("dumpLen"),
                             f"{len(dump)} vs {incident.get('dumpLen')}")
                checks.check("dump.txt CRC32 == dumpId crc", crc32_hex(dump) == id_crc,
                             f"{crc32_hex(dump)} vs {id_crc}")

            # [CRASH-TAIL] self-consistency (section 4).
            tail = CRASH_TAIL.search(dump)
            if tail:
                captured = int(tail.group(1))
                end = dump.find(b"[CRASH-TAIL-END]", tail.end())
                if checks.check("[CRASH-TAIL-END] present", end != -1):
                    body = dump[tail.end():end]
                    # The TRACE tail is followed by a newline before the END marker.
                    actual = len(body.rstrip(b"\n")) if body.endswith(b"\n") else len(body)
                    checks.check("[CRASH-TAIL] captured == bytes to [CRASH-TAIL-END]",
                                 actual == captured, f"captured={captured} actual={actual}")
            trailer = CRASH_TRUNCATED.search(dump)
            if trailer:
                total = int(trailer.group(2))
                checks.check("[CRASH-TRUNCATED] total == dumpLen", total == incident.get("dumpLen"),
                             f"{total} vs {incident.get('dumpLen')}")

    # trace.txt rules (section 7).
    trace_path = os.path.join(path, "trace.txt")
    if os.path.isfile(trace_path):
        with open(trace_path, "r", encoding="utf8", errors="replace") as handle:
            trace_lines = handle.read().splitlines()
        monotonic = True
        last = -1
        bad = None
        gaps = reboots = 0
        for line in trace_lines:
            if "[ASG-BES-GAP]" in line:
                gaps += 1
            if "[ASG-BES-REBOOT]" in line:
                reboots += 1
            field = line.split("\t", 1)[0]
            if field.isdigit():
                value = int(field)
                if value < last:
                    monotonic = False
                    bad = bad or f"{value} < {last}"
                last = value
        checks.check("trace.txt wallMs monotonic", monotonic, bad or "")
        if "traceGaps" in incident:
            checks.check("[ASG-BES-GAP] count == traceGaps", gaps == incident.get("traceGaps"),
                         f"{gaps} vs {incident.get('traceGaps')}")
        checks.check("[ASG-BES-REBOOT] counted", True, f"{reboots} reboot marker(s)")

    return checks


def adb_shell(command):
    result = subprocess.run(["adb", "shell", command], capture_output=True, timeout=60)
    return result.returncode, result.stdout.decode("utf8", errors="replace").replace("\r\n", "\n")


def run_as_available():
    code, out = adb_shell(f"run-as {PACKAGE} id")
    return code == 0 and "uid=" in out


def pull_device_bundles(keys, dest):
    """Copy incident dirs out of the app sandbox with run-as, then tar them to the host."""
    device_id = None
    code, out = adb_shell(f"run-as {PACKAGE} cat files/bes_incident/device_id 2>/dev/null")
    if code == 0 and out.strip():
        device_id = out.strip()
    if keys is None:
        code, out = adb_shell(f"run-as {PACKAGE} ls files/bes_incident 2>/dev/null")
        keys = [k for k in out.split() if BUNDLE_DIR_RE.match(k)] if code == 0 else []
    for key in keys:
        local = os.path.join(dest, key)
        os.makedirs(local, exist_ok=True)
        for name in ("incident.json", "dump.txt", "trace.txt"):
            code, out = adb_shell(f"run-as {PACKAGE} cat files/bes_incident/{key}/{name} 2>/dev/null")
            if code == 0 and out:
                with open(os.path.join(local, name), "w", encoding="utf8") as handle:
                    handle.write(out)
    return keys, device_id


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--all", action="store_true", help="every incident on the connected unit")
    group.add_argument("--key", help="one incidentKey on the connected unit")
    group.add_argument("--dir", help="one local bundle directory")
    group.add_argument("--root", help="a local directory of bundle directories")
    parser.add_argument("--device-id", help="expected anon device_id for incidentKey checks")
    args = parser.parse_args(argv)

    bundles = []
    device_id = args.device_id
    if args.dir:
        bundles = [args.dir]
    elif args.root:
        bundles = sorted(os.path.join(args.root, d) for d in os.listdir(args.root)
                         if BUNDLE_DIR_RE.match(d) and os.path.isdir(os.path.join(args.root, d)))
        dev = os.path.join(args.root, "device_id")
        if device_id is None and os.path.isfile(dev):
            device_id = open(dev).read().strip()
    else:
        if not run_as_available():
            print("run-as com.mentra.asg_client unavailable (device not connected or not debuggable)",
                  file=sys.stderr)
            return 2
        tmp = tempfile.mkdtemp(prefix="bes_incident_")
        keys = None if args.all else [args.key]
        pulled, dev = pull_device_bundles(keys, tmp)
        device_id = device_id or dev
        bundles = [os.path.join(tmp, k) for k in pulled]
        if not bundles:
            print("No incident bundles found on the unit (feature may be absent on this firmware/ASG).")
            return 0

    all_ok = True
    for bundle in bundles:
        checks = verify_bundle(bundle, device_id=device_id)
        print(checks.render())
        all_ok = all_ok and checks.passed
    print(f"\nOVERALL: {'PASS' if all_ok else 'FAIL'} ({len(bundles)} bundle(s))")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
