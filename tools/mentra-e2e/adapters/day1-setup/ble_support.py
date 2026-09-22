#!/usr/bin/env python3
"""Audited BLE framing, credentials and private evidence helpers; no workflow on import."""
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess
import time

from config import Guard, require, endpoint as safe_endpoint

SERVICE = "00004860-0000-1000-8000-00805f9b34fb"
NOTIFY = "000070ff-0000-1000-8000-00805f9b34fb"
COMMAND = "000071ff-0000-1000-8000-00805f9b34fb"

def load_credentials(cfg, path):
    require(path == cfg.credential.path, "use_preserved_fixture_credentials")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_uid == os.getuid() and info.st_nlink == 1, "credential_file_not_private_regular")
        raw = file.read(16385)
    require(len(raw) <= 16384, "credential_file_too_large")
    require(hashlib.sha256(raw).hexdigest() == cfg.credential.sha256, "credential_hash_changed")
    data = json.loads(raw)
    require(set(data) == {"schemaVersion", "fixture", "endpoint", "ssid", "password"}
            and data["schemaVersion"] == 1, "credential_schema")
    fixture = data["fixture"]
    require(set(fixture) == {"cid", "serial", "mac", "mtk", "slot", "boot"}, "fixture_schema")
    require(fixture["cid"] == cfg.fixture["cid"] and fixture["mac"] == cfg.fixture["mac"] and fixture["serial"] in cfg.serial_aliases
            and fixture["mtk"] == "MentraLive_20260113" and fixture["slot"] in ("_a", "_b")
            and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", fixture["boot"]), "fixture_not_expected_january")
    require(isinstance(data["ssid"], str) and 0 < len(data["ssid"].encode()) <= 32
            and isinstance(data["password"], str) and bool(data["password"]), "credential_values_invalid")
    safe_endpoint(data["endpoint"])
    return data, hashlib.sha256(raw).hexdigest()


def frame(message):
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    require(len(payload) <= 200, "single_frame_limit_exceeded")
    return b"##0" + len(payload).to_bytes(2, "big") + payload + b"$$"


def app_frame(command):
    return frame({"C": json.dumps(command, separators=(",", ":"), ensure_ascii=False), "W": 1})


class Decoder:
    def __init__(self):
        self.buffer = bytearray()

    def add(self, value):
        self.buffer.extend(value)
        require(len(self.buffer) <= 16384, "notification_buffer_limit")
        messages = []
        while len(self.buffer) >= 5:
            require(self.buffer[:3] == b"##0", "notification_frame_header")
            lengths = sorted({int.from_bytes(self.buffer[3:5], order) for order in ("big", "little")})
            lengths = [n for n in lengths if 0 < n <= 8192]
            require(lengths, "notification_frame_length")
            complete = [n for n in lengths if len(self.buffer) >= n + 7 and self.buffer[n+5:n+7] == b"$$"]
            if not complete:
                require(any(len(self.buffer) < n + 7 for n in lengths), "notification_frame_end")
                break
            require(len(complete) == 1, "notification_frame_ambiguous")
            n = complete[0]
            item = json.loads(self.buffer[5:n+5].decode())
            require(isinstance(item, dict), "notification_not_object")
            del self.buffer[:n+7]
            if isinstance(item.get("C"), str) and item["C"].startswith("{"):
                item = json.loads(item["C"])
                require(isinstance(item, dict), "wrapped_notification_not_object")
            messages.append(item)
        return messages


def status_proof(message, credentials, allow_new_ip=False):
    require(message.get("type") == "wifi_status" and message.get("connected") is True, "wifi_not_connected")
    require(message.get("ssid") == credentials["ssid"], "active_ssid_does_not_match_credential")
    ip = ipaddress.IPv4Address(message.get("local_ip", ""))
    require(ip.is_private and not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified), "invalid_fixture_lan_ip")
    endpoint = str(ip) + ":5555"
    require(allow_new_ip or endpoint == credentials["endpoint"], "active_ip_does_not_match_endpoint")
    return {"connected": True, "ssidMatches": True, "endpointUnchanged": endpoint == credentials["endpoint"]}, endpoint


class Audit:
    def __init__(self, cfg, output):
        self.cfg = cfg
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.output = output

    def save(self, name, value):
        fd = os.open(self.output/name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(value, file, indent=2); file.write("\n"); file.flush(); os.fsync(file.fileno())
        fd = os.open(self.output, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def event(self, operation, **fields):
        fd = os.open(self.output/"events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump({"at": time.time(), "operation": operation, **fields}, file)
            file.write("\n"); file.flush(); os.fsync(file.fileno())

    def command(self, label, argv):
        argv = [str(self.cfg.adb), *argv[1:]] if argv and argv[0] == "adb" else argv
        started = time.monotonic()
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        self.event(label, exitCode=p.returncode, elapsedSeconds=round(time.monotonic()-started, 3))
        require(p.returncode == 0, "command_failed_" + label)
        return p.stdout.strip()


def adb_transport(audit, endpoint):
    rows = [r.split() for r in audit.command("adb_inventory", ["adb", "devices", "-l"]).splitlines()]
    rows = [r for r in rows if r and r[0] == endpoint]
    require(len(rows) == 1 and len(rows[0]) > 2 and rows[0][1] == "device", "selected_adb_unavailable")
    ids = [r.split(":", 1)[1] for r in rows[0] if r.startswith("transport_id:")]
    require(len(ids) == 1 and ids[0].isdigit(), "transport_id_invalid")
    return ids[0]

