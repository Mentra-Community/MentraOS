#!/usr/bin/env python3
"""Pinned staging-helper transport and BES power reader; caller owns the lease."""
import argparse
import asyncio
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
from types import SimpleNamespace


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    require(Path(path).is_file() and not Path(path).is_symlink(), 'regular pinned file required')
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        info = os.fstat(f.fileno())
        require(info.st_uid == os.getuid() and info.st_nlink == 1 and info.st_mode & 0o777 == 0o600
                and info.st_size <= 1024 * 1024, 'private bounded input required')
        return f.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    raw = private(args.request)
    require(hashlib.sha256(raw).hexdigest() == args.sha256, 'request changed')
    r = json.loads(raw)
    lease = json.loads(private(r['leasePath']))
    require(lease['pid'] == os.getppid() == r['parentPid'] and bool(lease['token']), 'parent lease required')
    for ref in (r['adb'], r['python']):
        require(digest(ref['path']) == ref['sha256'], 'runtime changed')
    require(Path(sys.executable).resolve() == Path(r['python']['path']).resolve()
            and Path(shutil.which('adb')).resolve() == Path(r['adb']['path']).resolve(), 'runtime resolution changed')
    root = Path(r['january']['directory'])
    names = {'__init__.py', 'config.py', 'ble_support.py', 'factory_asg.py', 'recover_wiped.py',
             'bes_continuity.py', 'observe_power.py', 'query_bes_version.py', 'full_january.py', 'reconcile.py', 'observe.py'}
    require(set(r['january']['definition']) == names, 'incomplete source pins')
    for name, sha in r['january']['definition'].items():
        require(digest(root/name) == sha, 'January source changed')
    sys.path.insert(0, str(root))
    import full_january as f
    cfg = SimpleNamespace(adb=Path(r['adb']['path']), fixture={'mac': r['fixture']['bluetooth']},
                          ble_name='mentra_live_'+r['fixture']['bluetooth'].replace(':', '')[-4:].lower())
    audit = f.Audit(cfg, Path(r['auditDirectory']))
    audit.save = lambda name, value: f.save(audit.path/name, value)
    if r['mode'] == 'power':
        import observe_power
        asyncio.run(observe_power.observe(cfg, audit))
        print(json.dumps({'type': 'finished', 'result': str(audit.path/'result.json')}), flush=True)
        return
    require(r['mode'] == 'stage', 'unsupported mode')
    require(digest(r['helper']['path']) == r['helper']['sha256'] == f.HELPER_SHA, 'helper changed')
    original = json.loads(private(r['sourceIntent']['path']))
    require(digest(r['sourceIntent']['path']) == r['sourceIntent']['sha256'], 'source intent changed')
    owner = original['operationID']
    require(re.fullmatch(f.UUID, owner) and original['remote'] == '/storage/emulated/0/asg/mentra-restore-'+owner+'.zip', 'foreign owner')
    source, target = original['source'], original['target']
    expected = [r['python']['path'], r['helper']['path'], '--transport', source['transport']]
    expected += ['--usb-path', source['usb']] if source.get('usb') else ['--wifi-endpoint', source['wifiEndpoint']]
    expected += ['--expected-version', source['firmware'], '--expected-emmc-cid', source['cid'].lower(),
                 '--remote', original['remote'], '--size', str(target['size']), '--sha256', target['sha256'],
                 '--output', str(Path(original['runDirectory'])/('mtk-full-'+owner)),
                 '--update-engine-status-jar', r['probe']['path']]
    require(r['argv'] == expected, 'stage argv differs from source intent')
    require(digest(r['probe']['path']) == r['probe']['sha256'] == f.PROBE_SHA, 'probe changed')
    f.save(audit.path/'invocation.json', {'sourceIntent': r['sourceIntent'], 'argv': expected, 'owner': owner})
    spec = importlib.util.spec_from_file_location('restore_stage_helper', r['helper']['path'])
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    t = source['transport']
    broadcast = ['adb', '-t', t, 'shell', 'am', 'broadcast', '-a', 'com.xy.updateota', '-p', 'com.android.systemui',
                 '--es', 'cmd', 'start', '--es', 'pkname', 'com.mentra.asg_client', '--es', 'path', original['remote']]
    channel, gates = sys.stdout, []

    def run(argv, timeout=30):
        if argv == broadcast:
            require(not gates, 'second broadcast forbidden')
            gates.append(owner)
            print(json.dumps({'type': 'before-apply', 'owner': owner, 'argv': argv}), file=channel, flush=True)
            approval = json.loads(sys.stdin.readline())
            require(approval == {'owner': owner, 'approved': True}, 'parent withheld apply gate')
            f.save(audit.path/'apply-approved.json', {'owner': owner, 'argv': argv, 'sourceIntent': r['sourceIntent']})
        else:
            marker = len(argv) == 5 and argv[:4] == ['adb', '-t', t, 'shell'] and re.fullmatch(
                r'log -t MentraMtkStage -p i mentra-mtk-stage-[a-f0-9]{32}', argv[4])
            require(marker or argv == ['adb', 'devices', '-l'] or
                    (len(argv) == 5 and argv[:4] == ['adb', '-t', t, 'shell'] and
                     argv[4].startswith(('getprop ', 'cat /', 'stat -c ', 'sha256sum ', 'update_engine_client --status', 'CLASSPATH='))),
                    'unexpected helper command')
        return audit.run(f.status_probe_command(argv), timeout)

    helper.run = run
    sys.argv = expected[1:]
    with open(audit.path/'helper-stdout.txt', 'x', encoding='utf8') as out, contextlib.redirect_stdout(out):
        helper.main()
        out.flush(); os.fsync(out.fileno())
    require(len(gates) == 1, 'helper omitted apply gate')
    print(json.dumps({'type': 'finished', 'owner': owner}), file=channel, flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    main()
