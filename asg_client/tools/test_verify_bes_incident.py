#!/usr/bin/env python3
"""Synthetic-fixture unit tests for verify_bes_incident (python -m unittest)."""
import json
import os
import tempfile
import unittest
import zlib

import verify_bes_incident as v


def crc(data):
    return "%08x" % (zlib.crc32(data) & 0xFFFFFFFF)


def write_bundle(root, key, incident, dump=None, trace=None):
    path = os.path.join(root, key)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "incident.json"), "w", encoding="utf8") as handle:
        json.dump(incident, handle)
    if dump is not None:
        with open(os.path.join(path, "dump.txt"), "wb") as handle:
            handle.write(dump)
    if trace is not None:
        with open(os.path.join(path, "trace.txt"), "w", encoding="utf8") as handle:
            handle.write(trace)
    return path


def dump_incident(serial="ML395018B", seq="0000002a", body=b"crashbody-0123456789",
                  boot_id="9f3a0c1b2d4e5f60", tail=True, truncated=False, trace_gaps=0):
    full = b"### ASSERT @ 0x0C0F7F6B ###\n"
    full += (f"[CRASH-CONTEXT] v=2 seq=42 boot_id={boot_id} uptime_ms=1 unix_ms=0 clock=0 "
             "age_ms=0 boot_anchor_ms=0 reset_hw=0x1 reset_sw=0x00800030\n").encode()
    full += body + b"\n"
    if tail:
        tail_bytes = b"TRACELINE-A\nTRACELINE-B"
        full += b"[CRASH-TAIL] captured=%d requested=%d truncated=0 torn=0\n" % (
            len(tail_bytes), len(tail_bytes))
        full += tail_bytes + b"\n[CRASH-TAIL-END]\n"
    dump_crc = crc(full)
    dump_id = f"{seq}-{dump_crc}"
    stored = full
    if truncated:
        stored = full[: len(full) // 2]
        stored += b"[CRASH-TRUNCATED] sent=%d total=%d crc=%s\n" % (
            len(stored), len(full), crc(full[: len(full) // 2]).encode())
    incident = {
        "v": 1, "incidentKey": f"{serial}-dump-{dump_id}", "kind": "dump", "reason": "bes_crash",
        "state": "STORED", "attribution": "match", "bootId": boot_id, "observedBootId": boot_id,
        "dumpId": dump_id, "dumpLen": len(full), "resetHw": 1, "resetSw": 0,
        "flags": {"truncated": truncated, "torn": False, "tailCaptured": tail, "dumpGap": False},
        "traceGaps": trace_gaps, "uploaded": False,
    }
    return incident, stored, dump_id


class VerifyBesIncidentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bes_fixtures_")

    def verify(self, key, **kwargs):
        return v.verify_bundle(os.path.join(self.tmp, key), **kwargs)

    def test_valid_dump_incident_passes(self):
        incident, dump, dump_id = dump_incident()
        trace = "100\t1\t0a\tline one\n200\t1\t0b\tline two\n"
        key = incident["incidentKey"]
        write_bundle(self.tmp, key, incident, dump, trace)
        checks = self.verify(key)
        self.assertTrue(checks.passed, checks.render())

    def test_crash_dump_header_must_be_excluded(self):
        incident, dump, dump_id = dump_incident()
        bad = b"[CRASH-DUMP] v=1 dump_id=%s len=1 crc=00000000\n" % dump_id.encode() + dump
        # Recompute so only the header-exclusion check fails, not the CRC/len checks.
        incident["dumpLen"] = len(bad)
        incident["dumpId"] = dump_id.split("-")[0] + "-" + crc(bad)
        incident["incidentKey"] = "ML395018B-dump-" + incident["dumpId"]
        write_bundle(self.tmp, incident["incidentKey"], incident, bad, "1\t1\t0\tx\n")
        checks = self.verify(incident["incidentKey"])
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["[CRASH-DUMP] header excluded from dump.txt"])

    def test_wrong_crc_fails(self):
        incident, dump, dump_id = dump_incident()
        write_bundle(self.tmp, incident["incidentKey"], incident, dump + b"X", "1\t1\t0\tx\n")
        checks = self.verify(incident["incidentKey"])
        self.assertFalse(checks.passed)

    def test_crash_tail_captured_mismatch_fails(self):
        incident, dump, dump_id = dump_incident()
        dump = dump.replace(b"captured=23", b"captured=99")  # len("TRACELINE-A\nTRACELINE-B")==23
        incident["dumpLen"] = len(dump)
        incident["dumpId"] = dump_id.split("-")[0] + "-" + crc(dump)
        incident["incidentKey"] = "ML395018B-dump-" + incident["dumpId"]
        write_bundle(self.tmp, incident["incidentKey"], incident, dump, "1\t1\t0\tx\n")
        checks = self.verify(incident["incidentKey"])
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["[CRASH-TAIL] captured == bytes to [CRASH-TAIL-END]"])

    def test_truncated_incident_passes(self):
        incident, dump, dump_id = dump_incident(truncated=True)
        write_bundle(self.tmp, incident["incidentKey"], incident, dump, "1\t1\t0\tx\n")
        checks = self.verify(incident["incidentKey"])
        self.assertTrue(checks.passed, checks.render())

    def test_reset_incident_passes(self):
        boot, observed = "1a2b3c4d5e6f7081", "5566778899aabbcc"   # the reset boot, the boot that saw it
        incident = {"v": 1, "incidentKey": f"ML395018B-reset-{observed}", "kind": "reset",
                    "reason": "bes_unexpected_reset", "state": "STORED", "attribution": "older",
                    "bootId": boot, "observedBootId": observed, "traceGaps": 1, "uploaded": False}
        trace = "10\t1\t0\tboot\n20\t1\t1\t[ASG-BES-GAP] missed\n30\t1\t2\t[ASG-BES-REBOOT] old_bid=a new_bid=b\n"
        write_bundle(self.tmp, incident["incidentKey"], incident, None, trace)
        checks = self.verify(incident["incidentKey"])
        self.assertTrue(checks.passed, checks.render())

    def test_reset_key_must_name_the_observing_boot(self):
        boot, observed = "1a2b3c4d5e6f7081", "5566778899aabbcc"
        incident = {"v": 1, "incidentKey": f"ML395018B-reset-{boot}", "kind": "reset",
                    "reason": "bes_unexpected_reset", "state": "STORED", "attribution": "older",
                    "bootId": boot, "observedBootId": observed, "traceGaps": 0, "uploaded": False}
        write_bundle(self.tmp, incident["incidentKey"], incident, None, "10\t1\t0\tboot\n")
        checks = self.verify(incident["incidentKey"])
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["key bootId == incident.observedBootId"])

    def test_trace_gap_count_mismatch_fails(self):
        boot, observed = "1a2b3c4d5e6f7081", "5566778899aabbcc"   # the reset boot, the boot that saw it
        incident = {"v": 1, "incidentKey": f"ML395018B-reset-{observed}", "kind": "reset",
                    "reason": "bes_unexpected_reset", "state": "STORED", "attribution": "older",
                    "bootId": boot, "observedBootId": observed, "traceGaps": 5, "uploaded": False}
        trace = "10\t1\t0\tboot\n20\t1\t1\t[ASG-BES-GAP] missed\n"
        write_bundle(self.tmp, incident["incidentKey"], incident, None, trace)
        checks = self.verify(incident["incidentKey"])
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["[ASG-BES-GAP] count == traceGaps"])

    def test_nonmonotonic_trace_fails(self):
        boot, observed = "1a2b3c4d5e6f7081", "5566778899aabbcc"   # the reset boot, the boot that saw it
        incident = {"v": 1, "incidentKey": f"ML395018B-reset-{observed}", "kind": "reset",
                    "reason": "bes_unexpected_reset", "state": "STORED", "attribution": "unknown",
                    "bootId": boot, "observedBootId": observed, "traceGaps": 0, "uploaded": False}
        trace = "200\t1\t0\tlate\n100\t1\t1\tearlier\n"
        write_bundle(self.tmp, incident["incidentKey"], incident, None, trace)
        checks = self.verify(incident["incidentKey"])
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["trace.txt wallMs monotonic"])

    def test_anon_serial_matches_the_bare_stored_device_id(self):
        incident, dump, dump_id = dump_incident(serial="anon0123456789abcdef")
        key = incident["incidentKey"]
        write_bundle(self.tmp, key, incident, dump, "1\t1\t0\tx\n")
        self.assertTrue(self.verify(key, device_id="0123456789abcdef").passed)
        checks = self.verify(key, device_id="ffffffffffffffff")
        names = {name: ok for name, ok, _ in checks.results}
        self.assertFalse(names["anon serial well-formed/matches device_id"])

    def test_anon_serial_matches_device_id(self):
        incident, dump, dump_id = dump_incident(serial="anon0123456789abcdef")
        key = incident["incidentKey"]
        write_bundle(self.tmp, key, incident, dump, "1\t1\t0\tx\n")
        self.assertTrue(self.verify(key, device_id="anon0123456789abcdef").passed)
        checks = self.verify(key, device_id="anonffffffffffffffff")
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["anon serial well-formed/matches device_id"])

    def test_bad_state_and_key_fail(self):
        incident, dump, dump_id = dump_incident()
        incident["state"] = "WEIRD"
        incident["incidentKey"] = "bad key with spaces"
        write_bundle(self.tmp, "badbundle", incident, dump, "1\t1\t0\tx\n")
        checks = self.verify("badbundle")
        self.assertFalse(checks.passed)

    def test_key_dumpid_disagreement_fails(self):
        incident, dump, dump_id = dump_incident()
        incident["incidentKey"] = "ML395018B-dump-0000002a-deadbeef"  # crc != real
        write_bundle(self.tmp, incident["incidentKey"], incident, dump, "1\t1\t0\tx\n")
        checks = self.verify(incident["incidentKey"])
        names = {n: ok for n, ok, _ in checks.results}
        self.assertFalse(names["key dumpId == incident.dumpId"])



