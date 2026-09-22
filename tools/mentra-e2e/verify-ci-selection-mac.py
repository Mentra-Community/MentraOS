#!/usr/bin/env python3
"""Cache-only verifier; never run downloaded installers or launch the app."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess

import mac_ci


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--size', type=int, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    mac_ci.require(args.archive.is_file() and not args.archive.is_symlink(), 'Invalid cached archive')
    mac_ci.require(args.archive.stat().st_size == args.size
                   and mac_ci.digest(args.archive) == args.sha256, 'Cached archive changed')
    app = json.loads(args.receipt.read_bytes())['app']
    package = mac_ci.extract_package(args.archive, args.output)
    commands = []

    def command(argv):
        # mac_ci supplies fixed /usr/bin/codesign verification commands only.
        mac_ci.require(argv[0] == '/usr/bin/codesign' and '--verify' in argv, 'Unexpected verifier command')
        result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
        commands.append({'argv': argv, 'exitCode': result.returncode,
                         'stdout': result.stdout, 'stderr': result.stderr})
        (args.output / 'verification-commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        mac_ci.require(result.returncode == 0, 'Mac signature verification failed; see private command evidence')

    mac_ci.verify_package(package, app, command)
    mac_ci.require(mac_ci.digest(args.archive) == args.sha256, 'Cached archive changed during verification')
    bundle = package / 'Mentra.app'
    info = plistlib.loads((bundle / 'Info.plist').read_bytes())
    print(json.dumps({'packageDirectory': str(package), 'manifest': str(package / 'build.json'),
                      'evidence': str(args.output / 'verification-commands.json'),
                      'observed': {'bundleId': info['CFBundleIdentifier'],
                                   'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
                                   'executableSha256': mac_ci.digest(bundle / info['CFBundleExecutable']),
                                   'javascriptSha256': mac_ci.digest(bundle / 'main.jsbundle')}}))


if __name__ == '__main__':
    main()
