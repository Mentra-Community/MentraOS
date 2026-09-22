"""Immutable inputs for the one qualified January full-OTA setup profile.

This is a private worker input, not a firmware selector. The routine definition
pins every Python source file; user credentials stay in a separate 0600 file.
"""
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
from types import MappingProxyType

PROFILE = {
    'id': 'january-20260113-powerwash-asg27',
    'sourceVersion': 'MentraLive_20260921.0', 'sourceEpoch': '1790034149',
    'targetVersion': 'MentraLive_20260113', 'powerwash': True,
    'asgVersionCode': 27, 'asgSha256': '3f41ae1b05ad21c83b997719257a73944a34af916686d9a1e5440cb57b0cdbce',
    'otaSha256': 'a9ab45592ad0437f16aa286f9c9f4bdd8ffcb7b07818827a2966bc202186886d',
    'otaBytes': 607225124,
    'payloadSha256': '40dc039f47678451b306d5743f3d4399881b1a9bd9759318dcbbc24fe78df5f7',
    'verificationSha256': 'e96715d4429a285538701c1fabe68bc1ea73b026b5339fa540f7925c92ed801e',
}
PROFILE_SHA = hashlib.sha256(json.dumps(PROFILE, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
HELPER_SHA = '00f586a648c96383a9545145d7b44b25bbd2696ce24b8efb166238dde59a8698'
PROBE_SHA = 'c0488244fe62e24f0ca2c855355de01bc687d1d8ae762336e2fc0405e5e42a8e'
PROBE_BYTES = 2143
DEFINITION_FILES = frozenset(('__init__.py', 'config.py', 'ble_support.py', 'factory_asg.py',
    'recover_wiped.py', 'bes_continuity.py', 'observe_power.py', 'query_bes_version.py', 'full_january.py', 'reconcile.py', 'observe.py'))
SHA = r'[0-9a-f]{64}'
UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'


class Guard(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Guard(code)


def digest(path):
    with Path(path).open('rb') as file:
        value = hashlib.sha256()
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def private_bytes(path, maximum=65536):
    require(Path(path).is_absolute(), 'private_path_not_absolute')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= maximum, 'private_file_invalid')
        raw = file.read(maximum + 1)
    require(len(raw) <= maximum, 'private_file_too_large')
    return raw


def exact(value, names, code):
    require(isinstance(value, dict) and set(value) == set(names.split()), code)


def absolute(value):
    require(isinstance(value, str) and Path(value).is_absolute() and '\x00' not in value, 'absolute_path_required')
    require(str(Path(value)) == value and '..' not in Path(value).parts, 'path_not_normalized')
    return Path(value)


def endpoint(value):
    require(isinstance(value, str), 'endpoint_required')
    host, sep, port = value.rpartition(':')
    ip = ipaddress.IPv4Address(host)
    require(sep == ':' and port == '5555' and str(ip) == host and ip.is_private
            and not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified), 'unsafe_endpoint')
    return value


@dataclass(frozen=True)
class Reference:
    path: Path
    sha256: str
    size: int | None = None

    def verify(self):
        info = self.path.lstat()
        require(stat.S_ISREG(info.st_mode) and not self.path.is_symlink(), 'reference_not_regular')
        require(self.size is None or info.st_size == self.size, 'reference_size_changed')
        require(digest(self.path) == self.sha256, 'reference_hash_changed')

    def json(self):
        return {'path': str(self.path), 'sha256': self.sha256}


def reference(value, sized=False):
    exact(value, 'path sha256 size' if sized else 'path sha256', 'reference_schema')
    require(isinstance(value['sha256'], str) and re.fullmatch(SHA, value['sha256']), 'reference_hash_invalid')
    size = value.get('size')
    require(not sized or type(size) is int and size > 0, 'reference_size_invalid')
    return Reference(absolute(value['path']), value['sha256'], size)


@dataclass(frozen=True)
class Config:
    path: Path
    sha256: str
    fixture: object
    serial_aliases: tuple
    boot_serial: str
    ble_name: str
    claims_root: Path
    credential: Reference
    ota: Reference
    verification: Reference
    helper: Reference
    probe: Reference
    python: Path
    adb: Path
    lease_path: Path
    definition: object
    app_name: str
    source_endpoint: str
    bes_install: Reference

    @property
    def stage_claims(self):
        return self.claims_root / self.fixture['cid'] / 'stage'

    @property
    def recovery_claims(self):
        return self.claims_root / self.fixture['cid'] / 'provision'

    @property
    def child_args(self):
        return ['--config', str(self.path), '--config-sha256', self.sha256]

    def verify_definition(self):
        require(hashlib.sha256(private_bytes(self.path)).hexdigest() == self.sha256, 'config_changed')
        root = Path(__file__).resolve().parent
        for name, sha in self.definition.items():
            info = (root/name).lstat()
            require(stat.S_ISREG(info.st_mode) and digest(root/name) == sha, 'definition_changed')

    def require_lease(self, *, child=False):
        self.verify_definition()
        owner = json.loads(private_bytes(self.lease_path))
        pid = owner.get('pid')
        require(type(pid) is int and pid > 1 and isinstance(owner.get('token'), str)
                and bool(owner['token']), 'root_fixture_lease_required')
        os.kill(pid, 0)
        if child:
            import subprocess
            immediate_parent = os.getppid()
            parent = subprocess.run(['ps', '-p', str(immediate_parent), '-o', 'ppid='],
                                    capture_output=True, text=True, timeout=10)
            require(parent.returncode == 0 and parent.stdout.strip() == str(pid)
                    and os.getppid() == immediate_parent, 'child_lease_parent_mismatch')
        else:
            require(os.getppid() == pid, 'controller_lease_parent_mismatch')
        return pid

    def prepare_claims(self):
        for index, path in enumerate((self.claims_root, self.claims_root / self.fixture['cid'], self.stage_claims, self.recovery_claims)):
            if index and not path.exists():
                path.mkdir(mode=0o700)
            info = path.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                    and stat.S_IMODE(info.st_mode) == 0o700, 'claim_directory_not_private')

    def require_managed_app_absent(self):
        import subprocess
        result = subprocess.run(['pgrep', '-x', self.app_name], capture_output=True, text=True, timeout=10)
        require(result.returncode == 1 and not result.stdout.strip(), 'normal_mentra_app_still_running')

    def public_inputs(self):
        return {'schemaVersion': 1, 'profileId': PROFILE['id'], 'profileSha256': PROFILE_SHA,
                'configSha256': self.sha256, 'fixture': dict(self.fixture), 'bootSerial': self.boot_serial,
                'otaSha256': self.ota.sha256, 'payloadSha256': PROFILE['payloadSha256'],
                'verificationSha256': self.verification.sha256, 'helperSha256': self.helper.sha256,
                'probeSha256': self.probe.sha256, 'credentialFileSha256': self.credential.sha256,
                'besInstallProofSha256': self.bes_install.sha256, 'definition': dict(self.definition)}


