"""Current identity/engine observation, with explicit diagnostic-only probe staging.

No firmware, activation, provisioning or process control. The existing stage and
activation entry points retain their independent admission/continuity gates.
"""
import math
import os
from pathlib import Path
import re
import time

import config
import full_january as f
import reconcile


class RecoveryAudit:
    """Adapt the existing recovery reader to the same raw command journal."""
    def __init__(self, audit): self.audit = audit
    def command(self, label, argv):
        result = self.audit.run(argv)
        f.require(result.returncode == 0, 'observer_read_failed_'+label)
        return result.stdout.strip()
    def save(self, name, value): self.audit.event(name, value=value)


def binding(cfg, run):
    """Reuse only the original owned recovery bridge on its exact recorded boot."""
    after_path = run/'activation/recovery/after.json'
    if not after_path.exists():
        return {'kind':'source', 'endpoint':cfg.source_endpoint, 'references':[]}
    operation = reconcile._operation(cfg, run)
    f.activation_inputs(cfg, run)
    receipt = run/'activation/receipt.json'
    proof = f.recovery.activation_proof(cfg, receipt, cfg.credential.sha256)
    after = f.private(after_path)
    result_path = run/'activation/recovery/result.json'
    result = f.private(result_path)
    f.require(proof['owner'] == operation['owner'] and proof['source'] ==
              {key:operation['source'][key] for key in ('boot','slot','mtk')}
              and result['owner'] == operation['owner'] and result['status'] == 'passed'
              and result['newBootVerified'] is True and result['factoryJanuaryIdentityVerified'] is True
              and result['freshBleBridgeVerified'] is True, 'observer_recovery_not_owned')
    bridge = after['freshBleBridge']
    f.require(bridge == {'mac':cfg.fixture['mac'], 'endpoint':config.endpoint(bridge['endpoint']), 'ssidMatches':True}
              and after['boot'] != operation['source']['boot'] and re.fullmatch(config.UUID, after['boot'])
              and after['cid'] == cfg.fixture['cid'] and after['serial'] in cfg.serial_aliases
              and after['bootSerial'] == cfg.boot_serial and after['mtk'] == f.TARGET
              and after['slot'] == proof['target']['slot'] and after['asgVersionCode'] == 27
              and after['asgSha256'] == config.PROFILE['asgSha256'], 'observer_recovery_bridge_mismatch')
    return {'kind':'target', 'endpoint':bridge['endpoint'], 'proof':proof, 'after':after,
            'references':[{'path':str(path),'sha256':f.digest(path)} for path in
                          (run/'operation.json', receipt, after_path, result_path)]}


def identity(cfg, audit, selected):
    address = selected['endpoint']
    if selected['kind'] == 'source':
        return f.source_identity(cfg, audit, address)
    # The original fresh BLE bridge is retained, not claimed as a new BLE read.
    t = f.transport(audit, address)
    value = f.recovery.identity(cfg, RecoveryAudit(audit), selected['proof'], address,
                                selected['after']['freshBleBridge'])
    f.require(value['boot'] == selected['after']['boot'] and value['transport'] == t
              and f.transport(audit, address) == t, 'observer_target_boot_or_transport_changed')
    return t, value


def ensure_probe(cfg, audit, selected, t, actual, allow_stage):
    client = audit.run(['adb','-t',t,'shell','command -v update_engine_client'])
    if client.returncode == 0 and client.stdout.strip(): return False, 0
    f.require(client.returncode == 1 and not client.stdout.strip(), 'status_client_probe_failed')
    exists = audit.run(['adb','-t',t,'shell',f'test -e {f.REMOTE_PROBE} || test -L {f.REMOTE_PROBE}'])
    f.require(exists.returncode in (0,1), 'status_probe_presence_unknown')
    writes = 0
    if exists.returncode == 1:
        f.require(allow_stage, 'status_probe_missing_explicit_staging_required')
        cfg.require_lease(); cfg.probe.verify()
        cfg.prepare_claims()
        current_t, current = identity(cfg, audit, selected)
        f.require(current_t == t and current == actual, 'probe_identity_changed')
        # A diagnostic helper has its own per-boot claim, never a firmware intent.
        # Wiping /data removes the helper, but the new boot permits one new stage.
        claim_path = cfg.claims_root/cfg.fixture['cid']/'status-probe'/(actual['boot']+'-'+config.PROBE_SHA+'.json')
        intent = {'kind':'readonly-update-engine-probe', 'configSha256':cfg.sha256,
                  'identity':actual, 'endpoint':selected['endpoint'], 'audit':str(audit.path),
                  'local':str(cfg.probe.path), 'sha256':config.PROBE_SHA, 'remote':f.REMOTE_PROBE,
                  'createdAt':time.time(), 'count':1, 'firmwareWrites':0, 'resendAllowed':False}
        if not claim_path.parent.exists():
            claim_path.parent.mkdir(mode=0o700)
            parent = os.open(claim_path.parent.parent, os.O_RDONLY)
            try: os.fsync(parent)
            finally: os.close(parent)
        claim = f.one_claim(claim_path.parent, claim_path.name, intent)
        f.save(audit.path/'probe-intent.json', {**intent, 'claim':claim})
        cfg.require_lease(); cfg.probe.verify()
        current_t, current = identity(cfg, audit, selected)
        f.require(current_t == t and current == actual, 'probe_identity_changed')
        # Recheck absence immediately before the only push. Unknown bytes stay untouched.
        exists = audit.run(['adb','-t',t,'shell',f'test -e {f.REMOTE_PROBE} || test -L {f.REMOTE_PROBE}'])
        f.require(exists.returncode == 1, 'probe_appeared_before_push')
        cfg.require_lease(); cfg.probe.verify()
        pushed = audit.run(['adb','-t',t,'push',str(cfg.probe.path),f.REMOTE_PROBE])
        f.require(pushed.returncode == 0, 'probe_push_ambiguous_do_not_resend')
        writes = 1
    regular = audit.run(['adb','-t',t,'shell',f'test -f {f.REMOTE_PROBE} && test ! -L {f.REMOTE_PROBE}'])
    f.require(regular.returncode == 0, 'status_probe_not_regular')
    sha = audit.shell(t, 'sha256sum '+f.REMOTE_PROBE).split()
    f.require(sha and sha[0] == config.PROBE_SHA, 'existing_status_probe_not_reviewed')
    f.save(audit.path/'probe-result.json', {'remote':f.REMOTE_PROBE,'sha256':sha[0],
        'diagnosticWrites':writes,'firmwareWrites':0,'resendAllowed':False})
    return True, writes


