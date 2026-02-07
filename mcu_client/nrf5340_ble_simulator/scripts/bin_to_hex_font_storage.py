#!/usr/bin/env python3
"""Convert a binary font file to Intel HEX with a base address.

Example:
  python3 scripts/bin_to_hex_font_storage.py font_zh_en_24.bin chinese_font.hex
  python3 scripts/bin_to_hex_font_storage.py font_zh_en_24.bin chinese_font.hex --address 0xF0000
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Iterable

DEFAULT_BASE_ADDRESS = 0xF0000
RECORD_DATA_LEN = 16


def iter_chunks(data: bytes, size: int) -> Iterable[bytes]:
    for i in range(0, len(data), size):
        yield data[i : i + size]


def checksum(byte_values: Iterable[int]) -> int:
    total = sum(byte_values) & 0xFF
    return ((~total + 1) & 0xFF)


def write_hex_record(out, record_type: int, address: int, data: bytes) -> None:
    length = len(data)
    addr_hi = (address >> 8) & 0xFF
    addr_lo = address & 0xFF
    bytes_list = [length, addr_hi, addr_lo, record_type, *data]
    csum = checksum(bytes_list)
    record = ":{:02X}{:04X}{:02X}{}{:02X}\n".format(
        length,
        address & 0xFFFF,
        record_type,
        "".join(f"{b:02X}" for b in data),
        csum,
    )
    out.write(record)


def write_extended_linear_address(out, upper_address: int) -> None:
    data = bytes([(upper_address >> 8) & 0xFF, upper_address & 0xFF])
    write_hex_record(out, 0x04, 0x0000, data)


def convert_bin_to_hex(bin_path: str, hex_path: str, base_address: int) -> None:
    with open(bin_path, "rb") as f:
        data = f.read()

    with open(hex_path, "w", encoding="utf-8") as out:
        current_upper = None
        offset = 0
        for chunk in iter_chunks(data, RECORD_DATA_LEN):
            addr = base_address + offset
            upper = (addr >> 16) & 0xFFFF
            if current_upper != upper:
                write_extended_linear_address(out, upper)
                current_upper = upper
            write_hex_record(out, 0x00, addr & 0xFFFF, chunk)
            offset += len(chunk)
        out.write(":00000001FF\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert .bin font to Intel HEX for external flash.")
    parser.add_argument("input", help="Input .bin file")
    parser.add_argument("output", help="Output .hex file")
    parser.add_argument(
        "--address",
        default=f"0x{DEFAULT_BASE_ADDRESS:X}",
        help=f"Base address (default: 0x{DEFAULT_BASE_ADDRESS:X})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        base_address = int(args.address, 0)
    except ValueError:
        print(f"Invalid address: {args.address}", file=sys.stderr)
        return 2

    if base_address < 0:
        print("Address must be non-negative.", file=sys.stderr)
        return 2

    if not os.path.isfile(args.input):
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 2

    convert_bin_to_hex(args.input, args.output, base_address)
    print(f"Wrote {args.output} with base address 0x{base_address:X}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
