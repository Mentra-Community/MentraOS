"""One owned compact January BES install and bounded observer. Import is hardware-free."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

import bes_setup as adapter_module
import config as inputs


def dispatch_owner(message, pid, expected_pid, artifact_id, target):
    if pid != expected_pid:
        return None
    found = re.search(r'DEBUG: starting validated BES version change artifact=(\S+) '
                      r'target=(\S+) owner=(adb-bes-[0-9a-f]{32})(?:\s|$)', message)
    return found[3] if found and found[1] == artifact_id and found[2] == target else None


def verified_success(message, pid, stamp, actual, owner, target, auth_boot, max_age=60):
    """The completion's verify_boot must match independently read current device identity."""
    version, proof_boot, state = adapter_module.version_proof(message)
    required = {'state': 'TERMINAL', 'owner': owner, 'auth_boot': auth_boot,
                'verify_boot': actual['boot_id'], 'target': target,
                'terminal_status': 'SUCCESS', 'terminal_code': 'verified'}
    if (pid != actual['pid'] or version != target or proof_boot != actual['boot_id'] or
            actual['boot_id'] == auth_boot or not -1 <= actual['device_epoch'] - stamp <= max_age or
            any(state.get(key) != value for key, value in required.items())):
        return False
    top = adapter_module.fields(re.sub(r'\{[^}]*\}', '', message))
    if 'current_boot' in top and top['current_boot'] != actual['boot_id']:
        return False
    return ('version_proof_complete ' not in message or top.get('result') == 'APPLIED')


def install_trace(log, source_pid, lifecycle_owner, source_boot):
    """Bind actual native admission/apply acceptance to this one artifact/owner.

    A reconnect can repeat exact log rows. Distinct admissions or stages remain
    ambiguous; no synthetic native owner is accepted.
    """
    rows = sorted(set(adapter_module.log_entries(log)))
    dispatch = [(stamp, dispatch_owner(message, pid, source_pid, 'setup-'+lifecycle_owner, inputs.VERSION))
                for stamp, pid, message in rows]
    dispatch = [(stamp, native) for stamp, native in dispatch if native]
    adapter_module.require(len(dispatch) == 1, 'Missing or ambiguous artifact admission')
    started, native_owner = dispatch[0]
    stamps = [started]
    for needle, state_name, acceptance in (
            ('op=reserve_authorization ', 'AUTH_ATTEMPTED', 'committed=true readback_match=true'),
            ('apply_boundary=after_uart_write ', 'APPLY_PENDING', 'write_accepted=true'),
            ('BES_OTA_DIAG apply_ack ', 'APPLY_PENDING', 'accepted=true')):
        found = []
        for stamp, pid, message in rows:
            value = adapter_module.fields(message)
            if (pid == source_pid and needle in message and acceptance in message
                    and value.get('owner') == native_owner and value.get('auth_boot') == source_boot
                    and value.get('target') == inputs.VERSION and value.get('state') == state_name):
                found.append(stamp)
        adapter_module.require(len(found) == 1, 'Missing or ambiguous native install stage')
        stamps.append(found[0])
    adapter_module.require(stamps == sorted(stamps), 'Native install stages out of order')
    return {'nativeOwner': native_owner, 'dispatchEpoch': stamps[0], 'reserveEpoch': stamps[1],
            'applyEpoch': stamps[2], 'ackEpoch': stamps[3]}


