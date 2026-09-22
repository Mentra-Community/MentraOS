#!/usr/bin/env python3
"""Export registered-device downloads from the coordinated store IPA, without compiling."""
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).parent / 'pr-ios'))
from artifacts import BUNDLE_ID, configure, digest, package_mac_app, read_profile, run, validate_profile
from repackage import unpack


def validate_app(app, plan, ota_url):
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if (info.get('CFBundleIdentifier') != BUNDLE_ID
            or info.get('CFBundleVersion') != str(plan['native']['buildNumber'])
            or info.get('CFBundleShortVersionString') != plan['native']['marketingVersion']
            or 'iPhoneOS' not in info.get('CFBundleSupportedPlatforms', [])
            or Path(info.get('CFBundleExecutable', '')).name != info.get('CFBundleExecutable')):
        raise ValueError('Download does not match the coordinated iOS app identity')
    bundle = (app / 'main.jsbundle').read_bytes()
    for value in (plan['releaseIdentity'], plan['sourceCommit'], ota_url):
        if not value or value.encode() not in bundle:
            raise ValueError('Download is missing the coordinated release metadata or OTA pin')
    run('codesign', '--verify', '--deep', '--strict', app)
    run('codesign', '--verify', '-R', '=anchor apple generic', app)
    return info


def package(plan_path, ipa, output):
    plan = json.loads(Path(plan_path).read_text())
    if plan['channel'] not in ('dev', 'beta'):
        raise ValueError('Direct downloads are for coordinated dev/staging releases only')
    ota_url = os.environ['COORDINATED_OTA_URL']
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = f"mentraos-{plan['releaseIdentity']}"
    with tempfile.TemporaryDirectory(prefix='mentra-release-downloads-') as tmp:
        root = Path(tmp)
        source = unpack(ipa, root / 'store')
        info = validate_app(source, plan, ota_url)
        # An exported, unencrypted CI IPA contains the same compiled app. A
        # minimal archive lets Xcode perform its normal profile/entitlement
        # conversion on both a fresh build and an immutable-release retry.
        archive = root / 'Mentra.xcarchive'
        target = archive / 'Products/Applications' / source.name
        target.parent.mkdir(parents=True)
        run('ditto', source, target)
        archive_info = {'ArchiveVersion': 2, 'CreationDate': dt.datetime.now(dt.timezone.utc).replace(tzinfo=None),
            'Name': 'Mentra', 'SchemeName': 'Mentra', 'ApplicationProperties': {
                'ApplicationPath': f'Applications/{source.name}', 'CFBundleIdentifier': BUNDLE_ID,
                'CFBundleShortVersionString': info['CFBundleShortVersionString'],
                'CFBundleVersion': info['CFBundleVersion']}}
        (archive / 'Info.plist').write_bytes(plistlib.dumps(archive_info))
        configure(root / 'signing', os.environ['MENTRA_CI_KEYCHAIN'])
        run('xcodebuild', '-exportArchive', '-archivePath', archive,
            '-exportOptionsPlist', root / 'signing/ExportOptions.plist', '-exportPath', root / 'export')
        exported = list((root / 'export').glob('*.ipa'))
        if len(exported) != 1:
            raise ValueError('Expected one registered-device IPA')
        app = unpack(exported[0], root / 'adhoc')
        validate_app(app, plan, ota_url)
        profile = read_profile(app / 'embedded.mobileprovision')
        team = validate_profile(profile)
        if (source / 'main.jsbundle').read_bytes() != (app / 'main.jsbundle').read_bytes():
            raise ValueError('Export changed the JavaScript bundle')
        for name, original in [('store', source), ('adhoc', app)]:
            binary = root / name / 'unsigned-executable'
            shutil.copy2(original / info['CFBundleExecutable'], binary)
            run('codesign', '--remove-signature', binary)
        if (root / 'store/unsigned-executable').read_bytes() != (root / 'adhoc/unsigned-executable').read_bytes():
            raise ValueError('Export changed compiled iOS code')
        manifest = {'bundleId': BUNDLE_ID, 'app': 'Mentra.app', 'headSha': plan['sourceCommit'],
            'buildSha': plan['sourceCommit'], 'releaseIdentity': plan['releaseIdentity'],
            'backend': 'dev' if plan['channel'] == 'dev' else 'staging', 'otaManifestUrl': ota_url,
            'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
            'executableSha256': digest(app / info['CFBundleExecutable']),
            'javascriptSha256': digest(app / 'main.jsbundle'), 'profileUUID': profile['UUID'],
            'profileExpires': profile['ExpirationDate'].isoformat(), 'teamId': team}
        files = {'iphone': f'{prefix}-iphone.ipa', 'mac': f'{prefix}-mac.zip'}
        shutil.copy2(exported[0], output / files['iphone'])
        package_mac_app(app, output / files['mac'], manifest, folder_name='Mentra Release', readme=f'''# Mentra {plan['releaseIdentity']}

This is the {manifest['backend']} build. The same signed iOS app runs on a registered iPhone or Apple Silicon Mac.

Mac: install Bun from https://bun.sh if needed, unzip, then open Install.command. macOS may require Open Anyway under Privacy & Security and approval to trust Mentra Labs prerelease software. The installer preserves your existing Mentra data. The bundled app retains its Apple signature.

Your device must be included in this build's provisioning profile. Installing this replaces the current Mentra App. Connect your glasses and follow the OTA prompt to reach this release's pinned firmware.
''')
        receipt = {'schemaVersion': 1, 'releaseIdentity': plan['releaseIdentity'], 'sourceCommit': plan['sourceCommit'],
            'app': manifest, 'artifacts': {kind: {'name': name, 'size': (output / name).stat().st_size,
                'sha256': digest(output / name)} for kind, name in files.items()}}
        (output / f'{prefix}-apple-downloads.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    package(*sys.argv[1:])
