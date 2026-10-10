#!/usr/bin/env python3
"""Mac as a second BLE central (stranger or new owner) against Mentra Live.

Usage: mac_central.py [--name Mentra_Live_02BE] [--hold 70] [--read] [--attempts 1]

Connects, optionally reads an attribute to provoke encryption/bonding, and holds the
link for --hold seconds. Prints one JSON line per attempt with how long the link lived.
"""

import argparse
import asyncio
import json
import time

from bleak import BleakClient, BleakScanner

READ_CHAR = "000070ff-0000-1000-8000-00805f9b34fb"


async def attempt(name: str, hold: float, do_read: bool, do_pair: bool) -> dict:
    out = {"name": name, "t0": time.strftime("%H:%M:%S")}
    dev = await BleakScanner.find_device_by_name(name, timeout=10)
    if dev is None:
        out["result"] = "not_found"
        return out
    disconnected_at = {}

    def on_disc(_client):
        disconnected_at["t"] = time.time()

    client = BleakClient(dev, disconnected_callback=on_disc, timeout=15)
    start = time.time()
    try:
        await client.connect()
        out["connected"] = True
    except Exception as e:  # noqa: BLE001
        out["connected"] = False
        out["error"] = repr(e)[:200]
        out["result"] = "connect_failed"
        return out
    if do_pair:
        try:
            out["pair"] = await client.pair()
        except Exception as e:  # noqa: BLE001
            out["pair_error"] = repr(e)[:200]
    if do_read:
        try:
            val = await client.read_gatt_char(READ_CHAR)
            out["read"] = val.hex()[:40]
        except Exception as e:  # noqa: BLE001
            out["read_error"] = repr(e)[:200]
    while client.is_connected and time.time() - start < hold:
        await asyncio.sleep(0.5)
    out["link_seconds"] = round((disconnected_at.get("t") or time.time()) - start, 1)
    out["dropped_by_peer"] = "t" in disconnected_at
    if client.is_connected:
        await client.disconnect()
    out["result"] = "done"
    return out


async def main_async(args) -> None:
    for _ in range(args.attempts):
        res = await attempt(args.name, args.hold, args.read, args.pair)
        print(json.dumps(res), flush=True)
        await asyncio.sleep(args.pause)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="Mentra_Live_02BE")
    ap.add_argument("--hold", type=float, default=10)
    ap.add_argument("--read", action="store_true")
    ap.add_argument("--pair", action="store_true")
    ap.add_argument("--attempts", type=int, default=1)
    ap.add_argument("--pause", type=float, default=1)
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
