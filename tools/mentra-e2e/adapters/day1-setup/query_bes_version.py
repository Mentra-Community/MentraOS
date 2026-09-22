#!/usr/bin/env python3
"""One fresh MAC-gated cs_syvr; its version response is observed separately on ASG UART."""
import argparse
import asyncio
import os
from pathlib import Path
import re
import time

import full_january as f
import config


async def query(cfg, audit, operation, pid, start_ticks, asg_sha):
    from bleak import BleakClient, BleakScanner
    r = f.rehearse
    devices = await BleakScanner.discover(timeout=8, return_adv=True)
    candidates = [d for d, a in devices.values() if (a.local_name or d.name or '').casefold() == cfg.ble_name]
    f.require(len(candidates) == 1, 'ble_candidate_ambiguous_or_absent')
    async with BleakClient(candidates[0], timeout=20) as client:
        decoder, queue = r.Decoder(), asyncio.Queue(maxsize=128)
        errors = []
        def received(_sender, value):
            try:
                for item in decoder.add(bytes(value)): queue.put_nowait(item)
            except Exception:
                errors.append(True)
                if not queue.full(): queue.put_nowait({'decodeError': True})
        await client.start_notify(r.NOTIFY, received)
        async def mac():
            while not queue.empty(): queue.get_nowait()
            audit.event('read_only_ble_query', command='cs_btaddr')
            await asyncio.wait_for(client.write_gatt_char(r.COMMAND, r.frame({'C': 'cs_btaddr'}), response=True), 5)
            deadline = time.monotonic()+8
            while True:
                item = await asyncio.wait_for(queue.get(), max(0, deadline-time.monotonic()))
                f.require(not errors, 'notification_decode_failed')
                if item.get('C') == 'sr_btaddr':
                    f.require(item.get('S') == 0 and isinstance(item.get('B'), dict)
                              and str(item['B'].get('btaddr', '')).upper() == cfg.fixture['mac'], 'ble_mac_mismatch')
                    return
        await mac()
        t, _ = f.source_identity(cfg, audit, operation['endpoint'], operation['source'])
        f.app_absent(cfg, audit)
        f.require(audit.shell(t, 'pidof com.mentra.asg_client') == pid
                  and audit.shell(t, f'cat /proc/{pid}/stat').rsplit(') ', 1)[1].split()[19] == start_ticks,
                  'version_query_process_changed')
        apk = audit.shell(t, 'pm path com.mentra.asg_client')
        f.require(re.fullmatch(r'package:/[A-Za-z0-9_./=+~-]+\.apk', apk)
                  and audit.shell(t, 'sha256sum '+apk[8:]).split()[0] == asg_sha, 'version_query_apk_changed')
        # Toybox date supports %N. Preserve the real boundary; never synthesize log freshness.
        boundary = audit.shell(t, 'date +%s.%N')
        f.require(re.fullmatch(r'[0-9]{10}\.[0-9]{9}', boundary), 'device_nanosecond_epoch_unavailable')
        sent = time.time()
        f.save(audit.path / 'query-intent.json', {'command': 'cs_syvr', 'count': 1, 'deviceEpochBoundary': boundary,
               'boot': operation['source']['boot'], 'pid': pid, 'startTicks': start_ticks, 'mac': cfg.fixture['mac'], 'at': sent})
        await asyncio.wait_for(client.write_gatt_char(r.COMMAND, r.frame({'C': 'cs_syvr'}), response=True), 5)
        await mac()
        f.save(audit.path / 'result.json', {'status': 'query-dispatched', 'command': 'cs_syvr', 'count': 1,
               'deviceEpochBoundary': boundary, 'mac': cfg.fixture['mac'], 'boot': operation['source']['boot'], 'pid': pid,
               'startTicks': start_ticks, 'asgSha256': asg_sha, 'sentAt': sent,
               'identityRecheckedAt': time.time(), 'firmwareWrites': 0, 'versionObserved': False})


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--operation', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--pid', required=True)
    parser.add_argument('--start-ticks', required=True)
    parser.add_argument('--asg-sha', required=True)
    parser.add_argument('--lease-pid', type=int, required=True)
    config.arguments(parser)
    args = parser.parse_args()
    cfg = config.from_arguments(args)
    audit = f.Audit(cfg, args.out.absolute())
    try:
        # This child may only run beneath the lease-owning TS wrapper's Python controller.
        owner_pid = cfg.require_lease(child=True)
        f.require(args.lease_pid == owner_pid, 'root_fixture_lease_required')
        operation = f.private(args.operation)
        asyncio.run(query(cfg, audit, operation, args.pid, args.start_ticks, args.asg_sha))
    except BaseException as exc:
        f.save(audit.path / 'failure.json', {'status': 'failed', 'code': str(exc) if isinstance(exc, f.Guard) else type(exc).__name__})
        raise SystemExit(1)


if __name__ == '__main__': main()