class StoreEnumerationTests(unittest.TestCase):
    """The store root also holds files that are not bundles."""

    def test_device_listing_keeps_only_bundle_directories(self):
        listing = ("ML395018B-dump-0000002a-1f2e3d4c\nML395018B-reset-9f3a0c1b2d4e5f60\n"
                   "collected.json\ndevice_id\nevictions.json\nlast_boot\n"
                   "ML395018B-dump-0000002a-1f2e3d4c.tmp\nML-395-dump-0000002a-1f2e3d4c\n")
        calls = []

        def fake_adb(command):
            calls.append(command)
            if "ls files/bes_incident" in command:
                return 0, listing
            return 1, ""

        original = v.adb_shell
        v.adb_shell = fake_adb
        try:
            with tempfile.TemporaryDirectory() as dest:
                keys, _ = v.pull_device_bundles(None, dest)
        finally:
            v.adb_shell = original
        self.assertEqual(keys, ["ML395018B-dump-0000002a-1f2e3d4c",
                                "ML395018B-reset-9f3a0c1b2d4e5f60",
                                "ML-395-dump-0000002a-1f2e3d4c"])

    def test_root_mode_skips_store_files_and_stray_directories(self):
        with tempfile.TemporaryDirectory() as root:
            write_bundle(root, "ML395018B-dump-0000002a-1f2e3d4c", {"v": 1})
            os.makedirs(os.path.join(root, "scratch"))
            for name in ("device_id", "last_boot", "collected.json", "evictions.json"):
                with open(os.path.join(root, name), "w") as handle:
                    handle.write("anon0123456789abcdef")
            names = [d for d in os.listdir(root) if v.BUNDLE_DIR_RE.match(d)]
            self.assertEqual(names, ["ML395018B-dump-0000002a-1f2e3d4c"])


if __name__ == "__main__":
    unittest.main()
