"""Pure reconciliation of a BES attempt and fresh caller-owned native observation.

No subprocess, device or lease operation. Missing/ambiguous proof is unknown,
never permission to retry. The caller persists returned observations separately.
"""
import hashlib
import json
import math
import re
import time

import config
import bes_setup as adapter
import run_once as observer


def read(path):
    return json.loads(config.private_bytes(path))


def reference(path):
    return {'path': str(path), 'sha256': hashlib.sha256(config.private_bytes(path)).hexdigest()}


def current_identity(cfg, current, now):
    start, finish = current['startedAt'], current['finishedAt']
    config.require(all(type(x) in (int, float) and math.isfinite(x) for x in (start, finish, now))
                   and 0 <= finish-start <= 30 and 0 <= now-finish <= 30, 'fresh_bracket_required')
    actual, expected, fixture = current['observed'], cfg.data['expected'], cfg.data['fixture']
    config.require(re.fullmatch(config.UUID, actual['boot_id'])
                   and current['bootBefore'] == current['bootAfter'] == actual['boot_id']
                   and actual['serial'] in fixture['serial_aliases'] and actual['cid'] == fixture['cid']
                   and actual['mac'].upper() == fixture['mac']
                   and all(actual[k] == expected[k] for k in ('mtk', 'slot', 'asg_version_code'))
                   and actual['apk_sha256'] == expected['asg_apk_sha256']
                   and current['endpoint'] == fixture['transport']['address']
                   and isinstance(actual['pid'], str) and re.fullmatch(r'[1-9]\d*', actual['pid'])
                   and current['pidBefore'] == current['pidAfter'] == actual['pid']
                   and isinstance(current['startTicksBefore'], str) and current['startTicksBefore'].isdigit()
                   and current['startTicksBefore'] == current['startTicksAfter']
                   and type(actual['device_epoch']) in (int, float) and math.isfinite(actual['device_epoch'])
                   and actual['device_epoch'] > 0, 'current_fixture_mismatch')
    config.require(type(current['logCapturedAt']) in (int, float) and math.isfinite(current['logCapturedAt'])
                   and start <= current['logCapturedAt'] <= finish, 'log_not_in_current_bracket')
    path = config.reference(current['log'], private=True)
    raw = config.private_bytes(path).decode()
    config.require('chatty' not in raw and 'dropped' not in raw.lower() and 'truncated' not in raw.lower(), 'current_log_incomplete')
    rows = [(stamp, pid, message) for stamp, pid, message in adapter.log_entries(raw) if pid == actual['pid']]
    config.require(rows and all(stamp <= actual['device_epoch']+1 for stamp, _, _ in rows), 'current_log_clock_invalid')
    return actual, raw, rows


