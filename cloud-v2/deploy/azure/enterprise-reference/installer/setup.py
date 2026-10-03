#!/usr/bin/env python3
"""Portable, resumable Azure installer. Python standard library only."""
import argparse
import base64
import contextlib
import datetime
import hashlib
import http.client
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import uuid
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = ('Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.ManagedIdentity',
             'Microsoft.Communication', 'Microsoft.DocumentDB', 'Microsoft.Storage')
BINDING_KEYS = ('subscriptionId', 'tenantId', 'resourceGroup', 'registryName', 'location',
                'workspaceHostname', 'environmentName', 'runtimeName', 'coreName', 'pullIdentityName',
                'communicationName', 'mongoAccountName', 'reportStorageAccountName', 'deploymentName',
                'resourceTags', 'coreApiClientId', 'mobileClientId')
GUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')


class SetupError(Exception):
    pass


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise SetupError(f'Cannot read JSON file {path}: {exc}') from None


def write_json(path, value):
    path = Path(path)
    if path.is_symlink():
        raise SetupError(f'Refusing symlink: {path}')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def run(argv, env=None, capture=True):
    # Azure deployment failures can contain parameter values. Never echo raw
    # subprocess output, command lines, HTTP bodies, or exception text to logs.
    result = subprocess.run(argv, env=env, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE)
    if result.returncode:
        raise SetupError(f'{Path(argv[0]).name} {argv[1] if len(argv) > 1 else ""} failed '
                         f'(exit {result.returncode}). Check Azure Portal deployment operations. '
                         'Raw provider output is withheld because it may contain secrets.')
    return result.stdout or ''


def azure(config, *args):
    return json.loads(run(['az', *args, '--subscription', config['subscriptionId'], '--output', 'json']))


def check_release():
    release = read_json(ROOT / 'release.json')
    if release.get('schemaVersion') != 1 or not re.fullmatch(
            r'ghcr\.io/mentra-community/mentra-cloud@sha256:[0-9a-f]{64}', release.get('sourceImage', '')):
        raise SetupError('Invalid release metadata')
    required = {'setup.sh', 'installer/setup.py', 'installer/admin-key.ts', 'main.bicep', 'bootstrap.bicep',
                'deployment.config.example.json', 'scripts/deploy.sh', 'scripts/configure-entra.sh',
                'scripts/generate-private-secrets.sh', 'scripts/import-runtime-image.sh', 'scripts/smoke-test.sh'}
    inventory = release.get('files')
    if not isinstance(inventory, dict) or not required.issubset(inventory):
        raise SetupError('Release inventory is incomplete')
    for filename, expected in release['files'].items():
        path = ROOT / filename
        if (not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected)
                or Path(filename).is_absolute() or '..' in Path(filename).parts
                or not path.resolve().is_relative_to(ROOT) or path.is_symlink() or not path.is_file()):
            raise SetupError(f'Invalid release file: {filename}')
        if digest(path) != expected:
            raise SetupError(f'Release file changed: {filename}. Obtain the original installer package.')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', release.get('releaseTag', '')):
        raise SetupError('Invalid image release tag')
    apps = release.get('managedMiniapps')
    if not isinstance(apps, list) or not any(isinstance(a, dict) and a.get('packageName') == 'com.mentra.call' for a in apps):
        raise SetupError('Release must include Mentra Call')
    for app in apps:
        if (not isinstance(app, dict) or not isinstance(app.get('version'), str)
                or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+', app.get('packageName', ''))
                or not re.fullmatch(r'[0-9a-f]{64}', app.get('sha256', ''))
                or app.get('bundlePath') != f"/miniapps/{app['packageName']}-{app.get('version')}.zip"
                or '/' in app.get('version', '') or '\\' in app.get('version', '')):
            raise SetupError('Invalid managed miniapp release')
    return release


@contextlib.contextmanager
def locked(directory):
    # Cloud Shell, Linux and macOS release this advisory lock even if the
    # installer is killed. Keep the inode in place to prevent recovery races.
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    value = directory.stat()
    if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) & 0o077:
        raise SetupError('Setup directory must be owner-only (chmod 700). In persistent Cloud Shell use $HOME/mentra-install, not the clouddrive SMB share.')
    path = directory / '.setup-lock'
    if path.is_symlink():
        raise SetupError('Refusing a symlink setup lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Another setup is running; wait for it to finish') from None
        try:
            stream.seek(0)
            stream.truncate()
            stream.write(json.dumps({'pid': os.getpid(), 'hostname': socket.gethostname()}))
            stream.flush()
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def recover_identity(directory, config, state):
    # Journal the two-file identity update before publishing either file. A
    # killed process can finish the same authorized update on its next load.
    journal = directory / 'identity.pending.json'
    if not journal.exists():
        return
    pending = read_json(journal)
    if state.get('outputs') or state.get('configHash'):
        raise SetupError('Pending identity update conflicts with a deployed configuration')
    previous = pending['previousBinding']
    updated = dict(config, coreApiClientId=pending['coreApiClientId'], mobileClientId=pending['mobileClientId'])
    binding = {k: updated.get(k) for k in BINDING_KEYS}
    if (any(updated.get(k) != previous.get(k) for k in BINDING_KEYS
            if k not in ('coreApiClientId', 'mobileClientId'))
            or state['binding'] not in (previous, binding)
            or (digest(directory / 'deployment.config.json') != pending['previousConfigHash']
                and config != updated)):
        raise SetupError('Pending identity update conflicts with saved configuration; restore the original files')
    write_json(directory / 'deployment.config.json', updated)
    config.update(updated)
    state['binding'] = binding
    checkpoint(directory, state, 'identity_configured')
    journal.unlink()


