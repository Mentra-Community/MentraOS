"""Synthetic fixtures only; no actual device identities, firmware or commands."""
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

import config

BOOT = '65b56b33-bde8-4457-8027-35c8684cc1c9'
NEW_BOOT = '6e2ec8ea-1256-4022-aebd-709e4e135721'
OWNER = 'f99b48bb-490a-4d28-9c39-a6ce731be055'
NATIVE = 'adb-bes-'+'1'*32
STAMP = 1000.
FIXTURE = {'cid':'ab'*16, 'mac':'02:00:00:00:00:01', 'serial_aliases':['TEST-DEVICE-01'],
           'transport':{'kind':'network', 'address':'192.168.50.20:5555'}}
EXPECTED = {'boot_id':BOOT, 'slot':'_a', 'mtk':'MentraLive_20260921.0', 'bes':'26.9.21.3',
            'asg_version_code':123456, 'asg_apk_sha256':'e'*64}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = value if isinstance(value, bytes) else (json.dumps(value)+'\n').encode()
    path.write_bytes(raw); path.chmod(0o600)
    return {'path':str(path), 'sha256':hashlib.sha256(raw).hexdigest()}


def line(message, pid='1936', stamp=STAMP):
    return f'{stamp:.3f} {pid} 2001 I K900BluetoothManager: {message}\n'


def ready_log():
    return (line(f'BES_OTA_DIAG version_proof actual={EXPECTED["bes"]} current_boot={BOOT} snapshot={{state=IDLE}}')
            + line('UART link ready at fast baud 1152000', stamp=STAMP+.1))


def completion(stamp=1010., pid='1444'):
    state = f'state=TERMINAL owner={NATIVE} auth_boot={BOOT} verify_boot={NEW_BOOT} target=17.26.1.13 terminal_status=SUCCESS terminal_code=verified'
    return line('BES_OTA_DIAG version_proof_complete result=APPLIED actual=17.26.1.13 snapshot={'+state+'}',pid,stamp)


def trace():
    base=f'owner={NATIVE} auth_boot={BOOT} target=17.26.1.13'
    return (line(f'DEBUG: starting validated BES version change artifact=setup-{OWNER} target=17.26.1.13 owner={NATIVE}',stamp=1002.)
        +line('op=reserve_authorization committed=true readback_match=true snapshot={state=AUTH_ATTEMPTED '+base+'}',stamp=1003.)
        +line('BES_OTA_DIAG apply_boundary=after_uart_write '+base+' write_accepted=true snapshot={state=APPLY_PENDING '+base+'}',stamp=1004.)
        +line('BES_OTA_DIAG apply_ack accepted=true snapshot={state=APPLY_PENDING '+base+'}',stamp=1005.))


def make_config(test, root):
    root.mkdir(mode=0o700)
    raw = write(root/'raw.bin', b'R'*1966076)
    ota = write(root/'ota.bin', b'O'*1131730)
    verifier = write(root/'verifier.py', b'# synthetic verifier; never executed\n')
    for key, value in [('RAW_SHA',raw['sha256']),('OTA_SHA',ota['sha256']),('VERIFIER_SHA',verifier['sha256'])]:
        patcher=patch.object(config,key,value);patcher.start();test.addCleanup(patcher.stop)
    python = str(Path(sys.executable).resolve())
    runtime={'path':python, 'sha256':config.digest(python)}
    native=write(root/'native.log',ready_log().encode())
    lease=root/'lease.json';write(lease,{'pid':os.getppid(),'token':'synthetic-lease-token'})
    claims=root/'claims';claims.mkdir(mode=0o700)
    value={'schemaVersion':1,'profileId':config.PROFILE,'fixture':FIXTURE,'expected':EXPECTED,
        'target':{'version':config.VERSION,'raw':raw,'ota':ota},
        'tools':{'adb':runtime,'python':runtime,'verifier':verifier},
        'sourceProof':{'log':native,'pid':'1936','deviceEpoch':1001.},'proof_max_age_seconds':60,
        'lease':{'path':str(lease)},'claimsRoot':str(claims),
        'definition':{name:config.digest(Path(config.__file__).parent/name) for name in config.FILES}}
    ref=write(root/'config.json',value)
    return config.load(ref['path'],ref['sha256'])


def source_observed():
    return {'boot_id':BOOT,'serial':FIXTURE['serial_aliases'][0], 'cid':FIXTURE['cid'],'mac':FIXTURE['mac'],
            **{k:EXPECTED[k] for k in ('mtk','slot','asg_version_code')},'apk_sha256':EXPECTED['asg_apk_sha256'],
            'pid':'1936','device_epoch':1001.}


def current(root, *, target=False):
    observed=source_observed()
    if target: observed.update(boot_id=NEW_BOOT,pid='1444',device_epoch=1011.)
    log=write(root/'current.log',(completion() if target else ready_log()).encode())
    return {'startedAt':1999.,'finishedAt':2000.,'bootBefore':observed['boot_id'],'bootAfter':observed['boot_id'],
            'pidBefore':observed['pid'],'pidAfter':observed['pid'],'startTicksBefore':'100','startTicksAfter':'100',
            'observed':observed,'log':log,'logCapturedAt':1999.5,'endpoint':FIXTURE['transport']['address']}
