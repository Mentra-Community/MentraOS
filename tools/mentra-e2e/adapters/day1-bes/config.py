"""Private, hash-pinned inputs for the qualified compact January BES adapter."""
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat

PROFILE = 'compact-january-bes-v1'
VERSION = '17.26.1.13'
RAW_SHA = '07ce5f661095a9db417f0fc26c5dfe34575312c53a5785e548a22abc8d92e7db'
OTA_SHA = 'f2583b2c0978145d3ede09d397098881b1cef4813abaab132cae120c80b8efae'
VERIFIER_SHA = '9f12314c1c9108981aafc7377c1378ec7686f32acfb935c4633a7197b085adb3'
FILES = frozenset(('__init__.py', 'config.py', 'bes_setup.py', 'run_once.py', 'run.py', 'reconcile.py'))
SHA = r'[0-9a-f]{64}'
UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'


class Guard(RuntimeError):
    pass


def require(ok, reason):
    if not ok:
        raise Guard(reason)


def digest(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def absolute(value):
    require(isinstance(value, str) and Path(value).is_absolute() and str(Path(value)) == value
            and '..' not in Path(value).parts and not any(c in value for c in '\0\r\n'), 'normalized_absolute_path_required')
    return Path(value)


def private_bytes(path, maximum=20_000_000):
    path = absolute(str(path))
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= maximum, 'private_file_invalid')
        raw = file.read(maximum + 1)
    require(len(raw) <= maximum, 'private_file_too_large')
    return raw


def exact(value, keys, code):
    require(isinstance(value, dict) and set(value) == set(keys.split()), code)


def reference(value, *, private=False):
    exact(value, 'path sha256', 'reference_schema')
    path = absolute(value['path'])
    require(isinstance(value['sha256'], str) and re.fullmatch(SHA, value['sha256']), 'reference_sha_invalid')
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), 'reference_not_regular')
    actual = hashlib.sha256(private_bytes(path)).hexdigest() if private else digest(path)
    require(actual == value['sha256'], 'reference_sha_changed')
    return path


def endpoint(value):
    require(isinstance(value, str), 'endpoint_required')
    host, sep, port = value.rpartition(':')
    ip = ipaddress.IPv4Address(host)
    require(sep == ':' and port == '5555' and str(ip) == host and any(ip in net for net in
            map(ipaddress.ip_network, ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))), 'explicit_lan_endpoint_required')
    return value


@dataclass(frozen=True)
class Config:
    path: Path
    sha256: str
    raw: bytes

    @property
    def data(self):
        # Each consumer gets a copy; caller changes cannot mutate the frozen input.
        return json.loads(self.raw)

    @property
    def claim_path(self):
        row = self.data
        return absolute(row['claimsRoot']) / row['fixture']['cid'] / (row['expected']['boot_id']+'-'+OTA_SHA+'.json')

    def verify_definition(self):
        require(hashlib.sha256(private_bytes(self.path, 65536)).hexdigest() == self.sha256, 'config_changed')
        for name, sha in self.data['definition'].items():
            path = Path(__file__).resolve().parent / name
            require(path.is_file() and not path.is_symlink() and digest(path) == sha, 'definition_changed')

    def require_lease(self):
        self.verify_definition()
        value = self.data
        lease = json.loads(private_bytes(absolute(value['lease']['path']), 65536))
        pid = lease.get('pid')
        require(type(pid) is int and pid > 1 and pid == os.getppid() and isinstance(lease.get('token'), str)
                and bool(lease['token']), 'immediate_parent_must_own_fixture_lease')
        os.kill(pid, 0)
        for name in ('adb', 'python'):
            path = reference(value['tools'][name])
            require(os.access(path, os.X_OK), 'runtime_not_executable')
        return pid

    def prepare_claims(self):
        root = absolute(self.data['claimsRoot'])
        for path in (root, root / self.data['fixture']['cid']):
            if path != root and not path.exists():
                path.mkdir(mode=0o700)
                parent = os.open(root, os.O_RDONLY)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o700, 'claims_directory_not_private')

    def adapter_config(self):
        import bes_setup
        row = self.data
        proof = row['sourceProof']
        log = private_bytes(reference(proof['log'], private=True)).decode()
        state = bes_setup.settled_source(log, proof['pid'], row['expected']['boot_id'],
                                        row['expected']['bes'], proof['deviceEpoch'], row['proof_max_age_seconds'])
        result = {key: row[key] for key in ('fixture', 'expected', 'target', 'proof_max_age_seconds')}
        result['settled_source'] = state
        result['tools'] = {name: row['tools'][name]['path'] for name in ('adb', 'python')}
        result['tools']['verifier'] = row['tools']['verifier']
        return result


