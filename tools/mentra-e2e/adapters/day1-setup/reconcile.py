"""Read-only receipt reconciliation using one fresh, caller-collected observation.

The current observation must come from the trusted routine's identity-bracketed
reader, never CI request JSON or a copied result. This module performs no device,
process, lease, network or provisioning commands and has no executable CLI.
"""
import math
import re
import time

import config
import full_january as f

IDLE = 'UPDATE_STATUS_IDLE'
READY = 'UPDATE_STATUS_UPDATED_NEED_REBOOT'
BUSY = frozenset(('UPDATE_STATUS_CHECKING_FOR_UPDATE', 'UPDATE_STATUS_UPDATE_AVAILABLE',
    'UPDATE_STATUS_DOWNLOADING', 'UPDATE_STATUS_VERIFYING', 'UPDATE_STATUS_FINALIZING',
    'UPDATE_STATUS_REPORTING_ERROR_EVENT', 'UPDATE_STATUS_ATTEMPTING_ROLLBACK'))


def _fresh(current, now):
    start, finish = current['startedAt'], current['finishedAt']
    f.require(all(type(x) in (int, float) and math.isfinite(x) for x in (start, finish, now))
              and 0 <= now-finish <= 30 and 0 <= finish-start <= 30, 'current_observation_not_fresh')
    identity = current['identity']
    f.require(re.fullmatch(config.UUID, str(identity['boot']))
              and current['bootBefore'] == current['bootAfter'] == identity['boot'], 'current_boot_not_bracketed')
    f.require(current['engineStatus'] in BUSY | {IDLE, READY}, 'current_engine_unknown')
    return identity


def _fixture(cfg, identity):
    f.require(identity['cid'] == cfg.fixture['cid'] and identity['serial'] in cfg.serial_aliases
              and identity['bootSerial'] == cfg.boot_serial and identity['slot'] in ('_a', '_b'), 'current_fixture_mismatch')


def _source(cfg, identity):
    _fixture(cfg, identity)
    f.require(identity['mac'].upper() == cfg.fixture['mac'] and identity['mtk'] == f.SOURCE
              and identity['epoch'] == f.EPOCH and identity['uid'] == '2000'
              and identity['bootCompleted'] == '1', 'current_source_mismatch')


def _operation(cfg, run):
    op = f.private(run/'operation.json')
    f.require(op['run'] == str(run) and re.fullmatch(config.UUID, op['owner'])
              and op['configSha256'] == cfg.sha256 and op['profileSha256'] == config.PROFILE_SHA
              and op['otaSha256'] == f.ZIP_SHA and op['credentialFileSha256'] == cfg.credential.sha256
              and op['appExecutableName'] == cfg.app_name and op['endpoint'] == cfg.source_endpoint,
              'operation_not_current_config')
    _source(cfg, op['source'])
    f.require(op['claim']['path'] == str(cfg.stage_claims/(op['source']['boot']+'-'+f.ZIP_SHA+'.json')),
              'operation_claim_path_changed')
    claim = f.recovery.referenced(op['claim'])
    f.require(claim == {key:value for key,value in op.items() if key != 'claim'}, 'operation_claim_changed')
    return op


def _target(cfg, current, op, result, wipe, after):
    identity = current['identity']
    _fixture(cfg, identity)
    f.require(identity['boot'] == wipe['newBoot'] == after['boot'] and identity['boot'] != op['source']['boot']
              and identity['mtk'] == f.TARGET and identity['slot'] == ('_b' if op['source']['slot'] == '_a' else '_a')
              and type(identity['uid']) is int and identity['uid'] == 2000
              and identity['asgVersionCode'] == 27 and identity['asgSha256'] == config.PROFILE['asgSha256'],
              'current_target_mismatch')
    bridge = identity['freshBleBridge']
    f.require(bridge == after['freshBleBridge'] and bridge['mac'] == cfg.fixture['mac']
              and bridge['ssidMatches'] is True and config.endpoint(bridge['endpoint']) == bridge['endpoint']
              and (identity['mac'] == '' or identity['mac'].upper() == cfg.fixture['mac']), 'current_target_bridge_mismatch')
    asg = identity['factoryAsgIdentity']
    f.require(asg['activePath'] == f.factory_asg.SYSTEM or f.factory_asg.DATA_PATH.fullmatch(asg['activePath']),
              'current_factory_path_invalid')
    f.require(asg['systemPath'] == f.factory_asg.SYSTEM and asg['backupPath'] == f.factory_asg.BACKUP
              and asg['sha256'] == config.PROFILE['asgSha256'] and asg['versionCode'] == 27
              and asg['hashes'] == {name:config.PROFILE['asgSha256'] for name in ('active','system','backup')},
              'current_factory_bytes_mismatch')
    log = current['januaryLog']
    # Close the live identity/engine reads with the actual log capture. A cached
    # pre-admission log cannot accompany a newer target observation.
    f.require(all(type(x) in (int, float) and math.isfinite(x) for x in
                  (current['stateReadsFinishedAt'], log['capturedAt']))
              and current['startedAt'] <= current['stateReadsFinishedAt'] <= log['capturedAt'] <= current['finishedAt'],
              'current_january_log_not_in_observation')
    f.require(isinstance(log['pidBefore'], str) and log['pidBefore'].isdigit()
              and log['pidBefore'] == log['pidAfter']
              and isinstance(log['startTicksBefore'], str) and log['startTicksBefore'].isdigit()
              and log['startTicksBefore'] == log['startTicksAfter'], 'current_january_process_changed')
    f.require(all(type(log[key]) in (int, float) and math.isfinite(log[key]) for key in ('bootEpoch','deviceEpoch'))
              and 0 < log['bootEpoch'] < log['deviceEpoch'], 'current_january_clock_invalid')
    f.continuity.check_january_span(log['text'], log['pidBefore'], f.require, log['bootEpoch'], log['deviceEpoch'])
    f.require(result['besSetupContinuity']['newBoot'] == identity['boot'], 'current_bes_continuity_boot_changed')