def load(directory):
    config = read_json(directory / 'deployment.config.json')
    state = read_json(directory / 'state.json')
    if state.get('schemaVersion') != 1 or state['deploymentId'] != config['deploymentId']:
        raise SetupError('State belongs to a different deployment')
    release = check_release()
    recover_upgrade(directory, config, state)
    if state['releaseHash'] != digest(ROOT / 'release.json'):
        raise SetupError('Installer release differs from saved state. Use the original package; upgrades require a new reviewed release.')
    recover_identity(directory, config, state)
    recover_configuration(directory, config, state)
    for key in BINDING_KEYS:
        if config.get(key) != state['binding'].get(key):
            raise SetupError(f'{key} changed since initialization. Restore the original configuration.')
    if config['sourceImage'] != release['sourceImage'] or config['releaseTag'] != release['releaseTag']:
        raise SetupError('Image pin changed. Use a reviewed release package.')
    if config.get('managedMiniapps') != release['managedMiniapps']:
        raise SetupError('Managed miniapp pin changed. Use a reviewed release package.')
    if state.get('configHash') and state['configHash'] != digest(directory / 'deployment.config.json'):
        raise SetupError('Configuration changed after deployment started. Restore it before resuming.')
    secrets = directory / 'secrets.json'
    if state.get('secretsCreated') and not secrets.is_file():
        raise SetupError('Original secrets file is missing. Restore it from your secret manager; do not regenerate signing keys.')
    if secrets.exists() and (secrets.is_symlink() or not stat.S_ISREG(secrets.stat().st_mode)
                             or secrets.stat().st_uid != os.getuid()
                             or stat.S_IMODE(secrets.stat().st_mode) & 0o077):
        raise SetupError('Secrets must be a regular file accessible only by its owner (chmod 600).')
    return config, state, release


def recover_upgrade(directory, config, state):
    journal = directory / 'upgrade.pending.json'
    if not journal.exists():
        return
    pending = read_json(journal)
    if pending['targetReleaseHash'] != digest(ROOT / 'release.json'):
        raise SetupError('An upgrade is pending. Resume using its target installer package; do not edit saved state.')
    previous = pending['previousConfig']
    updated = pending['updatedConfig']
    allowed = {'sourceImage', 'releaseTag', 'managedMiniapps', 'clientMinVersion', 'clientRecommendedVersion'}
    release = check_release()
    if (config not in (previous, updated)
            or state['releaseHash'] not in (pending['previousReleaseHash'], pending['targetReleaseHash'])
            or state.get('configHash') not in (pending['previousConfigHash'], pending['updatedConfigHash'])
            or any(previous.get(k) != state['binding'].get(k) for k in BINDING_KEYS)
            or any(previous.get(k) != updated.get(k) for k in set(previous) | set(updated) if k not in allowed)
            or any(updated.get(k) != release.get(k) for k in ('sourceImage', 'releaseTag', 'managedMiniapps', 'clientMinVersion'))
            or updated.get('clientRecommendedVersion') != release['clientMinVersion']):
        raise SetupError('Pending upgrade conflicts with saved configuration. Restore the protected upgrade backup.')
    write_json(directory / 'deployment.config.json', updated)
    config.update(updated)
    checkpoint(directory, state, 'upgrade_ready', releaseHash=pending['targetReleaseHash'],
               configHash=pending['updatedConfigHash'], upgrade=pending['summary'])
    journal.unlink()


def release_version(release):
    value = release['releaseTag']
    match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z0-9.-]+))?', value)
    if not match:
        raise SetupError('Upgrade requires a coordinated semantic release identity')
    base = tuple(int(x) for x in match.group(1, 2, 3))
    suffix = match.group(4)
    if suffix is None:
        return base + (1, ())
    identifiers = suffix.split('.')
    if any(not x or (x.isdigit() and len(x) > 1 and x.startswith('0')) for x in identifiers):
        raise SetupError('Upgrade requires a canonical semantic release identity')
    parts = tuple((0, int(x)) if x.isdigit() else (1, x) for x in identifiers)
    return base + (0, parts)


