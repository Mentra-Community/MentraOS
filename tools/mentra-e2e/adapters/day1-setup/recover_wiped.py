#!/usr/bin/env python3
"""Recover network ADB after an owned full-OTA activation; never assert a wipe."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

import ble_support as r
import config
from config import PROFILE as BASELINE
import factory_asg

PROFILE = "january-wiped-asg27"
ZIP_SHA = "a9ab45592ad0437f16aa286f9c9f4bdd8ffcb7b07818827a2966bc202186886d"
PAYLOAD_SHA = "40dc039f47678451b306d5743f3d4399881b1a9bd9759318dcbbc24fe78df5f7"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
SHA = r"[0-9a-f]{64}"


def private_json(path):
    r.require(path.is_absolute(), "proof_path_not_absolute")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        r.require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                  and info.st_uid == os.getuid() and info.st_nlink == 1, "proof_not_private_regular")
        raw = file.read(65537)
    r.require(len(raw) <= 65536, "proof_too_large")
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def keys(value, expected, code):
    r.require(isinstance(value, dict) and set(value) == set(expected.split()), code)


def referenced(ref):
    keys(ref, "path sha256", "proof_reference_schema")
    r.require(isinstance(ref["path"], str) and isinstance(ref["sha256"], str)
              and re.fullmatch(SHA, ref["sha256"]), "proof_reference_invalid")
    value, digest = private_json(Path(ref["path"]))
    r.require(digest == ref["sha256"], "proof_reference_digest_mismatch")
    return value


def activation_proof(cfg, path, credential_digest):
    receipt, digest = private_json(path)
    keys(receipt, "schemaVersion profile owner credentialFileSha256 intent activation", "receipt_schema")
    owner = receipt["owner"]
    r.require(type(receipt["schemaVersion"]) is int and receipt["schemaVersion"] == 1 and receipt["profile"] == PROFILE
              and isinstance(owner, str) and re.fullmatch(UUID, owner), "receipt_profile_or_owner")
    r.require(receipt["credentialFileSha256"] == credential_digest, "credential_receipt_mismatch")
    intent, activation = referenced(receipt["intent"]), referenced(receipt["activation"])
    keys(intent, "schemaVersion owner operation fixture source target ota createdAt activationCount resendAllowed", "activation_intent_schema")
    keys(intent["source"], "boot slot mtk", "source_schema")
    keys(intent["target"], "slot mtk asgVersionCode asgSha256", "target_schema")
    keys(intent["ota"], "kind sha256 payloadSha256 powerwash", "ota_schema")
    source, target = intent["source"], intent["target"]
    r.require(type(intent["schemaVersion"]) is int and intent["schemaVersion"] == 1 and intent["owner"] == owner
              and intent["operation"] == "activate-full-ota" and intent["fixture"] == dict(cfg.fixture)
              and type(intent["activationCount"]) is int and intent["activationCount"] == 1 and intent["resendAllowed"] is False, "activation_intent_not_owned")
    r.require(isinstance(source["boot"], str) and re.fullmatch(UUID, source["boot"])
              and source["slot"] in ("_a", "_b") and source["mtk"] == "MentraLive_20260921.0", "source_not_qualified_full_ota")
    r.require(target == {"slot": "_b" if source["slot"] == "_a" else "_a", "mtk": "MentraLive_20260113",
                        "asgVersionCode": 27, "asgSha256": BASELINE["asgSha256"]}, "target_not_january_factory")
    r.require(intent["ota"] == {"kind": "full", "sha256": ZIP_SHA, "payloadSha256": PAYLOAD_SHA,
                                "powerwash": True} and intent["ota"]["powerwash"] is True, "ota_not_verified_january_full")
    keys(activation, "schemaVersion owner status intentSha256 updateEngineStatus payloadApplied targetSlot sourceBoot acceptedAt dispatchExitCode activationCount", "activation_result_schema")
    r.require(type(activation["schemaVersion"]) is int and activation["schemaVersion"] == 1 and activation["owner"] == owner
              and activation["status"] == "activation-dispatched" and activation["intentSha256"] == receipt["intent"]["sha256"]
              and activation["updateEngineStatus"] == "UPDATED_NEED_REBOOT" and activation["payloadApplied"] is True
              and activation["targetSlot"] == target["slot"] and activation["sourceBoot"] == source["boot"]
              and type(activation["dispatchExitCode"]) is int and activation["dispatchExitCode"] == 0
              and type(activation["activationCount"]) is int and activation["activationCount"] == 1, "activation_not_successfully_dispatched")
    r.require(type(intent["createdAt"]) in (int, float) and type(activation["acceptedAt"]) in (int, float)
              and 0 < intent["createdAt"] <= activation["acceptedAt"] <= time.time() + 5, "activation_time_invalid")
    return {"owner": owner, "source": source, "target": target, "receiptSha256": digest,
            "intentSha256": receipt["intent"]["sha256"], "activationSha256": receipt["activation"]["sha256"]}


def claim_path(owner, claims):
    claims.mkdir(mode=0o700, exist_ok=True)
    info = claims.lstat()
    r.require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
              and info.st_uid == os.getuid(), "claim_directory_not_private")
    return claims / (owner + ".json")


def claim_once(path, intent):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(intent, file, indent=2); file.write("\n"); file.flush(); os.fsync(file.fileno())
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


async def wait_wifi_status(query, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return await query()
        except (asyncio.TimeoutError, r.Guard) as exc:
            if isinstance(exc, r.Guard) and str(exc) != "ble_query_deadline":
                raise
            r.require(time.monotonic() < deadline, "initial_wifi_status_deadline")
            await asyncio.sleep(2)


async def wait_ready(audit, endpoint, timeout=60):
    deadline = time.monotonic() + timeout
    while True:
        try:
            transport = r.adb_transport(audit, endpoint)
            if audit.command("adb_boot_ready", ["adb", "-t", transport, "shell", "getprop", "sys.boot_completed"]) == "1":
                return
        except r.Guard as exc:
            if str(exc) not in ("selected_adb_unavailable", "command_failed_adb_boot_ready"):
                raise
        r.require(time.monotonic() < deadline, "adb_boot_readiness_deadline")
        await asyncio.sleep(1)


def identity(cfg, audit, proof, endpoint, bridge):
    r.require(bridge == {"mac": cfg.fixture["mac"], "endpoint": endpoint, "ssidMatches": True}, "fresh_ble_bridge_required")
    transport = r.adb_transport(audit, endpoint)
    sh = lambda label, *args: audit.command(label, ["adb", "-t", transport, "shell", *args])
    boot = sh("read_boot_before", "cat", "/proc/sys/kernel/random/boot_id")
    r.require(re.fullmatch(UUID, boot) and boot != proof["source"]["boot"], "activation_new_boot_not_observed")
    actual = {"boot": boot, "cid": sh("read_cid", "cat", "/sys/block/mmcblk0/device/cid"),
              "serial": sh("read_serial", "getprop", "ro.serialno"),
              "bootSerial": sh("read_boot_serial", "getprop", "ro.boot.serialno"),
              "mac": sh("read_persisted_mac", "getprop", "persist.mentra.live.mac"),
              "mtk": sh("read_mtk", "getprop", "ro.custom.ota.version"),
              "slot": sh("read_slot", "getprop", "ro.boot.slot_suffix")}
    audit.save("observed-adb-identity.json", actual)
    r.require(actual["cid"] == cfg.fixture["cid"] and actual["serial"] in cfg.serial_aliases and actual["bootSerial"] == cfg.boot_serial
              and actual["mtk"] == proof["target"]["mtk"] and actual["slot"] == proof["target"]["slot"], "returned_adb_identity_mismatch")
    r.require(actual["mac"] == "" or actual["mac"].upper() == cfg.fixture["mac"], "conflicting_persisted_mac")
    r.require(sh("read_uid", "id", "-u") == "2000", "adb_not_unrooted")
    r.require(sh("read_boot_complete", "getprop", "sys.boot_completed") == "1", "boot_incomplete")
    asg = factory_asg.verify(cfg, sh)
    r.require(sh("read_asg_pid", "pidof", "com.mentra.asg_client").isdigit(), "asg_not_running")
    r.require(sh("read_cid_after", "cat", "/sys/block/mmcblk0/device/cid") == cfg.fixture["cid"]
              and sh("read_boot_after", "cat", "/proc/sys/kernel/random/boot_id") == boot, "boot_changed_during_identity")
    return {**actual, "profile": PROFILE, "transport": transport, "uid": 2000, "asgVersionCode": 27,
            "asgSha256": BASELINE["asgSha256"], "factoryAsgIdentity": asg,
            "persistedMacEmpty": actual["mac"] == "", "freshBleBridge": bridge}


async def recover(cfg, credentials_path, receipt_path, audit, *, claims=None):
    r.require(claims is None or claims == cfg.recovery_claims, "configured_claim_root_required")
    claims = cfg.recovery_claims
    r.require(credentials_path == cfg.credential.path, "use_preserved_fixture_credentials")
    credentials, credential_digest = r.load_credentials(cfg, credentials_path)
    proof = activation_proof(cfg, receipt_path, credential_digest)
    wire = r.app_frame({"type": "set_wifi_credentials", "ssid": credentials["ssid"], "password": credentials["password"]})
    marker = claim_path(proof["owner"], claims)
    r.require(not marker.exists(), "provisioning_already_claimed_do_not_resend")
    audit.save("inputs.json", {"profile": PROFILE, "credentialsPath": str(credentials_path),
               "credentialFileSha256": credential_digest, "activationReceiptPath": str(receipt_path), **proof,
               "scope": "Network recovery after owned full-OTA activation; no independent userdata-wipe assertion"})
    from bleak import BleakClient, BleakScanner
    devices = await BleakScanner.discover(timeout=8, return_adv=True)
    candidates = [d for d, a in devices.values() if (a.local_name or d.name or "").casefold() == cfg.ble_name]
    r.require(len(candidates) == 1, "ble_candidate_ambiguous_or_absent")
    async with BleakClient(candidates[0], timeout=20) as client:
        decoder, queue, failed = r.Decoder(), asyncio.Queue(maxsize=128), [False]
        def notification(_sender, value):
            try:
                for item in decoder.add(bytes(value)):
                    queue.put_nowait(item)
            except Exception:
                failed[0] = True
                if not queue.full(): queue.put_nowait({"internalError": True})
        await client.start_notify(r.NOTIFY, notification)
        async def exchange(request, label, selector, timeout=8):
            while not queue.empty(): queue.get_nowait()
            audit.event(label, shapeOnly=True)
            await asyncio.wait_for(client.write_gatt_char(r.COMMAND, request, response=True), 5)
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                r.require(remaining > 0, "ble_query_deadline")
                item = await asyncio.wait_for(queue.get(), remaining)
                r.require(not failed[0] and not item.get("internalError"), "notification_decode_failed")
                if selector(item): return item
        async def ble_identity():
            item = await exchange(r.frame({"C": "cs_btaddr"}), "ble_read_identity", lambda x: x.get("C") == "sr_btaddr")
            r.require(item.get("S") == 0 and isinstance(item.get("B"), dict)
                      and str(item["B"].get("btaddr", "")).upper() == cfg.fixture["mac"], "ble_mac_mismatch")
            audit.event("ble_identity_verified", mac=cfg.fixture["mac"])
        async def wifi_status():
            return await exchange(r.app_frame({"type": "request_wifi_status"}), "ble_read_wifi_status",
                                  lambda x: x.get("type") == "wifi_status")
        await ble_identity()
        first_status = await wait_wifi_status(wifi_status)
        count = 0
        if first_status.get("connected") is True:
            r.status_proof(first_status, credentials, allow_new_ip=True)
            audit.save("provision-skipped.json", {"reason": "already_connected_to_exact_saved_ssid", "requestCount": 0})
        else:
            r.require(first_status.get("connected") is False, "wifi_status_unknown")
            r.require(r.load_credentials(cfg, credentials_path)[1] == credential_digest, "credential_file_changed")
            r.require(activation_proof(cfg, receipt_path, credential_digest) == proof, "activation_proof_changed")
            await ble_identity()
            intent = {"at": time.time(), "profile": PROFILE, "owner": proof["owner"],
                      "receiptSha256": proof["receiptSha256"], "credentialFileSha256": credential_digest,
                      "output": str(audit.output), "command": "set_wifi_credentials", "requestCount": 1,
                      "resendAllowed": False, "freshBleMac": cfg.fixture["mac"]}
            cfg.require_lease(child=True)
            cfg.require_managed_app_absent()
            claim_once(marker, intent)
            audit.save("provision-intent.json", {**intent, "claimPath": str(marker)})
            count = 1
            await asyncio.wait_for(client.write_gatt_char(r.COMMAND, wire, response=True), 5)
            audit.event("provision_write_returned", requestCount=1)
            await asyncio.sleep(3)
        deadline = time.monotonic() + 45
        while True:
            try:
                status, endpoint = r.status_proof(await wifi_status(), credentials, allow_new_ip=True)
                break
            except (asyncio.TimeoutError, r.Guard) as exc:
                if isinstance(exc, r.Guard) and str(exc) not in ("wifi_not_connected", "ble_query_deadline"): raise
                r.require(time.monotonic() < deadline, "wifi_status_deadline")
                await asyncio.sleep(2)
        audit.save("network.json", {**status, "endpoint": endpoint, "source": "fresh MAC-identified BLE wifi_status"})
        await ble_identity()
        audit.command("adb_connect_ble_endpoint", ["adb", "connect", endpoint])
        await wait_ready(audit, endpoint)
        await ble_identity()
        _, current_endpoint = r.status_proof(await wifi_status(), credentials, allow_new_ip=True)
        r.require(current_endpoint == endpoint, "ble_endpoint_changed_before_adb_identity")
        bridge = {"mac": cfg.fixture["mac"], "endpoint": endpoint, "ssidMatches": True}
        after = identity(cfg, audit, proof, endpoint, bridge)
        audit.save("after.json", after)
        audit.save("result.json", {"status": "passed", "scope": "Network recovery after owned full-OTA activation",
                   "profile": PROFILE, "owner": proof["owner"], "requestCount": count, "resend": False,
                   "newBootVerified": True, "factoryJanuaryIdentityVerified": True,
                   "freshBleBridgeVerified": True, "userdataWipeIndependentlyVerified": False,
                   "firmwareWrites": 0, "propertyWrites": 0, "fixtureReadyForOtherRoutines": False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True, type=Path)
    parser.add_argument("--activation-receipt", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    config.arguments(parser)
    args = parser.parse_args()
    cfg = config.from_arguments(args)
    cfg.require_lease(child=True)
    audit = r.Audit(cfg, args.out.absolute())
    try:
        asyncio.run(recover(cfg, args.credentials.absolute(), args.activation_receipt.absolute(), audit))
        print("January network recovery verified; see private result.json. Wipe not independently asserted.")
    except Exception as exc:
        audit.save("failure.json", {"status": "failed", "code": str(exc) if isinstance(exc, r.Guard) else type(exc).__name__,
                   "provisionIntentExists": (audit.output/"provision-intent.json").exists(),
                   "sharedClaimMustBeChecked": True, "resendAllowed": False})
        print("Recovery failed; preserve evidence and reconcile read-only. Do not resend provisioning.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
