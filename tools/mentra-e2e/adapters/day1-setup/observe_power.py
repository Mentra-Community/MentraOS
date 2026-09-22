#!/usr/bin/env python3
"""One bounded, MAC-identified BES heartbeat. No firmware, pairing or Wi-Fi mutation."""
import argparse
import asyncio
from pathlib import Path
import time

import ble_support as r
import config


def heartbeat(message):
    body = message.get('B')
    r.require(message.get('C') == 'sr_hrt' and type(message.get('S')) is int and message.get('S') == 0 and isinstance(body, dict), 'heartbeat_invalid')
    level, voltage, ready, charging = (body.get(k) for k in ('pt', 'vt', 'ready', 'charg'))
    r.require(type(level) is int and 0 <= level <= 100 and type(voltage) is int and 2500 <= voltage <= 5000
              and type(ready) is int and ready == 1, 'heartbeat_battery_or_ready_invalid')
    r.require(charging is None or (type(charging) is int and charging in (0, 1)), 'heartbeat_charging_invalid')
    return {'batteryPercent': level, 'voltageMillivolts': voltage,
            'charging': None if charging is None else charging == 1, 'mtkReady': True}


async def observe(cfg, audit):
    from bleak import BleakClient, BleakScanner
    devices = await BleakScanner.discover(timeout=8, return_adv=True)
    candidates = [d for d, a in devices.values() if (a.local_name or d.name or '').casefold() == cfg.ble_name]
    r.require(len(candidates) == 1, 'ble_candidate_ambiguous_or_absent')
    async with BleakClient(candidates[0], timeout=20) as client:
        decoder, queue, errors = r.Decoder(), asyncio.Queue(maxsize=128), [False]
        def received(_sender, value):
            try:
                for item in decoder.add(bytes(value)): queue.put_nowait(item)
            except Exception:
                errors[0] = True
                if not queue.full(): queue.put_nowait({'decodeError': True})
        await client.start_notify(r.NOTIFY, received)
        async def exchange(command, reply):
            while not queue.empty(): queue.get_nowait()
            sent = time.time()
            audit.event('read_only_ble_query', command=command)
            await asyncio.wait_for(client.write_gatt_char(r.COMMAND, r.frame({'C': command}), response=True), 5)
            deadline = time.monotonic()+8
            while True:
                item = await asyncio.wait_for(queue.get(), max(0, deadline-time.monotonic()))
                r.require(not errors[0] and not item.get('decodeError'), 'notification_decode_failed')
                if item.get('C') == reply: return sent, time.time(), item
        async def identity():
            _, _, message = await exchange('cs_btaddr', 'sr_btaddr')
            r.require(message.get('S') == 0 and isinstance(message.get('B'), dict)
                      and str(message['B'].get('btaddr', '')).upper() == cfg.fixture['mac'], 'ble_mac_mismatch')
        await identity()
        sent, seen, message = await exchange('cs_hrt', 'sr_hrt')
        value = heartbeat(message)
        await identity()
        audit.save('result.json', {'schemaVersion': 1, 'status': 'passed', 'source': 'fresh MAC-identified BES sr_hrt',
                   'mac': cfg.fixture['mac'], 'sentAt': sent, 'observedAt': seen, 'identityRecheckedAt': time.time(),
                   'queryCount': 1, 'firmwareWrites': 0, **value})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    config.arguments(parser)
    args = parser.parse_args()
    cfg = config.from_arguments(args)
    cfg.require_lease(child=True)
    audit = r.Audit(cfg, args.out.absolute())
    try: asyncio.run(observe(cfg, audit))
    except BaseException as exc:
        audit.save('failure.json', {'status': 'failed', 'code': str(exc) if isinstance(exc, r.Guard) else type(exc).__name__})
        raise SystemExit(1)
    print('Recorded one BES power observation; the controller must still bind it to the exact source device.')


if __name__ == '__main__': main()