def publish_backup(destination, contents):
    fd, name = tempfile.mkstemp(dir=destination.parent, prefix='.upgrade-backup-')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        # Same supported owner-only POSIX filesystem as setup state. Publish
        # a complete inode without replacing a concurrently created backup.
        os.link(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def upgrade(args, directory):
    if not args.backup_confirmed:
        raise SetupError('Upgrade requires --backup-confirmed after backing up the database, attachments and original signing material')
    if not args.previous_package:
        raise SetupError('upgrade requires --previous-package PATH to the retained original installer package')
    previous_root = Path(args.previous_package).resolve()
    if previous_root == ROOT:
        raise SetupError('Use the new target package for upgrade and retain the previous package separately')
    import importlib.util
    spec = importlib.util.spec_from_file_location('mentra_previous_installer', previous_root / 'installer/setup.py')
    if not spec or not spec.loader:
        raise SetupError('Cannot load the retained previous installer')
    previous = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(previous)
    config, state, old_release = previous.load(directory)
    if state['phase'] != 'infrastructure_verified':
        raise SetupError('Verify the current deployment with its original package before upgrade')
    target = check_release()
    if release_version(target) < release_version(old_release):
        raise SetupError('Release downgrade is refused: image rollback does not roll back database migrations')
    if target['releaseTag'] == old_release['releaseTag'] and target['sourceImage'] != old_release['sourceImage']:
        raise SetupError('A coordinated release identity cannot change its image digest')
    if digest(ROOT / 'release.json') == state['releaseHash']:
        raise SetupError('Target installer is already selected. Use resume or verify')
    if not (directory / 'secrets.json').is_file() or not state.get('secretsCreated'):
        raise SetupError('Restore the original signing secrets before upgrade')
    updated = dict(config, **{k: target[k] for k in ('sourceImage', 'releaseTag', 'managedMiniapps', 'clientMinVersion')},
                   clientRecommendedVersion=target['clientMinVersion'])
    preflight(updated, require_identity=True)
    # Keep the exact original bytes and state before publishing the new pins.
    # This snapshot supports diagnosis, not automatic database/image downgrade.
    backup = directory / 'upgrades' / digest(ROOT / 'release.json')
    backup.mkdir(parents=True, mode=0o700, exist_ok=True)
    if backup.is_symlink() or backup.stat().st_uid != os.getuid() or backup.stat().st_mode & 0o077:
        raise SetupError('Upgrade backup directory must be owner-only and not a symlink')
    for name in ('deployment.config.json', 'state.json'):
        destination = backup / name
        original = (directory / name).read_bytes()
        if destination.exists():
            if destination.is_symlink() or destination.read_bytes() != original:
                raise SetupError('Upgrade backup conflicts with original state; never overwrite recovery evidence')
        else:
            publish_backup(destination, original)
    temporary = directory / 'upgrade.update.json'
    write_json(temporary, updated)
    summary = {'fromRelease': old_release['releaseTag'], 'toRelease': target['releaseTag'],
               'fromImage': old_release['sourceImage'], 'toImage': target['sourceImage'], 'backup': str(backup)}
    write_json(directory / 'upgrade.pending.json', {
        'previousConfig': config, 'updatedConfig': updated, 'previousReleaseHash': state['releaseHash'],
        'targetReleaseHash': digest(ROOT / 'release.json'), 'previousConfigHash': digest(directory / 'deployment.config.json'),
        'updatedConfigHash': digest(temporary), 'summary': summary})
    temporary.unlink()
    recover_upgrade(directory, config, state)
    emit(args, {'status': 'upgrade_ready', **summary,
                'next': 'Use this target package to run resume, then verify employee sign-in, Calls and report retrieval. Original keys and resource bindings are retained. Retain both packages and your database/files backup.'})


def recover_configuration(directory, config, state):
    journal = directory / 'configuration.pending.json'
    if not journal.exists():
        return
    pending = read_json(journal)
    previous = pending['previousConfig']
    changes = pending['changes']
    if not changes or set(changes) - {'sourceRegistryMirror', 'coreAdminEmails'}:
        raise SetupError('Unsupported pending configuration update')
    updated = dict(previous, **changes)
    # Only approved distribution-endpoint and administrator-allowlist updates
    # can change. Never adopt resource bindings, release pins, or other edits.
    if (config not in (previous, updated)
            or state.get('configHash') not in (None, pending['previousConfigHash'], pending['updatedConfigHash'])
            or any(previous.get(k) != state['binding'].get(k) for k in BINDING_KEYS)):
        raise SetupError('Pending configuration update conflicts with saved configuration; restore the original files')
    write_json(directory / 'deployment.config.json', updated)
    config.update(updated)
    checkpoint(directory, state, state['phase'], configHash=pending['updatedConfigHash'] if state.get('configHash') else None)
    journal.unlink()


def update_configuration(directory, config, state, **changes):
    previous = dict(config)
    updated = dict(config, **changes)
    temporary = directory / 'configuration.update.json'
    write_json(temporary, updated)
    pending = {'previousConfig': previous, 'changes': changes,
               'previousConfigHash': digest(directory / 'deployment.config.json'),
               'updatedConfigHash': digest(temporary)}
    write_json(directory / 'configuration.pending.json', pending)
    temporary.unlink()
    recover_configuration(directory, config, state)


def configure_mirror(args, directory, config, state):
    if not args.mirror:
        raise SetupError('configure-mirror requires --mirror REGISTRY.azurecr.io/REPOSITORY')
    updated = dict(config, sourceRegistryMirror=args.mirror)
    check_source_image(updated)
    update_configuration(directory, config, state, sourceRegistryMirror=args.mirror)
    emit(args, {'status': 'mirror_configured', 'image': config['sourceImage'],
                'next': 'Run resume. The release digest and deployed resource settings are unchanged.'})


def emit(args, value):
    if args.json:
        print(json.dumps(value, indent=2))
    elif isinstance(value, dict):
        for key, item in value.items():
            print(f'{key}: {json.dumps(item) if isinstance(item, (list, dict)) else item}')
    else:
        print(value)


def init(args, directory):
    if (directory / 'state.json').exists() or (directory / 'deployment.config.json').exists():
        raise SetupError('Setup directory already initialized. Use status, install, or resume.')
    release = check_release()
    inputs = read_json(args.config) if args.config else {}
    allowed = set(read_json(ROOT / 'deployment.config.example.json')) | {'subscriptionId'}
    if not isinstance(inputs, dict) or set(inputs) - allowed:
        raise SetupError('Initialization accepts only documented configuration fields; keep secret values in secrets.json.')
    prompts = [('subscriptionId', 'Azure subscription ID'), ('tenantId', 'Microsoft Entra tenant ID'),
               ('deploymentId', 'Short deployment name (lowercase, e.g. lumber-mentra)'),
               ('displayName', 'Company display name'), ('location', 'Azure region', 'westus2'),
               ('workspaceHostname', 'Workspace hostname (blank uses Azure hostname)', '')]
    for item in prompts:
        key, label, *default = item
        if key not in inputs:
            if not sys.stdin.isatty():
                if default:
                    inputs[key] = default[0]
                else:
                    raise SetupError(f'{key} is required in --config for unattended initialization')
            else:
                inputs[key] = input(label + (f' [{default[0]}]' if default and default[0] else '') + ': ').strip() or (default[0] if default else '')
    for key in ('subscriptionId', 'tenantId'):
        if not GUID.fullmatch(inputs[key]):
            raise SetupError(f'{key} must be a UUID')
    name = inputs['deploymentId']
    if not re.fullmatch(r'[a-z][a-z0-9-]{2,17}[a-z0-9]', name):
        raise SetupError('Deployment name must be 4–19 lowercase letters, digits, or hyphens, starting with a letter.')
    hostname = inputs['workspaceHostname']
    if hostname and (not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}', hostname) or len(hostname) > 253):
        raise SetupError('Workspace hostname must be a DNS hostname, without https:// or a path.')
    ownership = str(uuid.uuid4())
    config = read_json(ROOT / 'deployment.config.example.json')
    config.update(inputs)
    config['deploymentName'] = 'mentra-private'
    config.update(sourceImage=release['sourceImage'], releaseTag=release['releaseTag'],
                  managedMiniapps=release['managedMiniapps'], clientMinVersion=release['clientMinVersion'],
                  clientRecommendedVersion=release['clientMinVersion'])
    defaults = dict(resourceGroup=f'rg-{name}', registryName=name.replace('-', '') + ownership.replace('-', '')[:8],
                    environmentName=f'cae-{name}', runtimeName=f'ca-{name}', coreName=f'ca-{name}-core',
                    pullIdentityName=f'id-{name}-pull', communicationName=f'{name}-acs-{ownership[:8]}',
                    coreApiClientId='', mobileClientId='', coreAdminEmails='',
                    privacyPolicyUrl='', termsOfServiceUrl='')
    for key, value in defaults.items():
        config[key] = inputs.get(key, value)
    config['approvedSystemMiniapps'] = ['com.mentra.settings', 'com.mentra.feedback']
    validate_resource_names(config)
    config['resourceTags'] = {'mentraDeploymentId': name, 'mentraInstallerOwner': ownership}
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    write_json(directory / 'deployment.config.json', config)
    write_json(directory / 'state.json', dict(schemaVersion=1, deploymentId=name, releaseHash=digest(ROOT / 'release.json'),
               binding={k: config.get(k) for k in BINDING_KEYS},
               owner=ownership, phase='initialized', createdAt=now(), secretsCreated=False, checks={}, outputs={}))
    emit(args, {'status': 'initialized', 'directory': str(directory), 'next': 'Run preflight and plan. Configure Entra before install.'})


def validate_resource_names(config):
    mirror = config.get('sourceRegistryMirror', '')
    if not isinstance(mirror, str) or (mirror and not re.fullmatch(r'[a-z0-9]+\.azurecr\.io/[a-z0-9]+(?:[._/-][a-z0-9]+)*', mirror)):
        raise SetupError('Invalid Azure source registry mirror')
    patterns = {'registryName': r'[a-z0-9]{5,50}', 'resourceGroup': r'[a-zA-Z0-9_-]{1,90}',
                'runtimeName': r'[a-z][a-z0-9-]{0,29}[a-z0-9]', 'coreName': r'[a-z][a-z0-9-]{0,29}[a-z0-9]',
                'environmentName': r'[a-zA-Z0-9-]{2,60}', 'pullIdentityName': r'[a-zA-Z0-9_-]{2,128}',
                'communicationName': r'[a-zA-Z0-9-]{2,63}', 'location': r'[a-z0-9]{2,40}'}
    for key, pattern in patterns.items():
        if not isinstance(config.get(key), str) or not re.fullmatch(pattern, config[key]):
            raise SetupError(f'Invalid Azure resource name: {key}')
    for key, pattern in (('mongoAccountName', r'[a-z0-9][a-z0-9-]{1,42}[a-z0-9]'),
                         ('reportStorageAccountName', r'[a-z0-9]{3,24}')):
        if config.get(key) and not re.fullmatch(pattern, config[key]):
            raise SetupError(f'Invalid Azure resource name: {key}')


def check_openssl():
    # macOS ships LibreSSL, which may exist but cannot generate our Ed25519 keys.
    # Exercise the exact key algorithm before creating any Azure resources.
    with tempfile.TemporaryDirectory(prefix='mentra-openssl-') as directory:
        result = subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519',
                                 '-out', str(Path(directory) / 'key.pem')],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise SetupError('OpenSSL must support Ed25519 key generation. Use Azure Cloud Shell Bash, '
                         'or install OpenSSL 3 and put it first on PATH.')


class NoRegistryRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check_source_image(config):
    username = os.environ.get('SOURCE_REGISTRY_USERNAME', '')
    password = os.environ.get('SOURCE_REGISTRY_PASSWORD', '')
    if bool(username) != bool(password):
        raise SetupError('Set both SOURCE_REGISTRY_USERNAME and SOURCE_REGISTRY_PASSWORD for a private image.')
    # Accept the official GHCR source or a customer-approved ACR mirror, always
    # with the release's unchanged digest. Never follow authentication URLs or
    # redirects supplied by a registry. Credentials exist only in memory.
    opener = urllib.request.build_opener(NoRegistryRedirects())
    token_headers = {}
    if username:
        encoded = base64.b64encode((username + ':' + password).encode()).decode()
        token_headers['Authorization'] = 'Basic ' + encoded
    mirror = config.get('sourceRegistryMirror', '')
    if mirror and not re.fullmatch(r'[a-z0-9]+\.azurecr\.io/[a-z0-9]+(?:[._/-][a-z0-9]+)*', mirror):
        raise SetupError('sourceRegistryMirror must be an Azure registry/repository without a tag, digest or credentials.')
    registry, repository = (mirror or 'ghcr.io/mentra-community/mentra-cloud').split('/', 1)
    token_path = '/token' if registry == 'ghcr.io' else '/oauth2/token'
    token_url = 'https://' + registry + token_path + '?service=' + registry + '&scope=' + urllib.parse.quote('repository:' + repository + ':pull', safe='')
    try:
        with opener.open(urllib.request.Request(token_url, headers=token_headers), timeout=30) as response:
            data = json.load(response)
            token = data.get('token') or data['access_token']
        pin = config['sourceImage'].split('@', 1)[1]
        url = 'https://' + registry + '/v2/' + repository + '/manifests/' + pin
        headers = {'Authorization': 'Bearer ' + token,
                   'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, '
                             'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'}
        with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
            if response.headers.get('Docker-Content-Digest') != pin:
                raise SetupError('Source registry did not confirm the pinned image digest.')
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        raise SetupError('Cannot read the pinned release image. '
                         'For a private release, obtain package read access or an approved ACR mirror from Mentra and set '
                         'SOURCE_REGISTRY_USERNAME and SOURCE_REGISTRY_PASSWORD in this shell. '
                         'Run configure-mirror --mirror REGISTRY.azurecr.io/REPOSITORY to correct the distribution endpoint, then resume. '
                         'No Azure resources are changed by this image-access check.') from None
    return 'authenticated' if username else 'public'


