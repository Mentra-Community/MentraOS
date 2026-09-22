import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import config
import full_january as f
import reconcile as r
from test_support import FIXTURE, ASG_SHA, make_config
from test_full_january import BOOT, OWNER, identity, operation

NEW_BOOT='6e2ec8ea-1256-4022-aebd-709e4e135721'


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.cfg=make_config(self.root/'configuration')
        self.run=self.root/'stage'
        self.source={'startedAt':1999.,'finishedAt':2000.,'bootBefore':BOOT,'bootAfter':BOOT,
                     'identity':identity(),'engineStatus':r.IDLE}

    def check(self,phase,current=None):
        # Every reconciliation test guards against accidental device/process execution.
        with patch('subprocess.run',side_effect=AssertionError('reconciliation must be read-only')):
            return r.reconcile(phase,self.cfg,self.run,current or self.source,now=2001.)

    def staged(self):
        self.run.mkdir(mode=0o700)
        op=operation(self.run,self.cfg)
        op['credentialFileSha256']=self.cfg.credential.sha256
        op['besContinuity']={'path':str(self.run/'bes-input.json'),'sha256':'a'*64}
        claim=self.cfg.stage_claims/(BOOT+'-'+f.ZIP_SHA+'.json')
        op['claim']=f.save(claim,copy.deepcopy(op));f.save(self.run/'operation.json',op)
        f.save(self.run/'bes-source-before-transfer.json',{})
        (self.run/'audited-stage').mkdir()
        child=f.save(self.run/'audited-stage/result.json',{'success':True})
        f.save(self.run/'stage-result.json',{'status':'staged-awaiting-explicit-activation',
            'payloadApplied':True,'activationCount':0,'owner':OWNER,'operationSha256':f.digest(self.run/'operation.json'),
            'stageResultSha256':child['sha256'],'source':op['source'],'targetSlot':'_b','useStatusProbe':False,
            'besSourceSha256':f.digest(self.run/'bes-source-before-transfer.json')})
        return op

    def completed(self):
        op=self.staged();folder=self.run/'activation';folder.mkdir();(folder/'recovery').mkdir()
        intent=f.make_activation_intent(self.cfg,op,'_b');intent['createdAt']=100.
        ref=f.save(folder/'activation-intent.json',intent)
        result=f.save(folder/'activation-result.json',{'schemaVersion':1,'owner':OWNER,'status':'activation-dispatched',
            'intentSha256':ref['sha256'],'updateEngineStatus':'UPDATED_NEED_REBOOT','payloadApplied':True,
            'targetSlot':'_b','sourceBoot':BOOT,'acceptedAt':101.,'dispatchExitCode':0,'activationCount':1})
        f.save(folder/'receipt.json',{'schemaVersion':1,'profile':f.recovery.PROFILE,'owner':OWNER,
            'credentialFileSha256':self.cfg.credential.sha256,'intent':ref,'activation':result})
        bridge={'mac':FIXTURE['mac'],'endpoint':'192.168.50.20:5555','ssidMatches':True}
        factory={'activePath':f.factory_asg.SYSTEM,'systemPath':f.factory_asg.SYSTEM,'backupPath':f.factory_asg.BACKUP,
            'sha256':ASG_SHA,'versionCode':27,'hashes':{name:ASG_SHA for name in ('active','system','backup')}}
        target={'boot':NEW_BOOT,**FIXTURE,'bootSerial':FIXTURE['serial'],'mac':'','mtk':f.TARGET,'slot':'_b','uid':2000,
            'asgVersionCode':27,'asgSha256':ASG_SHA,'factoryAsgIdentity':factory,'freshBleBridge':bridge}
        f.save(folder/'recovery/after.json',target)
        recovery=f.save(folder/'recovery/result.json',{'status':'passed','owner':OWNER,'requestCount':1,
            'newBootVerified':True,'factoryJanuaryIdentityVerified':True,'freshBleBridgeVerified':True})
        wipe=f.save(folder/'wipe-proof.json',{'status':'passed','owner':OWNER,'sourceBoot':BOOT,'newBoot':NEW_BOOT,
            'markerAbsent':True,'parentAccessible':True,'factoryJanuaryIdentityVerified':True})
        bes={'status':'passed','kind':'verified-install-continuity','setupOnly':True,'version':f.continuity.VERSION,
            'sourceBoot':BOOT,'newBoot':NEW_BOOT,'mtkOwner':OWNER,'mtkSha256':f.ZIP_SHA,'payloadSha256':f.PAYLOAD_SHA,
            'installEvidence':op['besContinuity'],'postWipeFreshBesObserved':False,'usableAsFinalModernFirmwareProof':False}
        f.save(folder/'bes-continuity-result.json',bes)
        f.save(folder/'result.json',{'status':'january-setup-baseline-verified','owner':OWNER,'setupBaselineReady':True,
            'activationCount':1,'payloadApplied':True,'newBootVerified':True,'recoveryResultSha256':recovery['sha256'],
            'wipeProofSha256':wipe['sha256'],'besSetupContinuity':bes})
        current={**self.source,'identity':target,'bootBefore':NEW_BOOT,'bootAfter':NEW_BOOT,'stateReadsFinishedAt':1999.5,
            'januaryLog':{'text':'1000.00 321 333 I OtaHelper: Autonomous OTA mode DISABLED - updates only via phone app',
                'pidBefore':'321','pidAfter':'321','startTicksBefore':'100','startTicksAfter':'100','bootEpoch':990.,'deviceEpoch':1005.,'capturedAt':1999.9}}
        return current

    def test_pre_stage_requires_fresh_exact_source_idle_and_no_prior_claim(self):
        self.assertEqual(self.check('stage')['status'],'settled')
        f.save(self.cfg.stage_claims/(BOOT+'-'+f.ZIP_SHA+'.json'),{'owner':'other'})
        self.assertEqual(self.check('stage')['status'],'unknown')

    def test_stale_wrong_source_or_unknown_engine_never_settled(self):
        for key,value in [('finishedAt',1900.),('startedAt',1900.),('startedAt',float('nan')),
                          ('bootAfter',NEW_BOOT),('engineStatus','IDLE'),('engineStatus',r.READY)]:
            with self.subTest(key=key):self.assertEqual(self.check('stage',{**self.source,key:value})['status'],'unknown')
        for key,value in [('epoch','0'),('cid','0'*32),('mac',''),('mtk',f.TARGET),('uid','0')]:
            with self.subTest(key=key):
                value={**self.source,'identity':{**self.source['identity'],key:value}}
                self.assertEqual(self.check('stage',value)['status'],'unknown')

    def test_existing_run_even_before_operation_never_authorizes_restart(self):
        self.run.mkdir();f.save(self.run/'failure.json',{'status':'failed'})
        self.assertEqual(self.check('stage')['status'],'unknown')

    def test_stage_and_activation_share_original_owner_and_distinguish_busy(self):
        self.staged();current={**self.source,'engineStatus':r.READY}
        stage=self.check('stage',current);activation=self.check('activate',current)
        self.assertEqual(stage['status'],'satisfied');self.assertEqual(stage['owner'],OWNER)
        self.assertEqual(activation['status'],'settled');self.assertEqual(activation['owner'],OWNER)
        for phase in ('stage','activate'):
            self.assertEqual(self.check(phase,{**self.source,'engineStatus':'UPDATE_STATUS_DOWNLOADING'})['status'],'active')
            self.assertEqual(self.check(phase,self.source)['status'],'unknown')

    def test_stage_receipt_mutation_and_failed_phase_do_not_become_satisfied(self):
        self.staged();current={**self.source,'engineStatus':r.READY}
        self.assertEqual(self.check('stage',current)['status'],'satisfied')
        (self.run/'audited-stage/result.json').write_text('{"success":false}')
        self.assertEqual(self.check('stage',current)['status'],'unknown')

    def test_activation_directory_is_no_resend_even_when_source_still_ready(self):
        self.staged();(self.run/'activation').mkdir()
        self.assertEqual(self.check('activate',{**self.source,'engineStatus':r.READY})['status'],'unknown')

    def test_completed_setup_requires_live_target_and_preserves_setup_scope(self):
        current=self.completed();result=self.check('activate',current)
        self.assertEqual(result['status'],'satisfied');self.assertTrue(result['setupOnly'])
        self.assertFalse(result['fixtureReadyForOtherRoutines'])
        self.assertIn(str(self.run/'activation/receipt.json'),result['evidence'])
        for key,value in [('boot',BOOT),('mac','AA:AA:AA:AA:AA:AA'),('cid','0'*32),('asgVersionCode',37),('asgSha256','0'*64)]:
            bad=copy.deepcopy(current);bad['identity'][key]=value
            with self.subTest(key=key):self.assertEqual(self.check('activate',bad)['status'],'unknown')
        self.assertEqual(self.check('activate',{**current,'finishedAt':1900.})['status'],'unknown')

    def test_missing_or_later_admission_log_never_proves_target_continuity(self):
        current=self.completed()
        for text in ('', current['januaryLog']['text']+'\n1001.0 321 333 I OtaHelper: Received ota_start command from phone',
                     current['januaryLog']['text']+'\nchatty: dropped 10 lines'):
            bad=copy.deepcopy(current);bad['januaryLog']['text']=text
            self.assertEqual(self.check('activate',bad)['status'],'unknown')
        bad=copy.deepcopy(current);bad['januaryLog']['pidAfter']='777'
        self.assertEqual(self.check('activate',bad)['status'],'unknown')
        for stamp in (1900.,1999.4,2001.,float('nan')):
            bad=copy.deepcopy(current);bad['januaryLog']['capturedAt']=stamp
            self.assertEqual(self.check('activate',bad)['status'],'unknown')

    def test_changed_result_hash_and_activation_failure_remain_unknown(self):
        current=self.completed();folder=self.run/'activation'
        self.assertEqual(self.check('activate',current)['status'],'satisfied')
        f.save(folder/'failure.json',{'status':'failed'})
        self.assertEqual(self.check('activate',current)['status'],'unknown')
        (folder/'failure.json').unlink() # test fixture only
        (folder/'wipe-proof.json').write_text((folder/'wipe-proof.json').read_text()+' ')
        self.assertEqual(self.check('activate',current)['status'],'unknown')

    def test_configuration_changed_between_phases_is_unknown_without_commands(self):
        self.staged();current={**self.source,'engineStatus':r.READY}
        self.cfg.path.write_text(self.cfg.path.read_text()+' ')
        self.assertEqual(self.check('activate',current)['status'],'unknown')


if __name__=='__main__':unittest.main()
