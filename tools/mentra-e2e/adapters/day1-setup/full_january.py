#!/usr/bin/env python3
"""One-shot January full-OTA setup beneath the caller-owned harness lease."""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import shlex
import uuid
import subprocess
import sys
import time
import zipfile

HERE = Path(__file__).resolve().parent
import config
from config import PROFILE as BASELINE
import recover_wiped as recovery
import ble_support as rehearse
import bes_continuity as continuity
import factory_asg

Guard, require = rehearse.Guard, rehearse.require
SOURCE, TARGET, EPOCH = BASELINE['sourceVersion'], BASELINE['targetVersion'], BASELINE['sourceEpoch']
ZIP_SHA, PAYLOAD_SHA, ZIP_BYTES = BASELINE['otaSha256'], BASELINE['payloadSha256'], BASELINE['otaBytes']
VERIFICATION_SHA = BASELINE['verificationSha256']
HELPER_SHA, PROBE_SHA = config.HELPER_SHA, config.PROBE_SHA
HELPER_REMOTE_PROBE = "/data/local/tmp/mentra-update-engine-status.jar"
REMOTE_PROBE = "/data/local/tmp/mentra-update-engine-status-" + PROBE_SHA + ".jar"
POWER_HELPER, VERSION_HELPER = HERE / 'observe_power.py', HERE / 'query_bes_version.py'
UUID = recovery.UUID


def digest(path):
    with path.open("rb") as file:
        value = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def save(path, value):
    recovery.claim_once(path, value)
    return {"path": str(path), "sha256": digest(path)}


def private(path):
    return recovery.private_json(path)[0]