def load(path, sha256):
    path = absolute(str(path))
    require(isinstance(sha256, str) and re.fullmatch(SHA, sha256), 'config_sha_required')
    raw = private_bytes(path, 65536)
    require(hashlib.sha256(raw).hexdigest() == sha256, 'config_sha_mismatch')
    row = json.loads(raw)
    exact(row, 'schemaVersion profileId fixture expected target tools sourceProof proof_max_age_seconds lease claimsRoot definition', 'config_schema')
    require(type(row['schemaVersion']) is int and row['schemaVersion'] == 1 and row['profileId'] == PROFILE, 'unqualified_profile')
    f, expected = row['fixture'], row['expected']
    exact(f, 'cid mac serial_aliases transport', 'fixture_schema')
    require(isinstance(f['cid'], str) and re.fullmatch(r'[0-9a-f]{32}', f['cid'])
            and isinstance(f['mac'], str) and re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', f['mac']), 'fixture_identity_invalid')
    aliases = f['serial_aliases']
    require(isinstance(aliases, list) and 0 < len(aliases) <= 4 and len(set(aliases)) == len(aliases)
            and all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', x) for x in aliases)
            and aliases != ['0123456789ABCDEF'], 'serial_aliases_invalid')
    exact(f['transport'], 'kind address', 'transport_schema')
    require(f['transport']['kind'] == 'network', 'explicit_network_transport_required')
    endpoint(f['transport']['address'])
    exact(expected, 'boot_id slot mtk bes asg_version_code asg_apk_sha256', 'expected_schema')
    require(isinstance(expected['boot_id'], str) and re.fullmatch(UUID, expected['boot_id'])
            and expected['slot'] in ('_a', '_b') and isinstance(expected['mtk'], str)
            and re.fullmatch(r'MentraLive_\d{8}(?:\.\d{1,9})?', expected['mtk'])
            and isinstance(expected['bes'], str) and re.fullmatch(r'\d{1,5}(?:\.\d{1,5}){3}', expected['bes'])
            and expected['bes'] != VERSION and type(expected['asg_version_code']) is int and expected['asg_version_code'] > 0
            and isinstance(expected['asg_apk_sha256'], str) and re.fullmatch(SHA, expected['asg_apk_sha256']), 'expected_identity_invalid')
    exact(row['target'], 'version raw ota', 'target_schema')
    require(row['target']['version'] == VERSION, 'only_compact_january_target_supported')
    for name, sha, size in (('raw', RAW_SHA, 1966076), ('ota', OTA_SHA, 1131730)):
        value = row['target'][name]
        artifact_path = reference(value)
        require(value['sha256'] == sha and artifact_path.stat().st_size == size, 'unqualified_compact_artifact')
    exact(row['tools'], 'adb python verifier', 'tools_schema')
    for value in row['tools'].values():
        reference(value)
    require(row['tools']['verifier']['sha256'] == VERIFIER_SHA, 'unqualified_verifier')
    exact(row['sourceProof'], 'log pid deviceEpoch', 'source_proof_schema')
    proof = row['sourceProof']
    reference(proof['log'], private=True)
    require(isinstance(proof['pid'], str) and re.fullmatch(r'[1-9]\d*', proof['pid'])
            and type(proof['deviceEpoch']) in (int, float) and 0 < proof['deviceEpoch'] < 1e12, 'source_proof_clock_invalid')
    require(type(row['proof_max_age_seconds']) is int and 1 <= row['proof_max_age_seconds'] <= 60, 'invalid_proof_age')
    exact(row['lease'], 'path', 'lease_schema')
    absolute(row['lease']['path']); absolute(row['claimsRoot'])
    require(isinstance(row['definition'], dict) and set(row['definition']) == FILES
            and all(isinstance(x, str) and re.fullmatch(SHA, x) for x in row['definition'].values()), 'definition_schema')
    cfg = Config(path, sha256, raw)
    cfg.verify_definition()
    cfg.adapter_config()
    return cfg