def _completed(cfg, run, op, current):
    folder = run/'activation'
    f.require(not (folder/'failure.json').exists(), 'activation_failure_requires_separate_review')
    proof = f.recovery.activation_proof(cfg, folder/'receipt.json', op['credentialFileSha256'])
    f.require(proof['owner'] == op['owner'] and proof['source'] ==
              {key:op['source'][key] for key in ('boot','slot','mtk')}, 'activation_receipt_not_stage_owner')
    result, recovery = f.private(folder/'result.json'), f.private(folder/'recovery/result.json')
    wipe, bes, after = (f.private(folder/name) for name in ('wipe-proof.json','bes-continuity-result.json','recovery/after.json'))
    f.require(result['status'] == 'january-setup-baseline-verified' and result['owner'] == op['owner']
              and result['setupBaselineReady'] is True and result['activationCount'] == 1
              and result['payloadApplied'] is True and result['newBootVerified'] is True
              and result['recoveryResultSha256'] == f.digest(folder/'recovery/result.json')
              and result['wipeProofSha256'] == f.digest(folder/'wipe-proof.json')
              and result['besSetupContinuity'] == bes, 'activation_result_not_bound')
    f.require(recovery['status'] == 'passed' and recovery['owner'] == op['owner']
              and recovery['newBootVerified'] is True and recovery['factoryJanuaryIdentityVerified'] is True
              and recovery['freshBleBridgeVerified'] is True and type(recovery['requestCount']) is int
              and recovery['requestCount'] in (0, 1), 'recovery_result_not_bound')
    f.require(wipe['status'] == 'passed' and wipe['owner'] == op['owner'] and wipe['sourceBoot'] == op['source']['boot']
              and wipe['markerAbsent'] is True and wipe['parentAccessible'] is True
              and wipe['factoryJanuaryIdentityVerified'] is True, 'wipe_result_not_bound')
    f.require(bes['status'] == 'passed' and bes['kind'] == 'verified-install-continuity' and bes['setupOnly'] is True
              and bes['version'] == f.continuity.VERSION and bes['sourceBoot'] == op['source']['boot']
              and bes['mtkOwner'] == op['owner'] and bes['mtkSha256'] == f.ZIP_SHA
              and bes['payloadSha256'] == f.PAYLOAD_SHA and bes['installEvidence'] == op['besContinuity']
              and bes['postWipeFreshBesObserved'] is False and bes['usableAsFinalModernFirmwareProof'] is False,
              'bes_setup_scope_changed')
    _target(cfg, current, op, result, wipe, after)
    return [folder/'receipt.json',folder/'result.json',folder/'wipe-proof.json',folder/'bes-continuity-result.json',
            folder/'recovery/result.json',folder/'recovery/after.json']


def reconcile(phase, cfg, run, current, *, now=None):
    """Return status/reason/evidence; invalid, stale or missing proof is unknown.

    `settled` is returned only before the phase's first dispatch. An existing
    incomplete claim/phase never becomes permission to resend, even if idle.
    The caller still enforces the lifecycle's own mutation-intent rule.
    """
    result = {'status':'unknown', 'reason':'receipt_or_current_observation_unavailable',
              'owner':None, 'evidence':[], 'setupOnly':True, 'fixtureReadyForOtherRoutines':False}
    try:
        f.require(phase in ('stage','activate'), 'unknown_phase')
        cfg.verify_definition()
        run = config.absolute(str(run))
        identity = _fresh(current, time.time() if now is None else now)
        if phase == 'stage' and not (run/'operation.json').exists():
            _source(cfg, identity)
            claim = cfg.stage_claims/(identity['boot']+'-'+f.ZIP_SHA+'.json')
            f.require(not run.exists() and not claim.exists(), 'prior_run_or_claim_requires_review')
            f.require(current['engineStatus'] == IDLE, 'pre_stage_engine_not_idle')
            result.update(status='settled',reason='exact_source_idle_before_first_dispatch')
            return result
        op = _operation(cfg, run)
        result['owner'] = op['owner']
        result['evidence'] = [str(run/'operation.json'),op['claim']['path']]
        if identity == op['source'] and current['engineStatus'] in BUSY:
            result.update(status='active',reason='owned_source_engine_busy')
            return result
        _, staged = f.activation_inputs(cfg, run)
        result['evidence'].append(str(run/'stage-result.json'))
        if identity == op['source'] and current['engineStatus'] == READY:
            if phase == 'stage':
                result.update(status='satisfied',reason='owned_payload_applied_on_current_source')
            elif not (run/'activation').exists():
                result.update(status='settled',reason='owned_stage_ready_before_first_activation')
            else:
                result['reason']='activation_already_entered_no_resend'
            return result
        if phase == 'activate' and current['engineStatus'] == IDLE:
            evidence = _completed(cfg, run, op, current)
            result['evidence'].extend(str(path) for path in evidence)
            result.update(status='satisfied',reason='owned_january_baseline_and_fresh_current_target')
        return result
    except (config.Guard, OSError, ValueError, TypeError, KeyError, AttributeError):
        return result
