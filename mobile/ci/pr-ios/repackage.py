#!/usr/bin/env python3
"""Reuse a signed iOS app, a PR's (ad hoc) or a release's (App Store), replacing packaging metadata without compiling."""
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import sys
import tempfile
import zipfile

from artifacts import BUNDLE_ID, HERE, digest, read_profile, run, signer_certificate, unsigned_executable_bytes, validate_profile
sys.path.insert(0, str(HERE.parents[2] / '.github/scripts'))
from pr_mobile_config import read_build, packaged_config, packaging_inputs

CONFIG = 'EXConstants.bundle/app.config'


def unpack(ipa, root):
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(
            Path(n).is_absolute() or '..' in Path(n).parts or stat.S_ISLNK(e.external_attr >> 16)
            for n, e in zip(names, archive.infolist())
        ):
            raise ValueError('Unsafe or duplicate IPA entry')
    run('ditto', '-x', '-k', ipa, root)
    apps = list((root / 'Payload').glob('*.app'))
    if len(apps) != 1:
        raise ValueError('IPA must contain exactly one app')
    return apps[0]


def read_app(app, fingerprint):
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != BUNDLE_ID or 'iPhoneOS' not in info.get('CFBundleSupportedPlatforms', []):
        raise ValueError('Expected the Mentra iOS device app')
    executable = info['CFBundleExecutable']
    if Path(executable).name != executable:
        raise ValueError('Invalid executable name')
    config = json.loads((app / CONFIG).read_text())
    build = read_build(config)
    if build['mobileFingerprint'] != fingerprint:
        raise ValueError('Mobile fingerprint mismatch')
    return info, config


def verify_base(app, fingerprint, signing, profile):
    read_app(app, fingerprint)
    run('codesign', '--verify', '--deep', '--strict', app)
    run('codesign', '--verify', '-R', '=anchor apple generic', app)
    original_profile = read_profile(app / 'embedded.mobileprovision')
    # A refreshed device list/expiration does not invalidate compiled code.
    # A changed capability grant requires a fresh build; never silently drop it.
    if original_profile['Entitlements'] != profile['Entitlements']:
        raise ValueError('Cached app provisioning capabilities differ from the current profile')
    if signer_certificate(app) != signing['certificate']:
        raise ValueError('Cached app signer differs from the current distribution identity')


def configure(config, *, fingerprint, ota_url, build_number, metadata, identity):
    return packaged_config(config, fingerprint=fingerprint, ota_url=ota_url, build_number=build_number,
                           platform='ios', build_info=metadata, identity=identity)


def rewrite_app(app, **inputs):
    info, config = read_app(app, inputs['fingerprint'])
    config = configure(config, **inputs)
    build_number = inputs['build_number']
    info['CFBundleVersion'] = str(build_number)
    (app / 'Info.plist').write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
    (app / CONFIG).write_text(json.dumps(config, separators=(',', ':')))


def payload(app):
    return {str(p.relative_to(app)): digest(p) for p in app.rglob('*') if p.is_file()}


def verify_payload(before, after, **inputs):
    old_info, old_config = read_app(before, inputs['fingerprint'])
    info, config = read_app(after, inputs['fingerprint'])
    expected = dict(old_info, CFBundleVersion=str(inputs['build_number']))
    if info != expected or config != configure(old_config, **inputs):
        raise ValueError('Packaged iOS configuration does not match requested inputs')
    allowed = {'Info.plist', CONFIG, 'embedded.mobileprovision', old_info['CFBundleExecutable']}
    # Only the outer app seal changes. Frameworks and all other resources must
    # remain byte-for-byte identical, including their existing signatures.
    filtered = lambda files: {n: h for n, h in files.items() if n not in allowed and not n.startswith('_CodeSignature/')}
    if filtered(payload(before)) != filtered(payload(after)):
        raise ValueError('Compiled iOS payload or resources changed')
    # Compare scratch copies with identical signature normalization, preserving code.
    with tempfile.TemporaryDirectory(prefix='mentra-ios-code-') as temp:
        copies = []
        for name, app in [('before', before), ('after', after)]:
            target = Path(temp) / name
            copies.append(unsigned_executable_bytes(app / old_info['CFBundleExecutable'], target))
        if copies[0] != copies[1]:
            raise ValueError('Compiled iOS executable changed')


