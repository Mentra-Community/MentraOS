import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import config
import bes_setup as adapter
import run
import run_once as observer
from test_support import BOOT, NEW_BOOT, OWNER, NATIVE, EXPECTED, FIXTURE, current, completion, line, make_config, ready_log, trace, write


class AdapterTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);self.cfg=make_config(self,self.root/'inputs')

    def changed_config(self, change):
        value=self.cfg.data;change(value)
        ref=write(self.cfg.path,value)
        return lambda:config.load(ref['path'],ref['sha256'])

    def test_explicit_config_derives_native_idle_without_invented_owner(self):
        actual=self.cfg.adapter_config()
        self.assertEqual(actual['fixture'],FIXTURE)
        self.assertEqual(actual['expected'],EXPECTED)
        self.assertEqual(actual['settled_source'],{'state':'IDLE'})
        self.assertEqual(self.cfg.path,self.root/'inputs/config.json')
        changed=self.cfg.data;changed['expected']['bes']='1.1.1.1'
        self.assertEqual(self.cfg.data['expected']['bes'],EXPECTED['bes'])

    def test_changed_config_definition_or_nonprivate_file_rejected(self):
        self.cfg.path.chmod(0o644)
        with self.assertRaises(config.Guard):config.load(self.cfg.path,self.cfg.sha256)
        self.cfg.path.chmod(0o600)
        with self.assertRaises(config.Guard):
            self.changed_config(lambda v:v['definition'].update({'run.py':'a'*64}))()
        with self.assertRaises(config.Guard):self.cfg.verify_definition()

    def test_only_exact_compact_artifact_and_verifier_are_accepted(self):
        with self.assertRaises(config.Guard):
            self.changed_config(lambda v:v['target'].update(version='26.9.21.3'))()

    def test_old_raw_bytes_or_changed_runtime_cannot_be_used(self):
        raw=Path(self.cfg.data['target']['raw']['path']);raw.write_bytes(b'X'*1966336)
        with self.assertRaises(config.Guard):config.load(self.cfg.path,self.cfg.sha256)

    def test_source_proof_wrong_pid_boot_stale_and_busy_rejected(self):
        for text, pid, boot, now in [(ready_log(),'999',BOOT,1001),
                (ready_log(),'1936',NEW_BOOT,1001),(ready_log(),'1936',BOOT,1062),
                (ready_log()+line('state=AUTH_ATTEMPTED',stamp=1000.2),'1936',BOOT,1001),
                (ready_log().replace('state=IDLE','state=IDLE owner=invented'),'1936',BOOT,1001),
                (ready_log().replace('UART link ready at fast baud 1152000','UART quarantined'),'1936',BOOT,1001)]:
            with self.subTest(text=text,pid=pid),self.assertRaises(RuntimeError):
                adapter.settled_source(text,pid,boot,EXPECTED['bes'],now,60)

    def test_terminal_source_can_keep_old_completed_boot_with_fresh_current_boot(self):
        state={'state':'TERMINAL','owner':NATIVE,'auth_boot':NEW_BOOT,'verify_boot':NEW_BOOT,
               'target':EXPECTED['bes'],'terminal_status':'SUCCESS','terminal_code':'verified'}
        log=ready_log().replace('state=IDLE',' '.join(k+'='+v for k,v in state.items()))
        self.assertEqual(adapter.settled_source(log,'1936',BOOT,EXPECTED['bes'],1001,60),state)

    def test_endpoint_never_selects_usb_or_other_address(self):
        instance=adapter.Adapter(self.cfg,self.root/'observe',OWNER)
        instance.command=Mock(return_value='List of devices attached\n192.168.50.20:5555 device usb:123 transport_id:2\n192.168.50.21:5555 device transport_id:3\n')
        self.assertIsNone(instance.transport(required=False))
        instance.command.return_value+='192.168.50.20:5555 device transport_id:4\n'
        self.assertEqual(instance.transport(),'4')
        for host in ('127.0.0.1:5555','8.8.8.8:5555','169.254.1.2:5555','192.168.50.20:22'):
            with self.assertRaises(Exception):config.endpoint(host)

    def test_parent_lease_mismatch_stops_before_observer_and_claim(self):
        write(Path(self.cfg.data['lease']['path']),{'pid':1,'token':'synthetic'})
        with patch.object(observer,'run') as called,self.assertRaises(config.Guard):
            run.execute(self.cfg,'install',self.root/'attempt',OWNER)
        called.assert_not_called();self.assertFalse(self.cfg.claim_path.exists())

    def test_shared_claim_blocks_other_run_and_owner_without_resend(self):
        with patch.object(observer,'run',return_value=0) as called:
            run.execute(self.cfg,'install',self.root/'one',OWNER)
            with self.assertRaises(FileExistsError):run.execute(self.cfg,'install',self.root/'two',NEW_BOOT)
            called.assert_called_once()
        claim=json.loads(self.cfg.claim_path.read_text())
        self.assertEqual(claim['lifecycleOwner'],OWNER)
        self.assertEqual(self.cfg.claim_path.stat().st_mode&0o777,0o600)

    def test_changed_identity_stops_write_and_intent_is_exclusive(self):
        instance=adapter.Adapter(self.cfg,self.root/'attempt',OWNER)
        instance.identity=Mock(side_effect=RuntimeError('CID changed'));instance.adb=Mock()
        with self.assertRaises(RuntimeError):instance.write('push','source','target')
        instance.adb.assert_not_called()
        path=instance.run_dir/'install-intent.json'
        adapter.durable_new(path,{'owner':OWNER})
        with self.assertRaises(FileExistsError):adapter.durable_new(path,{'owner':NEW_BOOT})

    def test_existing_protocol_has_one_push_and_durable_intent_before_broadcast(self):
        instance=adapter.Adapter(self.cfg,self.root/'attempt',OWNER)
        instance.validate_artifact=Mock();instance.observe=Mock(return_value={'transport':'7'})
        instance.identity=Mock(return_value={'transport':'7'});instance.write=Mock()
        calls=[]
        def shell(t,*argv):
            calls.append(argv)
            if argv[0]=='sha256sum':return config.OTA_SHA+' file'
            self.assertEqual(argv[:4],('am','broadcast','-a',adapter.ACTION))
            intent=json.loads((instance.run_dir/'install-intent.json').read_text())
            self.assertEqual(intent['run_id'],OWNER)
            self.assertIn('setup-'+OWNER,argv)
            return 'Broadcast completed'
        instance.shell=shell
        instance.install()
        instance.write.assert_called_once_with('push',self.cfg.data['target']['ota']['path'],adapter.REMOTE_PREFIX+config.OTA_SHA+'.bin')
        self.assertEqual(sum(x[0]=='am' for x in calls),1)
        with self.assertRaises(RuntimeError):instance.install()

    def test_native_trace_requires_exact_owner_artifact_acceptance_and_order(self):
        found=observer.install_trace(trace(),'1936',OWNER,BOOT)
        self.assertEqual(found['nativeOwner'],NATIVE)
        self.assertEqual(observer.install_trace(trace()+trace(),'1936',OWNER,BOOT),found)
        for value in (trace().replace('accepted=true','accepted=false'), trace().replace('setup-'+OWNER,'setup-'+NEW_BOOT),
                      trace().replace('1004.000','1006.000'),trace()+line('DEBUG: starting validated BES version change artifact=setup-'+OWNER+' target=17.26.1.13 owner='+NATIVE,stamp=1002.5)):
            with self.assertRaises(RuntimeError):observer.install_trace(value,'1936',OWNER,BOOT)

    def test_completion_accepts_verify_boot_but_rejects_wrong_owner_process_or_clock(self):
        stamp,pid,message=next(adapter.log_entries(completion()))
        observed=current(self.root,target=True)['observed']
        self.assertTrue(observer.verified_success(message,pid,stamp,observed,NATIVE,config.VERSION,BOOT))
        for changed in (message.replace(NATIVE,'adb-bes-'+'2'*32),message.replace('APPLIED','INVALID_STATE'),
                        message.replace('SUCCESS','FAILURE'),message.replace(NEW_BOOT,BOOT)):
            self.assertFalse(observer.verified_success(changed,pid,stamp,observed,NATIVE,config.VERSION,BOOT))
        self.assertFalse(observer.verified_success(message,'999',stamp,observed,NATIVE,config.VERSION,BOOT))
        self.assertFalse(observer.verified_success(message,pid,900,observed,NATIVE,config.VERSION,BOOT))


if __name__=='__main__':unittest.main()