def pin_tools(cfg):
    cfg.verify_definition()
    cfg.helper.verify()
    cfg.probe.verify()
    require(cfg.python.is_file() and os.access(cfg.python, os.X_OK)
            and cfg.adb.is_file() and os.access(cfg.adb, os.X_OK), "configured_runtime_missing")
    # The unchanged helper creates its own read-only logcat process via PATH.
    # Require that resolution to select the configured ADB; do not alter host PATH.
    import shutil
    require(shutil.which('adb') is not None and Path(shutil.which('adb')).resolve() == cfg.adb.resolve(),
            "stage_helper_adb_path_mismatch")
    spec = importlib.util.spec_from_file_location("audited_mtk_stage", cfg.helper.path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def artifact(cfg):
    require(cfg.ota.path.is_file() and cfg.ota.path.stat().st_size == ZIP_BYTES and digest(cfg.ota.path) == ZIP_SHA, "local_ota_mismatch")
    proof = cfg.verification.path
    require(digest(proof) == VERIFICATION_SHA, "offline_verification_changed")
    report = json.loads(proof.read_bytes())
    v = report["verification"]
    require(report["status"] == "artifact-verified" and v["payloadSignatureVerification"] == "passed"
            and v["targetPartitionVerification"] == "passed" and v["otaSha256"] == ZIP_SHA
            and v["payload"]["minorVersion"] == 0 and v["payload"]["powerwash"] is True
            and v["payload"]["maxTimestamp"] == int(EPOCH) and v["payload"]["payloadSha256"] == PAYLOAD_SHA
            and v["source"]["version"] == SOURCE and v["source"]["timestamp"] == EPOCH
            and v["target"]["version"] == TARGET, "offline_verification_incompatible")
    with zipfile.ZipFile(cfg.ota.path) as archive:
        require(len(archive.namelist()) == len(set(archive.namelist())), "duplicate_zip_entries")
        metadata = dict(line.split("=", 1) for line in archive.read("META-INF/com/android/metadata").decode().splitlines())
        properties = dict(line.split("=", 1) for line in archive.read("payload_properties.txt").decode().splitlines())
        require(metadata.get("ota-type") == "AB" and metadata.get("ota-wipe") == "yes"
                and metadata.get("ota-downgrade") == "yes" and properties.get("POWERWASH") == "1", "ota_not_full_wipe")
    return {"path": str(cfg.ota.path), "sha256": ZIP_SHA, "bytes": ZIP_BYTES, "payloadSha256": PAYLOAD_SHA,
            "verificationPath": str(proof), "verificationSha256": VERIFICATION_SHA,
            "sourceVersion": SOURCE, "sourceEpoch": EPOCH, "targetVersion": TARGET,
            "payloadSignatureVerifiedOffline": True, "targetPartitionBytesVerifiedOffline": True}


class Audit:
    def __init__(self, cfg, path):
        self.cfg = cfg
        path.mkdir(mode=0o700, exist_ok=False)
        self.path, self.sequence = path, 0

    def event(self, operation, **values):
        fd = os.open(self.path / "events.jsonl", os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump({"at": time.time(), "operation": operation, **values}, file)
            file.write("\n"); file.flush(); os.fsync(file.fileno())

    def run(self, argv, timeout=30):
        argv = [str(self.cfg.adb), *argv[1:]] if argv and argv[0] == "adb" else argv
        started = time.time()
        try:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
            record = {"exitCode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}
        except BaseException as exc:
            record = {"interrupted": True, "errorClass": type(exc).__name__}
            raise
        finally:
            self.sequence += 1
            save(self.path / f"command-{self.sequence:04d}.json", {"argv": argv, "startedAt": started,
                 "endedAt": time.time(), "elapsedSeconds": time.time()-started, **record})
        return p

    def shell(self, transport, command, timeout=30):
        p = self.run(["adb", "-t", transport, "shell", command], timeout)
        require(p.returncode == 0, "adb_read_failed")
        return p.stdout.strip().rstrip("\r")


def lease(cfg):
    cfg.require_lease()


def endpoint(value):
    host, sep, port = value.rpartition(":")
    ip = ipaddress.IPv4Address(host)
    require(sep == ":" and port == "5555" and str(ip) == host and ip.is_private
            and not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified), "unsafe_endpoint")
    return value


def transport(audit, address):
    p = audit.run(["adb", "devices", "-l"])
    require(p.returncode == 0, "adb_inventory_failed")
    rows = [row.split() for row in p.stdout.splitlines() if row.split() and row.split()[0] == address]
    require(len(rows) == 1 and len(rows[0]) >= 3 and rows[0][1] == "device"
            and not any(x.startswith("usb:") for x in rows[0]), "exact_wifi_transport_unavailable")
    ids = [x.split(":", 1)[1] for x in rows[0] if x.startswith("transport_id:")]
    require(len(ids) == 1 and ids[0].isdigit(), "transport_ambiguous")
    return ids[0]


def source_identity(cfg, audit, address, expected=None):
    t = transport(audit, address)
    sh = lambda command: audit.shell(t, command)
    boot = sh("cat /proc/sys/kernel/random/boot_id")
    value = {"boot": boot, "cid": sh("cat /sys/block/mmcblk0/device/cid"),
             "serial": sh("getprop ro.serialno"), "bootSerial": sh("getprop ro.boot.serialno"),
             "mac": sh("getprop persist.mentra.live.mac"), "mtk": sh("getprop ro.custom.ota.version"),
             "epoch": sh("getprop ro.build.date.utc"), "slot": sh("getprop ro.boot.slot_suffix"),
             "uid": sh("id -u"), "bootCompleted": sh("getprop sys.boot_completed")}
    audit.event("source_identity_observed", transport=t, endpoint=address, identity=value)
    require(value["cid"] == dict(cfg.fixture)["cid"] and value["serial"] in cfg.serial_aliases
            and value["bootSerial"] == cfg.boot_serial and value["mac"].upper() == dict(cfg.fixture)["mac"]
            and value["mtk"] == SOURCE and value["epoch"] == EPOCH and value["slot"] in ("_a", "_b")
            and re.fullmatch(UUID, boot) and value["uid"] == "2000" and value["bootCompleted"] == "1", "source_identity_mismatch")
    require(expected is None or value == expected, "source_changed_during_operation")
    require(sh("cat /proc/sys/kernel/random/boot_id") == boot and transport(audit, address) == t, "source_changed_during_identity")
    return t, value


def app_absent(cfg, audit):
    p = audit.run(["pgrep", "-x", cfg.app_name])
    require(p.returncode == 1 and not p.stdout.strip(), "normal_mentra_app_still_running")
    audit.event("normal_mentra_process_absent", executableName=cfg.app_name, processAbsent=True)


def capacity(audit, t, required_bytes):
    lines = audit.shell(t, "df -k /data").splitlines()
    require(len(lines) >= 2, "capacity_unreadable")
    fields = lines[-1].split()
    require(len(fields) >= 6 and fields[3].isdigit(), "capacity_unreadable")
    available = int(fields[3])*1024
    require(available >= required_bytes, "insufficient_userdata_capacity")
    # Keep Android's observation for diagnosis. It is not the separate BES battery/PMU.
    audit.shell(t, "dumpsys battery")
    audit.event("capacity_verified", availableBytes=available, requiredBytes=required_bytes,
                androidBatteryUsedForSafetyGate=False)


def verified_usb(cfg, audit, source):
    p = audit.run(["adb", "devices", "-l"])
    require(p.returncode == 0, "usb_inventory_failed")
    candidates = [row.split() for row in p.stdout.splitlines() if row.split() and row.split()[0] in cfg.serial_aliases
                  and len(row.split()) > 1 and row.split()[1] == "device" and any(x.startswith("usb:") for x in row.split())]
    require(len(candidates) == 1, "identified_usb_power_connection_required")
    ids = [x.split(":", 1)[1] for x in candidates[0] if x.startswith("transport_id:")]
    require(len(ids) == 1 and ids[0].isdigit(), "usb_transport_ambiguous")
    t = ids[0]
    for command, expected in (("cat /proc/sys/kernel/random/boot_id", source["boot"]),
            ("cat /sys/block/mmcblk0/device/cid", dict(cfg.fixture)["cid"]), ("getprop ro.boot.serialno", cfg.boot_serial),
            ("getprop persist.mentra.live.mac", dict(cfg.fixture)["mac"]), ("getprop ro.custom.ota.version", SOURCE),
            ("cat /proc/sys/kernel/random/boot_id", source["boot"])):
        require(audit.shell(t, command) == expected, "usb_identity_mismatch")
    return {"transport": t, "serial": dict(cfg.fixture)["serial"], "cid": dict(cfg.fixture)["cid"], "boot": source["boot"],
            "usbAttached": True, "chargingInferred": False}


def power_ready(cfg, audit, operation, label):
    before_write(cfg, audit, operation)
    started = time.time()
    directory = audit.path / ("power-"+label)
    p = audit.run([str(cfg.python), str(POWER_HELPER), *cfg.child_args, "--out", str(directory)], 75)
    require(p.returncode == 0, "fresh_bes_power_observation_failed")
    value = private(directory / "result.json")
    require(value.get("status") == "passed" and value.get("mac") == dict(cfg.fixture)["mac"]
            and value.get("source") == "fresh MAC-identified BES sr_hrt" and value.get("queryCount") == 1
            and value.get("firmwareWrites") == 0 and value.get("mtkReady") is True
            and started <= value["sentAt"] <= value["observedAt"] <= value["identityRecheckedAt"] <= time.time()
            and time.time()-value["observedAt"] <= 30
            and type(value.get("batteryPercent")) is int and 50 <= value["batteryPercent"] <= 100
            and type(value.get("voltageMillivolts")) is int and 2500 <= value["voltageMillivolts"] <= 5000
            and (value.get("charging") is None or type(value["charging"]) is bool), "bes_power_not_ready")
    usb = None if value["charging"] is True else verified_usb(cfg, audit, operation["source"])
    before_write(cfg, audit, operation)
    result = {"besObservationSha256": digest(directory / "result.json"), "batteryPercent": value["batteryPercent"],
              "charging": value["charging"], "usb": usb, "sourceBoot": operation["source"]["boot"],
              "basis": "BES PMU charging" if usb is None else "fresh BES battery plus identified live USB attachment",
              "chargingNotInferredFromVoltageOrAdb": True}
    save(directory / "bound-result.json", result)
    audit.event("power_precondition_verified", **result)
    return result


def status_probe_command(argv):
    # The pinned shared helper has no remote-path option. Remap only its exact two
    # read-only probe commands, preserving its hash guard and status parser.
    if len(argv) == 5 and argv[:2] == ["adb", "-t"] and argv[3] == "shell":
        exact = (f"sha256sum {HELPER_REMOTE_PROBE} | cut -d' ' -f1",
                 f"CLASSPATH={HELPER_REMOTE_PROBE} app_process /system/bin UpdateEngineStatus")
        if argv[4] in exact: return [*argv[:4], argv[4].replace(HELPER_REMOTE_PROBE, REMOTE_PROBE)]
    return argv


def activity_responses(text, pid, version_id, activity_id, earliest, latest):
    """Only exact release output envelopes inside the current process/uptime interval."""
    found = {"version": [], "activity": []}
    version_prefix = ("BLE_TRACE direction=glasses_to_phone layer=asg_ble_output "
                      "source=asg_client type=version_info_1 bytes=")
    for line in text.splitlines():
        row = re.match(r'^\s*([0-9]+\.[0-9]+)\s+(\d+)\s+\d+\s+[A-Z]\s+([^:]+):\s?(.*)$', line)
        if not row or row[2] != pid or not earliest <= float(row[1]) <= latest: continue
        tag, message = row[3].strip(), row[4]
        if tag == "MentraBleTrace" and message.startswith(version_prefix):
            payload = re.fullmatch(r'[1-9]\d* payload=(\{.*\})', message[len(version_prefix):])
            if payload:
                value = json.loads(payload[1])
                if value.get("type") == "version_info_1" and value.get("request_id") == version_id:
                    found["version"].append(value)
        elif tag == "OtaCommandHandler" and message.startswith("OTA activity snapshot: "):
            value = json.loads(message[len("OTA activity snapshot: "):])
            if isinstance(value, dict) and value.get("request_id") == activity_id: found["activity"].append(value)
    require(all(len(values) <= 1 for values in found.values()), "activity_response_ambiguous")
    return found


def activity_snapshot(cfg, audit, operation, t, pid, expected_asg):
    """Two once-only diagnostics; use short fresh response logs, never the historical ring."""
    version_id, activity_id = "setup-version-"+uuid.uuid4().hex, "setup-activity-"+uuid.uuid4().hex
    started = time.time()
    before_uptime = float(audit.shell(t, "cat /proc/uptime").split()[0])
    requests = ({"type": "request_version", "request_id": version_id},
                {"type": "ota_query_status", "include_activity": True, "request_id": activity_id})
    for request in requests:
        command = ("am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver "
                   "-a com.mentra.asg_client.ACTION_SEND_COMMAND --es json "
                   + shlex.quote(json.dumps(request, separators=(",", ":"))))
        checked_write(cfg, audit, operation, ["adb", "-t", t, "shell", command])
    deadline = time.monotonic()+15
    while True:
        p = audit.run(["adb", "-t", t, "logcat", "-b", "main", "-d", "-v", "threadtime",
                       "-v", "monotonic", "-v", "usec", "--pid", pid], 20)
        require(p.returncode == 0, "activity_response_log_unavailable")
        after_uptime = float(audit.shell(t, "cat /proc/uptime").split()[0])
        require(0 <= before_uptime <= after_uptime and time.time()-started <= 60, "activity_capture_unbounded")
        found = activity_responses(p.stdout, pid, version_id, activity_id, before_uptime, after_uptime)
        if all(len(values) == 1 for values in found.values()): break
        require(time.monotonic() < deadline, "fresh_activity_response_missing_no_resend")
        time.sleep(0.25)
    observed = continuity.validate_activity(found["activity"][0], found["version"][0], activity_id, version_id,
                                            expected_asg, before_uptime, after_uptime, require)
    return {**observed, "queryStartedAt": started, "observedAt": time.time(),
            "responseUptimeBounds": {"before": before_uptime, "after": after_uptime},
            "responseLogSha256": hashlib.sha256(p.stdout.encode()).hexdigest()}


def bes_source_span(cfg, audit, operation, label, prior=None):
    t = before_write(cfg, audit, operation)
    evidence = recovery.referenced(operation["besContinuity"])
    evidence = continuity.validate_input(evidence, operation["source"], dict(cfg.fixture), require, digest)
    pid = audit.shell(t, "pidof com.mentra.asg_client")
    require(pid.isdigit(), "bes_asg_process_ambiguous")
    proc = audit.shell(t, f"cat /proc/{pid}/stat")
    start_ticks = proc.rsplit(") ", 1)[1].split()[19]
    require(start_ticks.isdigit(), "bes_asg_process_start_unreadable")
    path = audit.shell(t, "pm path com.mentra.asg_client")
    require(re.fullmatch(r"package:/[A-Za-z0-9_./=+~-]+\.apk", path), "bes_asg_path_ambiguous")
    require(audit.shell(t, "sha256sum "+path[8:]).split()[0] == evidence["asgSha256"], "bes_asg_bytes_changed")
    activity = activity_snapshot(cfg, audit, operation, t, pid, evidence["asgVersionCode"])
    if prior is None:
        # Query only after the slower artifact/identity/power/activity checks. January
        # replies to BLE cs_syvr over UART; do not restart its already-working reader.
        before_write(cfg, audit, operation)
        query_dir = audit.path / ("bes-query-"+label)
        started = time.time()
        p = audit.run([str(cfg.python), str(VERSION_HELPER), *cfg.child_args, "--operation", str(audit.path / "operation.json"),
                       "--out", str(query_dir), "--pid", pid, "--start-ticks", start_ticks,
                       "--asg-sha", evidence["asgSha256"], "--lease-pid", str(os.getppid())], 75)
        require(p.returncode == 0, "fresh_bes_query_failed_no_resend")
        query = private(query_dir / "result.json")
        require(query.get("status") == "query-dispatched" and query.get("command") == "cs_syvr"
                and query.get("count") == 1 and query.get("firmwareWrites") == 0
                and query.get("mac") == dict(cfg.fixture)["mac"] and query.get("boot") == operation["source"]["boot"]
                and query.get("pid") == pid and query.get("startTicks") == start_ticks
                and query.get("asgSha256") == evidence["asgSha256"]
                and started <= query["sentAt"] <= query["identityRecheckedAt"] <= time.time(), "fresh_bes_query_not_bound")
        boundary = query["deviceEpochBoundary"]
        require(re.fullmatch(r"[0-9]{10}\.[0-9]{9}", boundary), "bes_query_boundary_invalid")
        deadline = time.monotonic()+10
        while True:
            p = audit.run(["adb", "-t", t, "logcat", "-b", "all", "-d", "-v", "epoch", "--pid", pid,
                           "-T", boundary[:14]], 20)
            require(p.returncode == 0, "bes_source_log_unavailable")
            short = query_span(p.stdout, float(boundary))
            now = float(audit.shell(t, "date +%s.%N"))
            try:
                proof = continuity.check_source_span(short, evidence, operation["source"]["boot"], pid, now, require)
                break
            except Guard as exc:
                require(str(exc) == "bes_owned_current_boot_proof_missing" and time.monotonic() < deadline, str(exc))
                time.sleep(0.25)
        initial_log_sha = hashlib.sha256(short.encode()).hexdigest()
        save(audit.path / ("bes-query-log-"+label+".json"), {"deviceEpochBoundary": boundary, "text": short,
             "sha256": initial_log_sha, "queryResultSha256": digest(query_dir / "result.json")})
    else:
        require(prior["sourceBoot"] == operation["source"]["boot"], "bes_source_boot_changed")
        continuity.unchanged_generation(prior, activity, pid, start_ticks, require)
        proof, initial_log_sha = prior["proof"], prior["initialProofLogSha256"]
    require(audit.shell(t, f"cat /proc/{pid}/stat").rsplit(") ",1)[1].split()[19] == start_ticks
            and audit.shell(t, "pidof com.mentra.asg_client") == pid, "bes_asg_changed_during_observation")
    before_write(cfg, audit, operation)
    result = {"pid": pid, "startTicks": start_ticks, "proof": proof, "sourceBoot": operation["source"]["boot"],
              "capturedAt": time.time(), "initialProofLogSha256": initial_log_sha, "activity": activity,
              "noAsgOtaAdmissionDuringInterval": True, "historicalRingRetentionRequired": False, "setupOnly": True}
    save(audit.path / ("bes-source-"+label+".json"), result)
    return result


def query_span(raw, boundary):
    """Exclude only definitely older timestamped rows; retain unknown gap diagnostics."""
    return "\n".join(line for line in raw.splitlines()
                     if not (match := re.match(r'^\s*([0-9]+\.[0-9]+)\s+', line)) or float(match[1]) >= boundary)


def finish_bes_continuity(cfg, audit, operation, wipe):
    after = private(audit.path / "recovery/after.json")
    require(wipe["status"] == "passed" and wipe["newBoot"] == after["boot"]
            and after["boot"] != operation["source"]["boot"] and after["asgSha256"] == BASELINE["asgSha256"],
            "bes_continuity_target_not_verified")
    t = transport(audit, after["freshBleBridge"]["endpoint"])
    pid = audit.shell(t, "pidof com.mentra.asg_client")
    require(pid.isdigit(), "january_asg_process_ambiguous")
    start_ticks = audit.shell(t, f"cat /proc/{pid}/stat").rsplit(") ",1)[1].split()[19]
    p = audit.run(["adb", "-t", t, "logcat", "-b", "all", "-d", "-v", "epoch", "--pid", pid], 30)
    require(p.returncode == 0, "january_startup_log_unavailable")
    device_epoch = float(audit.shell(t, "date +%s"))
    uptime = float(audit.shell(t, "cat /proc/uptime").split()[0])
    require(uptime > 0 and start_ticks.isdigit(), "january_process_clock_unreadable")
    continuity.check_january_span(p.stdout, pid, require, device_epoch-uptime, device_epoch)
    asg = factory_asg.verify(cfg, lambda label, *argv: audit.shell(t, shlex.join(argv)))
    require(asg == after["factoryAsgIdentity"], "january_asg_changed_after_wipe_proof")
    require(audit.shell(t, "cat /proc/sys/kernel/random/boot_id") == after["boot"]
            and audit.shell(t, "pidof com.mentra.asg_client") == pid
            and audit.shell(t, f"cat /proc/{pid}/stat").rsplit(") ",1)[1].split()[19] == start_ticks,
            "january_process_changed_during_continuity")
    original = private(audit.path.parent / "bes-source-before-transfer.json")
    closing = private(audit.path / "bes-source-before-reboot.json")
    require(original["proof"] == closing["proof"], "bes_continuity_interval_changed")
    continuity.unchanged_generation(original, closing["activity"], closing["pid"], closing["startTicks"], require)
    result = {"schemaVersion": 1, "status": "passed", "kind": "verified-install-continuity", "setupOnly": True,
              "version": continuity.VERSION, "sourceBoot": operation["source"]["boot"], "newBoot": after["boot"],
              "originalBesObservedDeviceEpoch": original["proof"]["stamp"], "closedAt": time.time(),
              "installEvidence": operation["besContinuity"], "mtkOwner": operation["owner"], "mtkSha256": ZIP_SHA,
              "admissionGeneration": original["activity"]["admissionGeneration"],
              "processSid": original["activity"]["processSid"],
              "sourceIntervalBasis": "Same ASG bytes/PID/start/SID, consistent idle snapshots and unchanged admission generation",
              "payloadSha256": PAYLOAD_SHA, "factoryAsgSha256": BASELINE["asgSha256"],
              "januaryStartupLogSha256": hashlib.sha256(p.stdout.encode()).hexdigest(),
              "postWipeFreshBesObserved": False, "usableAsFinalModernFirmwareProof": False,
              "scope": "Verified January BES install retained across the exclusively owned MTK-only setup operation",
              "limitation": "Bounded controller/ASG writer continuity; not a post-wipe BES readback or protection against unowned physical/remote changes"}
    save(audit.path / "bes-continuity-result.json", result)
    return result


def one_claim(directory, name, value):
    directory.mkdir(mode=0o700, exist_ok=True)
    require(directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o777 == 0o700
            and not directory.is_symlink(), "claim_directory_not_private")
    return save(directory/name, value)


def before_write(cfg, audit, operation):
    lease(cfg)
    app_absent(cfg, audit)
    require(operation["configSha256"] == cfg.sha256 and operation["profileSha256"] == config.PROFILE_SHA, "operation_config_changed")
    require(rehearse.load_credentials(cfg, cfg.credential.path)[1] == operation["credentialFileSha256"], "credentials_changed")
    return source_identity(cfg, audit, operation["endpoint"], operation["source"])[0]


def checked_write(cfg, audit, operation, argv, timeout=30):
    t = before_write(cfg, audit, operation)
    require(argv[:3] == ["adb", "-t", t], "write_transport_changed")
    p = audit.run(argv, timeout)
    require(p.returncode == 0, "write_dispatch_failed_do_not_resend")
    return p


def read_status(cfg, helper, audit, t, use_probe):
    original = helper.run
    helper.run = lambda argv, timeout=30: audit.run(status_probe_command(argv), timeout)
    try:
        result = helper.update_engine_status(t, cfg.probe.path if use_probe else None, PROBE_SHA if use_probe else None)
        audit.event("update_engine_status", **result)
        return result["current_op"]
    finally:
        helper.run = original


def ensure_probe(cfg, audit, operation, t):
    p = audit.run(["adb", "-t", t, "shell", "command -v update_engine_client"])
    if p.returncode == 0 and p.stdout.strip():
        return False
    require(p.returncode == 1 and not p.stdout.strip(), "status_client_probe_failed")
    exists = audit.run(["adb", "-t", t, "shell", f"test -e {REMOTE_PROBE} || test -L {REMOTE_PROBE}"])
    require(exists.returncode in (0, 1), "status_probe_presence_unknown")
    if exists.returncode == 1:
        save(audit.path / "probe-intent.json", {"owner": operation["owner"], "at": time.time(),
             "local": str(cfg.probe.path), "sha256": PROBE_SHA, "remote": REMOTE_PROBE, "count": 1})
        checked_write(cfg, audit, operation, ["adb", "-t", t, "push", str(cfg.probe.path), REMOTE_PROBE])
    observed = audit.shell(t, f"sha256sum {REMOTE_PROBE}").split()
    require(bool(observed) and observed[0] == PROBE_SHA, "existing_status_probe_not_reviewed")
    return True


def run_stage_helper(cfg, helper, audit, operation, use_probe):
    t = source_identity(cfg, audit, operation["endpoint"], operation["source"])[0]
    remote = operation["remote"]
    broadcast = ["adb", "-t", t, "shell", "am", "broadcast", "-a", "com.xy.updateota", "-p", "com.android.systemui",
                 "--es", "cmd", "start", "--es", "pkname", "com.mentra.asg_client", "--es", "path", remote]
    original_run, original_argv = helper.run, sys.argv
    def guarded_run(argv, timeout=10):
        marker = len(argv) == 5 and argv[:4] == ["adb", "-t", t, "shell"] and re.fullmatch(
            r"log -t MentraMtkStage -p i mentra-mtk-stage-[a-f0-9]{32}", argv[4])
        if argv == broadcast:
            capacity(audit, t, 512*1024*1024)
            power_ready(cfg, audit, operation, "before-apply")
            bes_source_span(cfg, audit, operation, "before-apply", private(audit.path / "bes-source-before-transfer.json"))
            require(read_status_isolated(cfg, audit, t, use_probe) == helper.UPDATE_STATUS_IDLE, "update_not_idle_at_dispatch")
            require(before_write(cfg, audit, operation) == t, "apply_transport_changed")
            save(audit.path / "apply-intent.json", {"owner": operation["owner"], "at": time.time(),
                 "source": operation["source"], "otaSha256": ZIP_SHA, "remote": remote, "applyCount": 1, "resendAllowed": False})
            audit.event("apply_dispatch_started")
        elif marker:
            require(before_write(cfg, audit, operation) == t, "marker_transport_changed")
        else:
            require(argv[:3] == ["adb", "-t", t] or argv == ["adb", "devices", "-l"], "unexpected_stage_tool_command")
            require(argv == ["adb", "devices", "-l"] or (len(argv) == 5 and argv[3] == "shell"
                    and argv[4].startswith(("getprop ", "cat /", "stat -c ", "sha256sum ", "update_engine_client --status", "CLASSPATH="))),
                    "unexpected_stage_tool_write")
        return audit.run(status_probe_command(argv), timeout)
    helper.run = guarded_run
    sys.argv = [str(cfg.helper.path), "--transport", t, "--wifi-endpoint", operation["endpoint"], "--expected-version", SOURCE,
                "--expected-emmc-cid", dict(cfg.fixture)["cid"], "--remote", remote, "--size", str(ZIP_BYTES), "--sha256", ZIP_SHA,
                "--output", str(audit.path / "audited-stage"), "--timeout", "1800"]
    if use_probe: sys.argv += ["--update-engine-status-jar", str(cfg.probe.path)]
    audit.event("audited_stage_invocation", argv=sys.argv, helperSha256=HELPER_SHA,
                logcatArgs=["adb", "-t", t, "logcat", "-b", "all", "-v", "threadtime", "-T", "1",
                            "-s", "update_engine:I", "_otaupdate_:V", "MentraMtkStage:I"])
    try:
        helper.main()
    finally:
        helper.run, sys.argv = original_run, original_argv
    result = json.loads((audit.path / "audited-stage/result.json").read_bytes())
    require(result.get("success") is True and result["post_update_engine"]["current_op"] == helper.UPDATE_STATUS_UPDATED_NEED_REBOOT,
            "staged_success_not_proven")
    return result


def read_status_isolated(cfg, audit, t, use_probe):
    # A second module avoids recursively invoking the helper's dispatch interceptor.
    return read_status(cfg, pin_tools(cfg), audit, t, use_probe)


def stage(cfg, args, helper, audit):
    require(re.fullmatch(UUID, args.owner or ""), "explicit_owner_uuid_required")
    address = cfg.source_endpoint
    lease(cfg)
    app_absent(cfg, audit)
    credentials_sha = rehearse.load_credentials(cfg, cfg.credential.path)[1]
    local = artifact(cfg)
    save(audit.path / "artifact.json", local)
    t, source = source_identity(cfg, audit, address)
    capacity(audit, t, ZIP_BYTES+1024*1024*1024)
    cfg.bes_install.verify()
    continuity_value = private(cfg.bes_install.path)
    continuity.validate_input(continuity_value, source, dict(cfg.fixture), require, digest)
    continuity_ref = save(audit.path / "bes-continuity-input.json", continuity_value)
    operation = {"schemaVersion": 1, "owner": args.owner, "endpoint": address, "source": source,
                 "remote": f"/storage/emulated/0/asg/january-full-{args.owner}.zip",
                 "otaSha256": ZIP_SHA, "appExecutableName": cfg.app_name, "configSha256": cfg.sha256,
                 "profileSha256": config.PROFILE_SHA, "besContinuity": continuity_ref,
                 "credentialFileSha256": credentials_sha, "createdAt": time.time(), "run": str(audit.path)}
    cfg.prepare_claims()
    claim = one_claim(cfg.stage_claims, source["boot"]+"-"+ZIP_SHA+".json", operation)
    operation["claim"] = claim
    save(audit.path / "operation.json", operation)
    stage_transfer(cfg, helper, audit, operation, local)


def stage_transfer(cfg, helper, audit, operation, local):
    """Previously unentered transfer/apply boundary; owner/claim creation stays outside."""
    power_ready(cfg, audit, operation, "before-transfer")
    bes_source_span(cfg, audit, operation, "before-transfer")
    t = before_write(cfg, audit, operation)
    use_probe = ensure_probe(cfg, audit, operation, t)
    require(read_status(cfg, helper, audit, t, use_probe) == helper.UPDATE_STATUS_IDLE, "update_not_idle")
    exists = audit.run(["adb", "-t", t, "shell", f"test -e {operation['remote']} || test -L {operation['remote']}"])
    require(exists.returncode == 1, "ota_remote_exists_or_unknown_do_not_overwrite")
    require(audit.shell(t, "test -d /storage/emulated/0/asg && echo present") == "present", "asg_directory_missing")
    save(audit.path / "transfer-intent.json", {"owner": operation["owner"], "at": time.time(), "ota": local,
         "remote": operation["remote"], "count": 1, "resendAllowed": False})
    transfer_started = time.time()
    audit.event("transfer_started")
    checked_write(cfg, audit, operation, ["adb", "-t", t, "push", str(cfg.ota.path), operation["remote"]], 1200)
    transfer_finished = time.time()
    audit.event("transfer_finished")
    source_identity(cfg, audit, operation["endpoint"], operation["source"])
    staged = run_stage_helper(cfg, helper, audit, operation, use_probe)
    apply_observed = time.time()
    audit.event("payload_apply_completed", updateEngine="UPDATED_NEED_REBOOT")
    source_identity(cfg, audit, operation["endpoint"], operation["source"])
    save(audit.path / "stage-result.json", {"status": "staged-awaiting-explicit-activation", "owner": operation["owner"],
         "operationSha256": digest(audit.path / "operation.json"), "payloadApplied": True,
         "useStatusProbe": use_probe, "updateEngineStatus": "UPDATED_NEED_REBOOT", "completedAt": time.time(),
         "stageResultSha256": digest(audit.path / "audited-stage/result.json"), "source": operation["source"],
         "besSourceSha256": digest(audit.path / "bes-source-before-transfer.json"),
         "targetSlot": "_b" if operation["source"]["slot"] == "_a" else "_a", "activationCount": 0,
         "timings": {"transferStartedAt": transfer_started, "transferFinishedAt": transfer_finished,
                     "transferSeconds": transfer_finished-transfer_started,
                     "applyDispatchAt": private(audit.path / "apply-intent.json")["at"],
                     "applySuccessObservedAt": apply_observed,
                     "applySecondsUntilObservation": apply_observed-private(audit.path / "apply-intent.json")["at"]},
         "customerRoutinePassed": False, "fixtureReadyForOtherRoutines": False})


def activation_inputs(cfg, run):
    require(not (run / "failure.json").exists(), "failed_stage_requires_readonly_reconciliation")
    operation = private(run / "operation.json")
    result = private(run / "stage-result.json")
    require(operation["run"] == str(run) and operation["appExecutableName"] == cfg.app_name
            and operation["configSha256"] == cfg.sha256 and operation["profileSha256"] == config.PROFILE_SHA,
            "operation_path_or_config_changed")
    require(result["status"] == "staged-awaiting-explicit-activation" and result["payloadApplied"] is True
            and result["activationCount"] == 0 and result["owner"] == operation["owner"]
            and result["operationSha256"] == digest(run / "operation.json")
            and result["stageResultSha256"] == digest(run / "audited-stage/result.json")
            and result["source"] == operation["source"] and operation["otaSha256"] == ZIP_SHA
            and isinstance(operation.get("besContinuity"), dict)
            and result.get("besSourceSha256") == digest(run / "bes-source-before-transfer.json"), "staging_proof_changed")
    require(operation["claim"]["path"] == str(cfg.stage_claims / (operation["source"]["boot"]+"-"+ZIP_SHA+".json")),
            "operation_claim_path_changed")
    claim = recovery.referenced(operation["claim"])
    require(claim == {key: value for key, value in operation.items() if key != "claim"}, "operation_claim_changed")
    return operation, result


def make_activation_intent(cfg, operation, target_slot):
    source = operation["source"]
    return {"schemaVersion": 1, "owner": operation["owner"], "operation": "activate-full-ota", "fixture": dict(cfg.fixture),
            "source": {"boot": source["boot"], "slot": source["slot"], "mtk": source["mtk"]},
            "target": {"slot": target_slot, "mtk": TARGET, "asgVersionCode": 27, "asgSha256": BASELINE["asgSha256"]},
            "ota": {"kind": "full", "sha256": ZIP_SHA, "payloadSha256": PAYLOAD_SHA, "powerwash": True},
            "createdAt": time.time(), "activationCount": 1, "resendAllowed": False}


def capture_recovery_log(audit, t, name):
    """Optional read-only corroboration; unavailable pmsg is never a wipe assertion."""
    try:
        p = audit.run(["adb", "-t", t, "logcat", "-L", "-b", "all", "-d", "-v", "epoch"], 30)
        raw = p.stdout
        result = {"available": p.returncode == 0, "exitCode": p.returncode,
                  "sha256": hashlib.sha256(raw.encode()).hexdigest(),
                  "wipeReasonReported": "wipe_data_from_ota" in raw,
                  "dataFormatReported": "Formatting /data" in raw,
                  "dataWipeCompleteReported": "Data wipe complete." in raw}
    except subprocess.TimeoutExpired:
        result = {"available": False, "reason": "read_timeout"}
    save(audit.path / name, result)
    return result


def prepare_wipe_witness(cfg, audit, operation):
    t = before_write(cfg, audit, operation)
    remote = f"/data/local/tmp/mentra-day1-wipe-{operation['owner']}.json"
    probe = audit.run(["adb", "-t", t, "shell", f"test -e {remote} || test -L {remote}"])
    require(probe.returncode == 1, "wipe_witness_exists_or_unknown_no_overwrite")
    require(audit.shell(t, "test -d /data/local/tmp && test -w /data/local/tmp && echo ready") == "ready",
            "wipe_witness_parent_unavailable")
    marker = {"owner": operation["owner"], "sourceBoot": operation["source"]["boot"],
              "otaSha256": ZIP_SHA, "createdAt": time.time(), "purpose": "owned userdata reset witness"}
    local = save(audit.path / "wipe-witness.json", marker)
    save(audit.path / "wipe-witness-intent.json", {"owner": operation["owner"], "remote": remote,
         "local": local, "sourceBoot": operation["source"]["boot"], "at": time.time(), "writeCount": 1, "resendAllowed": False})
    checked_write(cfg, audit, operation, ["adb", "-t", t, "push", local["path"], remote])
    # The source's toybox sync takes no file argument. Flush before readback so a
    # later missing marker is not merely an unflushed write lost during reboot.
    checked_write(cfg, audit, operation, ["adb", "-t", t, "shell", "sync"])
    t = source_identity(cfg, audit, operation["endpoint"], operation["source"])[0]
    observed_hash = audit.shell(t, f"sha256sum {remote}").split()
    require(bool(observed_hash) and observed_hash[0] == local["sha256"]
            and json.loads(audit.shell(t, f"cat {remote}")) == marker, "wipe_witness_readback_mismatch")
    proof = {"owner": operation["owner"], "remote": remote, "local": local, "sourceBoot": operation["source"]["boot"],
             "syncReturned": True, "hashReadbackVerified": True, "contentReadbackVerified": True, "verifiedAt": time.time()}
    save(audit.path / "wipe-witness-before.json", proof)
    return proof


def verify_wipe_witness(cfg, audit, operation, receipt, witness, previous_log):
    after = private(audit.path / "recovery/after.json")
    proof = recovery.activation_proof(cfg, Path(receipt["path"]), operation["credentialFileSha256"])
    class IdentityAudit:
        def command(self, label, argv):
            p = audit.run(argv)
            require(p.returncode == 0, "wipe_identity_read_failed")
            return p.stdout.strip()
        def save(self, name, value):
            save(audit.path / ("wipe-"+name), value)
    # Reuse the exact Jan MTK/stock-ASG27/CID/serial/new-boot verifier. The BLE bridge is
    # the just-completed owned recovery's observation, not a new BLE query or injected property.
    current = recovery.identity(cfg, IdentityAudit(), proof, after["freshBleBridge"]["endpoint"], after["freshBleBridge"])
    require(current["boot"] == after["boot"], "boot_changed_after_network_recovery")
    t, remote = current["transport"], witness["remote"]
    require(remote == f"/data/local/tmp/mentra-day1-wipe-{operation['owner']}.json"
            and witness["sourceBoot"] == operation["source"]["boot"] and witness["owner"] == operation["owner"]
            and witness["syncReturned"] is True and witness["hashReadbackVerified"] is True and witness["contentReadbackVerified"] is True,
            "wipe_witness_not_owned")
    state = audit.shell(t, "if [ ! -d /data/local/tmp ] || [ ! -r /data/local/tmp ] || [ ! -x /data/local/tmp ]; "
                         "then echo UNREADABLE; exit 3; fi; "
                         f"if [ -e {remote} ] || [ -L {remote} ]; then echo PRESENT; else echo ABSENT; fi")
    require(state == "ABSENT", "owned_userdata_marker_survived_or_unreadable")
    require(audit.shell(t, "cat /proc/sys/kernel/random/boot_id") == current["boot"], "boot_changed_during_wipe_observation")
    log = capture_recovery_log(audit, t, "recovery-log-after.json")
    log_markers = (log.get("available") is True and log.get("wipeReasonReported") is True
                   and log.get("dataFormatReported") is True and log.get("dataWipeCompleteReported") is True)
    result = {"status": "passed", "owner": operation["owner"], "sourceBoot": witness["sourceBoot"], "newBoot": current["boot"],
              "scope": "Previously hash/read-verified owned userdata marker absent after owned activation and exact January recovery",
              "marker": witness, "markerAbsent": True, "parentAccessible": True,
              "factoryJanuaryIdentityVerified": True, "recoveryLogContainsWipeMarkers": log_markers,
              "recoveryLogChanged": (log.get("available") is True and previous_log.get("available") is True
                                     and log.get("sha256") != previous_log.get("sha256")),
              "recoveryLogBoundToThisActivation": False,
              "allUserdataBlocksErased": "not-verified", "otherUserdataContentsExamined": False,
              "limitation": "One owned marker's deletion does not prove every file or physical storage block was erased"}
    save(audit.path / "wipe-proof.json", result)
    return result


def wait_departure(audit, operation, timeout=90):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        try:
            t = transport(audit, operation["endpoint"])
        except Guard as exc:
            if str(exc) != "exact_wifi_transport_unavailable": raise
            audit.event("source_transport_departed", evidence="transport disappearance; new boot still requires recovery")
            return
        try:
            boot = audit.shell(t, "cat /proc/sys/kernel/random/boot_id")
        except (Guard, subprocess.TimeoutExpired) as exc:
            if isinstance(exc, Guard) and str(exc) != "adb_read_failed": raise
            audit.event("reboot_read_unavailable", evidence="not itself a reboot or device-identity assertion")
            time.sleep(1)
            continue
        if re.fullmatch(UUID, boot) and boot != operation["source"]["boot"]:
            audit.event("new_boot_observed_before_ble_recovery", boot=boot)
            return
        time.sleep(1)
    raise Guard("reboot_departure_not_observed_no_retry")


def activate(cfg, args, helper, audit):
    operation, staged = activation_inputs(cfg, args.run)
    t = before_write(cfg, audit, operation)
    capacity(audit, t, 128*1024*1024)
    require(read_status(cfg, helper, audit, t, staged["useStatusProbe"]) == helper.UPDATE_STATUS_UPDATED_NEED_REBOOT,
            "activation_requires_updated_need_reboot")
    require(staged["targetSlot"] == ("_b" if operation["source"]["slot"] == "_a" else "_a"), "target_slot_mismatch")
    power_ready(cfg, audit, operation, "before-activation")
    previous_log = capture_recovery_log(audit, t, "recovery-log-before.json")
    witness = prepare_wipe_witness(cfg, audit, operation)
    t = before_write(cfg, audit, operation)
    require(read_status(cfg, helper, audit, t, staged["useStatusProbe"]) == helper.UPDATE_STATUS_UPDATED_NEED_REBOOT,
            "activation_status_changed_after_witness")
    bes_source_span(cfg, audit, operation, "before-reboot", private(args.run / "bes-source-before-transfer.json"))
    intent = make_activation_intent(cfg, operation, staged["targetSlot"])
    intent_ref = save(audit.path / "activation-intent.json", intent)
    # O_EXCL phase directory plus boot/artifact operation claim disallows replay after any ambiguous reboot.
    p = checked_write(cfg, audit, operation, ["adb", "-t", t, "reboot"])
    accepted = time.time()
    result_ref = save(audit.path / "activation-result.json", {"schemaVersion": 1, "owner": operation["owner"],
         "status": "activation-dispatched", "intentSha256": intent_ref["sha256"], "updateEngineStatus": "UPDATED_NEED_REBOOT",
         "payloadApplied": True, "targetSlot": staged["targetSlot"], "sourceBoot": operation["source"]["boot"],
         "acceptedAt": accepted, "dispatchExitCode": p.returncode, "activationCount": 1})
    receipt = save(audit.path / "receipt.json", {"schemaVersion": 1, "profile": recovery.PROFILE,
         "owner": operation["owner"], "credentialFileSha256": operation["credentialFileSha256"],
         "intent": intent_ref, "activation": result_ref})
    recovery.activation_proof(cfg, Path(receipt["path"]), operation["credentialFileSha256"])
    audit.event("activation_dispatch_accepted", activationCount=1)
    wait_departure(audit, operation)
    departed = time.time()
    app_absent(cfg, audit)
    audit.event("network_recovery_started")
    p = audit.run([str(cfg.python), str(HERE / "recover_wiped.py"), *cfg.child_args, "--credentials", str(cfg.credential.path),
                   "--activation-receipt", receipt["path"], "--out", str(audit.path / "recovery")], 420)
    require(p.returncode == 0, "network_recovery_failed_preserve_original_observer")
    recovered = private(audit.path / "recovery/result.json")
    require(recovered["status"] == "passed" and recovered["owner"] == operation["owner"]
            and recovered["newBootVerified"] is True and recovered["factoryJanuaryIdentityVerified"] is True, "recovery_not_verified")
    audit.event("january_network_readiness_verified")
    ready = time.time()
    wipe = verify_wipe_witness(cfg, audit, operation, receipt, witness, previous_log)
    bes = finish_bes_continuity(cfg, audit, operation, wipe)
    save(audit.path / "result.json", {"status": "january-setup-baseline-verified", "owner": operation["owner"],
         "payloadApplied": True, "activationCount": 1, "newBootVerified": True, "completedAt": time.time(),
         "recoveryResultSha256": digest(audit.path / "recovery/result.json"), "powerwashRequested": True,
         "timings": {**staged.get("timings", {}), "activationAcceptedAt": accepted,
                     "rebootDepartureOrNewBootObservedAt": departed, "networkReadinessVerifiedAt": ready,
                     "activationToReadinessSeconds": ready-accepted,
                     "explicitActivationHoldSeconds": intent["createdAt"]-staged.get("completedAt", intent["createdAt"])},
         "userdataResetIndependentlyObserved": wipe["status"] == "passed",
         "userdataWipeIndependentlyVerified": False,
         "wipeProofSha256": digest(audit.path / "wipe-proof.json"), "wipeProofScope": wipe["scope"],
         "besVersionVerifiedByThisController": False, "besSetupContinuity": bes,
         "setupBaselineReady": True, "finalModernFirmwareVerificationPassed": False,
         "customerRoutinePassed": False, "fixtureReadyForOtherRoutines": False})


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('stage', 'activate', 'observe'))
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--owner')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--stage-missing-probe', action='store_true')
    config.arguments(parser)
    args = parser.parse_args()
    cfg = config.from_arguments(args)
    args.run = args.run.absolute()
    require(args.mode == 'stage' or args.owner is None, 'activation_uses_bound_stage_owner')
    require((args.mode == 'observe') == (args.out is not None)
            and (args.mode == 'observe' or not args.stage_missing_probe), 'observation_options_invalid')
    if args.out is not None:
        args.out = config.absolute(str(args.out))
        require(args.out != args.run and args.run not in args.out.parents, 'observation_must_not_create_stage_directory')
    cfg.require_lease()
    audit = Audit(cfg, args.out if args.mode == 'observe' else args.run if args.mode == 'stage' else args.run/'activation')
    def stopped(_signum, _frame): raise InterruptedError('controller_interrupted')
    signal.signal(signal.SIGTERM, stopped)
    try:
        save(audit.path/'adapter-inputs.json', cfg.public_inputs())
        helper = pin_tools(cfg)
        if args.mode == 'observe':
            import observe
            result = observe.collect(cfg, args.run, audit, helper, stage_missing_probe=args.stage_missing_probe)
            print(json.dumps({'current':result, 'firmwareWrites':0}))
            return
        (stage if args.mode == 'stage' else activate)(cfg, args, helper, audit)
    except BaseException as exc:
        save(audit.path/'failure.json', {'status': 'failed', 'mode': args.mode, 'at': time.time(),
             'code': str(exc) if isinstance(exc, Guard) else type(exc).__name__, 'resendAllowed': False,
             'reconcileReadOnly': True, 'fixtureReadyForOtherRoutines': False})
        print('Setup stopped. Preserve this failure; do not repeat transfer/apply/activation.')
        raise SystemExit(1)
    print('Recorded setup phase finished; customer test and final return qualification remain separate.')


if __name__ == '__main__':
    main()
