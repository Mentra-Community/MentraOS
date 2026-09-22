import copy
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import config
import full_january as f
import observe
import reconcile
from test_support import make_config, FIXTURE
from test_full_january import BOOT, identity, completed

NEW_BOOT='6e2ec8ea-1256-4022-aebd-709e4e135721'


class FakeAudit:
    def __init__(self,path):
        self.path=path;path.mkdir(mode=0o700)
        self.commands=[];self.events=[];self.present=False;self.client=False;self.push_code=0
        self.hash=config.PROBE_SHA;self.boot=BOOT;self.pid='321';self.ticks='123';self.log=''
    def event(self,name,**values):self.events.append((name,values))
    def run(self,argv,timeout=30):
        self.commands.append(argv)
        if 'push' in argv:
            self.present=self.push_code==0
            return completed(code=self.push_code)
        command=argv[-1]
        if command=='command -v update_engine_client':return completed('/system/bin/update_engine_client' if self.client else '',0 if self.client else 1)
        if command.startswith('test -e '):return completed(code=0 if self.present else 1)
        if command.startswith('test -f '):return completed(code=0 if self.present else 1)
        if 'logcat' in argv:return completed(self.log)
        raise AssertionError(argv)
    def shell(self,t,command):
        self.commands.append(['shell',t,command])
        if command.startswith('sha256sum '):return self.hash+'  '+f.REMOTE_PROBE
        if command=='cat /proc/sys/kernel/random/boot_id':return self.boot
        if command=='pidof com.mentra.asg_client':return self.pid
        if command.startswith('cat /proc/') and command.endswith('/stat'):return self.pid+' (process name) '+' '.join(['0']*19+[self.ticks])
        if command=='date +%s':return '1005'
        if command=='cat /proc/uptime':return '15 0'
        raise AssertionError(command)


class ObserveTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.cfg=make_config(self.root/'cfg');self.run=self.root/'stage'
        self.audit=FakeAudit(self.root/'audit');self.source=identity()
        self.selected={'kind':'source','endpoint':self.cfg.source_endpoint,'references':[]}
        for target in ((config.Config,'require_lease'),(config.Reference,'verify')):
            mock=patch.object(*target);mock.start();self.addCleanup(mock.stop)
        self.ident=patch.object(observe,'identity',return_value=('17',self.source)).start()
        self.addCleanup(patch.stopall)

    def ensure(self,allow=True):
        return observe.ensure_probe(self.cfg,self.audit,self.selected,'17',self.source,allow)

    def test_missing_probe_requires_explicit_allow_and_has_no_intent(self):
        with self.assertRaisesRegex(config.Guard,'explicit_staging'):self.ensure(False)
        self.assertFalse((self.audit.path/'probe-intent.json').exists())
        self.assertFalse(any('push' in cmd for cmd in self.audit.commands))

    def test_one_pinned_probe_push_has_prior_claim_and_intent(self):
        run=self.audit.run
        def command(argv,timeout=30):
            if 'push' in argv:
                intent=f.private(self.audit.path/'probe-intent.json')
                self.assertEqual(f.recovery.referenced(intent['claim'])['identity']['boot'],BOOT)
                self.assertEqual(intent['sha256'],config.PROBE_SHA)
                self.assertEqual(intent['firmwareWrites'],0)
            return run(argv,timeout)
        self.audit.run=command
        self.assertEqual(self.ensure(),(True,1))
        self.assertEqual(sum('push' in cmd for cmd in self.audit.commands),1)
        self.assertEqual(self.audit.commands[-1][-1],'sha256sum '+f.REMOTE_PROBE)
        self.assertFalse(self.run.exists())

    def test_existing_probe_reused_and_unknown_hash_never_overwritten(self):
        self.audit.present=True
        self.assertEqual(self.ensure(False),(True,0))
        self.audit.hash='0'*64
        with self.assertRaisesRegex(config.Guard,'not_reviewed'):self.ensure()
        self.assertFalse(any('push' in cmd for cmd in self.audit.commands))

    def test_ambiguous_probe_push_cannot_repeat_from_another_observation(self):
        self.audit.push_code=1
        with self.assertRaisesRegex(config.Guard,'do_not_resend'):self.ensure()
        self.audit=FakeAudit(self.root/'later')
        with self.assertRaises(FileExistsError):self.ensure()
        self.assertFalse(any('push' in cmd for cmd in self.audit.commands))

    def test_new_verified_postwipe_boot_can_stage_deleted_probe_once(self):
        self.assertEqual(self.ensure(),(True,1))
        source_claim=self.cfg.claims_root/FIXTURE['cid']/'status-probe'/(BOOT+'-'+config.PROBE_SHA+'.json')
        self.audit=FakeAudit(self.root/'postwipe')
        target={**self.source,'boot':NEW_BOOT,'mtk':f.TARGET,'mac':'','uid':2000,'asgVersionCode':27}
        self.ident.return_value=('17',target)
        selected={**self.selected,'kind':'target'}
        self.assertEqual(observe.ensure_probe(self.cfg,self.audit,selected,'17',target,True),(True,1))
        self.assertTrue(source_claim.is_file())
        target_claim=source_claim.with_name(NEW_BOOT+'-'+config.PROBE_SHA+'.json')
        self.assertEqual(f.private(target_claim)['identity']['boot'],NEW_BOOT)
        self.assertEqual(sum('push' in cmd for cmd in self.audit.commands),1)

    def test_identity_change_before_push_preserves_intent_and_no_push(self):
        changed={**self.source,'boot':NEW_BOOT}
        self.ident.side_effect=[('17',self.source),('17',changed)]
        with self.assertRaisesRegex(config.Guard,'identity_changed'):self.ensure()
        self.assertTrue((self.audit.path/'probe-intent.json').exists())
        self.assertFalse(any('push' in cmd for cmd in self.audit.commands))

    def test_native_client_requires_no_helper_stage(self):
        self.audit.client=True
        self.assertEqual(self.ensure(False),(False,0))
        self.assertFalse((self.audit.path/'probe-result.json').exists())

    def collect(self,selected=None,status=reconcile.IDLE):
        self.audit.present=True
        with patch.object(observe,'binding',return_value=selected or self.selected),\
             patch.object(f,'read_status',return_value=status) as status_read,\
             patch.object(f,'transport',return_value='17'):
            reference=observe.collect(self.cfg,self.run,self.audit,object())
        self.assertEqual(status_read.call_count,1)
        return f.recovery.referenced(reference)

    def test_actual_status_and_fresh_source_batch_feed_canonical_reconcile(self):
        value=self.collect(status=reconcile.READY)
        self.assertEqual(value['engineStatus'],reconcile.READY)
        self.assertEqual(value['bootBefore'],value['bootAfter'])
        self.assertEqual(value['diagnosticProbeWrites'],0)
        self.assertEqual(reconcile.reconcile('stage',self.cfg,self.run,value)['status'],'unknown')
        # The actual READY response never becomes invented IDLE before stage.
        self.assertFalse(self.run.exists())

    def test_unknown_engine_or_changed_closing_boot_has_no_current_result(self):
        with self.assertRaisesRegex(config.Guard,'engine_unknown'):self.collect(status='IDLE')
        self.assertFalse((self.audit.path/'current.json').exists())
        self.audit=FakeAudit(self.root/'changed-boot');self.audit.boot=NEW_BOOT
        with self.assertRaisesRegex(config.Guard,'boot_or_transport'):self.collect()

    def test_target_capture_closes_real_status_reads_with_current_pid_log(self):
        target={**self.source,'boot':NEW_BOOT,'mtk':f.TARGET,'mac':'','uid':2000,'asgVersionCode':27}
        self.ident.return_value=('17',target);self.audit.boot=NEW_BOOT
        self.audit.log='1000.00 321 333 I OtaHelper: Autonomous OTA mode DISABLED - updates only via phone app'
        value=self.collect(selected={**self.selected,'kind':'target'})
        self.assertEqual(value['identity'],target)
        self.assertEqual(value['januaryLog']['text'],self.audit.log)
        self.assertLessEqual(value['stateReadsFinishedAt'],value['januaryLog']['capturedAt'])
        self.assertLessEqual(value['januaryLog']['capturedAt'],value['finishedAt'])
        self.assertEqual(value['januaryLog']['startTicksBefore'],'123')
        self.assertFalse(value['freshBleReadPerformed'])

    def test_changed_target_process_or_stale_batch_fails_without_ready_claim(self):
        self.ident.return_value=('17',{**self.source,'boot':NEW_BOOT});self.audit.boot=NEW_BOOT
        with patch.object(observe,'process',side_effect=[('321','1'),('321','2')]):
            with self.assertRaisesRegex(config.Guard,'process_or_clock'):self.collect(selected={**self.selected,'kind':'target'})
        self.assertFalse((self.audit.path/'current.json').exists())

    def test_normal_receipts_bind_only_original_new_boot_and_owner(self):
        # Reuse the canonical successful synthetic stage/activation fixture.
        import test_reconcile
        fixture=test_reconcile.ReconcileTests('test_completed_setup_requires_live_target_and_preserves_setup_scope')
        fixture.setUp();self.addCleanup(fixture.doCleanups)
        fixture.completed()
        selected=observe.binding(fixture.cfg,fixture.run)
        self.assertEqual(selected['kind'],'target')
        self.assertEqual(selected['after']['boot'],NEW_BOOT)
        self.assertEqual(selected['proof']['owner'],f.private(fixture.run/'operation.json')['owner'])
        result_path=fixture.run/'activation/recovery/result.json'
        changed=f.private(result_path);changed['owner']='11111111-1111-1111-1111-111111111111'
        result_path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(config.Guard,'not_owned'):observe.binding(fixture.cfg,fixture.run)

    def test_target_binding_never_invents_recovery_from_boot(self):
        self.assertEqual(observe.binding(self.cfg,self.run)['kind'],'source')
        folder=self.run/'activation/recovery';folder.mkdir(parents=True)
        f.save(folder/'after.json',{'boot':NEW_BOOT})
        with self.assertRaises(OSError):observe.binding(self.cfg,self.run)


if __name__=='__main__':unittest.main()
