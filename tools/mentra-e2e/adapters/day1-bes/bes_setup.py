#!/usr/bin/env python3
"""Extracted compact BES adapter; protocol, timings and native admission are unchanged."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid
import config as inputs

PACKAGE = 'com.mentra.asg_client'
ACTION = 'com.mentra.DEBUG_BES_OTA'
REMOTE_PREFIX = '/storage/emulated/0/asg/debug_bes_'


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def durable_new(path, value):
    """Never replace an intent, including an intent from an interrupted dispatch."""
    with Path(path).open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        stream.write(json.dumps(value, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def log_entries(text):
    for line in text.splitlines():
        match = re.match(r'^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[A-Z]\s+[^:]+:\s?(.*)$', line)
        if match:
            yield float(match[1]), match[2], match[3]


def fields(text):
    return dict(re.findall(r'(\w+)=([^\s{}]+)', text))


def snapshot(message):
    found = re.findall(r'(?:snapshot|after)=\{([^}]*)\}', message)
    return fields(found[-1]) if found else {}


def version_proof(message):
    """Completion uses snapshot.verify_boot; ordinary observations use current_boot."""
    state = snapshot(message)
    top = fields(re.sub(r'\{[^}]*\}', '', message))
    if 'BES_OTA_DIAG version_proof_complete ' in message:
        return top.get('actual'), state.get('verify_boot'), state
    if 'BES_OTA_DIAG version_proof ' in message:
        return top.get('actual'), top.get('current_boot'), state
    return None, None, state


def readiness(log, pid, boot, version, now, max_age, settled_source):
    """Fresh UART version with exact native IDLE or verified terminal source state."""
    rows = [(stamp, msg) for stamp, process, msg in log_entries(log) if process == pid]
    proofs = [(i, stamp, msg, version_proof(msg)) for i, (stamp, msg) in enumerate(rows)
              if version_proof(msg)[:2] == (version, boot) and -1 <= now - stamp <= max_age]
    require(proofs, 'No fresh current-process UART version proof for expected BES/current boot')
    index, stamp, message, (_, _, state) = proofs[-1]
    if settled_source == {'state': 'IDLE'}:
        # Native isIdle() has no owner record. Do not invent a previous success.
        require(state == settled_source, 'Native idle source changed')
    else:
        require(settled_source.get('state') == 'TERMINAL' and
                settled_source.get('terminal_status') == 'SUCCESS' and
                settled_source.get('terminal_code') == 'verified', 'Expected settled source is invalid')
        for key, value in settled_source.items():
            require(state.get(key) == value, 'Previous successful owner changed: ' + key)
    busy = re.compile(r'apply_boundary=|state=(AUTH_ATTEMPTED|APPLY_PENDING|CORRUPT)|'
                      r'op=(prepare_start|retire_success|reserve_authorization)|startFirmwareUpdate|'
                          r'DEBUG: starting validated BES|MTK OTA in progress flag set to: true|APK update in progress', re.I)
    require(not any(busy.search(msg) for _, msg in rows[index + 1:]), 'Activity follows settled proof')
    ready = [i for i, (seen, msg) in enumerate(rows) if i >= index and
             re.search(r'UART link ready at (?:fast baud 1152000|rendezvous baud 460800)', msg)
             and -1 <= now - seen <= max_age]
    require(ready, 'No fresh stable UART readiness after version proof')
    require(not any(re.search(r'(raw mode|recovering|discovering BES|UART.*closed|quarantined|apply_boundary)',
                             msg, re.I) for _, msg in rows[ready[-1] + 1:]),
            'UART changed after readiness proof')
    return {'state': state, 'version': version, 'version_epoch': stamp,
            'age_seconds': now - stamp, 'proof': message, 'ready': rows[ready[-1]][1]}


def settled_source(log, pid, boot, version, now, max_age):
    """Derive source state from native evidence, never caller-provided success fields."""
    proofs = [version_proof(message)[2] for stamp, process, message in log_entries(log)
              if process == pid and version_proof(message)[:2] == (version, boot)
              and -1 <= now-stamp <= max_age]
    require(proofs, 'No fresh source proof')
    native = proofs[-1]
    if native == {'state': 'IDLE'}:
        state = native
    else:
        keys = ('state', 'owner', 'auth_boot', 'verify_boot', 'target', 'terminal_status', 'terminal_code')
        state = {key: native.get(key) for key in keys}
        require(state['state'] == 'TERMINAL' and state['target'] == version
                and state['terminal_status'] == 'SUCCESS' and state['terminal_code'] == 'verified'
                and isinstance(state['owner'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,119}', state['owner']),
                'Source is not native idle or verified success')
        for key in ('auth_boot', 'verify_boot'):
            require(isinstance(state[key], str) and re.fullmatch(inputs.UUID, state[key]), 'Invalid source boot')
    readiness(log, pid, boot, version, now, max_age, state)
    return state


class Adapter:
    def __init__(self, cfg, run_dir, owner):
        cfg.verify_definition()
        require(isinstance(owner, str) and re.fullmatch(inputs.UUID, owner), 'Lifecycle owner UUID required')
        self.inputs = cfg
        self.config = cfg.adapter_config()
        self.run_dir = inputs.absolute(str(run_dir))
        self.run_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.fixture, self.expected = self.config['fixture'], self.config['expected']
        self.target, self.tools = self.config['target'], self.config['tools']
        self.run_id = owner
        durable_new(self.run_dir / 'owner.json', {'run_id': self.run_id, 'config': self.config,
                    'config_sha256': cfg.sha256, 'script_sha256': digest(__file__)})

    def event(self, **value):
        with (self.run_dir / 'commands.jsonl').open('a', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(json.dumps(value) + '\n')
            stream.flush()
            os.fsync(stream.fileno())

    def command(self, args, timeout=25):
        started = time.time()
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            self.event(argv=args, started_epoch=started, elapsed=time.time()-started, timeout=True,
                       stdout=str(error.stdout or ''), stderr=str(error.stderr or ''))
            raise
        self.event(argv=args, started_epoch=started, elapsed=time.time()-started,
                   stdout=result.stdout, stderr=result.stderr, returncode=result.returncode)
        require(result.returncode == 0, 'Command failed: ' + shlex.join(args))
        return result.stdout.strip()

    def adb(self, transport, *args):
        return self.command([self.tools['adb'], '-t', transport, *args])

    def shell(self, transport, *args):
        return self.adb(transport, 'shell', shlex.join(args))

    def transport(self, required=True):
        rows = [line.split() for line in self.command([self.tools['adb'], 'devices', '-l']).splitlines()]
        rows = [row for row in rows if len(row) > 2 and
                row[0] == self.fixture['transport']['address'] and row[1] == 'device'
                and not any(word.startswith('usb:') for word in row[2:])]
        require(len(rows) <= 1, 'Ambiguous pinned network endpoint')
        if not rows and not required:
            return None
        require(rows, 'Pinned network endpoint is not connected; no automatic connect or fallback')
        ids = [word.split(':', 1)[1] for word in rows[0] if word.startswith('transport_id:')]
        require(len(ids) == 1 and ids[0].isdigit(), 'Missing exact network transport ID')
        return ids[0]

    def identity(self, boot_id=None):
        pinned_boot = boot_id or self.expected['boot_id']
        require(str(uuid.UUID(pinned_boot)) == pinned_boot, 'Invalid requested boot UUID')
        transport = self.transport()
        commands = {'serial': ('getprop', 'ro.serialno'), 'cid': ('cat', '/sys/block/mmcblk0/device/cid'),
                    'boot_id': ('cat', '/proc/sys/kernel/random/boot_id'),
                    'mtk': ('getprop', 'ro.custom.ota.version'), 'mac': ('getprop', 'persist.mentra.live.mac'), 'slot': ('getprop', 'ro.boot.slot_suffix')}
        actual = {key: self.shell(transport, *argv) for key, argv in commands.items()}
        package = self.shell(transport, 'dumpsys', 'package', PACKAGE)
        version = re.search(r'\bversionCode=(\d+)\b', package)
        actual['asg_version_code'] = int(version[1]) if version else None
        require(actual['serial'] in self.fixture['serial_aliases'] and actual['cid'] == self.fixture['cid']
                and actual['mac'].upper() == self.fixture['mac'], 'Fixture identity mismatch')
        require(actual['boot_id'] == pinned_boot, 'Unexpected boot UUID')
        for key in ('mtk', 'asg_version_code', 'slot'):
            require(actual[key] == self.expected[key], 'Unexpected ' + key + ': ' + str(actual[key]))
        paths = self.shell(transport, 'pm', 'path', PACKAGE).splitlines()
        require(len(paths) == 1 and paths[0].startswith('package:/'), 'Ambiguous ASG APK path')
        actual['apk_path'] = paths[0][8:]
        actual['apk_sha256'] = self.shell(transport, 'sha256sum', actual['apk_path']).split()[0]
        require(actual['apk_sha256'] == self.expected['asg_apk_sha256'], 'ASG APK hash mismatch')
        # A reboot during the independent reads cannot form a coherent fixture observation.
        require(self.shell(transport, 'cat', '/proc/sys/kernel/random/boot_id') == actual['boot_id'],
                'Boot changed during identity readback')
        require(self.transport() == transport, 'Transport changed during identity readback')
        actual['transport'] = transport
        self.event(identity=actual)
        return actual

    def observe(self, need_version=False):
        actual = self.identity()
        t = actual['transport']
        actual['pid'] = self.shell(t, 'pidof', PACKAGE)
        require(actual['pid'].isdigit(), 'Exactly one running ASG process is required')
        log = self.adb(t, 'logcat', '-d', '-v', 'epoch', '-t', '5000')
        actual['device_epoch'] = int(self.shell(t, 'date', '+%s'))
        if need_version:
            actual['readiness'] = readiness(log, actual['pid'], actual['boot_id'], self.expected['bes'],
                actual['device_epoch'], self.config['proof_max_age_seconds'], self.config['settled_source'])
        self.event(observation=actual)
        return actual

    def validate_artifact(self):
        for name in ('raw', 'ota', 'verifier'):
            item = self.target[name] if name != 'verifier' else self.tools['verifier']
            require(Path(item['path']).is_file() and digest(item['path']) == item['sha256'], name + ' SHA mismatch')
        require(Path(self.target['raw']['path']).stat().st_size < 1966080, 'Raw BES exceeds strict OTA bound')
        output = self.command([self.tools['python'], self.tools['verifier']['path'],
                               self.target['raw']['path'], self.target['ota']['path']], timeout=60)
        self.event(artifact_verification=output, target=self.target)

    def write(self, *args):
        # Recheck the sole parent lease and exact identity immediately before every write.
        self.inputs.require_lease()
        transport = self.identity()['transport']
        self.inputs.require_lease()
        return self.adb(transport, *args)

    def install(self):
        marker = self.run_dir / 'install-intent.json'
        require(not marker.exists(), 'Install already attempted; inspect evidence, never retry this run')
        self.validate_artifact()
        self.observe(need_version=True)
        sha = self.target['ota']['sha256']
        require(re.fullmatch(r'[0-9a-f]{64}', sha), 'Invalid OTA SHA')
        remote = REMOTE_PREFIX + sha + '.bin'
        self.inputs.require_lease()
        durable_new(self.run_dir / 'transfer-intent.json', {'owner': self.run_id, 'sha256': sha,
                    'remote': remote, 'created_epoch': time.time(), 'noResend': True})
        self.write('push', self.target['ota']['path'], remote)
        actual = self.observe(need_version=True)
        require(self.shell(actual['transport'], 'sha256sum', remote).split()[0] == sha, 'Staged OTA SHA mismatch')
        # The marker is durable before the command that can authorize firmware changes.
        self.inputs.require_lease()
        transport = self.identity()['transport']
        self.inputs.require_lease()
        durable_new(marker, {'run_id': self.run_id, 'fixture': self.fixture, 'expected': self.expected,
                    'target': self.target, 'transport': transport, 'created_epoch': time.time(),
                    'meaning': 'Dispatch intended; success is NOT established. Never automatically resend.'})
        self.shell(transport, 'am', 'broadcast', '-a', ACTION, '--es', 'target_version', self.target['version'],
                   '--es', 'sha256', sha, '--es', 'artifact_id', 'setup-' + self.run_id,
                   '-n', PACKAGE + '/.receiver.DebugBesOtaReceiver')
        return {'status': 'dispatch-attempted', 'intent': str(marker), 'target': self.target['version']}
