import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import config
import reconcile
from test_support import BOOT, NEW_BOOT, OWNER, NATIVE, EXPECTED, current, completion, line, make_config, source_observed, trace, write


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);self.cfg=make_config(self,self.root/'inputs');self.run=self.root/'attempt'

    def check(self,value):
        with patch('subprocess.run',side_effect=AssertionError('No commands during reconciliation')):
            return reconcile.reconcile(self.cfg,self.run,OWNER,value,now=2001.)

    def installed(self,failed=False):
        cfg=self.cfg
        cfg.prepare_claims()
        claim=write(cfg.claim_path,{'lifecycleOwner':OWNER,'run':str(self.run),'sourceBoot':BOOT,
                    'configSha256':cfg.sha256,'targetSha256':config.OTA_SHA,'noResend':True})
        write(self.run/'owner.json',{'lifecycleOwner':OWNER,'configSha256':cfg.sha256,'claim':claim})
        write(self.run/'dispatch/install-intent.json',{'run_id':OWNER,'fixture':cfg.data['fixture'],
                    'expected':cfg.data['expected'],'target':cfg.data['target']})
        write(self.run/'before.json',source_observed())
        write(self.run/'handshake.log',(trace()+('' if failed else completion())).encode())
        write(self.run/'result.json',{'status':'failed' if failed else 'passed','owner':NATIVE})

    def test_only_new_exact_source_is_settled(self):
        value=current(self.root)
        self.assertEqual(self.check(value)['status'],'settled')
        self.run.mkdir()
        self.assertEqual(self.check(value)['status'],'unknown')

    def test_missing_or_changed_claim_intent_never_authorizes_resend(self):
        self.installed();value=current(self.root,target=True)
        write(self.run/'dispatch/install-intent.json',{'run_id':NEW_BOOT})
        self.assertEqual(self.check(value)['status'],'unknown')

    def test_same_owner_success_returns_setup_only_continuity(self):
        self.installed();value=current(self.root,target=True);found=self.check(value)
        self.assertEqual(found['status'],'satisfied')
        self.assertEqual(found['nativeOwner'],NATIVE)
        self.assertTrue(found['setupOnly']);self.assertFalse(found['fixtureReadyForOtherRoutines'])
        self.assertEqual(found['continuityInput']['sourceBoot'],NEW_BOOT)
        self.assertEqual(found['continuityInput']['besOwner'],NATIVE)

    def test_continuity_input_is_accepted_by_existing_full_january_validator(self):
        self.installed();value=current(self.root,target=True)
        found=self.check(value)
        source=Path(__file__).resolve().parent.parent/'day1-setup/bes_continuity.py'
        spec=importlib.util.spec_from_file_location('bes_continuity_contract',source)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        # Only synthetic artifact hashes differ; exercise the real shared schema.
        with patch.object(module,'RAW_SHA',config.RAW_SHA),patch.object(module,'OTA_SHA',config.OTA_SHA):
            result=module.validate_input(found['continuityInput'],
                {'boot':NEW_BOOT,'mtk':EXPECTED['mtk']},
                {**self.cfg.data['fixture'],'serial':self.cfg.data['fixture']['serial_aliases'][0]},
                config.require,config.digest)
        self.assertEqual(result['acceptedVersionProof']['state']['owner'],NATIVE)
        self.assertEqual(result['version'],config.VERSION)

    def test_mismatched_original_source_receipt_is_unknown(self):
        self.installed();before=source_observed();before['cid']='0'*32
        write(self.run/'before.json',before)
        self.assertEqual(self.check(current(self.root,target=True))['status'],'unknown')

    def test_reconciled_native_success_keeps_original_failure_unchanged(self):
        self.installed(failed=True);before=(self.run/'result.json').read_bytes()
        value=current(self.root,target=True);found=self.check(value)
        self.assertEqual(found['status'],'satisfied');self.assertTrue(found['originalFailurePreserved'])
        self.assertEqual(found['continuityInput']['versionLog'],value['log'])
        self.assertEqual((self.run/'result.json').read_bytes(),before)

    def test_accepted_apply_alone_or_failed_stale_foreign_version_is_not_success(self):
        self.installed(failed=True)
        for log in (trace(),completion().replace('SUCCESS','FAILURE'),completion().replace(NATIVE,'adb-bes-'+'2'*32),
                    completion(stamp=900),completion().replace('APPLIED','INVALID_STATE')):
            value=current(self.root,target=True);value['log']=write(self.root/'current.log',log.encode())
            self.assertNotEqual(self.check(value)['status'],'satisfied')

    def test_changed_current_identity_process_or_time_rejects(self):
        self.installed();base=current(self.root,target=True)
        for key,value in [('cid','0'*32),('apk_sha256','0'*64),('boot_id',BOOT),('pid','999')]:
            changed=copy.deepcopy(base);changed['observed'][key]=value
            with self.subTest(key=key):self.assertEqual(self.check(changed)['status'],'unknown')
        for key,value in [('pidAfter','99'),('startTicksAfter','101'),('finishedAt',1900.),('logCapturedAt',1900.),('endpoint','192.168.50.21:5555')]:
            with self.subTest(key=key):self.assertEqual(self.check({**base,key:value})['status'],'unknown')

    def test_later_admission_gap_or_unfrozen_log_is_not_success(self):
        self.installed()
        for extra in (line('state=AUTH_ATTEMPTED',pid='1444',stamp=1010.1),
                      line('op=retire_success snapshot={state=TERMINAL}',pid='1444',stamp=1010.1),
                      'chatty: dropped 3 lines\n'):
            value=current(self.root,target=True);value['log']=write(self.root/'current.log',(completion()+extra).encode())
            self.assertEqual(self.check(value)['status'],'unknown')
        value=current(self.root,target=True);Path(value['log']['path']).write_text('changed')
        self.assertEqual(self.check(value)['status'],'unknown')


if __name__=='__main__':unittest.main()
