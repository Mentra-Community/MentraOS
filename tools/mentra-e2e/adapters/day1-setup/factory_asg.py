"""Exact January ASG27 bytes, including SystemUI's first-boot backup installation."""
import re

import ble_support as r
from config import PROFILE

PACKAGE = 'com.mentra.asg_client'
SYSTEM = '/system/app/MentraOSLauncher/MentraOSLauncher.apk'
BACKUP = '/system/media/MentraOSLauncherBackup.apk'
DATA_PATH = re.compile(r'/data/app/(?:~~[A-Za-z0-9_+=~-]+/)?com\.mentra\.asg_client-[A-Za-z0-9_+=~-]+/base\.apk')


def verify(cfg, read):
    """Caller supplies identity-bracketed read(label, *shell_argv); never installs."""
    before = read('read_asg_path', 'pm', 'path', PACKAGE)
    r.require(before.startswith('package:') and '\n' not in before, 'asg_path_ambiguous')
    active = before[8:]
    r.require(active == SYSTEM or DATA_PATH.fullmatch(active), 'asg_not_factory_path')
    hashes = {}
    for label, path in (('active', active), ('system', SYSTEM), ('backup', BACKUP)):
        observed = read('hash_asg_'+label, 'sha256sum', path).split()
        r.require(len(observed) == 2 and observed[0] == PROFILE['asgSha256'] and observed[1] == path,
                  'asg_factory_'+label+'_hash_mismatch')
        hashes[label] = observed[0]
    package = read('read_asg_package', 'dumpsys', 'package', PACKAGE)
    versions = re.findall(r'\bversionCode=(\d+)', package)
    r.require(versions and all(value == '27' for value in versions), 'asg_version_mismatch')
    r.require(read('read_asg_path_after', 'pm', 'path', PACKAGE) == before, 'asg_path_changed_during_identity')
    return {'activePath': active, 'systemPath': SYSTEM, 'backupPath': BACKUP, 'sha256': PROFILE['asgSha256'],
            'versionCode': 27, 'hashes': hashes, 'activeIsSystemPath': active == SYSTEM,
            'basis': 'Exact active/system/backup January APK bytes; SystemUI may reinstall the backup after wipe'}