def store_profile(app, now=None):
    """An App Store build keeps the profile it was exported with: unexpired, for every device, without debugging."""
    profile = read_profile(app / 'embedded.mobileprovision')
    now = now or dt.datetime.now(dt.timezone.utc)
    entitlements = profile['Entitlements']
    team = profile['TeamIdentifier'][0]
    # A week's margin: App Store Connect still has to process the upload.
    if (profile['ExpirationDate'].replace(tzinfo=dt.timezone.utc) <= now + dt.timedelta(days=7)
            or profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices')
            or entitlements.get('get-task-allow') is not False
            or entitlements.get('application-identifier') != f'{team}.{BUNDLE_ID}'):
        raise ValueError('Expected an unexpired App Store profile for com.mentra.mentra')
    return profile


def signing_for(mode, original):
    """The profile, identity and keychain a mode signs with: the PR's ad hoc ones, or a release's App Store ones."""
    if mode in ('verify-store', 'package-store'):
        keychain = os.environ['MENTRA_CI_KEYCHAIN']
        certificate = signer_certificate(original)
        if certificate not in run('security', 'find-identity', '-v', '-p', 'codesigning', keychain).decode():
            raise ValueError('The job keychain has no identity of the cached app\'s App Store signer')
        return {'certificate': certificate}, store_profile(original), original / 'embedded.mobileprovision', keychain
    profile_file = HERE.parents[1] / 'build/pr-ios/PR.mobileprovision'
    profile = read_profile(profile_file)
    validate_profile(profile)
    signing = json.loads((HERE.parents[1] / 'build/pr-ios/signing.json').read_text())
    return signing, profile, profile_file, os.environ.get('PR_IOS_KEYCHAIN')


def main():
    mode, source, fingerprint = sys.argv[1:4]
    if mode not in ('verify-base', 'package', 'verify-store', 'package-store'):
        raise ValueError('Expected verify-base, package, verify-store or package-store')
    with tempfile.TemporaryDirectory(prefix='mentra-ipa-') as temporary:
        root = Path(temporary)
        original = unpack(source, root / 'original')
        signing, profile, profile_file, keychain = signing_for(mode, original)
        verify_base(original, fingerprint, signing, profile)
        if mode.startswith('verify-'):
            print('Verified cached iOS fingerprint, original compilation and signing identity')
            return
        # Everything beside Payload (an App Store export's Symbols) goes into the new IPA unchanged.
        shutil.copytree(root / 'original', root / 'output', symlinks=True, ignore=lambda folder, names:
                        ['Payload'] if Path(folder) == root / 'original' else [])
        app = root / 'output/Payload' / original.name
        app.parent.mkdir(parents=True)
        run('ditto', original, app)
        if not keychain:
            raise ValueError('No signing keychain for this mode')
        inputs = dict(fingerprint=fingerprint, **packaging_inputs())
        # Preserve the app's actual signed capabilities, not every capability
        # the profile could grant. This prevents accidental entitlement changes.
        entitlements = run('codesign', '-d', '--entitlements', ':-', original)
        entitlement_file = root / 'entitlements.plist'
        entitlement_file.write_bytes(plistlib.dumps(plistlib.loads(entitlements)))
        rewrite_app(app, **inputs)
        shutil.copy2(profile_file, app / 'embedded.mobileprovision')
        run(sys.executable, HERE / 'keychain-search.py', 'run', keychain,
            'codesign', '--force', '--sign', signing['certificate'], '--keychain', keychain,
            '--entitlements', entitlement_file, '--preserve-metadata=requirements,flags,runtime', '--timestamp=none', app)
        verify_base(app, fingerprint, signing, profile)
        if plistlib.loads(run('codesign', '-d', '--entitlements', ':-', app)) != plistlib.loads(entitlements):
            raise ValueError('App capabilities changed during signing')
        verify_payload(original, app, **inputs)
        output = Path(sys.argv[4]).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        run('ditto', '-c', '-k', root / 'output', output)
        delivered = unpack(output, root / 'delivered')
        verify_base(delivered, fingerprint, signing, profile)
        verify_payload(original, delivered, **inputs)
        print('Verified the packaged configuration, build number, unchanged compiled payload and signing identity')


if __name__ == '__main__':
    main()
