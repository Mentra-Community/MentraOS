import asyncio
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parent))
import recover_wiped as w
import ble_support as r
import config
from test_support import FIXTURE, ASG_SHA, make_config

OWNER = "2fa2bdd4-1b3a-4567-802f-84284b9afcde"
OLD_BOOT = "9ad31c85-1a26-49fc-b8b1-6e28b01fb931"
NEW_BOOT = "0fd908b2-b82d-41cd-aad2-74d8e72eaf06"


def write_json(path, value):
    path.write_text(json.dumps(value)); path.chmod(0o600)
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def credentials():
    return {"schemaVersion": 1, "fixture": {**FIXTURE, "mtk": "MentraLive_20260113", "slot": "_a", "boot": OLD_BOOT},
            "endpoint": "192.168.50.10:5555", "ssid": "private-test-network", "password": "fake-test-password"}


def inputs(base, mutate=None):
    credential_path = base/"credentials.json"
    credential_ref = write_json(credential_path, credentials())
    intent = {"schemaVersion": 1, "owner": OWNER, "operation": "activate-full-ota", "fixture": FIXTURE,
              "source": {"boot": OLD_BOOT, "slot": "_a", "mtk": "MentraLive_20260921.0"},
              "target": {"slot": "_b", "mtk": "MentraLive_20260113", "asgVersionCode": 27, "asgSha256": ASG_SHA},
              "ota": {"kind": "full", "sha256": w.ZIP_SHA, "payloadSha256": w.PAYLOAD_SHA, "powerwash": True},
              "createdAt": time.time()-20, "activationCount": 1, "resendAllowed": False}
    activation = {"schemaVersion": 1, "owner": OWNER, "status": "activation-dispatched", "intentSha256": "",
                  "updateEngineStatus": "UPDATED_NEED_REBOOT", "payloadApplied": True, "targetSlot": "_b",
                  "sourceBoot": OLD_BOOT, "acceptedAt": time.time()-10, "dispatchExitCode": 0, "activationCount": 1}
    if mutate: mutate(intent, activation)
    intent_ref = write_json(base/"activation-intent.json", intent)
    activation["intentSha256"] = intent_ref["sha256"]
    activation_ref = write_json(base/"activation-result.json", activation)
    receipt = {"schemaVersion": 1, "profile": w.PROFILE, "owner": OWNER,
               "credentialFileSha256": credential_ref["sha256"], "intent": intent_ref, "activation": activation_ref}
    receipt_path = base/"receipt.json"; write_json(receipt_path, receipt)
    return credential_path, receipt_path, intent


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.cfg=make_config(Path(self.tmp.name))

    def inputs(self, base, mutate=None):
        value=inputs(base,mutate)
        self.cfg=make_config(base/'configuration',value[0])
        return value

    def test_accepts_only_bound_successful_activation_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, p, _ = self.inputs(Path(tmp))
            proof = w.activation_proof(self.cfg, p, r.load_credentials(self.cfg, c)[1])
            self.assertEqual(proof["target"]["slot"], "_b")
            self.assertEqual(proof["owner"], OWNER)
        changes = [lambda i,a: a.update(status="failed"), lambda i,a: a.update(payloadApplied=False),
                   lambda i,a: a.update(updateEngineStatus="DOWNLOADING"), lambda i,a: a.update(dispatchExitCode=1),
                   lambda i,a: a.update(sourceBoot=NEW_BOOT), lambda i,a: a.update(targetSlot="_a"),
                   lambda i,a: a.update(owner=NEW_BOOT), lambda i,a: i["target"].update(slot="_a"),
                   lambda i,a: i["source"].update(mtk="MentraLive_20260113"),
                   lambda i,a: i["ota"].update(kind="incremental"), lambda i,a: i["ota"].update(powerwash=False),
                   lambda i,a: i["ota"].update(sha256="0"*64), lambda i,a: i.update(resendAllowed=True),
                   lambda i,a: a.update(activationCount=2), lambda i,a: a.update(activationCount=True),
                   lambda i,a: i["ota"].update(powerwash=1), lambda i,a: a.update(acceptedAt=0)]
        for change in changes:
            with self.subTest(change=changes.index(change)), tempfile.TemporaryDirectory() as tmp:
                c,p,_ = self.inputs(Path(tmp), change)
                with self.assertRaises(r.Guard): w.activation_proof(self.cfg, p, r.load_credentials(self.cfg, c)[1])

    def test_receipt_references_and_credentials_are_digest_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp); c,p,_=self.inputs(base); digest=r.load_credentials(self.cfg, c)[1]
            with self.assertRaises(r.Guard): w.activation_proof(self.cfg, p, "0"*64)
            ref=base/"activation-result.json"; ref.write_text(ref.read_text()+" ")
            with self.assertRaises(r.Guard): w.activation_proof(self.cfg, p, digest)

    def test_receipt_must_be_private_regular_file_and_exact_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp); c,p,_=self.inputs(base); digest=r.load_credentials(self.cfg, c)[1]
            p.chmod(0o644)
            with self.assertRaises(r.Guard): w.activation_proof(self.cfg, p, digest)
            p.chmod(0o600); link=base/"symlink"; link.symlink_to(p)
            with self.assertRaises(OSError): w.activation_proof(self.cfg, link, digest)
            value=json.loads(p.read_text()); value["profile"]="current-state-rehearsal"; write_json(p,value)
            with self.assertRaises(r.Guard): w.activation_proof(self.cfg, p, digest)

    def identity_values(self):
        return {"read_boot_before": NEW_BOOT, "read_cid": FIXTURE["cid"], "read_serial": "TEST012345",
                "read_boot_serial": "TEST012345", "read_persisted_mac": "", "read_mtk": "MentraLive_20260113",
                "read_slot": "_b", "read_uid": "2000", "read_boot_complete": "1",
                "read_asg_path": "package:/system/app/MentraOSLauncher/MentraOSLauncher.apk",
                "read_asg_path_after": "package:/system/app/MentraOSLauncher/MentraOSLauncher.apk",
                "hash_asg_active": ASG_SHA+"  /system/app/MentraOSLauncher/MentraOSLauncher.apk",
                "hash_asg_system": ASG_SHA+"  /system/app/MentraOSLauncher/MentraOSLauncher.apk",
                "hash_asg_backup": ASG_SHA+"  /system/media/MentraOSLauncherBackup.apk",
                "read_asg_package": "versionCode=27 minSdk=28", "read_asg_pid": "1338", "read_cid_after": FIXTURE["cid"],
                "read_boot_after": NEW_BOOT}

    def run_identity(self, modifications=None, bridge=True):
        values=self.identity_values(); values.update(modifications or {})
        audit=types.SimpleNamespace(command=lambda label, argv: values[label], save=lambda *_args: None)
        proof={"source":{"boot":OLD_BOOT}, "target":{"mtk":"MentraLive_20260113","slot":"_b"}}
        with patch.object(r,"adb_transport",return_value="17"):
            return w.identity(self.cfg, audit,proof,"192.168.50.20:5555",
                   {"mac":FIXTURE["mac"],"endpoint":"192.168.50.20:5555","ssidMatches":True} if bridge else {})

    def test_empty_persisted_mac_requires_explicit_fresh_ble_bridge(self):
        result=self.run_identity()
        self.assertTrue(result["persistedMacEmpty"])
        self.assertEqual(result["asgVersionCode"],27)
        with self.assertRaises(r.Guard): self.run_identity(bridge=False)
        self.assertFalse(self.run_identity({"read_persisted_mac":FIXTURE["mac"].lower()})["persistedMacEmpty"])

    def test_actual_new_boot_exact_fixture_factory_apk_and_unrooted_shell_required(self):
        bad={"read_boot_before":OLD_BOOT,"read_cid":"0"*32,"read_serial":"0123456789ABCDEF",
             "read_boot_serial":"0123456789ABCDEF","read_persisted_mac":"AA:AA:AA:AA:AA:AA",
             "read_mtk":"MentraLive_20260921.0","read_slot":"_a","read_uid":"0","read_boot_complete":"0",
             "read_asg_path":"package:/data/app/asg.apk","hash_asg_active":"0"*64,"read_asg_package":"versionCode=39",
             "read_asg_pid":"", "read_cid_after":"0"*32, "read_boot_after":OLD_BOOT}
        for field,value in bad.items():
            with self.subTest(field=field),self.assertRaises(r.Guard): self.run_identity({field:value})

    def fake_run(self, *, fail_write=False, wrong_mac=False, initially_connected=False, wrong_ssid=False,
                 wrong_post_endpoint=False, retry=False):
        counters={"provisions":0,"connects":[],"identityCalls":0,"scannerCalls":0}
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp); c,p,_=self.inputs(base); claims=self.cfg.recovery_claims; audit=r.Audit(self.cfg, base/"run")
            creds=credentials(); states={"statusRequests":0}
            class Client:
                def __init__(self,*_a,**_k): pass
                async def __aenter__(self): return self
                async def __aexit__(self,*_a): pass
                async def start_notify(self,_char,callback): self.callback=callback
                async def write_gatt_char(self,_char,wire,**_kwargs):
                    outer=json.loads(wire[5:-2])
                    if outer["C"]=="cs_btaddr":
                        reply={"C":"sr_btaddr","S":0,"B":{"btaddr":"AA:AA:AA:AA:AA:AA" if wrong_mac else FIXTURE["mac"]}}
                    else:
                        inner=json.loads(outer["C"])
                        if inner["type"]=="set_wifi_credentials":
                            counters["provisions"]+=1
                            self_test.assertTrue((claims/(OWNER+".json")).exists())
                            self_test.assertTrue((audit.output/"provision-intent.json").exists())
                            self_test.assertEqual(inner["ssid"],creds["ssid"])
                            if fail_write: raise asyncio.TimeoutError()
                            return
                        states["statusRequests"]+=1
                        connected=initially_connected or states["statusRequests"]>1
                        reply={"type":"wifi_status","connected":connected,
                               "ssid":"wrong-network" if wrong_ssid else creds["ssid"],
                               "local_ip":"192.168.50.21" if wrong_post_endpoint and states["statusRequests"]>2 else "192.168.50.20"}
                    self.callback(None,r.frame(reply))
            self_test=self
            async def discover(**_kwargs):
                counters["scannerCalls"]+=1
                return {"one":(types.SimpleNamespace(name="Mentra_Live_EE01"),types.SimpleNamespace(local_name="Mentra_Live_EE01"))}
            fake=types.SimpleNamespace(BleakClient=Client,BleakScanner=types.SimpleNamespace(discover=discover))
            def command(label,argv):
                counters["connects"].append(argv)
                return "connected"
            def identity(*_args):
                counters["identityCalls"]+=1
                return {"boot":NEW_BOOT,"asgVersionCode":27}
            with patch.dict(sys.modules,{"bleak":fake}),patch.object(config.Config,"require_lease"), \
                 patch.object(config.Config,"require_managed_app_absent"), \
                 patch.object(w,"wait_ready",new=AsyncMock()), \
                 patch.object(w,"identity",side_effect=identity),patch.object(r.Audit,"command",side_effect=command), \
                 patch.object(w.asyncio,"sleep",new=AsyncMock()):
                try:
                    asyncio.run(w.recover(self.cfg, c,p,audit,claims=claims)); counters["error"]=None
                except Exception as exc: counters["error"]=type(exc).__name__
                if retry:
                    another=r.Audit(self.cfg, base/"different-output")
                    with self.assertRaisesRegex(r.Guard,"already_claimed"):
                        asyncio.run(w.recover(self.cfg, c,p,another,claims=claims))
            counters["claimed"]=(claims/(OWNER+".json")).exists()
            counters["passed"]=(audit.output/"result.json").exists()
            if counters["passed"]:
                result=json.loads((audit.output/"result.json").read_text())
                self.assertFalse(result["userdataWipeIndependentlyVerified"])
                self.assertFalse(result["fixtureReadyForOtherRoutines"])
            for folder in [audit.output,claims]:
                if folder.exists():
                    for output in folder.iterdir():
                        self.assertNotIn(creds["ssid"],output.read_text())
                        self.assertNotIn(creds["password"],output.read_text())
        return counters

    def test_one_provision_claimed_before_write_uses_only_ble_returned_endpoint(self):
        result=self.fake_run()
        self.assertEqual(result["provisions"],1);self.assertTrue(result["passed"])
        self.assertEqual(result["connects"],[["adb","connect","192.168.50.20:5555"]])
        self.assertEqual(result["identityCalls"],1)

    def test_ambiguous_write_is_not_resent_even_with_new_output_directory(self):
        result=self.fake_run(fail_write=True,retry=True)
        self.assertEqual(result["provisions"],1);self.assertTrue(result["claimed"])
        self.assertFalse(result["passed"]);self.assertEqual(result["scannerCalls"],1)
        self.assertEqual(result["connects"],[])

    def test_wrong_ble_mac_aborts_without_provisioning_or_adb(self):
        result=self.fake_run(wrong_mac=True)
        self.assertEqual(result["provisions"],0);self.assertFalse(result["claimed"])
        self.assertEqual(result["connects"],[])

    def test_already_connected_exact_ssid_does_not_provision_again(self):
        result=self.fake_run(initially_connected=True)
        self.assertEqual(result["provisions"],0);self.assertFalse(result["claimed"]);self.assertTrue(result["passed"])

    def test_wrong_ssid_or_changed_ip_never_authorizes_adb_identity(self):
        result=self.fake_run(initially_connected=True,wrong_ssid=True)
        self.assertEqual(result["provisions"],0);self.assertEqual(result["connects"],[])
        result=self.fake_run(wrong_post_endpoint=True)
        self.assertEqual(result["identityCalls"],0);self.assertFalse(result["passed"])

    def test_initial_wifi_readiness_retries_only_missing_response(self):
        expected={"type":"wifi_status","connected":False}
        query=AsyncMock(side_effect=[asyncio.TimeoutError(),r.Guard("ble_query_deadline"),expected])
        with patch.object(w.asyncio,"sleep",new=AsyncMock()):
            self.assertEqual(asyncio.run(w.wait_wifi_status(query)),expected)
        self.assertEqual(query.await_count,3)
        query=AsyncMock(side_effect=r.Guard("notification_decode_failed"))
        with self.assertRaisesRegex(r.Guard,"notification_decode_failed"):
            asyncio.run(w.wait_wifi_status(query))
        self.assertEqual(query.await_count,1)
        query=AsyncMock(side_effect=asyncio.TimeoutError())
        with self.assertRaisesRegex(r.Guard,"initial_wifi_status_deadline"):
            asyncio.run(w.wait_wifi_status(query,timeout=0))

    def test_readiness_wait_only_retries_transport_and_boot_readiness(self):
        audit=types.SimpleNamespace(command=unittest.mock.Mock(side_effect=[r.Guard("command_failed_adb_boot_ready"),"0","1"]))
        with patch.object(r,"adb_transport",return_value="17"),patch.object(w.asyncio,"sleep",new=AsyncMock()):
            asyncio.run(w.wait_ready(audit,"192.168.50.20:5555"))
        self.assertEqual(audit.command.call_count,3)
        for call in audit.command.call_args_list:
            self.assertEqual(call.args[1],["adb","-t","17","shell","getprop","sys.boot_completed"])
        with patch.object(r,"adb_transport",side_effect=r.Guard("transport_id_invalid")):
            with self.assertRaisesRegex(r.Guard,"transport_id_invalid"):
                asyncio.run(w.wait_ready(audit,"192.168.50.20:5555"))

    def test_non_preserved_credential_path_rejected_before_ble(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);c,p,_=self.inputs(base)
            with self.assertRaisesRegex(r.Guard,"use_preserved_fixture_credentials"):
                asyncio.run(w.recover(self.cfg, base/"wrong-credentials.json",p,r.Audit(self.cfg, base/"run"),claims=self.cfg.recovery_claims))

    def test_claim_is_private_exclusive_across_run_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=w.claim_path(OWNER,Path(tmp)/"claims")
            w.claim_once(path,{"resendAllowed":False})
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):w.claim_once(path,{})

    def test_missing_successful_activation_never_scans_or_connects(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);c,p,_=self.inputs(base,lambda i,a:a.update(status="failed"))
            with patch.dict(sys.modules,{"bleak":types.SimpleNamespace()}):
                with self.assertRaisesRegex(r.Guard,"not_successfully_dispatched"):
                    asyncio.run(w.recover(self.cfg, c,p,r.Audit(self.cfg, base/"run"),claims=self.cfg.recovery_claims))


if __name__ == "__main__": unittest.main()