def reconcile(cfg, run, owner, current, *, now=None):
    """current is produced by a trusted reader under the lifecycle lease, not CI JSON."""
    result = {'status': 'unknown', 'reason': 'missing_or_unsettled_proof', 'lifecycleOwner': owner,
              'nativeOwner': None, 'setupOnly': True, 'fixtureReadyForOtherRoutines': False, 'evidence': []}
    try:
        cfg.verify_definition()
        run = config.absolute(str(run))
        config.require(isinstance(owner, str) and re.fullmatch(config.UUID, owner), 'lifecycle_owner_invalid')
        actual, raw, rows = current_identity(cfg, current, time.time() if now is None else now)
        result['evidence'] = [current['log']['path']]
        expected = cfg.data['expected']
        if not run.exists() and not cfg.claim_path.exists():
            config.require(actual['boot_id'] == expected['boot_id'], 'source_boot_changed')
            adapter.readiness(raw, actual['pid'], actual['boot_id'], expected['bes'], actual['device_epoch'],
                              cfg.data['proof_max_age_seconds'], cfg.adapter_config()['settled_source'])
            result.update(status='settled', reason='exact_source_before_first_attempt')
            return result
        claim = read(cfg.claim_path)
        config.require(claim['lifecycleOwner'] == owner and claim['run'] == str(run)
                       and claim['sourceBoot'] == expected['boot_id'] and claim['configSha256'] == cfg.sha256
                       and claim['targetSha256'] == config.OTA_SHA and claim['noResend'] is True, 'claim_mismatch')
        saved = read(run/'owner.json')
        config.require(saved['lifecycleOwner'] == owner and saved['configSha256'] == cfg.sha256
                       and saved['claim'] == reference(cfg.claim_path), 'run_owner_mismatch')
        intent = read(run/'dispatch/install-intent.json')
        config.require(intent['run_id'] == owner and intent['fixture'] == cfg.data['fixture']
                       and intent['expected'] == expected and intent['target'] == cfg.data['target'], 'intent_mismatch')
        before = read(run/'before.json')
        config.require(before['boot_id'] == expected['boot_id']
                       and before['serial'] in cfg.data['fixture']['serial_aliases']
                       and before['cid'] == cfg.data['fixture']['cid'] and before['mac'].upper() == cfg.data['fixture']['mac']
                       and all(before[key] == expected[key] for key in ('mtk', 'slot', 'asg_version_code'))
                       and before['apk_sha256'] == expected['asg_apk_sha256'], 'original_source_identity_mismatch')
        log_path = run/'handshake.log'
        install_log = config.private_bytes(log_path).decode()
        trace = observer.install_trace(install_log, before['pid'], owner, expected['boot_id'])
        native_owner = trace['nativeOwner']
        result['nativeOwner'] = native_owner
        result['evidence'] += [str(cfg.claim_path), str(run/'owner.json'), str(run/'dispatch/install-intent.json'), str(log_path)]
        proofs = [(stamp, pid, message) for stamp, pid, message in rows
                  if observer.verified_success(message, pid, stamp, actual, native_owner, config.VERSION,
                                               expected['boot_id'], cfg.data['proof_max_age_seconds'])]
        if not proofs:
            if any(adapter.snapshot(message).get('owner') == native_owner
                   and adapter.snapshot(message).get('state') in ('AUTH_ATTEMPTED', 'APPLY_PENDING')
                   and -1 <= actual['device_epoch']-stamp <= 60 for stamp, _, message in rows):
                result.update(status='active', reason='owned_native_update_active')
            return result
        stamp, _, message = proofs[-1]
        busy = re.compile(r'apply_boundary=|state=(AUTH_ATTEMPTED|APPLY_PENDING|CORRUPT)|'
                          r'op=(prepare_start|retire_success|reserve_authorization)|startFirmwareUpdate|'
                          r'DEBUG: starting validated BES|MTK OTA in progress flag set to: true|APK update in progress', re.I)
        config.require(not any(seen >= stamp and text != message and busy.search(text) for seen, _, text in rows),
                       'activity_after_version_proof')
        # Preserve an actual completion for the MTK continuity input. An ordinary
        # fresh version query can confirm it but cannot manufacture completion.
        completion_ref = None
        for log, ref in ((install_log, reference(log_path)), (raw, current['log'])):
            if any('BES_OTA_DIAG version_proof_complete ' in text
                   and observer.verified_success(text, pid, seen, {**actual, 'device_epoch': seen}, native_owner,
                                                config.VERSION, expected['boot_id'])
                   and trace['ackEpoch'] <= seen <= actual['device_epoch']+1
                   for seen, pid, text in adapter.log_entries(log)):
                completion_ref = ref
                break
        config.require(completion_ref is not None, 'accepted_completion_missing')
        result.update(status='satisfied', reason='same_owner_fresh_native_success_verified',
            continuityInput={'schemaVersion':1, 'kind':'verified-install-continuity', 'sourceBoot':actual['boot_id'],
                'besOwner':native_owner, 'installIntent':reference(run/'dispatch/install-intent.json'),
                'installLog':reference(log_path), 'versionLog':completion_ref},
            originalFailurePreserved=(run/'recovery-required.json').exists() or read(run/'result.json').get('status') == 'failed')
        return result
    except (RuntimeError, OSError, ValueError, TypeError, KeyError, AttributeError):
        return result
