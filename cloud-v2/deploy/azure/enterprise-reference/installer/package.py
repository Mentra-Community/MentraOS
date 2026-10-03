#!/usr/bin/env python3
"""Build a portable installer from an attested coordinated runtime publication."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[3]
FILES = ('setup.sh', 'installer/setup.py', 'installer/admin-key.ts', 'main.bicep', 'bootstrap.bicep',
         'deployment.config.example.json', 'scripts/deploy.sh', 'scripts/configure-entra.sh',
         'scripts/generate-private-secrets.sh', 'scripts/import-runtime-image.sh', 'scripts/smoke-test.sh')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def build(publication_path, sbom_path, output):
    publication = json.loads(Path(publication_path).read_text())
    if (publication.get('schemaVersion') != 1 or publication.get('component') != 'mentra-cloud-image'
            or publication.get('status') != 'published'
            or not re.fullmatch(r'ghcr\.io/mentra-community/mentra-cloud@sha256:[0-9a-f]{64}', publication.get('reference', ''))
            or publication['reference'] != publication.get('image', '') + '@' + publication.get('digest', '')
            or not re.fullmatch(r'[0-9a-f]{40}', publication.get('sourceCommit', ''))
            or not re.fullmatch(r'[A-Za-z0-9._-]+', publication.get('releaseIdentity', ''))):
        raise ValueError('Expected a published coordinated image record with an immutable digest')
    sbom = Path(sbom_path).read_bytes()
    metadata = publication['sbom']
    if metadata['format'] != 'spdx-json' or sha(sbom) != metadata['sha256'] or len(sbom) != metadata['size']:
        raise ValueError('SBOM bytes do not match publication evidence')
    source = publication['sourceCommit']
    client_version = json.loads(subprocess.check_output(['git', 'show', f'{source}:mobile/package.json'], cwd=REPO))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', client_version):
        raise ValueError('Image source must declare a valid Mentra App marketing version')
    prefix = 'cloud-v2/deploy/azure/enterprise-reference/'
    manifest = json.loads(subprocess.check_output(['git', 'show', f'{source}:{prefix}mentra-deployment.json'], cwd=REPO))
    apps = []
    for app in manifest['miniapps']['managed']:
        if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+', app.get('packageName', '')):
            raise ValueError('Invalid managed miniapp package name')
        filename = f"{app['packageName']}-{app['version']}.zip"
        if '/' in filename or '\\' in filename:
            raise ValueError('Invalid managed miniapp filename')
        blob = subprocess.check_output(['git', 'show', f'{source}:{prefix}miniapps/{filename}'], cwd=REPO)
        if sha(blob) != app['sha256']:
            raise ValueError('Managed miniapp hash does not match image source manifest')
        apps.append({k: app[k] for k in ('packageName', 'version', 'sha256')} | {'bundlePath': '/miniapps/' + filename})
    if not any(app['packageName'] == 'com.mentra.call' for app in apps):
        raise ValueError('Image release must include Mentra Call')
    installer_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    # Package committed bytes only. A local working-tree modification must never
    # masquerade as the recorded installer source commit.
    contents = {name: subprocess.check_output(['git', 'show', f'{installer_commit}:{prefix}{name}'], cwd=REPO)
                for name in FILES}
    contents['runtime-image-publication.json'] = Path(publication_path).read_bytes()
    contents['runtime-image.spdx.json'] = sbom
    release = dict(schemaVersion=1, sourceImage=publication['reference'], releaseTag=publication['releaseIdentity'],
                   imageSourceCommit=source, installerSourceCommit=installer_commit, managedMiniapps=apps,
                   clientMinVersion=client_version, files={name: sha(data) for name, data in contents.items()})
    contents['release.json'] = (json.dumps(release, indent=2) + '\n').encode()
    contents['INSTALL.txt'] = b'''Mentra Private Cloud Azure installer
Use Azure Portal > Cloud Shell > Bash on Windows, macOS, or Linux.
Select Cloud Shell persistent storage, then use $HOME/mentra-install for the package and setup state.
Do not put private keys directly in clouddrive: its SMB permissions cannot restrict access.
Read release.json and verify the archive checksum and publisher attestations before executing.
Run ./setup.sh init --directory ../mentra-setup
Run ./setup.sh preflight --directory ../mentra-setup
Run ./setup.sh plan --directory ../mentra-setup
Run ./setup.sh configure-entra --directory ../mentra-setup
Run ./setup.sh check-teams --directory ../mentra-setup --teams-user EMPLOYEE_OBJECT_ID
If Teams is missing, Microsoft 365 admin center > Marketplace: choose a plan with Teams.
Assign it to intended Teams employees and a customer-owned guest meeting organizer; wait for provisioning.
Guest joining does not require an employee Teams license. Guest creation needs a licensed organizer.
Creating meetings also needs Graph OnlineMeetings.ReadWrite.All consent and a Teams application access policy.
Ask Mentra for the IT guide before configuring these; never reuse Mentra's consumer organizer.
Run ./setup.sh install --directory ../mentra-setup
Install/verify checks Teams licensing when the operator has permission; otherwise it gives an Entra-admin handoff.
After Core is deployed: ./setup.sh bootstrap-admin --directory ../mentra-setup
Store admin-key.json in your secret manager; use its value as MENTRA_ADMIN_TOKEN.
A custom hostname pauses for the CNAME and TXT in dns-records.json.
After publishing those records: ./setup.sh resume --directory ../mentra-setup --dns-ready
The setup directory contains private keys: protect it and back it up to your secret manager.
Server verification does not certify Teams licensing/policy or phone behavior.
Retain this original package and protected state. Resume never changes release pins.
Before upgrade, back up the database, report attachment share, state and original secrets.
From a verified target release package run:
./setup.sh upgrade --directory ../mentra-setup --previous-package /path/to/retained/mentra-private-cloud --backup-confirmed
Then ./setup.sh resume --directory ../mentra-setup and verify employee Calls and reports.
Upgrade retains resource/identity bindings and original keys; unsafe downgrades are refused.
An image rollback is not database rollback. Follow the approved recovery procedure.

'''
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as tmp:
        temp_path = Path(tmp.name)
    try:
        with tarfile.open(temp_path, 'w:gz') as archive:
            for name, data in sorted(contents.items()):
                info = tarfile.TarInfo('mentra-private-cloud/' + name)
                info.size = len(data)
                info.mode = 0o755 if name.endswith('.sh') else 0o644
                archive.addfile(info, io.BytesIO(data))
        temp_path.replace(output)
    finally:
        temp_path.unlink(missing_ok=True)
    checksum = sha(output.read_bytes())
    output.with_name(output.name + '.sha256').write_text(checksum + '  ' + output.name + '\n')
    return release


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication', required=True)
    parser.add_argument('--sbom', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    build(args.publication, args.sbom, args.output)
    print(args.output)