def preflight(config, require_identity=False):
    missing = [tool for tool in ('az', 'bash', 'jq', 'curl', 'openssl') if not shutil.which(tool)]
    if missing:
        raise SetupError('Missing tools: ' + ', '.join(missing) + '. Use Azure Portal → Cloud Shell → Bash.')
    check_openssl()
    account = azure(config, 'account', 'show')
    if account['id'].lower() != config['subscriptionId'].lower() or account['tenantId'].lower() != config['tenantId'].lower():
        raise SetupError('Azure login tenant/subscription does not match this deployment. Run az login --tenant TENANT_ID.')
    if account.get('state') != 'Enabled':
        raise SetupError('Azure subscription is not enabled')
    if require_identity and not all(GUID.fullmatch(config.get(k, '')) for k in ('coreApiClientId', 'mobileClientId')):
        raise SetupError('Entra registrations are missing. Run configure-entra before install, or supply existing customer app IDs with init --config.')
    providers = {p: azure(config, 'provider', 'show', '--namespace', p)['registrationState'] for p in PROVIDERS}
    missing = [p for p, value in providers.items() if value != 'Registered']
    if missing:
        raise SetupError('Register these providers, wait for Registered, then resume: ' + ', '.join(missing))
    groups = azure(config, 'group', 'list')
    group = next((g for g in groups if g['name'].lower() == config['resourceGroup'].lower()), None)
    if group and group.get('tags', {}).get('mentraInstallerOwner') != config['resourceTags']['mentraInstallerOwner']:
        raise SetupError('Resource group already exists and is not owned by this installer. Choose a new group; automatic adoption is refused.')
    source_access = 'checked before install'
    if require_identity:
        staged = False
        if group:
            # Resume can proceed during an upstream outage once the exact
            # release is staged. An owned group alone never proves that.
            result = subprocess.run(['az', 'acr', 'manifest', 'show-metadata', '--registry', config['registryName'],
                                     '--name', 'mentra-cloud-enterprise:' + config['releaseTag'],
                                     '--subscription', config['subscriptionId'], '--output', 'json'],
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode == 0:
                try:
                    staged = json.loads(result.stdout).get('digest') == config['sourceImage'].split('@', 1)[1]
                except ValueError:
                    pass
        source_access = 'verified in customer registry' if staged else check_source_image(config)
    return {'tenant': account['tenantId'], 'subscription': account['id'], 'providers': providers,
            'sourceImageAccess': source_access,
            'resourceGroup': 'owned' if group else 'new',
            'teamsSetup': 'Run check-teams --teams-user EMPLOYEE_OBJECT_ID before installation. Guest joining needs no employee Teams license; meeting creation needs Graph consent, an organizer license and a Teams access policy.',
            'permissionNote': 'Azure Owner, or Contributor plus RBAC assignment permission, is required. Install runs ARM validation before deployment. Some policy/quota constraints are only evaluated when Azure provisions resources.'}


def environment(config):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('MENTRA_ADMIN_TOKEN', 'MENTRA_CALL_', 'TEAMS_GRAPH_'))}
    env['MENTRA_SUBSCRIPTION_ID'] = config['subscriptionId']
    env['MENTRA_EXPECTED_TENANT_ID'] = config['tenantId']
    env['MENTRA_GROUP_PREPARED'] = 'true'
    env['MENTRA_SKIP_SMOKE'] = 'true'
    env['MENTRA_REQUIRE_CALL'] = 'true'
    return env


def checkpoint(directory, state, phase, **values):
    state.update(values, phase=phase, updatedAt=now())
    write_json(directory / 'state.json', state)


def deploy(directory, config, state, hostname):
    effective = dict(config, workspaceHostname=hostname)
    write_json(directory / 'effective.config.json', effective)
    output = run(['bash', str(ROOT / 'scripts/deploy.sh'), str(directory / 'effective.config.json'),
                  str(directory / 'secrets.json')], env=environment(config))
    # Helpers may print progress before the final output; parse only the final
    # ARM outputs object, and retain an allowlist of public outputs.
    decoder = json.JSONDecoder()
    candidates = []
    for match in re.finditer(r'(?m)^\{', output):
        try:
            value, _ = decoder.raw_decode(output[match.start():])
            if 'workspaceOrigin' in value:
                candidates.append(value)
        except ValueError:
            pass
    if not candidates:
        raise SetupError('Deployment completed without recognized public outputs. Inspect Azure Portal, then resume.')
    outputs = {k: v['value'] for k, v in candidates[-1].items() if k in
               ('workspaceOrigin', 'coreOrigin', 'generatedRuntimeHostname', 'generatedCoreHostname', 'customDomainVerificationId',
                'communicationResourceId', 'registryLoginServer')}
    checkpoint(directory, state, 'deployed', outputs=outputs)
    return outputs


def dns_handoff(directory, config, state):
    app = azure(config, 'containerapp', 'show', '--name', config['runtimeName'], '--resource-group', config['resourceGroup'])
    target = app['properties']['configuration']['ingress']['fqdn']
    verification = app['properties']['customDomainVerificationId']
    host = config['workspaceHostname']
    records = [{'type': 'CNAME', 'name': host, 'value': target, 'proxy': False},
               {'type': 'TXT', 'name': 'asuid.' + host, 'value': verification}]
    write_json(directory / 'dns-records.json', {'records': records, 'instructions':
               'Ask your DNS admin to add these records with DNS-only routing. Leave all mail/MX records unchanged. Run resume --dns-ready after propagation.'})
    checkpoint(directory, state, 'awaiting_dns', dns=records)
    return records


def check_dns(config, state):
    if not shutil.which('dig'):
        raise SetupError('dig is required for DNS verification; Azure Cloud Shell includes it.')
    host = config['workspaceHostname']
    cname = run(['dig', '+short', 'CNAME', host]).strip().rstrip('.').lower()
    txt = run(['dig', '+short', 'TXT', 'asuid.' + host]).replace('"', '').strip()
    if cname != state['dns'][0]['value'].lower() or txt != state['dns'][1]['value']:
        raise SetupError('DNS records do not match dns-records.json yet. Confirm DNS-only CNAME and asuid TXT, wait, then resume.')


