import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import full_january as f
import observe_power as power
import config
from test_support import FIXTURE, ASG_SHA, make_config

OWNER = "c3ae628f-a8aa-42a0-b91b-f9141ddcfe27"
BOOT = "1ae86177-4bba-4fb0-9e80-0494e0b867ca"
ENDPOINT = "192.168.50.10:5555"


def completed(stdout="", code=0):
    return types.SimpleNamespace(stdout=stdout, stderr="", returncode=code)


def identity():
    return {"boot": BOOT, **FIXTURE, "bootSerial": FIXTURE["serial"], "mtk": f.SOURCE,
            "epoch": f.EPOCH, "slot": "_a", "uid": "2000", "bootCompleted": "1"}


def operation(run, cfg):
    return {"schemaVersion": 1, "owner": OWNER, "endpoint": ENDPOINT, "source": identity(),
            "remote": f"/storage/emulated/0/asg/january-full-{OWNER}.zip", "otaSha256": f.ZIP_SHA,
            "appExecutableName": "Mentra", "configSha256":cfg.sha256, "profileSha256":config.PROFILE_SHA, "credentialFileSha256": "b"*64, "createdAt": time.time(), "run": str(run)}


class MemoryAudit:
    def __init__(self, path):
        self.path = path
        self.commands = []
        self.events = []
    def event(self, operation, **values): self.events.append((operation, values))
    def run(self, argv, timeout=30):
        self.commands.append(argv)
        return completed("Broadcast completed: result=0")


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg=make_config(Path(self.tmp.name))

    def test_exact_wifi_transport_rejects_usb_and_ambiguous_rows(self):
        row = ENDPOINT+" device product:MentraLive transport_id:17"
        audit = types.SimpleNamespace(run=lambda argv: completed(row))
        self.assertEqual(f.transport(audit, ENDPOINT), "17")
        for bad in (row+" usb:12", row+"\n"+row, row.replace("device ", "offline "), row.replace(ENDPOINT, "192.168.50.11:5555")):
            audit.run = lambda argv, value=bad: completed(value)
            with self.assertRaises(f.Guard): f.transport(audit, ENDPOINT)

    def run_identity(self, changes=None):
        values = identity(); values.update(changes or {})
        mapping = {"cat /proc/sys/kernel/random/boot_id": values["boot"], "cat /sys/block/mmcblk0/device/cid": values["cid"],
                   "getprop ro.serialno": values["serial"], "getprop ro.boot.serialno": values["bootSerial"],
                   "getprop persist.mentra.live.mac": values["mac"], "getprop ro.custom.ota.version": values["mtk"],
                   "getprop ro.build.date.utc": values["epoch"], "getprop ro.boot.slot_suffix": values["slot"],
                   "id -u": values["uid"], "getprop sys.boot_completed": values["bootCompleted"]}
        audit = types.SimpleNamespace(shell=lambda t,c: mapping[c], event=lambda *a,**k: None)
        with patch.object(f,"transport",return_value="17"):
            return f.source_identity(self.cfg, audit, ENDPOINT)

    def test_actual_source_epoch_full_mac_cid_serial_and_boot_are_required(self):
        self.assertEqual(self.run_identity()[1], identity())
        for field, bad in {"cid":"0"*32,"serial":"0123456789ABCDEF","bootSerial":"0123456789ABCDEF",
                           "mac":"","mtk":f.TARGET,"epoch":"1790034150","boot":"unknown","slot":"_c",
                           "uid":"0","bootCompleted":"0"}.items():
            with self.subTest(field=field), self.assertRaises(f.Guard): self.run_identity({field:bad})

    def test_actual_process_absence_not_a_handwritten_assertion(self):
        for code, out, permitted in ((1,"",True),(0,"4321",False),(2,"",False),(1,"4321",False)):
            audit=types.SimpleNamespace(run=lambda _: completed(out,code),event=lambda *a,**k:None)
            if permitted: f.app_absent(self.cfg, audit)
            else:
                with self.assertRaises(f.Guard): f.app_absent(self.cfg, audit)

    def test_capacity_does_not_treat_android_stub_as_bes_power(self):
        for available,level,powered,ok in ((2000000,60,True,True),(1,60,True,False),(2000000,49,True,True),(2000000,100,False,True)):
            audit=types.SimpleNamespace(shell=lambda t,c: (f"Filesystem 1K-blocks Used Available Use% Mounted\n/data 9000000 7000000 {available} 70% /data"
                 if c.startswith("df") else f"  USB powered: {str(powered).lower()}\n  level: {level}\n"),event=lambda *a,**k:None)
            if ok: f.capacity(audit,"17",f.ZIP_BYTES+1024**3)
            else:
                with self.assertRaises(f.Guard): f.capacity(audit,"17",f.ZIP_BYTES+1024**3)

    def test_source_boot_claim_prevents_a_new_owner_or_output_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp)/"claims"; name=BOOT+"-"+f.ZIP_SHA[:16]+".json"
            f.one_claim(directory,name,{"owner":OWNER})
            with self.assertRaises(FileExistsError): f.one_claim(directory,name,{"owner":BOOT})
            self.assertEqual(f.private(directory/name),{"owner":OWNER})

    def test_checked_write_rejects_transport_change_without_dispatch(self):
        audit=MemoryAudit(Path("/unused"))
        with patch.object(f,"before_write",return_value="18"):
            with self.assertRaises(f.Guard): f.checked_write(self.cfg, audit,{},["adb","-t","17","reboot"])
        self.assertEqual(audit.commands,[])

    def test_helper_broadcast_intent_precedes_single_apply_and_denies_a_second(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp); audit=MemoryAudit(path); op=operation(path, self.cfg); f.save(path/"bes-source-before-transfer.json",{}); helper=types.SimpleNamespace(UPDATE_STATUS_IDLE="UPDATE_STATUS_IDLE", run=None)
            def main():
                argv=["adb","-t","17","shell","am","broadcast","-a","com.xy.updateota","-p","com.android.systemui",
                      "--es","cmd","start","--es","pkname","com.mentra.asg_client","--es","path",op["remote"]]
                helper.run(argv)
                self.assertTrue((path/"apply-intent.json").exists())
                helper.run(argv)
            helper.main=main
            with patch.object(f,"source_identity",return_value=("17",identity())), patch.object(f,"before_write",return_value="17"), \
                 patch.object(f,"capacity"),patch.object(f,"power_ready"),patch.object(f,"bes_source_span"), patch.object(f,"read_status_isolated",return_value="UPDATE_STATUS_IDLE"):
                with self.assertRaises(FileExistsError): f.run_stage_helper(self.cfg, helper,audit,op,False)
            self.assertEqual(len(audit.commands),1)
            self.assertEqual(f.private(path/"apply-intent.json")["applyCount"],1)

    def test_helper_nonidle_state_never_dispatches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp); audit=MemoryAudit(path); op=operation(path, self.cfg); f.save(path/"bes-source-before-transfer.json",{})
            helper=types.SimpleNamespace(UPDATE_STATUS_IDLE="UPDATE_STATUS_IDLE",run=None)
            helper.main=lambda: helper.run(["adb","-t","17","shell","am","broadcast","-a","com.xy.updateota","-p","com.android.systemui",
                     "--es","cmd","start","--es","pkname","com.mentra.asg_client","--es","path",op["remote"]])
            with patch.object(f,"source_identity",return_value=("17",identity())),patch.object(f,"capacity"),patch.object(f,"power_ready"),patch.object(f,"bes_source_span"), \
                 patch.object(f,"read_status_isolated",return_value="UPDATE_STATUS_DOWNLOADING"):
                with self.assertRaises(f.Guard): f.run_stage_helper(self.cfg, helper,audit,op,False)
            self.assertEqual(audit.commands,[])
            self.assertFalse((path/"apply-intent.json").exists())

    def prepare_activation(self, path):
        op=operation(path, self.cfg)
        f.save(path/"bes-source-before-transfer.json",{})
        op["besContinuity"]={"path":str(path/"bes-input.json"),"sha256":"a"*64}
        op["claim"]=f.save(self.cfg.stage_claims/(BOOT+"-"+f.ZIP_SHA+".json"),copy.deepcopy(op))
        f.save(path/"operation.json",op)
        (path/"audited-stage").mkdir()
        child=f.save(path/"audited-stage/result.json",{"success":True})
        stage={"status":"staged-awaiting-explicit-activation","payloadApplied":True,"activationCount":0,"owner":OWNER,
               "operationSha256":f.digest(path/"operation.json"),"stageResultSha256":child["sha256"],"source":identity(),
               "targetSlot":"_b","useStatusProbe":False,"besSourceSha256":f.digest(path/"bes-source-before-transfer.json")}
        f.save(path/"stage-result.json",stage)
        return op,stage

    def test_failed_or_changed_stage_cannot_be_activated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);op,_=self.prepare_activation(path)
            self.assertEqual(f.activation_inputs(self.cfg, path)[0],op)
            f.save(path/"failure.json",{"status":"failed"})
            with self.assertRaises(f.Guard):f.activation_inputs(self.cfg, path)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);self.cfg=make_config(path/"configuration");self.prepare_activation(path)
            (path/"audited-stage/result.json").write_text('{"success":false}')
            with self.assertRaises(f.Guard):f.activation_inputs(self.cfg, path)

    def test_normalized_activation_receipt_matches_real_recovery_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);op=operation(path, self.cfg)
            intent=f.make_activation_intent(self.cfg, op,"_b")
            intent_ref=f.save(path/"activation-intent.json",intent)
            result_ref=f.save(path/"activation-result.json",{"schemaVersion":1,"owner":OWNER,"status":"activation-dispatched",
               "intentSha256":intent_ref["sha256"],"updateEngineStatus":"UPDATED_NEED_REBOOT","payloadApplied":True,
               "targetSlot":"_b","sourceBoot":BOOT,"acceptedAt":time.time(),"dispatchExitCode":0,"activationCount":1})
            receipt=path/"receipt.json"
            f.save(receipt,{"schemaVersion":1,"profile":f.recovery.PROFILE,"owner":OWNER,"credentialFileSha256":"b"*64,
               "intent":intent_ref,"activation":result_ref})
            proof=f.recovery.activation_proof(self.cfg, receipt,"b"*64)
            self.assertEqual(proof["owner"],OWNER)
            self.assertEqual(proof["source"]["boot"],BOOT)

    def test_activation_nonready_does_not_create_intent_or_reboot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);self.prepare_activation(path); audit=MemoryAudit(path)
            helper=types.SimpleNamespace(UPDATE_STATUS_UPDATED_NEED_REBOOT="UPDATE_STATUS_UPDATED_NEED_REBOOT")
            with patch.object(f,"before_write",return_value="17"),patch.object(f,"capacity"),patch.object(f,"power_ready"),patch.object(f,"bes_source_span"), \
                 patch.object(f,"read_status",return_value="UPDATE_STATUS_DOWNLOADING"):
                with self.assertRaises(f.Guard):f.activate(self.cfg, types.SimpleNamespace(run=path),helper,audit)
            self.assertEqual(audit.commands,[])
            self.assertFalse((path/"activation-intent.json").exists())

    def test_ambiguous_activation_keeps_intent_and_omits_successful_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);self.prepare_activation(path);audit=MemoryAudit(path)
            helper=types.SimpleNamespace(UPDATE_STATUS_UPDATED_NEED_REBOOT="UPDATE_STATUS_UPDATED_NEED_REBOOT")
            def failed(*args):
                self.assertTrue((path/"activation-intent.json").exists())
                raise TimeoutError()
            with patch.object(f,"before_write",return_value="17"),patch.object(f,"capacity"),patch.object(f,"power_ready"),patch.object(f,"bes_source_span"), \
                 patch.object(f,"read_status",return_value="UPDATE_STATUS_UPDATED_NEED_REBOOT"),patch.object(f,"checked_write",side_effect=failed), \
                 patch.object(f,"capture_recovery_log",return_value={"available":False}),patch.object(f,"prepare_wipe_witness",return_value={}):
                with self.assertRaises(TimeoutError):f.activate(self.cfg, types.SimpleNamespace(run=path),helper,audit)
            self.assertFalse((path/"receipt.json").exists())
            self.assertFalse((path/"activation-result.json").exists())

    def test_controller_does_not_accept_public_or_usb_endpoints(self):
        self.assertEqual(f.endpoint(ENDPOINT),ENDPOINT)
        for value in ("8.8.8.8:5555","127.0.0.1:5555","169.254.1.1:5555","192.168.50.10:4444"):
            with self.assertRaises(f.Guard):f.endpoint(value)


    def test_wipe_witness_is_owned_read_back_and_never_overwritten_or_resent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);op=operation(path, self.cfg);audit=MemoryAudit(path);writes=[];exists=[False]
            def command(argv,timeout=30):return completed("",0 if exists[0] else 1)
            def write(_cfg,_audit,_op,argv,timeout=30):
                self.assertTrue((path/"wipe-witness-intent.json").exists())
                if argv[3:] == ["shell","sync"]:
                    self.assertTrue(exists[0])
                    return completed()
                self.assertEqual(argv[-1],f"/data/local/tmp/mentra-day1-wipe-{OWNER}.json")
                writes.append(argv);exists[0]=True;return completed()
            def shell(t,c):
                if c.startswith("test -d"):return "ready"
                if c.startswith("sha256sum"):return f.digest(path/"wipe-witness.json")+"  owned"
                if c.startswith("cat"):return (path/"wipe-witness.json").read_text()
                raise AssertionError(c)
            audit.run=command;audit.shell=shell
            with patch.object(f,"before_write",return_value="17"),patch.object(f,"source_identity",return_value=("17",identity())), \
                 patch.object(f,"checked_write",side_effect=write):
                proof=f.prepare_wipe_witness(self.cfg, audit,op)
                self.assertTrue(proof["hashReadbackVerified"] and proof["contentReadbackVerified"] and proof["syncReturned"])
                with self.assertRaises(f.Guard):f.prepare_wipe_witness(self.cfg, audit,op)
            self.assertEqual(len(writes),1)

    def test_ambiguous_witness_write_cannot_produce_verified_witness_or_activation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);audit=MemoryAudit(path);op=operation(path, self.cfg)
            audit.run=lambda argv,timeout=30:completed("",1)
            audit.shell=lambda t,c:"ready"
            with patch.object(f,"before_write",return_value="17"),patch.object(f,"checked_write",side_effect=TimeoutError):
                with self.assertRaises(TimeoutError):f.prepare_wipe_witness(self.cfg, audit,op)
            self.assertTrue((path/"wipe-witness-intent.json").exists())
            self.assertFalse((path/"wipe-witness-before.json").exists())
            self.assertFalse((path/"activation-intent.json").exists())

    def run_wipe_observation(self, marker_state="ABSENT", wrong_boot=False, identity_error=False):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);audit=MemoryAudit(path);op=operation(path, self.cfg)
            (path/"recovery").mkdir()
            new_boot="6e2ec8ea-1256-4022-aebd-709e4e135721"
            after={"boot":new_boot,"freshBleBridge":{"mac":FIXTURE["mac"],"endpoint":ENDPOINT,"ssidMatches":True}}
            f.save(path/"recovery/after.json",after)
            witness={"owner":OWNER,"sourceBoot":BOOT,"remote":f"/data/local/tmp/mentra-day1-wipe-{OWNER}.json",
                     "hashReadbackVerified":True,"contentReadbackVerified":True,"syncReturned":True}
            current={"boot":new_boot,"transport":"23"}
            audit.shell=lambda t,c: (BOOT if wrong_boot else new_boot) if c.startswith("cat") else marker_state
            with patch.object(f.recovery,"activation_proof",return_value={}), \
                 patch.object(f.recovery,"identity",side_effect=f.Guard("wrong_identity") if identity_error else None,return_value=current), \
                 patch.object(f,"capture_recovery_log",return_value={"available":False}):
                return f.verify_wipe_witness(self.cfg, audit,op,{"path":str(path/"receipt.json")},witness,{"available":False})

    def test_wipe_proof_requires_new_january_identity_and_accessible_absence(self):
        result=self.run_wipe_observation()
        self.assertEqual(result["status"],"passed")
        self.assertTrue(result["markerAbsent"])
        self.assertEqual(result["allUserdataBlocksErased"],"not-verified")
        self.assertFalse(result["otherUserdataContentsExamined"])
        self.assertFalse(result["recoveryLogContainsWipeMarkers"])
        self.assertFalse(result["recoveryLogBoundToThisActivation"])
        for state in ("PRESENT","UNREADABLE",""):
            with self.subTest(state=state),self.assertRaises(f.Guard):self.run_wipe_observation(marker_state=state)
        with self.assertRaises(f.Guard):self.run_wipe_observation(wrong_boot=True)
        with self.assertRaises(f.Guard):self.run_wipe_observation(identity_error=True)

    def test_unavailable_recovery_log_is_not_interpreted_as_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit=MemoryAudit(Path(tmp));audit.run=lambda *a,**k:completed("permission denied",1)
            result=f.capture_recovery_log(audit,"23","log.json")
            self.assertFalse(result["available"])
            self.assertFalse(result["dataWipeCompleteReported"])

    def test_after_witness_status_change_prevents_activation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);self.prepare_activation(path);audit=MemoryAudit(path)
            helper=types.SimpleNamespace(UPDATE_STATUS_UPDATED_NEED_REBOOT="UPDATE_STATUS_UPDATED_NEED_REBOOT")
            with patch.object(f,"before_write",return_value="17"),patch.object(f,"capacity"),patch.object(f,"power_ready"),patch.object(f,"bes_source_span"), \
                 patch.object(f,"read_status",side_effect=["UPDATE_STATUS_UPDATED_NEED_REBOOT","UPDATE_STATUS_IDLE"]), \
                 patch.object(f,"capture_recovery_log",return_value={"available":False}),patch.object(f,"prepare_wipe_witness",return_value={}):
                with self.assertRaises(f.Guard):f.activate(self.cfg, types.SimpleNamespace(run=path),helper,audit)
            self.assertFalse((path/"activation-intent.json").exists())

    def test_existing_activation_phase_is_never_reopened_after_interruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"activation"
            f.Audit(self.cfg, path)
            f.save(path/"activation-intent.json",{"owner":OWNER,"activationCount":1})
            before=(path/"activation-intent.json").read_bytes()
            with self.assertRaises(FileExistsError):f.Audit(self.cfg, path)
            self.assertEqual((path/"activation-intent.json").read_bytes(),before)

    def test_status_probe_remaps_only_exact_audited_read_commands(self):
        for text in (f"sha256sum {f.HELPER_REMOTE_PROBE} | cut -d' ' -f1",
                     f"CLASSPATH={f.HELPER_REMOTE_PROBE} app_process /system/bin UpdateEngineStatus"):
            argv=['adb','-t','17','shell',text]
            self.assertEqual(f.status_probe_command(argv),[*argv[:4],text.replace(f.HELPER_REMOTE_PROBE,f.REMOTE_PROBE)])
        argv=['adb','-t','17','shell','rm '+f.HELPER_REMOTE_PROBE]
        self.assertEqual(f.status_probe_command(argv),argv)

    def test_unknown_shared_probe_is_not_queried_or_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            audit=MemoryAudit(Path(tmp)); op=operation(Path(tmp), self.cfg); commands=[]
            def run(argv,timeout=30):
                commands.append(argv)
                return completed("",1)
            audit.run=run;audit.shell=lambda t,c:f.PROBE_SHA+" owned"
            with patch.object(f,"checked_write",return_value=completed()) as write:
                self.assertTrue(f.ensure_probe(self.cfg, audit,op,"17"))
                self.assertEqual(write.call_args.args[3][-1],f.REMOTE_PROBE)
                self.assertNotEqual(f.REMOTE_PROBE,f.HELPER_REMOTE_PROBE)
            self.assertFalse(any(f.HELPER_REMOTE_PROBE in part for argv in commands for part in argv))

    def test_bes_heartbeat_requires_real_numeric_battery_and_ready(self):
        message={"C":"sr_hrt","S":0,"B":{"pt":80,"vt":4050,"ready":1,"charg":1}}
        self.assertEqual(power.heartbeat(message)["charging"],True)
        del message["B"]["charg"]
        self.assertIsNone(power.heartbeat(message)["charging"])
        for key,value in (("pt",True),("pt",-1),("pt",101),("vt",0),("ready",0),("charg",2),("charg",True)):
            changed=copy.deepcopy(message);changed["B"][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(f.Guard):power.heartbeat(changed)

    def test_low_or_stale_bes_power_never_uses_usb_to_forge_battery(self):
        for level,age,charging,allowed in ((70,0,True,True),(70,0,False,True),(70,0,None,True),
                                         (49,0,True,False),(100,31,False,False)):
            with self.subTest(level=level,age=age,charging=charging),tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp);audit=MemoryAudit(path);op=operation(path, self.cfg)
                def run(argv,timeout=30):
                    directory=Path(argv[-1]);directory.mkdir()
                    now=time.time()-age
                    f.save(directory/"result.json",{"status":"passed","source":"fresh MAC-identified BES sr_hrt",
                       "mac":FIXTURE["mac"],"queryCount":1,"firmwareWrites":0,"mtkReady":True,
                       "sentAt":now,"observedAt":now,"identityRecheckedAt":now,
                       "batteryPercent":level,"voltageMillivolts":4000,"charging":charging})
                    return completed()
                audit.run=run
                with patch.object(f,"before_write",return_value="17"),patch.object(f,"verified_usb",return_value={"usbAttached":True}) as usb:
                    if allowed:
                        result=f.power_ready(self.cfg, audit,op,"test")
                        self.assertEqual(result["charging"],charging)
                        self.assertEqual(usb.call_count,0 if charging is True else 1)
                    else:
                        with self.assertRaises(f.Guard):f.power_ready(self.cfg, audit,op,"test")
                        usb.assert_not_called()

    def test_wifi_transport_or_wrong_usb_identity_cannot_prove_attachment(self):
        audit=MemoryAudit(Path("/unused"))
        audit.run=lambda argv:completed(FIXTURE["serial"]+" device usb:12 transport_id:53")
        def shell(t,c):
            return {"cat /proc/sys/kernel/random/boot_id":BOOT,"cat /sys/block/mmcblk0/device/cid":FIXTURE["cid"],
                    "getprop ro.boot.serialno":FIXTURE["serial"],"getprop persist.mentra.live.mac":FIXTURE["mac"],
                    "getprop ro.custom.ota.version":f.SOURCE}[c]
        audit.shell=shell
        self.assertFalse(f.verified_usb(self.cfg, audit,identity())["chargingInferred"])
        audit.run=lambda argv:completed(ENDPOINT+" device transport_id:17")
        with self.assertRaises(f.Guard):f.verified_usb(self.cfg, audit,identity())
        audit.run=lambda argv:completed(FIXTURE["serial"]+" device usb:12 transport_id:53")
        audit.shell=lambda t,c:"wrong"
        with self.assertRaises(f.Guard):f.verified_usb(self.cfg, audit,identity())

    def test_later_source_gate_needs_no_original_ring_and_rejects_changed_counter(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);op=operation(path, self.cfg);op['besContinuity']={'path':'/private/input','sha256':'a'*64}
            prior={'sourceBoot':BOOT,'pid':'123','startTicks':'100','proof':{'stamp':100,'line':'original'},
                   'initialProofLogSha256':'d'*64,'activity':{'processSid':'abcd1234','admissionGeneration':7,
                   'elapsedRealtimeMs':100000,'requestId':'initial','versionRequestId':'initial-version'}}
            current={**prior['activity'],'elapsedRealtimeMs':1900000,'requestId':'closing','versionRequestId':'closing-version'}
            def shell(t,c):
                if c.startswith('pidof'):return '123'
                if c.startswith('cat /proc/123/stat'):return '123 (asg) '+' '.join(['0']*19+['100'])
                if c.startswith('pm path'):return 'package:/data/app/asg/base.apk'
                if c.startswith('sha256sum'):return 'a'*64+' file'
                raise AssertionError(c)
            audit=MemoryAudit(path);audit.shell=shell
            with patch.object(f,'before_write',return_value='17'),patch.object(f.recovery,'referenced',return_value={}), \
                 patch.object(f.continuity,'validate_input',return_value={'asgSha256':'a'*64,'asgVersionCode':303006206}), \
                 patch.object(f,'activity_snapshot',return_value=current) as query:
                result=f.bes_source_span(self.cfg, audit,op,'before-reboot',prior)
                self.assertEqual(result['proof'],prior['proof'])
                self.assertEqual(audit.commands,[]) # no historical log dump is required
                self.assertFalse(result['historicalRingRetentionRequired'])
                query.return_value={**current,'admissionGeneration':8}
                with self.assertRaises(f.Guard):f.bes_source_span(self.cfg, audit,op,'changed',prior)
                self.assertFalse((path/'bes-source-changed.json').exists())

    def test_fresh_activity_uses_actual_tags_and_does_not_resend_missing_query(self):
        from test_bes_continuity import ContinuityTests
        templates=ContinuityTests()
        with tempfile.TemporaryDirectory() as tmp:
            audit=MemoryAudit(Path(tmp));audit.shell=lambda t,c:'10.50 0.0'
            requests=[]
            def write(c,a,o,argv):
                requests.append(json.loads(f.shlex.split(argv[-1])[-1]))
            def logs(argv,timeout):
                self.assertIn('monotonic',argv)
                self.assertNotIn('epoch',argv)
                version={**templates.version(),'request_id':requests[0]['request_id']}
                activity={**templates.activity(),'request_id':requests[1]['request_id']}
                return completed('10.500000 123 200 I MentraBleTrace: BLE_TRACE direction=glasses_to_phone layer=asg_ble_output source=asg_client type=version_info_1 bytes=411 payload='+json.dumps(version)+'\n'+
                    '10.500000 123 200 I OtaCommandHandler: OTA activity snapshot: '+json.dumps(activity))
            audit.run=logs
            with patch.object(f,'checked_write',side_effect=write):
                result=f.activity_snapshot(self.cfg, audit,{},'17','123',303006206)
            self.assertEqual(result['admissionGeneration'],4)
            self.assertEqual([x['type'] for x in requests],['request_version','ota_query_status'])
            requests.clear();audit.run=lambda *args:completed('')
            with patch.object(f,'checked_write',side_effect=write),patch.object(f.time,'monotonic',side_effect=[0,16]):
                with self.assertRaises(f.Guard):f.activity_snapshot(self.cfg, audit,{},'17','123',303006206)
            self.assertEqual(len(requests),2)

    def test_release_version_response_requires_exact_envelope_pid_time_nonce_and_unique_reply(self):
        from test_bes_continuity import ContinuityTests
        value=ContinuityTests().version()
        raw=('8995.257905 2166 2225 I MentraBleTrace: BLE_TRACE direction=glasses_to_phone '
             'layer=asg_ble_output source=asg_client type=version_info_1 bytes=411 payload='+json.dumps(value))
        parse=lambda text:f.activity_responses(text,'2166','version-new','activity-new',8995.0,8996.0)
        self.assertEqual(parse(raw)['version'],[value])
        for old,new in [('direction=glasses_to_phone','direction=phone_to_glasses'),
                        ('layer=asg_ble_output','layer=asg_ble_outbound_queue'),('source=asg_client','source=other'),
                        ('type=version_info_1','type=version_info_3'),(' 2166 ',' 2167 '),
                        ('8995.257905','8994.999999'),('8995.257905','8996.000001'),
                        ('version-new','different-nonce'),('bytes=411','bytes=0'),('MentraBleTrace:','OtherTag:'),
                        ('"type": "version_info_1"','"type": "version_info_3"')]:
            with self.subTest(old=old,new=new):self.assertEqual(parse(raw.replace(old,new))['version'],[])
        self.assertEqual(parse('8995.3 2166 2225 D AsgClientServiceV2: 📤 Sending version_info_1: '+json.dumps(value))['version'],[])
        with self.assertRaises(f.Guard):parse(raw+'\n'+raw)
        self.assertEqual(parse(raw[:-1])['version'],[])

    def test_completed_continuity_is_setup_only_and_keeps_original_bes_epoch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/"activation").mkdir();path=root/"activation";audit=MemoryAudit(path)
            op=operation(root, self.cfg);op["besContinuity"]={"path":"/private/proof.json","sha256":"a"*64}
            original={"proof":{"stamp":1790055833.851,"line":"verified"},"pid":"123","startTicks":"100",
                      "activity":{"processSid":"a98b9c05","admissionGeneration":4,"elapsedRealtimeMs":123000,
                                  "requestId":"first-activity","versionRequestId":"first-version"}}
            f.save(root/"bes-source-before-transfer.json",original)
            f.save(path/"bes-source-before-reboot.json",{**original,"activity":{**original["activity"],
                   "elapsedRealtimeMs":456000,"requestId":"last-activity","versionRequestId":"last-version"}})
            (path/"recovery").mkdir()
            new_boot="6e2ec8ea-1256-4022-aebd-709e4e135721"
            f.save(path/"recovery/after.json",{"boot":new_boot,"asgSha256":ASG_SHA,
                   "factoryAsgIdentity":{"sha256":ASG_SHA},
                   "freshBleBridge":{"endpoint":ENDPOINT}})
            audit.run=lambda argv,timeout=30:completed("1790056000.000 321 399 I OtaHelper: Autonomous OTA mode DISABLED - updates only via phone app")
            def shell(t,c):
                if c.startswith("pidof"):return "321"
                if c.startswith("cat /proc/321/stat"):return "321 (asg) "+" ".join(["0"]*19+["123"])
                if c=="date +%s":return "1790056010"
                if c=="cat /proc/uptime":return "20.00 15.00"
                if c.startswith("pm path"):return "package:/system/app/MentraOSLauncher/MentraOSLauncher.apk"
                if c.startswith("sha256sum"):return ASG_SHA+" file"
                if c.endswith("boot_id"):return new_boot
                raise AssertionError(c)
            audit.shell=shell
            with patch.object(f,"transport",return_value="17"), patch.object(f.factory_asg,"verify",return_value={"sha256":ASG_SHA}):
                result=f.finish_bes_continuity(self.cfg, audit,op,{"status":"passed","newBoot":new_boot})
            self.assertEqual(result["kind"],"verified-install-continuity")
            self.assertTrue(result["setupOnly"])
            self.assertFalse(result["postWipeFreshBesObserved"])
            self.assertFalse(result["usableAsFinalModernFirmwareProof"])
            self.assertEqual(result["originalBesObservedDeviceEpoch"],1790055833.851)

    def test_incomplete_wipe_cannot_become_bes_setup_continuity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);(path/"recovery").mkdir()
            f.save(path/"recovery/after.json",{"boot":BOOT,"asgSha256":ASG_SHA})
            audit=MemoryAudit(path)
            with self.assertRaises(f.Guard):f.finish_bes_continuity(self.cfg, audit,operation(path, self.cfg),{"status":"failed","newBoot":BOOT})
            self.assertEqual(audit.commands,[])
            self.assertFalse((path/"bes-continuity-result.json").exists())


if __name__ == "__main__":unittest.main()
