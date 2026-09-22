#!/usr/bin/env python3
"""Verify unattended access to the job's Apple Distribution private key."""
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def verify(keychain):
    identities = subprocess.check_output(['security', 'find-identity', '-v', '-p', 'codesigning', keychain], text=True)
    certificates = re.findall(r'\b([A-F0-9]{40}) "Apple Distribution:', identities)
    if len(certificates) != 1:
        raise ValueError('Expected exactly one valid Apple Distribution identity in the job keychain')
    with tempfile.TemporaryDirectory(prefix='mentra-signing-probe-') as directory:
        probe = Path(directory) / 'probe'
        subprocess.run(['xcrun', 'clang', '-x', 'c', '-', '-o', probe], input=b'int main(void) { return 0; }\n', check=True)
        subprocess.run(['codesign', '--force', '--sign', certificates[0], '--keychain', keychain,
                        '--timestamp=none', probe], check=True)
        subprocess.run(['codesign', '--verify', '--strict', '-R', '=anchor apple generic', probe], check=True)
    print('Verified unattended Apple Distribution signing before compilation')


if __name__ == '__main__':
    verify(sys.argv[1])
