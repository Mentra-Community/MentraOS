#!/usr/bin/env python3
"""Normal compact BES observe/install; the caller owns the existing fixture lease."""
import argparse
import json
import os
from pathlib import Path
import re
import time

import config


def execute(cfg, mode, output, owner):
    # Validate before importing dispatch code. Import itself performs no work.
    cfg.require_lease()
    import bes_setup
    import run_once
    output = config.absolute(str(output))
    config.require(mode in ('observe', 'install') and isinstance(owner, str)
                   and re.fullmatch(config.UUID, owner), 'mode_and_lifecycle_owner_required')
    config.require(not output.exists() and not output.is_symlink(), 'new_run_directory_required')
    if mode == 'observe':
        adapter = bes_setup.Adapter(cfg, output, owner)
        result = adapter.observe(need_version=True)
        bes_setup.durable_new(output/'result.json', {'status':'observed', 'observed':result,
                             'lifecycleOwner':owner, 'configSha256':cfg.sha256, 'firmwareWrites':0})
        return {'status':'observed', 'run':str(output), 'firmwareWrites':0}
    cfg.prepare_claims()
    # The CID/source-boot/artifact claim outlives the evidence directory. Neither
    # another owner nor another run directory can authorize a second attempt.
    bes_setup.durable_new(cfg.claim_path, {'schemaVersion':1, 'lifecycleOwner':owner, 'run':str(output),
        'sourceBoot':cfg.data['expected']['boot_id'], 'configSha256':cfg.sha256,
        'targetSha256':config.OTA_SHA, 'claimedAt':time.time(), 'noResend':True})
    code = run_once.run(cfg, output, owner)
    config.require(code == 0, 'observer_failed_reconcile_without_resend')
    return {'status':'observed-install-complete', 'run':str(output), 'setupOnly':True,
            'lifecycleOwner':owner, 'fixtureReadyForOtherRoutines':False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('observe', 'install'))
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    cfg = config.load(args.config, args.config_sha256)
    print(json.dumps(execute(cfg, args.mode, args.run, args.owner)))


if __name__ == '__main__':
    main()
