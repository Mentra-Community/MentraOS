"""Setup-only accepted-install continuity. Never a fresh post-wipe BES measurement."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

VERSION = '17.26.1.13'
OTA_SHA = 'f2583b2c0978145d3ede09d397098881b1cef4813abaab132cae120c80b8efae'
RAW_SHA = '07ce5f661095a9db417f0fc26c5dfe34575312c53a5785e548a22abc8d92e7db'
# All known ASG27/modern explicit BES admission paths; ordinary UART recovery is not a writer.
BES_WRITE = re.compile(r'startFirmwareUpdate|Starting BES firmware update|DEBUG: starting validated BES|'
                       r'apply_boundary=|state=(?:AUTH_ATTEMPTED|APPLY_PENDING|CORRUPT)|'
                       r'op=authorize|op=reserve_authorization|op=prepare_start|op=retire_success|op=mark_apply_pending|Received ota_start|Starting OTA from phone request|'
                       r'Check OTA update method init', re.I)


def content(ref, require):
    require(isinstance(ref, dict) and set(ref) == {'path', 'sha256'}
            and Path(ref['path']).is_absolute() and re.fullmatch(r'[0-9a-f]{64}', ref['sha256']), 'bes_reference_invalid')
    fd = os.open(ref['path'], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 32*1024*1024, 'bes_evidence_not_private_regular')
        raw = file.read()
    require(hashlib.sha256(raw).hexdigest() == ref['sha256'], 'bes_evidence_changed')
    return raw.decode()


def rows(raw):
    for line in raw.splitlines():
        match = re.match(r'^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[A-Z]\s+[^:]+:\s?(.*)$', line)
        if match: yield float(match[1]), match[2], match[3]


def fields(raw): return dict(re.findall(r'(\w+)=([^\s{}]+)', raw))


def proof(raw, owner, boot, require, completion=False):
    result = []
    for stamp, pid, message in rows(raw):
        if 'BES_OTA_DIAG version_proof_complete ' not in message and (completion or 'BES_OTA_DIAG version_proof ' not in message): continue
        snapshots = re.findall(r'(?:snapshot|after)=\{([^}]*)\}', message)
        if not snapshots: continue
        state = fields(snapshots[-1]); top = fields(re.sub(r'\{[^}]*\}', '', message))
        current = state.get('verify_boot') if 'version_proof_complete ' in message else top.get('current_boot')
        if (top.get('actual') == VERSION and current == boot and state.get('owner') == owner
                and state.get('state') == 'TERMINAL' and state.get('terminal_status') == 'SUCCESS'
                and state.get('terminal_code') == 'verified' and state.get('target') == VERSION
                and state.get('verify_boot') == boot):
            result.append({'stamp': stamp, 'pid': pid, 'line': message, 'state': state})
    require(result, 'bes_owned_current_boot_proof_missing')
    return result[-1]


def validate_input(value, source, fixture, require, digest):
    require(set(value) == {'schemaVersion', 'kind', 'sourceBoot', 'besOwner', 'installIntent', 'installLog', 'versionLog'}
            and value['schemaVersion'] == 1 and value['kind'] == 'verified-install-continuity'
            and value['sourceBoot'] == source['boot']
            and re.fullmatch(r'adb-bes-[0-9a-f]{32}', value['besOwner']), 'bes_continuity_input_invalid')
    intent = json.loads(content(value['installIntent'], require))
    require(intent['fixture']['cid'] == fixture['cid'] and intent['fixture']['mac'] == fixture['mac']
            and fixture['serial'] in intent['fixture']['serial_aliases']
            and intent['expected']['mtk'] == source['mtk'] and intent['expected']['boot_id'] != source['boot']
            and re.fullmatch(r'[0-9]+(?:\.[0-9]+){3}', intent['expected']['bes'])
            and intent['expected']['bes'] != VERSION
            and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', intent['run_id'])
            and re.fullmatch(r'[0-9a-f]{64}', intent['expected']['asg_apk_sha256'])
            and type(intent['expected']['asg_version_code']) is int and intent['expected']['asg_version_code'] > 0
            and intent['target']['version'] == VERSION and intent['target']['ota']['sha256'] == OTA_SHA
            and intent['target']['raw']['sha256'] == RAW_SHA, 'bes_install_intent_not_exact_fixture_target')
    for kind, expected in (('raw', RAW_SHA), ('ota', OTA_SHA)):
        require(digest(Path(intent['target'][kind]['path'])) == expected, 'bes_install_artifact_changed')
    install = content(value['installLog'], require)
    marker = 'artifact=setup-'+intent['run_id']+' target='+VERSION+' owner='+value['besOwner']
    require('DEBUG: starting validated BES version change '+marker in install, 'bes_install_owner_not_correlated')
    acknowledgements = [fields(message) for _, _, message in rows(install)
                        if 'BES_OTA_DIAG apply_ack ' in message and 'accepted=true' in message]
    require(any(x.get('owner') == value['besOwner'] and x.get('auth_boot') == intent['expected']['boot_id']
                and x.get('target') == VERSION and x.get('state') == 'APPLY_PENDING' for x in acknowledgements),
            'bes_apply_acceptance_missing')
    completed = proof(content(value['versionLog'], require), value['besOwner'], source['boot'], require, completion=True)
    require(completed['state'].get('auth_boot') == intent['expected']['boot_id'], 'bes_install_completion_unrelated')
    return {'input': value, 'asgSha256': intent['expected']['asg_apk_sha256'],
            'asgVersionCode': intent['expected']['asg_version_code'], 'acceptedVersionProof': completed,
            'version': VERSION, 'otaSha256': OTA_SHA, 'rawSha256': RAW_SHA}


def check_source_span(raw, evidence, boot, pid, device_epoch, require):
    require('chatty' not in raw and 'dropped' not in raw.lower() and 'truncated' not in raw.lower(), 'bes_log_span_incomplete')
    found = proof(raw, evidence['input']['besOwner'], boot, require)
    require(found['pid'] == pid, 'bes_proof_process_changed')
    require(0 <= device_epoch-found['stamp'] <= 60, 'bes_source_proof_not_fresh')
    require(not any(p == pid and stamp >= found['stamp'] and message != found['line'] and BES_WRITE.search(message)
                    for stamp, p, message in rows(raw)), 'bes_writer_after_verified_install')
    require(all(stamp <= device_epoch+1 for stamp, p, _ in rows(raw) if p == pid), 'bes_log_clock_invalid')
    return found


def check_january_span(raw, pid, require, boot_epoch, device_epoch):
    require('chatty' not in raw and 'dropped' not in raw.lower() and 'truncated' not in raw.lower(), 'january_log_span_incomplete')
    current = [(stamp, message) for stamp, p, message in rows(raw) if p == pid]
    require(current and all(boot_epoch-2 <= stamp <= device_epoch+1 for stamp, _ in current),
            'january_log_not_current_boot')
    messages = [message for _, message in current]
    start = 'Autonomous OTA mode DISABLED - updates only via phone app'
    require(any(start in message for message in messages), 'january_disabled_startup_missing')
    require(not any(BES_WRITE.search(message) for message in messages), 'january_ota_writer_observed')


def validate_activity(value, version, activity_id, version_id, asg_version, before_uptime, after_uptime, require):
    require(version.get('type') == 'version_info_1' and version.get('package_name') == 'com.mentra.asg_client'
            and version.get('request_id') == version_id and str(version.get('build_number')) == str(asg_version)
            and re.fullmatch(r'[a-f0-9]{8}', str(version.get('sid', ''))), 'activity_version_response_mismatch')
    require(type(value.get('schema')) is int and value['schema'] == 1 and value.get('request_id') == activity_id
            and value.get('process_sid') == version['sid'], 'activity_not_correlated')
    generation = value.get('admission_generation')
    elapsed = value.get('elapsed_realtime_ms')
    require(type(generation) is int and 0 <= generation <= 9007199254740991
            and type(elapsed) is int and before_uptime*1000 <= elapsed < (after_uptime+0.01)*1000,
            'activity_counter_or_clock_invalid')
    session = value.get('session')
    require(isinstance(session, dict) and isinstance(session.get('session_id'), str)
            and (session['session_id'] == '' or re.fullmatch(r'[a-f0-9]{8}', session['session_id']))
            and session.get('status') in ('idle', 'complete', 'failed')
            and session.get('restart_pending') is False, 'activity_session_not_idle')
    require(value.get('consistent') is True and all(value.get(key) is False for key in
            ('updating', 'mtk_in_progress', 'bes_in_progress', 'admission_held')), 'activity_updater_not_idle')
    return {'processSid': version['sid'], 'admissionGeneration': generation,
            'elapsedRealtimeMs': elapsed, 'requestId': activity_id, 'versionRequestId': version_id,
            'consistent': True, 'asgUpdatersIdle': True}


def unchanged_generation(prior, current, pid, start_ticks, require):
    require(prior['pid'] == pid and prior['startTicks'] == start_ticks, 'bes_asg_process_changed')
    require(prior['activity']['processSid'] == current['processSid']
            and prior['activity']['admissionGeneration'] == current['admissionGeneration']
            and current['elapsedRealtimeMs'] >= prior['activity']['elapsedRealtimeMs']
            and current['requestId'] != prior['activity']['requestId']
            and current['versionRequestId'] != prior['activity']['versionRequestId'],
            'asg_admission_or_process_changed_during_continuity')
