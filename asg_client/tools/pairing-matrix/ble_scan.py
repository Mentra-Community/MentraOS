#!/usr/bin/env python3
"""Scan for Mentra Live advertisements and decode the 0xB822 manufacturer data.

Usage: ble_scan.py [--seconds N] [--json]
"""

import argparse
import asyncio
import json
import time

from bleak import BleakScanner

MENTRA_COMPANY_ID = 0xB822


def decode_mentra(data: bytes) -> dict:
    """Mirror MentraLivePairingAdvertisementParser (company-id-stripped payload)."""
    out = {"raw": data.hex(), "secure": False}
    if len(data) <= 11:
        return out
    version, capability = data[6], data[7]
    if 2 <= version <= 15 and capability & 0x01 and data[10] == 0x4D and data[11] == 0x50:
        out.update(
            secure=True,
            pairing=data[5] == 0x01,
            version=version,
            code=f"{data[9]:02X}{data[8]:02X}",
        )
    return out


async def scan(seconds: float) -> list:
    found = {}

    def on_adv(device, adv):
        name = adv.local_name or device.name or ""
        mfr = adv.manufacturer_data or {}
        if "mentra" not in name.lower() and MENTRA_COMPANY_ID not in mfr:
            return
        entry = found.setdefault(
            device.address,
            {"address": device.address, "name": name, "first_seen": time.time()},
        )
        entry["name"] = name or entry["name"]
        entry["rssi"] = adv.rssi
        entry["last_seen"] = time.time()
        entry["service_uuids"] = adv.service_uuids
        if MENTRA_COMPANY_ID in mfr:
            entry["mentra"] = decode_mentra(bytes(mfr[MENTRA_COMPANY_ID]))
        entry["mfr_ids"] = [hex(k) for k in mfr]

    scanner = BleakScanner(on_adv)
    await scanner.start()
    await asyncio.sleep(seconds)
    await scanner.stop()
    return list(found.values())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=6.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    results = asyncio.run(scan(args.seconds))
    if args.json:
        print(json.dumps(results, indent=2))
        return
    for r in results:
        m = r.get("mentra", {})
        print(
            f"{r['address']}  {r['name']:<22} rssi={r.get('rssi')}  "
            f"secure={m.get('secure')} pairing={m.get('pairing')} code={m.get('code', '')} "
            f"raw={m.get('raw', '')}"
        )


if __name__ == "__main__":
    main()
