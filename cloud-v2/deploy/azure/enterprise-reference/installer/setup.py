#!/usr/bin/env python3
"""Portable, resumable Azure installer. Python standard library only."""
import argparse
import base64
import contextlib
import datetime
import getpass
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
             'Microsoft.Communication', 'Microsoft.DocumentDB', 'Microsoft.Storage', 'Microsoft.KeyVault')
BINDING_KEYS = ('subscriptionId', 'tenantId', 'resourceGroup', 'registryName', 'location',
                'workspaceHostname', 'environmentName', 'runtimeName', 'coreName', 'coreIdentityName', 'runtimeIdentityName',
                'communicationName', 'mongoAccountName', 'reportStorageAccountName', 'deploymentName',
                'resourceTags', 'coreApiClientId', 'mobileClientId', 'keyVaultName')
# Key Vault holds every original secret; nothing secret is stored locally.
ADMIN_KEY_SECRET = 'mentra-admin-key'
# Teams settings may be added after installation; resume rolls them out.
UPDATABLE_KEYS = {'sourceRegistryMirror', 'coreAdminEmails', 'teamsGraphTenantId', 'teamsGraphClientId',
                  'teamsGraphOrganizerId'}
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


def run(argv, env=None, capture=True, explain=False):
    # Provider output can contain credentials, so it is withheld by default.
    # The deployment scripts take no secrets (keys live in Key Vault), so with
    # explain=True their error tail is shown, with any registry password removed.
    result = subprocess.run(argv, env=env, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE)
    if result.returncode:
        name = f'{Path(argv[1] if argv[0] == "bash" and len(argv) > 1 else argv[0]).name}'
        if explain:
            lines = [line for line in (result.stderr or '').splitlines() if line.strip() and 'WARNING' not in line]
            detail = '\n'.join(lines[-12:])
            for secret in filter(None, (os.environ.get('SOURCE_REGISTRY_PASSWORD'), (env or {}).get('SOURCE_REGISTRY_PASSWORD'))):
                detail = detail.replace(secret, '***')
            raise SetupError(f'{name} failed (exit {result.returncode}):\n{detail or "(no error output)"}')
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
    required = {'setup.sh', 'installer/setup.py', 'installer/admin-key.ts', 'main.bicep', 'bootstrap.bicep', 'access.bicep',
                'deployment.config.example.json', 'scripts/deploy.sh', 'scripts/configure-entra.sh',
                'scripts/ensure-vault-secrets.sh', 'scripts/import-runtime-image.sh', 'scripts/smoke-test.sh'}
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


def check_upgradable(config):
    # Pre-release installers kept the signing keys on disk and have no Key Vault
    # or per-app identities. Their deployments are reinstalled, not upgraded.
    if not all(config.get(k) for k in ('keyVaultName', 'coreIdentityName', 'runtimeIdentityName')):
        raise SetupError('This deployment was made by a pre-release installer that kept its keys outside Key Vault, '
                         'and it cannot be upgraded. Install a new deployment with this package instead.')


def select_upgrade(args, directory):
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
    check_upgradable(config)
    if state['phase'] != 'infrastructure_verified':
        raise SetupError('Verify the current deployment with its original package before upgrade')
    target = check_release()
    if release_version(target) < release_version(old_release):
        raise SetupError('Release downgrade is refused: image rollback does not roll back database migrations')
    if target['releaseTag'] == old_release['releaseTag'] and target['sourceImage'] != old_release['sourceImage']:
        raise SetupError('A coordinated release identity cannot change its image digest')
    if digest(ROOT / 'release.json') == state['releaseHash']:
        raise SetupError('Target installer is already selected. Use resume or verify')
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
    return ({'status': 'upgrade_ready', **summary,
                'next': 'Use this target package to run resume, then verify employee sign-in, Calls and report retrieval. Original keys and resource bindings are retained. Retain both packages and your database/files backup.'})