def configure_azure_dns(args, directory, config, state):
    if not state.get('dns') or not args.dns_zone or not args.dns_resource_group:
        raise SetupError('Complete the first install/DNS handoff, then specify --dns-zone and --dns-resource-group')
    subscription = args.dns_subscription or config['subscriptionId']
    if not GUID.fullmatch(subscription):
        raise SetupError('DNS subscription must be a UUID')
    zone_config = dict(config, subscriptionId=subscription)
    account = azure(zone_config, 'account', 'show')
    if account['tenantId'].lower() != config['tenantId'].lower():
        raise SetupError('DNS subscription must belong to this deployment tenant')
    zone = azure(zone_config, 'network', 'dns', 'zone', 'show', '--name', args.dns_zone,
                 '--resource-group', args.dns_resource_group)
    host = config['workspaceHostname']
    zone_name = zone['name'].lower().rstrip('.')
    if not host.endswith('.' + zone_name):
        raise SetupError('Customer hostname must be a subdomain of the selected Azure DNS zone')
    records = azure(zone_config, 'network', 'dns', 'record-set', 'list', '--zone-name', zone['name'],
                    '--resource-group', args.dns_resource_group)
    desired = []
    for record in state['dns']:
        name = record['name'][:-len(zone_name) - 1]
        kind = record['type']
        value = ({'CNAMERecord': {'cname': record['value']}} if kind == 'CNAME'
                 else {'TXTRecords': [{'value': [record['value']]}]})
        existing = next((r for r in records if r['name'].lower() == name.lower()
                         and r['type'].split('/')[-1].upper() == kind), None)
        if existing:
            normalized = {k.lower(): v for k, v in existing.items()}
            actual = {key: normalized.get(key.lower()) for key in value}
            if kind == 'CNAME':
                matches = (actual['CNAMERecord'] or {}).get('cname', '').rstrip('.').lower() == record['value'].lower()
            else:
                matches = any(''.join(r.get('value', [])) == record['value'] for r in actual['TXTRecords'] or [])
            if not matches:
                raise SetupError(f'Azure DNS {kind} record {name} already exists with different content; no records changed')
        else:
            # Check conflicts before creating either record. Conditional creation
            # also refuses a competing operator's record between list and PUT.
            if kind == 'CNAME' and any(r['name'].lower() == name.lower() for r in records):
                raise SetupError('Customer hostname already has another record type; no records changed')
            if kind == 'TXT' and any(r['name'].lower() == name.lower() and r['type'].split('/')[-1].upper() == 'CNAME' for r in records):
                raise SetupError('Verification hostname already has a CNAME record; no records changed')
            desired.append((name, kind, value))
    for name, kind, value in desired:
        body = {'properties': dict(value, TTL=300, metadata={'mentraInstallerOwner': state['owner']})}
        run(['az', 'rest', '--method', 'put', '--url', 'https://management.azure.com' + zone['id'] + '/' + kind + '/' + name + '?api-version=2018-05-01',
             '--headers', 'If-None-Match=*', '--body', json.dumps(body), '--output', 'none'])
    emit(args, {'status': 'dns_records_configured', 'next': 'Wait for propagation, then resume --dns-ready. Existing records and mail settings were preserved.'})


def install(args, directory, config, state):
    checks = preflight(config, require_identity=True)
    env = environment(config)
    secrets = directory / 'secrets.json'
    if not secrets.exists():
        if state['secretsCreated']:
            raise SetupError('Restore original secrets; regeneration is refused')
        run(['bash', str(ROOT / 'scripts/generate-private-secrets.sh'), str(secrets)], env=env)
    checkpoint(directory, state, state['phase'], secretsCreated=True, checks=checks)
    run(['bash', str(ROOT / 'scripts/deploy.sh'), '--validate-only', str(directory / 'deployment.config.json'), str(secrets)], env=env)
    if checks['resourceGroup'] == 'new':
        azure(config, 'group', 'create', '--name', config['resourceGroup'], '--location', config['location'],
              '--tags', 'mentraInstallerOwner=' + state['owner'], 'mentraDeploymentId=' + config['deploymentId'])
    domain_verified = state.get('domainVerified', False)
    checkpoint(directory, state, 'deploying', configHash=digest(directory / 'deployment.config.json'))
    if config['workspaceHostname']:
        if not state.get('dns'):
            deploy(directory, config, state, '')
            records = dns_handoff(directory, config, state)
            emit(args, {'status': 'awaiting_dns', 'records': records, 'next': 'Add DNS records, then resume --dns-ready.'})
            return
        if not args.dns_ready and not domain_verified:
            checkpoint(directory, state, 'awaiting_dns')
            emit(args, {'status': 'awaiting_dns', 'records': state['dns'], 'next': 'resume --dns-ready'})
            return
        check_dns(config, state)
    deploy(directory, config, state, config['workspaceHostname'])
    if config['workspaceHostname']:
        checkpoint(directory, state, 'deployed', domainVerified=True)
    verify(args, directory, config, state)


def verify(args, directory, config, state):
    if state.get('upgrade') and state['phase'] not in ('deployed', 'infrastructure_verified'):
        raise SetupError('Selected upgrade has not completed deployment. Run resume with the target package before verify.')
    origin = state.get('outputs', {}).get('workspaceOrigin')
    if not origin:
        raise SetupError('No deployment outputs saved. Run resume first.')
    if config['workspaceHostname'] and (not state.get('domainVerified') or origin != 'https://' + config['workspaceHostname']):
        raise SetupError('Final customer domain is not deployed yet. Complete DNS and run resume --dns-ready.')
    run(['bash', str(ROOT / 'scripts/smoke-test.sh'), origin], env=environment(config))
    # Azure resource administrators need not have Entra license-read rights.
    # Check when possible, but report an unknown result rather than blocking
    # working Core/guest joining or interpreting permission errors as no license.
    try:
        teams = inspect_teams(args, config)
    except SetupError as exc:
        teams = {'teamsSubscription': 'unknown', 'verifiedMeetingCreation': False,
                 'next': str(exc)}
    checkpoint(directory, state, 'infrastructure_verified', verifiedAt=now())
    checkpoint(directory, state, state['phase'], teamsSetupChecks=teams)
    emit(args, {'status': 'infrastructure_verified', 'workspace': origin,
               'teamsSetup': teams,
               'remaining': 'Assign employees in Entra, validate a licensed Teams account and guest fallback on the Mentra App, submit/retrieve feedback. Server smoke tests do not certify device or Teams policy behavior.'})