def process(audit, t):
    pid = audit.shell(t, 'pidof com.mentra.asg_client')
    f.require(re.fullmatch(r'[1-9]\d*',pid), 'january_asg_process_ambiguous')
    stat = audit.shell(t, f'cat /proc/{pid}/stat').rsplit(') ',1)
    f.require(len(stat) == 2 and len(stat[1].split()) > 19, 'january_process_stat_invalid')
    ticks = stat[1].split()[19]
    f.require(ticks.isdigit(), 'january_start_ticks_invalid')
    return pid, ticks


def collect(cfg, run, audit, helper, *, stage_missing_probe=False):
    cfg.require_lease()
    selected = binding(cfg, run)
    f.save(audit.path/'binding.json', {**selected, 'freshBleReadPerformed':False})
    t, initial = identity(cfg, audit, selected)
    use_probe, writes = ensure_probe(cfg, audit, selected, t, initial, stage_missing_probe)
    # Diagnostic staging can precede this freshness bracket; the data below is
    # always newly read afterward, including the real update-engine response.
    started = time.time()
    t, actual = identity(cfg, audit, selected)
    f.require(actual == initial, 'identity_changed_after_probe_preparation')
    before_process = process(audit,t) if selected['kind'] == 'target' else None
    status = f.read_status(cfg, helper, audit, t, use_probe)
    f.require(status in reconcile.BUSY | {reconcile.IDLE,reconcile.READY}, 'observed_engine_unknown')
    closing_t, closing = identity(cfg, audit, selected)
    f.require(closing_t == t and closing == actual, 'observer_identity_changed')
    result = {'startedAt':started, 'identity':actual, 'bootBefore':actual['boot'], 'engineStatus':status,
              'diagnosticProbeWrites':writes, 'firmwareWrites':0, 'freshBleReadPerformed':False}
    if before_process:
        result['stateReadsFinishedAt'] = time.time()
        p = audit.run(['adb','-t',t,'logcat','-b','all','-d','-v','epoch','--pid',before_process[0]])
        captured = time.time()
        f.require(p.returncode == 0 and len(p.stdout.encode()) <= 4*1024*1024, 'january_log_read_failed_or_oversize')
        device_epoch = float(audit.shell(t,'date +%s'))
        uptime = float(audit.shell(t,'cat /proc/uptime').split()[0])
        after_process = process(audit,t)
        f.require(before_process == after_process and math.isfinite(device_epoch) and math.isfinite(uptime)
                  and 0 < uptime < device_epoch, 'january_process_or_clock_changed')
        result['januaryLog'] = {'text':p.stdout, 'pidBefore':before_process[0], 'pidAfter':after_process[0],
            'startTicksBefore':before_process[1], 'startTicksAfter':after_process[1],
            'bootEpoch':device_epoch-uptime, 'deviceEpoch':device_epoch, 'capturedAt':captured}
    result['bootAfter'] = audit.shell(t,'cat /proc/sys/kernel/random/boot_id')
    f.require(result['bootAfter'] == actual['boot'] and f.transport(audit,selected['endpoint']) == t,
              'observer_boot_or_transport_changed')
    cfg.require_lease()
    for ref in selected['references']:
        f.require(f.digest(Path(ref['path'])) == ref['sha256'], 'observer_binding_changed')
    result['finishedAt'] = time.time()
    f.require(0 <= result['finishedAt']-started <= 30, 'observer_batch_too_slow')
    return f.save(audit.path/'current.json', result)