def recover_configuration(directory, config, state):
    journal = directory / 'configuration.pending.json'
    if not journal.exists():
        return
    pending = read_json(journal)
    previous = pending['previousConfig']
    changes = pending['changes']
    if not changes or set(changes) - UPDATABLE_KEYS:
        raise SetupError('Unsupported pending configuration update')
    updated = dict(previous, **changes)
    # Only the distribution endpoint, administrator allowlist and Teams Graph
    # settings can change. Never adopt resource bindings, release pins, or other edits.
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
    return ({'status': 'mirror_configured', 'image': config['sourceImage'],
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
        raise SetupError('Initialization accepts only documented configuration fields; secrets are created in Key Vault.')
    interactive = sys.stdin.isatty()
    account = signed_in_account() if interactive else {}
    if account:
        print(f"Signed in to Azure as {account.get('user', {}).get('name', 'unknown')}, "
              f"subscription {account.get('name')} ({account.get('id')}).")
    # Defaults come from the current Azure login only when a person can review them.
    prompts = [('subscriptionId', 'Azure subscription ID', account.get('id', '')),
               ('tenantId', 'Microsoft Entra tenant ID', account.get('tenantId', '')),
               ('displayName', 'Company name, as employees will see it', ''),
               ('deploymentId', 'Short deployment name (lowercase letters, digits, hyphens)', None),
               ('location', 'Azure region', 'westus2'),
               ('workspaceHostname', 'Custom web address, e.g. mentra.example.com (Enter to use an Azure address)', '')]
    for key, label, default in prompts:
        if key == 'deploymentId' and default is None:
            default = suggested_deployment_id(inputs.get('displayName', ''))
        if key == 'tenantId' and interactive and inputs.get('subscriptionId') not in ('', account.get('id')):
            # Suggest the tenant of the subscription actually chosen.
            chosen = subprocess.run(['az', 'account', 'show', '--subscription', inputs['subscriptionId'], '--query', 'tenantId',
                                     '--output', 'tsv'], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            default = chosen.stdout.strip() if chosen.returncode == 0 else ''
        if key in inputs:
            continue
        if not interactive:
            if key in ('location', 'workspaceHostname'):
                inputs[key] = default
            else:
                raise SetupError(f'{key} is required in --config for unattended initialization')
        else:
            inputs[key] = input(label + (f' [{default}]' if default else '') + ': ').strip() or (default or '')
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
                    coreIdentityName=f'id-{name}-core', runtimeIdentityName=f'id-{name}-runtime',
                    communicationName=f'{name}-acs-{ownership[:8]}',
                    keyVaultName='kv' + name.replace('-', '')[:14] + ownership.replace('-', '')[:8],
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
    return {'status': 'initialized', 'directory': str(directory), 'next': 'Run setup.sh to continue.'}


def validate_resource_names(config):
    mirror = config.get('sourceRegistryMirror', '')
    if not isinstance(mirror, str) or (mirror and not re.fullmatch(r'[a-z0-9]+\.azurecr\.io/[a-z0-9]+(?:[._/-][a-z0-9]+)*', mirror)):
        raise SetupError('Invalid Azure source registry mirror')
    patterns = {'registryName': r'[a-z0-9]{5,50}', 'resourceGroup': r'[a-zA-Z0-9_-]{1,90}',
                'runtimeName': r'[a-z][a-z0-9-]{0,29}[a-z0-9]', 'coreName': r'[a-z][a-z0-9-]{0,29}[a-z0-9]',
                'environmentName': r'[a-zA-Z0-9-]{2,60}', 'coreIdentityName': r'[a-zA-Z0-9_-]{2,128}',
                'runtimeIdentityName': r'[a-zA-Z0-9_-]{2,128}',
                'communicationName': r'[a-zA-Z0-9-]{2,63}', 'location': r'[a-z0-9]{2,40}',
                'keyVaultName': r'[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]'}
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
    output = run(['bash', str(ROOT / 'scripts/deploy.sh'), str(directory / 'effective.config.json')], env=environment(config),
                 explain=True)
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
                'communicationResourceId', 'registryLoginServer', 'keyVaultName')}
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
    return {'status': 'dns_records_configured', 'next': 'Wait for propagation, then resume --dns-ready. Existing records and mail settings were preserved.'}


def ensure_group(config, state, checks=None):
    checks = checks or preflight(config)
    if checks['resourceGroup'] == 'new':
        azure(config, 'group', 'create', '--name', config['resourceGroup'], '--location', config['location'],
              '--tags', 'mentraInstallerOwner=' + state['owner'], 'mentraDeploymentId=' + config['deploymentId'])
    return checks


def install(args, directory, config, state):
    # Returns the resulting status; signing keys are created in Key Vault by deploy.sh.
    if state['phase'] == 'deployed' and (not config['workspaceHostname'] or state.get('domainVerified')):
        # The final deployment already finished; only its verification remained.
        return verify(args, directory, config, state)
    checks = preflight(config, require_identity=True)
    checkpoint(directory, state, state['phase'], checks=checks)
    run(['bash', str(ROOT / 'scripts/deploy.sh'), '--validate-only', str(directory / 'deployment.config.json')],
        env=environment(config), explain=True)
    ensure_group(config, state, checks)
    domain_verified = state.get('domainVerified', False)
    checkpoint(directory, state, 'deploying', configHash=digest(directory / 'deployment.config.json'))
    if config['workspaceHostname']:
        if not state.get('dns'):
            deploy(directory, config, state, '')
            records = dns_handoff(directory, config, state)
            return {'status': 'awaiting_dns', 'records': records, 'next': 'Add DNS records, then resume --dns-ready.'}
        if not args.dns_ready and not domain_verified:
            checkpoint(directory, state, 'awaiting_dns')
            return {'status': 'awaiting_dns', 'records': state['dns'], 'next': 'resume --dns-ready'}
        check_dns(config, state)
    deploy(directory, config, state, config['workspaceHostname'])
    if config['workspaceHostname']:
        checkpoint(directory, state, 'deployed', domainVerified=True)
    return verify(args, directory, config, state)


def verify(args, directory, config, state):
    if state.get('upgrade') and state['phase'] not in ('deployed', 'infrastructure_verified'):
        raise SetupError('Selected upgrade has not completed deployment. Run resume with the target package before verify.')
    origin = state.get('outputs', {}).get('workspaceOrigin')
    if not origin:
        raise SetupError('No deployment outputs saved. Run resume first.')
    if config['workspaceHostname'] and (not state.get('domainVerified') or origin != 'https://' + config['workspaceHostname']):
        raise SetupError('Final customer domain is not deployed yet. Complete DNS and run resume --dns-ready.')
    run(['bash', str(ROOT / 'scripts/smoke-test.sh'), origin], env=environment(config), explain=True)
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
    return {'status': 'infrastructure_verified', 'workspace': origin,
            'teamsSetup': teams,
            'remaining': 'Assign employees in Entra, validate a licensed Teams account and guest fallback on the Mentra App, submit/retrieve feedback. Server smoke tests do not certify device or Teams policy behavior.'}


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
    return checks


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
    # The administrator key lives in Key Vault. Core's own journal returns the
    # same key if this is retried before the Key Vault write completes.
    if not state.get('outputs', {}).get('coreOrigin'):
        raise SetupError('Deploy Core before creating its administrator key')
    current = azure(config, 'containerapp', 'show', '--name', config['coreName'], '--resource-group', config['resourceGroup'])
    saved = vault_get(config, ADMIN_KEY_SECRET)
    if saved:
        credential = {'id': (saved.get('tags') or {}).get('keyId', ''), 'value': saved.get('value', '')}
    else:
        result = execute_admin_script(config, current, state['owner'], (ROOT / 'installer/admin-key.ts').read_bytes())
        match = re.search(r'MENTRA_ADMIN_BEGIN(.*?)MENTRA_ADMIN_END', result.stdout, re.S)
        if not match:
            raise SetupError('Core admin bootstrap did not return a credential. Check the selected Core revision; raw output withheld.')
        credential = json.loads(match.group(1))
    if not re.fullmatch(r'[0-9A-HJKMNP-TV-Z]{26}', credential.get('id', '')) or not credential.get('value', '').startswith('msk_local_'):
        raise SetupError('Core returned an invalid administrator credential')
    if not saved:
        vault_set(config, ADMIN_KEY_SECRET, credential['value'], keyId=credential['id'])
    email = 'api-key@' + credential['id'] + '.local'
    values = next((entry.get('value', '') for entry in current['properties']['template']['containers'][0]['env']
                   if entry['name'] == 'CLOUD_CORE_ADMIN_EMAILS'), '')
    emails = sorted(set(filter(None, (values + ',' + config.get('coreAdminEmails', '') + ',' + email).split(','))))
    allowlist = ','.join(emails)
    if allowlist != values:
        # Preserve the setting in installer configuration so later resume retains it.
        update_configuration(directory, config, state, coreAdminEmails=allowlist)
        azure(config, 'containerapp', 'update', '--name', config['coreName'], '--resource-group', config['resourceGroup'],
              '--set-env-vars', 'CLOUD_CORE_ADMIN_EMAILS=' + allowlist)
    check_admin_access(state['outputs']['coreOrigin'], credential['value'])
    checkpoint(directory, state, state['phase'], adminKey={'keyVault': config['keyVaultName'], 'secret': ADMIN_KEY_SECRET,
                                                            'keyId': credential['id'], 'verifiedAt': now()})
    return {'status': 'admin_key_ready', 'keyVault': config['keyVaultName'], 'secret': ADMIN_KEY_SECRET,
            'read': admin_key_command(config),
            'next': 'Use this key as MENTRA_ADMIN_TOKEN to retrieve feedback reports.'}


def admin_key_command(config):
    return (f"az keyvault secret show --vault-name {config['keyVaultName']} --name {ADMIN_KEY_SECRET} "
            f"--subscription {config['subscriptionId']} --query value --output tsv")


def check_admin_access(core_origin, token, attempts=30, wait=10):
    # Core restarts after an allowlist change; the key must retrieve reports.
    import time
    request = urllib.request.Request(core_origin.rstrip('/') + '/api/admin/reports?limit=1',
                                     headers={'Authorization': 'Bearer ' + token})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if isinstance(json.load(response).get('reports'), list):
                    return
        except (OSError, http.client.HTTPException, ValueError, AttributeError):
            pass
        if attempt + 1 < attempts:
            time.sleep(wait)
    raise SetupError('The administrator key could not retrieve reports from Core yet. Wait for the Core revision, then run setup again.')


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
    return {'status': 'configured', 'next': 'Assign employees to the Mobile enterprise application in Entra. Teams Graph creation needs customer app permissions and a Teams application access policy; see handoff documentation.'}


# ---------------------------------------------------------------------------
# Guided setup: one command that installs, resumes and upgrades.
# ---------------------------------------------------------------------------

GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'
DEFAULT_ACCESS_ROLE = '00000000-0000-0000-0000-000000000000'
MEETINGS_PERMISSION = 'OnlineMeetings.ReadWrite.All'
VAULT_RETRIES = 30
RETRY_SECONDS = 10


class GraphError(SetupError):
    def __init__(self, code):
        super().__init__(f'Microsoft Graph request failed (HTTP {code}). Provider output withheld.')
        self.code = code


def signed_in_account():
    result = subprocess.run(['az', 'account', 'show', '--output', 'json'], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        return json.loads(result.stdout) if result.returncode == 0 else {}
    except ValueError:
        return {}


def suggested_deployment_id(display_name):
    slug = re.sub(r'^[^a-z]+', '', re.sub(r'[^a-z0-9]+', '-', display_name.lower()).strip('-'))
    candidate = (slug[:12].rstrip('-') or 'company') + '-mentra'
    return candidate if re.fullmatch(r'[a-z][a-z0-9-]{2,17}[a-z0-9]', candidate) else 'company-mentra'


def install_home():
    # Packages from the install command live in <home>/packages/<version>/.
    return ROOT.parents[2] if ROOT.parents[1].name == 'packages' else None


def default_directory():
    home = install_home()
    if not home:
        return Path('mentra-state')
    # Packages before 3.3.0-dev.712 defaulted to mentra-setup; never start a second deployment.
    if not (home / 'mentra-state/state.json').exists() and (home / 'mentra-setup/state.json').exists():
        return home / 'mentra-setup'
    return home / 'mentra-state'


def setup_command():
    home = install_home()
    return f'cd {home} && ./mentra-private-cloud/setup.sh' if home else f'{ROOT / "setup.sh"}'


def vault_az(config, *args, missing_ok=False):
    # New role assignments can take minutes to reach Key Vault; retry only then.
    import time
    argv = ['az', 'keyvault', 'secret', *args, '--vault-name', config['keyVaultName'],
            '--subscription', config['subscriptionId'], '--output', 'json']
    granted = False
    for attempt in range(VAULT_RETRIES):
        result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0:
            return json.loads(result.stdout or 'null')
        if missing_ok and 'SecretNotFound' in result.stderr:
            return None
        if 'Forbidden' not in result.stderr or attempt + 1 == VAULT_RETRIES:
            break
        if not granted:
            grant_vault_access(config)
            granted = True
        time.sleep(RETRY_SECONDS)
    raise SetupError(f"Key Vault {config['keyVaultName']} refused the request. Setup gave you the Key Vault Secrets "
                     'Officer role, which can take a few minutes to apply; run setup again shortly. Provider output withheld.')


def grant_vault_access(config):
    # Each deploy gives its runner Key Vault access. An administrator resuming a
    # deployment someone else finished gets it here, from the same template.
    with tempfile.TemporaryDirectory(prefix='mentra-config-') as temp:
        path = Path(temp) / 'deployment.config.json'
        write_json(path, config)
        run(['bash', str(ROOT / 'scripts/deploy.sh'), '--bootstrap-only', str(path)], env=environment(config), explain=True)


def vault_get(config, name):
    return vault_az(config, 'show', '--name', name, missing_ok=True)


def vault_set(config, name, value, **tags):
    # Secret values travel through a private file, never a command-line argument.
    with tempfile.TemporaryDirectory(prefix='mentra-secret-') as temp:
        path = Path(temp) / 'value'
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
        extra = ['--tags', *[f'{k}={v}' for k, v in tags.items()]] if tags else []
        vault_az(config, 'set', '--name', name, '--file', str(path), '--encoding', 'utf-8',
                 '--content-type', 'text/plain', '--query', 'id', *extra)


_GRAPH_TOKENS = {}


def graph(config, method, path, body=None, missing_ok=False):
    tenant = config['tenantId']
    if tenant not in _GRAPH_TOKENS:
        try:
            _GRAPH_TOKENS[tenant] = json.loads(run(['az', 'account', 'get-access-token', '--tenant', tenant,
                                                    '--resource-type', 'ms-graph', '--output', 'json']))['accessToken']
        except (SetupError, ValueError, KeyError):
            raise GraphError('token') from None
    url = path if path.startswith('https://') else 'https://graph.microsoft.com/v1.0/' + path
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method,
                                     headers={'Authorization': 'Bearer ' + _GRAPH_TOKENS[tenant],
                                              'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        raise GraphError(error.code) from None
    except (OSError, http.client.HTTPException, ValueError):
        raise GraphError('network') from None


def odata(value):
    # An OData string literal; a quote inside it is doubled, as in O'Reilly.
    return "'" + str(value).replace("'", "''") + "'"


def graph_filter(collection, expression, select=''):
    query = '$filter=' + urllib.parse.quote(expression, safe="'=")
    return f'{collection}?{query}' + (f'&$select={select}' if select else '')


def service_principal(config, app_id, select='id,appRoles,appRoleAssignmentRequired'):
    found = graph(config, 'GET', graph_filter('servicePrincipals', f"appId eq {odata(app_id)}", select))['value']
    return found[0] if found else None


# --- Plan: Azure's own what-if preview, summarized -------------------------

FRIENDLY_TYPES = {
    'Microsoft.App/containerApps': 'Container App', 'Microsoft.App/managedEnvironments': 'Container Apps environment',
    'Microsoft.App/managedEnvironments/managedCertificates': 'TLS certificate',
    'Microsoft.App/managedEnvironments/storages': 'Report storage mount',
    'Microsoft.DocumentDB/databaseAccounts': 'Cosmos DB database', 'Microsoft.Storage/storageAccounts': 'Storage account',
    'Microsoft.Storage/storageAccounts/fileServices': 'File service',
    'Microsoft.Storage/storageAccounts/fileServices/shares': 'Report file share',
    'Microsoft.Communication/communicationServices': 'Azure Communication Services',
    'Microsoft.ContainerRegistry/registries': 'Container registry', 'Microsoft.KeyVault/vaults': 'Key Vault',
    'Microsoft.ManagedIdentity/userAssignedIdentities': 'Managed identity',
    'Microsoft.Authorization/roleAssignments': 'Role assignment'}


ROLE_PURPOSES = {'7f951dda-4ed3-4680-a7ca-43fe172d538d': 'apps can pull the image',
                 '4633458b-17de-408a-b874-0445c86b69e6': 'an app can read one of its own secrets',
                 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7': 'you can manage Key Vault secrets'}


def _resource(change):
    tail = change['resourceId'].split('/providers/')[-1].split('/')
    kind = '/'.join(tail[:2] + tail[3::2]) if len(tail) > 2 else '/'.join(tail[:2])
    name = tail[-1]
    if kind == 'Microsoft.Authorization/roleAssignments':
        role = str(((change.get('after') or change.get('before') or {}).get('properties') or {}).get('roleDefinitionId', ''))
        name = next((purpose for role_id, purpose in ROLE_PURPOSES.items() if role.endswith(role_id)), name)
    return FRIENDLY_TYPES.get(kind, kind), name


def _meaningful(deltas, prefix=''):
    # what-if lists server-managed defaults as deletions and unresolved
    # references as edits; only real configuration differences remain.
    found = []
    for delta in deltas or []:
        path = prefix + delta.get('path', '')
        if delta.get('children'):
            found += _meaningful(delta['children'], path + '.')
        elif delta.get('propertyChangeType') in ('Create', 'Modify', 'Array'):
            after = delta.get('after')
            if not (isinstance(after, str) and after.startswith('[')):
                found.append(path)
    return found


def _describe(paths):
    labels = []
    for path, label in (('.image', 'new software image'), ('.env', 'settings'), ('secrets', 'secrets'),
                        ('customDomains', 'custom web address'), ('probes', 'health checks'),
                        ('registries', 'image registry'), ('scale', 'scaling')):
        if any(label not in labels and (path in p) for p in paths):
            labels.append(label)
    return labels or ['settings']


def summarize_preview(preview):
    created, changed, unchanged = [], [], 0
    for template in ('bootstrap', 'access', 'main'):
        for change in (preview.get(template) or {}).get('changes', []):
            kind, name = _resource(change)
            if change['changeType'] == 'Create':
                created.append(f'{kind} {name}')
            elif change['changeType'] == 'Modify' and _meaningful(change.get('delta')):
                changed.append(f'{kind} {name}: ' + ', '.join(_describe(_meaningful(change.get('delta')))))
            elif change['changeType'] == 'Delete':
                changed.append(f'{kind} {name}: removed')
            else:
                unchanged += 1
    return {'create': sorted(set(created)), 'change': sorted(set(changed)), 'unchanged': unchanged}


def preview(directory, config, state):
    # A first install with a custom address deploys on Azure's address first.
    hostname = config['workspaceHostname'] if (state.get('dns') or state.get('domainVerified')) else ''
    effective = dict(config, workspaceHostname=hostname)
    write_json(directory / 'effective.config.json', effective)
    output = run(['bash', str(ROOT / 'scripts/deploy.sh'), '--what-if', str(directory / 'effective.config.json')],
                 env=environment(config), explain=True)
    return summarize_preview(json.loads(output))


def print_preview(summary, config):
    print(f"Azure preview for resource group {config['resourceGroup']} ({config['location']}):")
    if summary['create']:
        print(f"  Create {len(summary['create'])}:")
        for item in summary['create']:
            print('    + ' + item)
    if summary['change']:
        print(f"  Change {len(summary['change'])}:")
        for item in summary['change']:
            print('    ~ ' + item)
    print(f"  Unchanged: {summary['unchanged']}")
    if not summary['create'] and not summary['change']:
        print('  Nothing to change.')


def plan(args, directory, config, state):
    checks = ensure_group(config, state)
    summary = preview(directory, config, state)
    return {'deployment': config['deploymentId'], 'subscription': config['subscriptionId'], 'tenant': config['tenantId'],
            'region': config['location'], 'group': config['resourceGroup'], 'image': config['sourceImage'],
            'resourceGroup': 'created empty for the preview' if checks['resourceGroup'] == 'new' else 'existing',
            'preview': summary,
            'billing': 'These resources incur Azure charges. Review Azure Pricing Calculator and company budget before install.',
            'network': 'Authenticated public HTTPS ingress, Cosmos and Key Vault endpoints; this profile does not provision private endpoints.'}


# --- Prompts ---------------------------------------------------------------

def section(title):
    print(f'\n== {title}')


def ask(prompt, default='', interactive=True, secret=False):
    if not interactive:
        return default
    label = prompt + (f' [{default}]' if default and not secret else '') + ': '
    value = getpass.getpass(label) if secret else input(label)
    return value.strip() or default


def confirm(prompt, default=True, interactive=True):
    if not interactive:
        return default
    hint = 'Y/n' if default else 'y/N'
    while True:
        value = input(f'{prompt} [{hint}] ').strip().lower()
        if not value:
            return default
        if value in ('y', 'yes'):
            return True
        if value in ('n', 'no'):
            return False


# --- Azure and Entra readiness ---------------------------------------------

def missing_providers(config):
    return [p for p in PROVIDERS
            if azure(config, 'provider', 'show', '--namespace', p)['registrationState'] != 'Registered']


def ensure_providers(config, interactive):
    missing = missing_providers(config)
    if not missing:
        return
    print('This subscription has not enabled: ' + ', '.join(missing) + '.')
    if not confirm('Register them now? (needs permission to register resource providers)', True, interactive):
        raise SetupError('Register these resource providers, then run setup again: ' + ', '.join(missing))
    for namespace in missing:
        print(f'  Registering {namespace} (this can take a few minutes)...')
        run(['az', 'provider', 'register', '--namespace', namespace, '--wait', '--subscription', config['subscriptionId'],
             '--output', 'none'])


def grant_admin_consent(config):
    run(['bash', str(ROOT / 'scripts/configure-entra.sh'), '--consent-only', '--mobile-client-id', config['mobileClientId']],
        env=environment(config))


def mobile_access(config):
    sp = service_principal(config, config['mobileClientId'], 'id,appRoleAssignmentRequired')
    if not sp:
        return {'servicePrincipalId': None, 'consent': False, 'assigned': False}
    grants = graph(config, 'GET', f"servicePrincipals/{sp['id']}/oauth2PermissionGrants")['value']
    scopes = ' '.join(g.get('scope', '') for g in grants if g.get('consentType') == 'AllPrincipals').split()
    assigned = graph(config, 'GET', f"servicePrincipals/{sp['id']}/appRoleAssignedTo?$top=1")['value']
    return {'servicePrincipalId': sp['id'], 'assigned': bool(assigned),
            'consent': all(s in scopes for s in ('mentra.session', 'Teams.ManageCalls', 'Teams.ManageChats'))}


def resolve_principal(config, entry):
    if '@' in entry:
        user = graph(config, 'GET', 'users/' + urllib.parse.quote(entry) + '?$select=id,displayName', missing_ok=True)
        if not user:
            found = graph(config, 'GET', graph_filter('users', f"mail eq {odata(entry)}", 'id,displayName'))['value']
            user = found[0] if found else None
        return dict(user, collection='users') if user else None
    found = graph(config, 'GET', graph_filter('groups', f"displayName eq {odata(entry)}", 'id,displayName'))['value']
    return dict(found[0], collection='groups') if len(found) == 1 else None


def assign_employees(config, sp_id, entries):
    assigned, unknown, refused = [], [], []
    for entry in filter(None, (e.strip() for e in entries)):
        principal = resolve_principal(config, entry)
        if not principal:
            unknown.append(entry)
            continue
        name = principal.get('displayName') or entry
        try:
            graph(config, 'POST', f'servicePrincipals/{sp_id}/appRoleAssignedTo',
                  {'principalId': principal['id'], 'resourceId': sp_id, 'appRoleId': DEFAULT_ACCESS_ROLE})
        except GraphError as error:
            if error.code not in (400, 409):
                raise
            # Graph answers 400 both for an existing assignment, the desired end
            # state, and for a principal it cannot assign, such as a mail-only group.
            existing = graph(config, 'GET', graph_filter(f"{principal['collection']}/{principal['id']}/appRoleAssignments",
                                                         f'resourceId eq {sp_id}', 'id'))['value']
            if not existing:
                refused.append(name)
                continue
        assigned.append(name)
    return assigned, unknown, refused


def entra_handoffs(args, config, interactive):
    """Consent and employee access; returns any remaining administrator steps."""
    handoffs = []
    try:
        access = mobile_access(config)
    except GraphError:
        return [{'step': 'Employee sign-in', 'action': 'Setup could not read the Entra applications. An Entra administrator should grant admin consent and assign employees to the Mobile application.'}]
    consent_url = (f"https://login.microsoftonline.com/{config['tenantId']}/adminconsent"
                   f"?client_id={config['mobileClientId']}")
    if not access['consent']:
        if confirm('Grant tenant-wide consent for the Mentra sign-in app now? (needs an Entra admin role)', True, interactive):
            try:
                # Success means consent was granted; Graph can take a while to list it.
                grant_admin_consent(config)
                access['consent'] = True
            except SetupError:
                pass
        if not access['consent']:
            handoffs.append({'step': 'Admin consent', 'action': 'Send this link to an Entra administrator: ' + consent_url})
    sp_id = access['servicePrincipalId']
    portal = (f'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Users/objectId/{sp_id}'
              f"/appId/{config['mobileClientId']}")
    entries = [e for e in (getattr(args, 'employees', '') or '').split(',') if e.strip()]
    if not access['assigned'] and not entries and interactive:
        entries = ask('Who can sign in? Employee emails or group names, comma-separated (Enter to do this later)',
                      '', interactive).split(',')
    if sp_id and any(e.strip() for e in entries):
        try:
            assigned, unknown, refused = assign_employees(config, sp_id, entries)
            if assigned:
                print('  Allowed to sign in: ' + ', '.join(assigned))
                access['assigned'] = True
            if unknown:
                print('  Not found in Entra: ' + ', '.join(unknown))
            if refused:
                print('  Cannot be assigned (use users or security groups): ' + ', '.join(refused))
        except GraphError:
            print('  Could not assign employees with your Entra role.')
    if not access['assigned']:
        handoffs.append({'step': 'Employee access', 'action': 'Add employees or groups under Users and groups: ' + portal})
    return handoffs


# --- DNS --------------------------------------------------------------------

def find_azure_dns_zone(config, host):
    try:
        zones = azure(config, 'network', 'dns', 'zone', 'list')
    except SetupError:
        return None
    matches = [z for z in zones if host.endswith('.' + z['name'].lower().rstrip('.'))]
    return max(matches, key=lambda z: len(z['name'])) if matches else None


def wait_for_dns(config, state, attempts=40):
    import time
    for attempt in range(attempts):
        try:
            check_dns(config, state)
            return True
        except SetupError:
            if attempt + 1 < attempts:
                time.sleep(RETRY_SECONDS + 5)
    return False


def handle_dns(args, directory, config, state, interactive):
    # Returns True once the records resolve; otherwise prints the handoff.
    try:
        check_dns(config, state)
        return True
    except SetupError:
        pass
    host = config['workspaceHostname']
    zone = find_azure_dns_zone(config, host)
    if zone and confirm(f"The DNS zone {zone['name']} is in this Azure subscription. Add the two records now?", True, interactive):
        dns_args = argparse.Namespace(**dict(vars(args), dns_zone=zone['name'], dns_resource_group=zone['resourceGroup'],
                                             dns_subscription=None))
        configure_azure_dns(dns_args, directory, config, state)
        print('  Records added. Waiting for them to resolve...')
        if wait_for_dns(config, state):
            return True
    print(f'Your DNS administrator needs to add these records for {host} (DNS only, no proxy; leave mail records alone):')
    for record in state['dns']:
        print(f"  {record['type']:5} {record['name']}  ->  {record['value']}")
    print(f'They are also saved in {directory / "dns-records.json"}. When the records are in place, run setup again.')
    return False


# --- Teams meeting creation -------------------------------------------------

def create_meetings_app(directory, config, state):
    # Creates the Graph app that schedules meetings, or on a rerun reuses the one
    # setup recorded. Its secret goes to Key Vault the moment it exists.
    import time
    name = f"{config['displayName']} Mentra Meetings"
    graph_sp = service_principal(config, GRAPH_APP_ID)
    role = next(r for r in graph_sp['appRoles'] if r.get('value') == MEETINGS_PERMISSION)
    if state.get('meetingsAppId'):
        found = graph(config, 'GET', graph_filter('applications', f"appId eq {odata(state['meetingsAppId'])}", 'id,appId'))['value']
        if not found:
            raise SetupError(f"The meetings app {state['meetingsAppId']} that setup created is no longer in Entra. "
                             'Pass --teams-client-id to use another app.')
        app = found[0]
    else:
        # Never adopt an app setup did not create: the meetings permission would
        # extend to any credentials its owners already hold.
        if graph(config, 'GET', graph_filter('applications', f"displayName eq {odata(name)}", 'id'))['value']:
            raise SetupError(f'Entra already has an app named "{name}" that setup did not create. '
                             'Pass --teams-client-id to use it, or rename it and run setup again.')
        app = graph(config, 'POST', 'applications', {
            'displayName': name, 'signInAudience': 'AzureADMyOrg',
            'requiredResourceAccess': [{'resourceAppId': GRAPH_APP_ID, 'resourceAccess': [{'id': role['id'], 'type': 'Role'}]}]})
        checkpoint(directory, state, state['phase'], meetingsAppId=app['appId'])
    sp = None
    for attempt in range(12):
        # A new registration takes a moment to become visible.
        sp = service_principal(config, app['appId'], 'id')
        if sp:
            break
        try:
            sp = graph(config, 'POST', 'servicePrincipals', {'appId': app['appId']})
            break
        except GraphError:
            time.sleep(5)
    if not sp:
        raise SetupError('The meetings application was created but its service principal is not available yet. Run setup again.')
    try:
        graph(config, 'POST', f"servicePrincipals/{graph_sp['id']}/appRoleAssignedTo",
              {'principalId': sp['id'], 'resourceId': graph_sp['id'], 'appRoleId': role['id']})
        consent = True
    except GraphError:
        # An existing grant also fails; check rather than guess.
        consent = meetings_consent(config, app['appId'])
    expires = None
    if not vault_get(config, teams_secret(app['appId'])):
        expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=730)).strftime('%Y-%m-%dT%H:%M:%SZ')
        password = graph(config, 'POST', f"applications/{app['id']}/addPassword",
                         {'passwordCredential': {'displayName': 'Mentra Private Cloud', 'endDateTime': expires}})
        vault_set(config, teams_secret(app['appId']), password['secretText'])
    return app['appId'], consent, expires


def check_graph_secret(config, client_id, secret, attempts=6):
    # Sign in as the app before its secret replaces anything. A secret made
    # minutes ago can take a moment before Microsoft accepts it.
    import time
    body = urllib.parse.urlencode({'client_id': client_id, 'client_secret': secret, 'grant_type': 'client_credentials',
                                   'scope': 'https://graph.microsoft.com/.default'}).encode()
    url = f"https://login.microsoftonline.com/{config['tenantId']}/oauth2/v2.0/token"
    for attempt in range(attempts):
        request = urllib.request.Request(url, data=body, method='POST',
                                         headers={'Content-Type': 'application/x-www-form-urlencoded'})
        try:
            with urllib.request.urlopen(request, timeout=30):
                return
        except urllib.error.HTTPError as error:
            try:
                codes = json.loads(error.read() or b'{}').get('error_codes') or []
            except ValueError:
                codes = []
            # 7000215: wrong secret, 700016: unknown app; both also occur while new credentials propagate.
            if not set(codes) & {7000215, 700016}:
                break
        except (OSError, http.client.HTTPException):
            if attempt + 1 == attempts:
                raise SetupError('Could not reach Microsoft sign-in to check the client secret. Run setup again.') from None
        time.sleep(RETRY_SECONDS)
    raise SetupError(f'Microsoft sign-in rejected the client secret for Graph app {client_id}. '
                     'Check that it belongs to that app and has not expired.')


def meetings_consent(config, client_id):
    # True when the app holds the Graph application permission; None if unknown.
    try:
        graph_sp = service_principal(config, GRAPH_APP_ID)
        role = next(r for r in graph_sp['appRoles'] if r.get('value') == MEETINGS_PERMISSION)
        app_sp = service_principal(config, client_id, 'id')
        if not app_sp:
            return False
        granted = graph(config, 'GET', f"servicePrincipals/{app_sp['id']}/appRoleAssignments")['value']
        return any(a.get('appRoleId') == role['id'] and a.get('resourceId') == graph_sp['id'] for a in granted)
    except (GraphError, StopIteration, TypeError, KeyError):
        return None


def teams_policy_commands(client_id, organizer_id):
    commands = ['Install-Module MicrosoftTeams -Scope CurrentUser -Force   # first time only',
                'Connect-MicrosoftTeams -UseDeviceAuthentication',
                f'New-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds {client_id}',
                '# Let every employee create meetings as themselves (or grant per user with -Identity EMAIL):',
                'Grant-CsApplicationAccessPolicy -PolicyName MentraMeetings -Global']
    if organizer_id:
        commands.append(f'Grant-CsApplicationAccessPolicy -PolicyName MentraMeetings -Identity {organizer_id}')
    return commands


def teams_secret(client_id):
    return 'teams-graph-client-secret-' + client_id


def configure_teams(args, directory, config, state, interactive=None):
    interactive = sys.stdin.isatty() and not getattr(args, 'yes', False) if interactive is None else interactive
    if not state.get('outputs', {}).get('keyVaultName') and state['phase'] not in ('deployed', 'infrastructure_verified'):
        raise SetupError('Finish installation first; meeting creation is added afterwards.')
    client_id = getattr(args, 'teams_client_id', None) or config.get('teamsGraphClientId') or ''
    secret, consent, expires, created = None, None, None, False
    if not client_id:
        if confirm('Create the Microsoft Graph app that schedules meetings now? (needs an Entra admin role)', True, interactive):
            client_id, consent, expires = create_meetings_app(directory, config, state)
            created = True
            print(f'  Created app {client_id}; its client secret went straight to Key Vault.')
        else:
            client_id = ask('Client ID of your existing Graph app with OnlineMeetings.ReadWrite.All', '', interactive)
    if not GUID.fullmatch(client_id or ''):
        raise SetupError('A Graph application client ID is required for meeting creation.')
    if not created:
        if getattr(args, 'teams_secret_stdin', False):
            secret = sys.stdin.readline().strip()
        elif interactive:
            secret = ask('Client secret for that app (hidden; Enter keeps the saved one)', '', interactive, secret=True)
    # Each Graph app has its own secret, so saving a new app's secret leaves the
    # running deployment untouched until the rollout switches ID and secret together.
    if secret:
        print('  Checking the client secret with Microsoft sign-in...')
        check_graph_secret(config, client_id, secret)
        vault_set(config, teams_secret(client_id), secret)
    elif not vault_get(config, teams_secret(client_id)):
        raise SetupError(f'Provide the client secret for Graph app {client_id} (--teams-secret-stdin); '
                         'Key Vault has no secret saved for that app.')
    organizer = getattr(args, 'teams_organizer', None) or (config.get('teamsGraphOrganizerId') or '')
    if not organizer and interactive:
        organizer = ask('Licensed account that hosts meetings for guests (email; Enter to skip)', '', interactive)
    if organizer and not GUID.fullmatch(organizer):
        user = resolve_principal(config, organizer)
        if not user:
            raise SetupError(f'{organizer} was not found in Entra.')
        organizer = user['id']
    # Until the rollout below completes, the deployment counts as unfinished, so
    # running setup again retries it rather than reporting a finished install.
    checkpoint(directory, state, 'deploying')
    changes = {k: v for k, v in (('teamsGraphTenantId', config['tenantId']), ('teamsGraphClientId', client_id),
                                 ('teamsGraphOrganizerId', organizer)) if config.get(k, '') != v}
    if changes:
        update_configuration(directory, config, state, **changes)
    if consent is None:
        consent = meetings_consent(config, client_id)
    rollout = install(argparse.Namespace(**dict(vars(args), dns_ready=bool(state.get('domainVerified')))), directory, config, state)
    result = {'status': 'meeting_creation_configured' if rollout['status'] == 'infrastructure_verified' else rollout['status'],
              'graphClientId': client_id, 'adminConsent': {True: 'granted', False: 'needed'}.get(consent, 'unknown'),
              'teamsPolicy': teams_policy_commands(client_id, organizer)}
    if not consent:
        result['consentLink'] = f"https://login.microsoftonline.com/{config['tenantId']}/adminconsent?client_id={client_id}"
    if expires:
        result['secretExpires'] = expires
    return result


# --- Upgrade -----------------------------------------------------------------

def find_previous_package(state):
    home = install_home()
    candidates = []
    if home:
        candidates += sorted((home / 'packages').glob('*/mentra-private-cloud'))
        candidates.append(home / 'mentra-private-cloud')
    for candidate in candidates:
        try:
            if candidate.resolve() != ROOT and digest(candidate / 'release.json') == state['releaseHash']:
                return candidate.resolve()
        except OSError:
            continue
    return None


def relink():
    home = install_home()
    link = home / 'mentra-private-cloud' if home else None
    if link is None or not link.is_symlink():
        return
    target = f'packages/{ROOT.parent.name}/mentra-private-cloud'
    if os.readlink(link) != target:
        temporary = home / '.mentra-private-cloud.link'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target)
        temporary.replace(link)


def upgrade_command(args, directory, interactive=None):
    interactive = sys.stdin.isatty() and not getattr(args, 'yes', False) if interactive is None else interactive
    state = read_json(directory / 'state.json')
    pending = read_json(directory / 'upgrade.pending.json') if (directory / 'upgrade.pending.json').exists() else {}
    target_hash = digest(ROOT / 'release.json')
    if target_hash not in (state['releaseHash'], pending.get('targetReleaseHash')):
        previous = Path(args.previous_package).resolve() if getattr(args, 'previous_package', None) else find_previous_package(state)
        if not previous:
            raise SetupError('Cannot find the package this deployment runs. Pass --previous-package PATH to it.')
        old = read_json(previous / 'release.json')
        target = check_release()
        section(f"Upgrade from {old['releaseTag']} to {target['releaseTag']}")
        if state['phase'] != 'infrastructure_verified':
            raise SetupError(f"The current deployment has not finished setup ({state['phase']}). "
                             f'Finish it with {previous / "setup.sh"} first, then upgrade.')
        config = read_json(directory / 'deployment.config.json')
        check_upgradable(config)
        upcoming = dict(config, **{k: target[k] for k in ('sourceImage', 'releaseTag', 'managedMiniapps', 'clientMinVersion')},
                        clientRecommendedVersion=target['clientMinVersion'])
        try:
            print_preview(preview(directory, upcoming, state), upcoming)
        except SetupError as error:
            print(f'  Preview unavailable: {error}')
        print('Signing keys are safe in Key Vault. Back up the Cosmos DB database and the report file share first;\n'
              'a software image can be rolled back, but database changes cannot.')
        confirmed = getattr(args, 'backup_confirmed', False) or confirm(
            'Have you backed up the database and report files, and are you ready to upgrade?', False, interactive)
        if not confirmed:
            raise SetupError('Upgrade not started. Run it again after backing up, or pass --backup-confirmed.')
        select_upgrade(argparse.Namespace(**dict(vars(args), previous_package=str(previous), backup_confirmed=True)), directory)
    config, state, release = load(directory)
    result = install(argparse.Namespace(**dict(vars(args), dns_ready=bool(state.get('domainVerified')))), directory, config, state)
    if result['status'] == 'infrastructure_verified':
        relink()
        result = dict(result, status='upgraded', release=release['releaseTag'])
    return result


# --- The guided command -----------------------------------------------------

def guided(args, directory):
    interactive = sys.stdin.isatty() and not getattr(args, 'yes', False)
    release = check_release()
    print(f"Mentra Private Cloud {release['releaseTag']} setup. Run this same command again at any time to continue.")
    if not (directory / 'state.json').exists():
        section('Your company and Azure subscription')
        init(args, directory)
    state = read_json(directory / 'state.json')
    pending = read_json(directory / 'upgrade.pending.json') if (directory / 'upgrade.pending.json').exists() else {}
    if digest(ROOT / 'release.json') not in (state['releaseHash'], pending.get('targetReleaseHash')):
        result = upgrade_command(args, directory, interactive)
        return finish(directory, result)
    config, state, release = load(directory)
    section('Checking the Azure subscription')
    ensure_providers(config, interactive)
    preflight(config)
    if not (config.get('coreApiClientId') and config.get('mobileClientId')):
        section('Creating the Microsoft sign-in apps')
        configure_entra(argparse.Namespace(**dict(vars(args), grant_admin_consent=False)), directory, config, state)
        config, state, release = load(directory)
    section('Employee sign-in')
    handoffs = entra_handoffs(args, config, interactive)
    checkpoint(directory, state, state['phase'], handoffs=handoffs)
    if state['phase'] in ('initialized', 'identity_configured'):
        section('Preview')
        ensure_group(config, state)
        print_preview(preview(directory, config, state), config)
        print('These resources incur Azure charges; this profile uses authenticated public endpoints.')
        if not confirm('Create these resources now? This takes about 15 minutes.', True, interactive):
            return {'status': 'stopped', 'next': 'Run setup again when you are ready.'}
    result = {'status': state['phase']}
    if state['phase'] != 'infrastructure_verified':
        section('Installing')
        dns_ready = False
        if state['phase'] == 'awaiting_dns':
            dns_ready = handle_dns(args, directory, config, state, interactive)
            if not dns_ready:
                return {'status': 'awaiting_dns', 'next': 'Run setup again once the DNS records are in place.'}
        result = install(argparse.Namespace(**dict(vars(args), dns_ready=dns_ready)), directory, config, state)
        if result['status'] == 'awaiting_dns':
            section('Your web address')
            if not handle_dns(args, directory, config, state, interactive):
                return {'status': 'awaiting_dns', 'next': 'Run setup again once the DNS records are in place.'}
            result = install(argparse.Namespace(**dict(vars(args), dns_ready=True)), directory, config, state)
        config, state, release = load(directory)
    section('Administrator key')
    admin = bootstrap_admin(args, directory, config, state)
    config, state, release = load(directory)
    if not config.get('teamsGraphClientId') and not state.get('teamsOffered') and interactive:
        section('Teams meeting creation (optional)')
        print('Employees can already join Teams meetings. Creating new meetings needs a Graph app and a Teams admin.')
        checkpoint(directory, state, state['phase'], teamsOffered=True)
        if confirm('Set up meeting creation now?', False, interactive):
            result['teams'] = configure_teams(args, directory, config, state, interactive)
            config, state, release = load(directory)
    return finish(directory, dict(result, admin=admin))


def print_teams(teams):
    print(f"Meeting creation uses Graph app {teams['graphClientId']}; its secret is in Key Vault.")
    if teams.get('consentLink'):
        print('An Entra administrator grants its permission here: ' + teams['consentLink'])
    print('A Teams administrator runs these once in Cloud Shell (Switch to PowerShell):')
    for line in teams['teamsPolicy']:
        print('  ' + line)


def finish(directory, result):
    state = read_json(directory / 'state.json')
    config = read_json(directory / 'deployment.config.json')
    origin = state.get('outputs', {}).get('workspaceOrigin', '')
    section('Done' if state['phase'] == 'infrastructure_verified' else 'Status')
    if state['phase'] == 'infrastructure_verified':
        print(f'Mentra Private Cloud is running at {origin}')
        print(f'Employees: install the Mentra App, choose Connect to organization, and enter {origin.removeprefix("https://")}.')
        print(f'Administrator key: {admin_key_command(config)}')
        teams = result.get('teams')
        if teams:
            print_teams(teams)
        elif not config.get('teamsGraphClientId'):
            print(f'Teams meeting creation is off. Turn it on later with: {setup_command()} configure-teams')
    for handoff in state.get('handoffs') or []:
        print(f"Still to do - {handoff['step']}: {handoff['action']}")
    print(f'To check status, resume or upgrade later, run: {setup_command()}')
    return dict(result, phase=state['phase'], workspace=origin)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog='Run without a command for guided setup: it installs, continues an interrupted install, and upgrades.')
    parser.add_argument('command', nargs='?', default='guided',
                        choices=('guided', 'init', 'preflight', 'plan', 'configure-entra', 'configure-mirror', 'configure-azure-dns',
                                 'configure-teams', 'check-teams', 'install', 'resume', 'status', 'verify', 'bootstrap-admin',
                                 'upgrade', 'diagnostics'))
    parser.add_argument('--directory', help='Setup state folder (default: mentra-state next to the installed package)')
    parser.add_argument('--config', help='JSON answers for init; otherwise edit deployment.config.json')
    parser.add_argument('--yes', action='store_true', help='Accept defaults without prompting (for automation)')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--dns-ready', action='store_true')
    parser.add_argument('--grant-admin-consent', action='store_true')
    parser.add_argument('--employees', help='Comma-separated employee emails or group names allowed to sign in')
    parser.add_argument('--mirror', help='Approved Azure registry/repository for configure-mirror; release digest stays pinned')
    parser.add_argument('--dns-zone', help='Existing Azure DNS zone for configure-azure-dns')
    parser.add_argument('--dns-resource-group', help='Resource group containing the Azure DNS zone')
    parser.add_argument('--dns-subscription', help='DNS subscription, if different; must belong to the same Entra tenant')
    parser.add_argument('--teams-user', help='Employee object ID or UPN for check-teams; no license assignment is performed')
    parser.add_argument('--teams-client-id', help='Existing Graph app for configure-teams (default: create one)')
    parser.add_argument('--teams-organizer', help='Licensed account (email or object ID) that hosts meetings for guests')
    parser.add_argument('--teams-secret-stdin', action='store_true', help='Read the Graph app client secret from standard input')
    parser.add_argument('--backup-confirmed', action='store_true', help='Confirm the database and report files are backed up before upgrade')
    parser.add_argument('--previous-package', help='Package the deployment currently runs (default: found automatically)')
    args = parser.parse_args()
    directory = Path(args.directory).resolve() if args.directory else default_directory().resolve()
    try:
        if directory.is_relative_to(ROOT):
            raise SetupError('Keep setup state outside the installer package; from ~/mentra-install use --directory ./mentra-state.')
        with locked(directory):
            if args.command == 'guided':
                result = guided(args, directory)
                if result.get('status') in ('stopped', 'awaiting_dns'):
                    print(result['next'])
                return
            if args.command == 'init':
                emit(args, init(args, directory))
                return
            if args.command == 'upgrade':
                result = upgrade_command(args, directory)
                emit(args, result) if args.json else finish(directory, result)
                return
            config, state, release = load(directory)
            commands = {
                'preflight': lambda: preflight(config),
                'plan': lambda: plan(args, directory, config, state),
                'configure-entra': lambda: configure_entra(args, directory, config, state),
                'configure-mirror': lambda: configure_mirror(args, directory, config, state),
                'configure-azure-dns': lambda: configure_azure_dns(args, directory, config, state),
                'configure-teams': lambda: configure_teams(args, directory, config, state),
                'check-teams': lambda: check_teams(args, directory, config, state),
                'install': lambda: install(args, directory, config, state),
                'resume': lambda: install(args, directory, config, state),
                'verify': lambda: verify(args, directory, config, state),
                'bootstrap-admin': lambda: bootstrap_admin(args, directory, config, state),
                'status': lambda: state,
                'diagnostics': lambda: diagnostics(directory, state, release),
            }
            result = commands[args.command]()
            if args.command == 'configure-teams' and not args.json:
                print_teams(result)
            else:
                emit(args, result)
    except (SetupError, KeyError, TypeError, ValueError, OSError) as exc:
        print(f'Setup stopped: {exc}', file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print('\nSetup paused. Run the same command again to continue.', file=sys.stderr)
        sys.exit(130)


def diagnostics(directory, state, release):
    # No Azure logs, environment dump, config secrets, reports,
    # account tokens, or customer employee identifiers are exported.
    value = {k: state.get(k) for k in ('schemaVersion', 'deploymentId', 'phase', 'updatedAt', 'verifiedAt')}
    value['release'] = release['releaseTag']
    value['checks'] = state.get('checks', {})
    write_json(directory / 'diagnostics.json', value)
    return {'file': str(directory / 'diagnostics.json'), 'next': 'Review before sharing. No automatic upload.'}


if __name__ == '__main__':
    main()