def inspect_teams(args, config):
    # Installer-operator Graph access only; do not grant the Runtime license
    # inventory permissions or infer Teams identity from an M365 product name.
    # --tenant and --subscription are mutually exclusive for this CLI command.
    guidance = ('Cannot inspect Teams licenses. Ask an Entra administrator with license-read permission to run '
                'check-teams --teams-user EMPLOYEE_OBJECT_ID in this tenant; no license or permission was changed.')
    graph_tenant = config.get('teamsGraphTenantId') or config['tenantId']
    if graph_tenant.lower() != config['tenantId'].lower():
        raise SetupError('Teams Graph must use the deployment Entra tenant for this installer profile. Correct teamsGraphTenantId before checking licenses; another tenant inventory would not verify employee access.')
    try:
        profile = json.loads(run(['az', 'account', 'get-access-token', '--tenant', config['tenantId'],
                                  '--resource-type', 'ms-graph', '--output', 'json']))
        token = profile['accessToken']
    except (SetupError, ValueError, KeyError):
        raise SetupError(guidance) from None
    def graph(path):
        request = urllib.request.Request('https://graph.microsoft.com/v1.0/' + path,
                                        headers={'Authorization': 'Bearer ' + token})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except (OSError, http.client.HTTPException, ValueError):
            raise SetupError(guidance) from None
    inventory = graph('subscribedSkus')['value']
    teams_products = [s for s in inventory if s.get('capabilityStatus') == 'Enabled'
                      and any(p.get('servicePlanName') == 'TEAMS1' for p in s.get('servicePlans', []))]
    identities = []
    for label, user in (('guest meeting organizer', config.get('teamsGraphOrganizerId')),
                        ('test employee', getattr(args, 'teams_user', None))):
        if not user:
            continue
        licensed = graph('users/' + urllib.parse.quote(user, safe='') + '/licenseDetails')['value']
        has_teams = any(p.get('servicePlanName') == 'TEAMS1' and p.get('provisioningStatus') == 'Success'
                        for sku in licensed for p in sku.get('servicePlans', []))
        identities.append({'role': label, 'teamsLicense': 'enabled' if has_teams else 'missing_or_provisioning',
                           'next': ('Validate meeting creation and ACS exchange; license alone does not prove policy/consent.' if has_teams
                                    else 'Assign a license that includes Microsoft Teams and wait for provisioning. Unlicensed employees may join as guests; guest meeting creation still needs a licensed organizer.')})
    checks = {'teamsSubscription': 'available' if teams_products else 'missing', 'identities': identities,
              'meetingCreationClientConfigured': bool(config.get('teamsGraphClientId')),
              'guestOrganizerConfigured': bool(config.get('teamsGraphOrganizerId')),
              'next': ('Confirm employee/organizer license assignments, Graph OnlineMeetings.ReadWrite.All admin consent, and the Teams application access policy. Joining and creating meetings have different requirements.' if teams_products
                       else 'In Microsoft 365 admin center → Marketplace, choose a plan that includes Teams, then assign it to the intended employee and guest organizer. Business Basic without Teams is insufficient. Guest joining is still available; guest meeting creation needs a licensed organizer.'),
              'verifiedMeetingCreation': False}
    return checks


def check_teams(args, directory, config, state):
    checks = inspect_teams(args, config)
    checkpoint(directory, state, state['phase'], teamsSetupChecks=checks)
    emit(args, checks)


