import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).parent))
import full_january as f
import bes_continuity as b
from test_support import FIXTURE

AUTH='2ae86177-4bba-4fb0-9e80-0494e0b867ca'
BOOT='1ae86177-4bba-4fb0-9e80-0494e0b867ca'
RUN='27e266ab-9c20-40c3-aced-0b93acaf411f'
OWNER='adb-bes-d413bd8779e644c8aad13a9376222c8e'
PID='1936'
STAMP=1790055833.851
STATE=f'state=TERMINAL owner={OWNER} auth_boot={AUTH} verify_boot={BOOT} target={b.VERSION} terminal_status=SUCCESS terminal_code=verified'
MESSAGE=f'BES_OTA_DIAG version_proof_complete result=APPLIED actual={b.VERSION} snapshot={{{STATE}}}'
def row(message=MESSAGE,stamp=STAMP,pid=PID):return f'{stamp:.3f} {pid} 1998 I K900BluetoothManager: {message}\n'
def put(path,raw):
    path.write_text(raw);path.chmod(0o600)
    return {'path':str(path),'sha256':hashlib.sha256(raw.encode()).hexdigest()}


class ContinuityTests(unittest.TestCase):
    def setup_input(self,path):
        intent={'run_id':RUN,'fixture':{**FIXTURE,'serial_aliases':[FIXTURE['serial']]},
                'expected':{'mtk':f.SOURCE,'boot_id':AUTH,'bes':'26.9.21.1','asg_apk_sha256':'a'*64,'asg_version_code':303006206},
                'target':{'version':b.VERSION,'raw':{'path':'/private/raw','sha256':b.RAW_SHA},
                          'ota':{'path':'/private/ota','sha256':b.OTA_SHA}}}
        install=row('DEBUG: starting validated BES version change artifact=setup-'+RUN+' target='+b.VERSION+' owner='+OWNER,STAMP-90)
        install+=row('BES_OTA_DIAG apply_ack len=1 accepted=true snapshot={state=APPLY_PENDING owner='+OWNER+
                     ' auth_boot='+AUTH+' target='+b.VERSION+'}',STAMP-80)
        return {'schemaVersion':1,'kind':'verified-install-continuity','sourceBoot':BOOT,'besOwner':OWNER,
                'installIntent':put(path/'intent.json',json.dumps(intent)),
                'installLog':put(path/'install.log',install),'versionLog':put(path/'version.log',row())}

    def validate(self,value):
        return b.validate_input(value,{'boot':BOOT,'mtk':f.SOURCE},FIXTURE,f.require,
                                lambda path: b.RAW_SHA if str(path).endswith('raw') else b.OTA_SHA)

    def test_real_shaped_install_acceptance_and_current_boot_completion_both_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);value=self.setup_input(path)
            result=self.validate(value)
            self.assertEqual(result['acceptedVersionProof']['state']['verify_boot'],BOOT)
            self.assertEqual(result['version'],b.VERSION)
            intent=json.loads(Path(value['installIntent']['path']).read_text())
            intent['expected']['bes']='26.9.21.3'
            value['installIntent']=put(path/'intent.json',json.dumps(intent))
            self.assertEqual(self.validate(value)['version'],b.VERSION)
            for key,old,new in [('installLog','accepted=true','accepted=false'),('versionLog','SUCCESS','FAILURE'),
                               ('versionLog',BOOT,AUTH),('installLog','setup-'+RUN,'setup-'+BOOT),
                               ('versionLog',OWNER,'adb-bes-'+'a'*32)]:
                bad=copy.deepcopy(value);raw=Path(value[key]['path']).read_text().replace(old,new)
                bad[key]=put(path/'bad.txt',raw)
                with self.subTest(key=key,old=old),self.assertRaises(f.Guard):self.validate(bad)

    def test_reference_mutation_permissions_and_wrong_source_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);value=self.setup_input(path)
            bad=copy.deepcopy(value);bad['sourceBoot']=AUTH
            with self.assertRaises(f.Guard):self.validate(bad)
            target=path/'version.log';target.chmod(0o644)
            with self.assertRaises(f.Guard):self.validate(value)
            target.chmod(0o600);target.write_text(row().replace('actual=17.26.1.13','actual=26.9.21.1'))
            with self.assertRaises(f.Guard):self.validate(value)

    def test_old_factory_boot_or_different_mtk_install_cannot_seed_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);value=self.setup_input(path)
            intent=json.loads(Path(value['installIntent']['path']).read_text())
            intent['expected']['mtk']=f.TARGET
            value['installIntent']=put(path/'intent.json',json.dumps(intent))
            with self.assertRaises(f.Guard):self.validate(value)

    def test_initial_source_proof_must_be_fresh_and_cannot_hide_a_writer(self):
        evidence={'input':{'besOwner':OWNER}}
        found=b.check_source_span(row(),evidence,BOOT,PID,STAMP+2,f.require)
        self.assertEqual(found['stamp'],STAMP)
        for raw,pid,now in ((row(),PID,STAMP+61),(row(),'2333',STAMP+20),
                           (row()+'chatty: expired 40 lines\n',PID,STAMP+20),
                           (row()+row('startFirmwareUpdate artifact=other',STAMP+10),PID,STAMP+20),
                           (row()+row('snapshot={state=AUTH_ATTEMPTED owner=other}',STAMP+10),PID,STAMP+20),
                           (row()+row('BES_OTA_DIAG op=retire_success',STAMP+10),PID,STAMP+20)):
            with self.subTest(raw=raw,now=now),self.assertRaises(f.Guard):
                b.check_source_span(raw,evidence,BOOT,pid,now,f.require)

    def activity(self):
        return {'schema':1,'request_id':'activity-new','process_sid':'b928f14e',
                'admission_generation':4,'elapsed_realtime_ms':10509,
                'consistent':True,'updating':False,'mtk_in_progress':False,
                'bes_in_progress':False,'admission_held':False,
                'session':{'session_id':'a10bc23d','status':'complete','restart_pending':False}}

    def version(self):
        return {'type':'version_info_1','package_name':'com.mentra.asg_client',
                'request_id':'version-new','build_number':303006206,'sid':'b928f14e'}

    def validate_activity(self,value,version=None):
        return b.validate_activity(value,version or self.version(),'activity-new','version-new',303006206,10,10.50,f.require)

    def test_activity_requires_correlated_version_build_sid_nonce_and_finite_counter(self):
        self.assertEqual(self.validate_activity(self.activity())['admissionGeneration'],4)
        for key,value in [('schema',True),('request_id','stale'),('process_sid','deadbeef'),
                          ('admission_generation',-1),('admission_generation',True),
                          ('admission_generation','4'),('admission_generation',9007199254740992),
                          ('admission_generation',None),('elapsed_realtime_ms',9999),
                          ('elapsed_realtime_ms',10510),('elapsed_realtime_ms',True)]:
            bad=self.activity();bad[key]=value
            with self.subTest(key=key,value=value),self.assertRaises(f.Guard):self.validate_activity(bad)
        for key,value in [('type','other'),('package_name','other'),('request_id','stale'),
                          ('sid','deadbeef'),('build_number',27)]:
            bad=self.version();bad[key]=value
            with self.subTest(key=key),self.assertRaises(f.Guard):self.validate_activity(self.activity(),bad)

    def test_busy_inconsistent_unknown_or_restarting_snapshot_is_not_idle(self):
        for key,value in [('consistent',False),('updating',True),('mtk_in_progress',True),
                          ('bes_in_progress',True),('admission_held',True),('updating',None)]:
            bad=self.activity();bad[key]=value
            with self.subTest(key=key),self.assertRaises(f.Guard):self.validate_activity(bad)
        for key,value in [('status','downloading'),('status','unknown'),('status',None),
                          ('restart_pending',True),('restart_pending',None),('session_id','unknown')]:
            bad=self.activity();bad['session'][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(f.Guard):self.validate_activity(bad)

    def test_generation_detects_completed_admission_without_historical_logs(self):
        prior={'pid':PID,'startTicks':'1212','activity':self.validate_activity(self.activity())}
        current={**prior['activity'],'requestId':'later-activity','versionRequestId':'later-version',
                 'elapsedRealtimeMs':1200000}
        b.unchanged_generation(prior,current,PID,'1212',f.require)
        for key,value in [('admissionGeneration',5),('processSid','deadbeef'),
                          ('elapsedRealtimeMs',1000),('requestId','activity-new'),
                          ('versionRequestId','version-new')]:
            bad={**current,key:value}
            with self.subTest(key=key),self.assertRaises(f.Guard):
                b.unchanged_generation(prior,bad,PID,'1212',f.require)
        for pid,start in [('2333','1212'),(PID,'1313')]:
            with self.assertRaises(f.Guard):b.unchanged_generation(prior,current,pid,start,f.require)

    def test_january_startup_requires_real_current_boot_disabled_branch_no_admission(self):
        start='Autonomous OTA mode DISABLED - updates only via phone app'
        clean=row(start)
        b.check_january_span(clean,PID,f.require,STAMP-30,STAMP+2)
        for raw in ('',row('OtaService checks will begin automatically'),clean+row('Received ota_start command from phone'),
                    clean+row('startFirmwareUpdate artifact=other'),clean+'chatty: expired\n'):
            with self.subTest(raw=raw),self.assertRaises(f.Guard):b.check_january_span(raw,PID,f.require,STAMP-30,STAMP+2)
        with self.assertRaises(f.Guard):b.check_january_span(clean,PID,f.require,STAMP+100,STAMP+130)
        with self.assertRaises(f.Guard):b.check_january_span(clean,PID,f.require,STAMP-30,STAMP-10)

if __name__=='__main__':unittest.main()