def load(path, sha):
    path = absolute(str(path))
    require(isinstance(sha, str) and re.fullmatch(SHA, sha), 'config_hash_required')
    raw = private_bytes(path)
    require(hashlib.sha256(raw).hexdigest() == sha, 'config_hash_mismatch')
    value = json.loads(raw)
    exact(value, 'schemaVersion profileId profileSha256 fixture claimsRoot credential ota verification stagingHelper statusProbe python adb lease definition managedAppExecutableName sourceEndpoint besInstallProof', 'config_schema')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['profileId'] == PROFILE['id'] and value['profileSha256'] == PROFILE_SHA, 'unqualified_profile')
    f = value['fixture']
    exact(f, 'cid serial mac bootSerial serialAliases', 'fixture_schema')
    require(isinstance(f['cid'], str) and isinstance(f['mac'], str)
            and re.fullmatch(r'[0-9a-f]{32}', f['cid']) and re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', f['mac']), 'fixture_identity_invalid')
    aliases = f['serialAliases']
    require(isinstance(aliases, list) and 0 < len(aliases) <= 4
            and all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', x) for x in aliases)
            and len(set(aliases)) == len(aliases)
            and f['serial'] in aliases and f['bootSerial'] in aliases
            and f['serial'] != '0123456789ABCDEF', 'serial_aliases_invalid')
    fixture = MappingProxyType({key: f[key] for key in ('cid', 'serial', 'mac')})
    ota, proof = reference(value['ota'], True), reference(value['verification'])
    helper, probe = reference(value['stagingHelper']), reference(value['statusProbe'], True)
    require(ota.sha256 == PROFILE['otaSha256'] and ota.size == PROFILE['otaBytes']
            and proof.sha256 == PROFILE['verificationSha256'] and helper.sha256 == HELPER_SHA
            and probe.sha256 == PROBE_SHA and probe.size == PROBE_BYTES, 'unqualified_artifact_or_tool')
    exact(value['lease'], 'path', 'lease_schema')
    require(isinstance(value['definition'], dict) and set(value['definition']) == DEFINITION_FILES
            and all(isinstance(sha, str) and re.fullmatch(SHA, sha) for sha in value['definition'].values()), 'definition_schema')
    require(value['managedAppExecutableName'] == 'Mentra', 'unqualified_managed_app')
    cfg = Config(path, sha, fixture, tuple(aliases), f['bootSerial'], 'mentra_live_'+f['mac'].replace(':', '')[-4:].lower(),
        absolute(value['claimsRoot']), reference(value['credential']), ota, proof, helper, probe,
        absolute(value['python']), absolute(value['adb']), absolute(value['lease']['path']),
        MappingProxyType(value['definition']), value['managedAppExecutableName'],
        endpoint(value['sourceEndpoint']), reference(value['besInstallProof']))
    cfg.verify_definition()
    return cfg


def arguments(parser):
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--config-sha256', required=True)


def from_arguments(args):
    return load(args.config, args.config_sha256)