def execute_admin_script(config, current, owner, script):
    import pty
    code = base64.b64encode(script).decode()
    if not GUID.fullmatch(owner):
        raise SetupError('Invalid saved deployment owner')
    remote = '/app/cloud-v2/packages/core/mentra-admin-' + owner + '.ts'
    command = f'''bun -e "console.log('MENTRA_SCRIPT_READY'); const rl=require('node:readline').createInterface({{input:process.stdin}}); const chunks=[]; const encoded=await new Promise(resolve=>rl.on('line',line=>{{if(line==='MENTRA_SCRIPT_END')resolve(chunks.join(''));else chunks.push(line)}})); rl.close(); await Bun.write('{remote}',Buffer.from(encoded,'base64')); process.argv=['bun','{remote}','{owner}']; await import('{remote}')"'''
    master, slave = pty.openpty()
    try:
        process = subprocess.Popen(['az', 'containerapp', 'exec', '--name', config['coreName'],
                                '--resource-group', config['resourceGroup'], '--subscription', config['subscriptionId'],
                                '--revision', current['properties']['latestReadyRevisionName'],
                                '--command', command], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
        import time
        import select
        import signal
        start = time.monotonic()
        stdout = b''
        sent = False
        while time.monotonic() - start < 120:
            if select.select([process.stdout], [], [], 1)[0]:
                chunk = os.read(process.stdout.fileno(), 65536)
                stdout += chunk
                if not sent and b'MENTRA_SCRIPT_READY' in stdout:
                    # Both the local PTY and Azure's remote terminal may
                    # have canonical input limits. Keep each line <4 KiB.
                    payload = '\n'.join(code[i:i + 2000] for i in range(0, len(code), 2000)) + '\nMENTRA_SCRIPT_END\n'
                    remaining = payload.encode()
                    while remaining:
                        remaining = remaining[os.write(master, remaining):]
                    sent = True
                if b'MENTRA_ADMIN_END' in stdout or not chunk:
                    break
            if process.poll() is not None:
                break
        # Azure's stdin thread can outlive a finished remote command.
        # Terminate this invocation's process group, never other CLI work.
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                process.terminate()
        process.communicate(timeout=5)
        result = subprocess.CompletedProcess([], process.returncode, stdout.decode(), '')
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise SetupError('Admin bootstrap timed out. Retry to retrieve the same saved key; provider output withheld.') from None
    finally:
        os.close(slave)
        os.close(master)
    return result


def bootstrap_admin(args, directory, config, state):
    if not state.get('outputs', {}).get('coreOrigin'):
        raise SetupError('Deploy Core before creating its administrator key')
    output = directory / 'admin-key.json'
    if output.exists() and (output.is_symlink() or output.stat().st_mode & 0o077):
        raise SetupError('Administrator key file must be owner-only and not a symlink')
    current = azure(config, 'containerapp', 'show', '--name', config['coreName'], '--resource-group', config['resourceGroup'])
    if not output.exists():
        result = execute_admin_script(config, current, state['owner'], (ROOT / 'installer/admin-key.ts').read_bytes())
        match = re.search(r'MENTRA_ADMIN_BEGIN(.*?)MENTRA_ADMIN_END', result.stdout, re.S)
        if not match:
            raise SetupError('Core admin bootstrap did not return a credential. Check the selected Core revision; raw output withheld.')
        credential = json.loads(match.group(1))
        if not re.fullmatch(r'[0-9A-HJKMNP-TV-Z]{26}', credential.get('id', '')) or not credential.get('value', '').startswith('msk_local_'):
            raise SetupError('Core returned an invalid administrator credential')
        write_json(output, credential)
    else:
        # Previous installer versions left a plaintext share cache. Remove it
        # even when the protected local key allows skipping key creation.
        cleanup = b'const fs=require("node:fs");const p="/mnt/core-attachments/operator/admin-"+process.argv[2]+".json";if(fs.existsSync(p))fs.unlinkSync(p);console.log("MENTRA_ADMIN_END");'
        result = execute_admin_script(config, current, state['owner'], cleanup)
        if 'MENTRA_ADMIN_END' not in result.stdout:
            raise SetupError('Legacy admin credential cleanup did not complete; retry bootstrap-admin')
    credential = read_json(output)
    email = 'api-key@' + credential['id'] + '.local'
    values = next((entry.get('value', '') for entry in current['properties']['template']['containers'][0]['env']
                   if entry['name'] == 'CLOUD_CORE_ADMIN_EMAILS'), '')
    emails = sorted(set(filter(None, (values + ',' + config.get('coreAdminEmails', '') + ',' + email).split(','))))
    allowlist = ','.join(emails)
    # Preserve the setting in installer configuration so later resume retains it.
    update_configuration(directory, config, state, coreAdminEmails=allowlist)
    azure(config, 'containerapp', 'update', '--name', config['coreName'], '--resource-group', config['resourceGroup'],
          '--set-env-vars', 'CLOUD_CORE_ADMIN_EMAILS=' + allowlist)
    emit(args, {'status': 'admin_key_created', 'file': str(output),
                'next': 'Store this credential in your secret manager. Wait for the new Core revision, then use it as MENTRA_ADMIN_TOKEN for report retrieval.'})
def configure_entra(args, directory, config, state):
    preflight(config)
    if state.get('outputs') or state.get('configHash'):
        raise SetupError('Do not replace identity registrations after deployment. Reconcile existing IDs through the standalone helper.')
    argv = ['bash', str(ROOT / 'scripts/configure-entra.sh'), '--core-name', config['displayName'] + ' Core',
            '--mobile-name', config['displayName'] + ' Mobile']
    for field, flag in (('coreApiClientId', '--core-client-id'), ('mobileClientId', '--mobile-client-id')):
        if config.get(field):
            argv += [flag, config[field]]
    if args.grant_admin_consent:
        argv.append('--grant-admin-consent')
    result = json.loads(run(argv, env=environment(config)))
    if result['tenantId'].lower() != config['tenantId'].lower():
        raise SetupError('Entra helper returned another tenant')
    write_json(directory / 'identity.pending.json', dict(previousBinding=state['binding'],
               previousConfigHash=digest(directory / 'deployment.config.json'),
               coreApiClientId=result['coreApiClientId'], mobileClientId=result['mobileClientId']))
    recover_identity(directory, config, state)
    write_json(directory / 'entra.json', result)
    emit(args, {'status': 'configured', 'next': 'Assign employees to the Mobile enterprise application in Entra. Teams Graph creation needs customer app permissions and a Teams application access policy; see handoff documentation.'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('init', 'preflight', 'plan', 'configure-entra', 'configure-mirror', 'configure-azure-dns', 'check-teams', 'install', 'resume', 'status', 'verify', 'bootstrap-admin', 'upgrade', 'diagnostics'))
    parser.add_argument('--directory', default='./mentra-setup', help='Persistent state and secret directory outside the installer package')
    parser.add_argument('--config', help='JSON answers for init; otherwise edit deployment.config.json')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--dns-ready', action='store_true')
    parser.add_argument('--grant-admin-consent', action='store_true')
    parser.add_argument('--mirror', help='Approved Azure registry/repository for configure-mirror; release digest stays pinned')
    parser.add_argument('--dns-zone', help='Existing Azure DNS zone for configure-azure-dns')
    parser.add_argument('--dns-resource-group', help='Resource group containing the Azure DNS zone')
    parser.add_argument('--dns-subscription', help='DNS subscription, if different; must belong to the same Entra tenant')
    parser.add_argument('--teams-user', help='Employee object ID or UPN for check-teams; no license assignment is performed')
    parser.add_argument('--backup-confirmed', action='store_true', help='Confirm database, attachment and original-secret backups before upgrade')
    parser.add_argument('--previous-package', help='Retained original package directory for explicit upgrade')
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    try:
        if directory.is_relative_to(ROOT):
            raise SetupError('Keep setup state outside the extracted installer package; use --directory ../mentra-setup.')
        with locked(directory):
            if args.command == 'init':
                init(args, directory)
                return
            if args.command == 'upgrade':
                upgrade(args, directory)
                return
            config, state, release = load(directory)
            if args.command == 'preflight':
                emit(args, preflight(config))
            elif args.command == 'plan':
                emit(args, {'deployment': config['deploymentId'], 'subscription': config['subscriptionId'], 'tenant': config['tenantId'],
                            'region': config['location'], 'group': config['resourceGroup'], 'image': release['sourceImage'],
                            'resources': ['Basic ACR', 'Container Apps environment, Core + Runtime', 'Managed identity + AcrPull',
                                          'Azure Communication Services', 'Cosmos DB MongoDB serverless', 'Azure Files report attachments'],
                            'billing': 'These resources incur Azure charges. Review Azure Pricing Calculator and company budget before install.',
                            'network': 'Authenticated public HTTPS ingress and Cosmos endpoint; this profile does not provision private endpoints.',
                            'handoffs': ['DNS admin (custom hostname)', 'Entra admin consent and employee assignment',
                                         'Microsoft 365 admin: Teams license for employees using Teams identity and the guest meeting organizer; check-teams explains missing licenses',
                                         'Teams admin: Graph application permission and application access policy for meeting creation'],
                            'next': 'configure-entra, check-teams --teams-user EMPLOYEE_OBJECT_ID, then install. Plan performs no Azure writes.'})
            elif args.command == 'configure-entra':
                configure_entra(args, directory, config, state)
            elif args.command == 'configure-mirror':
                configure_mirror(args, directory, config, state)
            elif args.command == 'configure-azure-dns':
                configure_azure_dns(args, directory, config, state)
            elif args.command == 'check-teams':
                check_teams(args, directory, config, state)
            elif args.command in ('install', 'resume'):
                install(args, directory, config, state)
            elif args.command == 'verify':
                verify(args, directory, config, state)
            elif args.command == 'bootstrap-admin':
                bootstrap_admin(args, directory, config, state)
            elif args.command == 'status':
                emit(args, state)
            else:
                # No Azure logs, environment dump, config secrets, reports,
                # account tokens, or customer employee identifiers are exported.
                value = {k: state.get(k) for k in ('schemaVersion', 'deploymentId', 'phase', 'updatedAt', 'verifiedAt')}
                value['release'] = release['releaseTag']
                value['checks'] = state.get('checks', {})
                write_json(directory / 'diagnostics.json', value)
                emit(args, {'file': str(directory / 'diagnostics.json'), 'next': 'Review before sharing. No automatic upload.'})
    except (SetupError, KeyError, TypeError, ValueError, OSError) as exc:
        print(f'Setup stopped: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
