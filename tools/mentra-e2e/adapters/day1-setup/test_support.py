"""Synthetic fixture inputs; no real device, credential, firmware or transport."""
import hashlib
import json
from pathlib import Path
import sys
import config

FIXTURE = {'cid': '0123456789abcdef0123456789abcdef', 'serial': 'TEST012345', 'mac': 'AA:BB:CC:DD:EE:01'}
ASG_SHA = config.PROFILE['asgSha256']

def put(path, value):
    path.write_text(json.dumps(value)); path.chmod(0o600)
    return {'path':str(path), 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}

def make_config(base, credential_path=None):
    base.mkdir(mode=0o700, exist_ok=True)
    claim_root=base/'claims'; claim_root.mkdir(mode=0o700, exist_ok=True)
    credential_path=credential_path or base/'credentials.json'
    if not credential_path.exists():
        put(credential_path, {'schemaVersion':1, 'fixture':{**FIXTURE,'mtk':config.PROFILE['targetVersion'],
            'boot':'9ad31c85-1a26-49fc-b8b1-6e28b01fb931','slot':'_a'},'endpoint':'192.168.50.10:5555',
            'ssid':'synthetic-test-network','password':'synthetic-test-password'})
    reference=lambda name,sha: {'path':str(base/name),'sha256':sha}
    value={'schemaVersion':1, 'profileId':config.PROFILE['id'], 'profileSha256':config.PROFILE_SHA,
        'fixture':{**FIXTURE,'bootSerial':FIXTURE['serial'],'serialAliases':[FIXTURE['serial']]},
        'claimsRoot':str(claim_root), 'credential':{'path':str(credential_path),'sha256':config.digest(credential_path)},
        'ota':{**reference('full-ota.zip',config.PROFILE['otaSha256']),'size':config.PROFILE['otaBytes']},
        'verification':reference('artifact-verification.json',config.PROFILE['verificationSha256']),
        'stagingHelper':reference('stage_mtk_ota.py',config.HELPER_SHA),
        'statusProbe':{**reference('probe.jar',config.PROBE_SHA),'size':config.PROBE_BYTES},
        'python':str(Path(sys.executable).resolve()), 'adb':str(base/'adb'),
        'lease':{'path':str(base/'lease.json')},
        'definition':{name:config.digest(Path(config.__file__).parent/name) for name in config.DEFINITION_FILES},
        'managedAppExecutableName':'Mentra','sourceEndpoint':'192.168.50.10:5555',
        'besInstallProof':reference('bes-install.json','a'*64)}
    path=base/'config.json'; ref=put(path,value)
    cfg=config.load(path,ref['sha256']); cfg.prepare_claims()
    return cfg