def run(cfg, output, owner):
    cfg.require_lease()
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    save = lambda name, value: adapter_module.durable_new(output / name, value)
    save('owner.json', {'purpose': 'Verified modern BES to compact January BES before the owned full MTK downgrade',
                       'started': time.time(), 'automaticResend': False, 'fixtureAvailability': 'busy',
                       'scriptSha256': adapter_module.digest(__file__), 'lifecycleOwner': owner,
                       'configSha256': cfg.sha256, 'claim': {'path': str(cfg.claim_path), 'sha256': inputs.digest(cfg.claim_path)}})
    adapter = adapter_module.Adapter(cfg, output / 'dispatch', owner)
    process = None
    stream = error_stream = None
    try:
        before = adapter.observe(need_version=True)
        save('before.json', before)
        tags = ['BesOtaManager:V', 'BesOtaStateStore:V', 'DebugBesOtaReceiver:V', 'BES-UART:V',
                'K900BluetoothManager:V', 'ASGClientOTA:V', 'OtaHelper:V', '*:S']
        stream = (output / 'handshake.log').open('xb', buffering=0)
        error_stream = (output / 'logcat-error.txt').open('xb', buffering=0)
        os.fchmod(stream.fileno(), 0o600)
        os.fchmod(error_stream.fileno(), 0o600)
        start_epoch = before['device_epoch']

        def start_observer(transport):
            return subprocess.Popen([adapter.tools['adb'], '-t', transport, 'logcat', '-v', 'epoch',
                                     '-T', str(start_epoch) + '.000', '-s', *tags],
                                    stdout=stream, stderr=error_stream)

        process = start_observer(before['transport'])
        save('observer.json', {'pid': process.pid, 'deviceSince': start_epoch, 'tags': tags,
                               'artifactId': 'setup-' + adapter.run_id})
        adapter_module.require(process.poll() is None, 'Observer exited before dispatch')
        cfg.require_lease()
        save('dispatch-result.json', adapter.install())
        deadline, next_reconnect = time.monotonic() + 480, 0
        native_owner, reserved, reconnects = None, False, 0
        while time.monotonic() < deadline:
            text = (output / 'handshake.log').read_text(errors='replace')
            for stamp, pid, message in adapter_module.log_entries(text):
                if stamp < start_epoch:
                    continue
                bound = dispatch_owner(message, pid, before['pid'], 'setup-' + adapter.run_id,
                                       adapter.target['version'])
                if bound:
                    adapter_module.require(native_owner is None or native_owner == bound, 'Multiple dispatch owners')
                    native_owner = bound
                state = adapter_module.snapshot(message)
                if ('op=reserve_authorization ' in message and 'committed=true' in message and
                        state.get('auth_boot') == adapter.expected['boot_id'] and pid == before['pid']):
                    adapter_module.require(native_owner is not None and state.get('owner') == native_owner,
                                           'Reservation not owned by this dispatch artifact')
                    reserved = True
                if not reserved or state.get('owner') != native_owner:
                    continue
                if ('committed=true' in message and state.get('state') == 'TERMINAL' and
                        state.get('terminal_status') == 'FAILURE'):
                    save('result.json', {'status': 'failed', 'owner': native_owner, 'lifecycleOwner': owner, 'terminalProof': message,
                         'fixtureAvailability': 'recovery-required', 'noResend': True})
                    return 2
                version, proof_boot, _ = adapter_module.version_proof(message)
                if version == adapter.target['version'] and proof_boot and proof_boot != adapter.expected['boot_id']:
                    actual = adapter.identity(boot_id=proof_boot)
                    actual['pid'] = adapter.shell(actual['transport'], 'pidof', adapter_module.PACKAGE)
                    actual['device_epoch'] = int(adapter.shell(actual['transport'], 'date', '+%s'))
                    if verified_success(message, pid, stamp, actual, native_owner, adapter.target['version'],
                                        adapter.expected['boot_id'], adapter.config['proof_max_age_seconds']):
                        adapter_module.require('apply_boundary=after_uart_write owner=' + native_owner +
                                               ' write_accepted=true' in text, 'Missing owned apply acceptance')
                        install_trace(text, before['pid'], adapter.run_id, adapter.expected['boot_id'])
                        save('result.json', {'status': 'passed', 'scope': 'compact January BES setup only',
                             'owner': native_owner, 'lifecycleOwner': owner, 'bes': version, 'observed': actual, 'proof': message,
                             'noResend': True, 'fixtureAvailability': 'busy; factory ASG and OTA routine remain'})
                        print(json.dumps({'status': 'january-bes-verified', 'owner': native_owner, 'lifecycleOwner': owner, 'boot': proof_boot}))
                        return 0
            adapter_module.require((output / 'handshake.log').stat().st_size < 20_000_000,
                                   'Log bound reached; reconcile without resend')
            if process.poll() is not None and time.monotonic() >= next_reconnect:
                next_reconnect = time.monotonic() + 10
                transport = adapter.transport(required=False)
                if transport:
                    boot = adapter.shell(transport, 'cat', '/proc/sys/kernel/random/boot_id')
                    actual = adapter.identity(boot_id=boot)
                    process = start_observer(actual['transport'])
                    reconnects += 1
                    save('observer-reconnect-' + str(reconnects) + '.json',
                         {'pid': process.pid, 'observed': actual, 'sameDispatch': True})
            time.sleep(1)
        raise RuntimeError('Observation deadline; reconcile existing dispatch, do not resend')
    except Exception as error:
        save('recovery-required.json', {'error': repr(error), 'at': time.time(), 'noResend': True})
        raise
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if stream:
            stream.close()
        if error_stream:
            error_stream.close()
