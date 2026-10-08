#!/usr/bin/env python3
"""Extract the embedded glyph index from the stock G1 1.5.6 app image."""

import argparse
import csv
import hashlib
import io
import struct
import sys
import zipfile
from pathlib import Path

APP_SHA256 = "1eba87bfb1df261d197ca42e0850cc4ff7e668a9e94e02a8be46369b3bfaf483"
TABLE_OFFSET = 0x901FC
ENTRY_COUNT = 445


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("firmware", type=Path, help="G1 1.5.6 ZIP or app_update.bin")
    args = parser.parse_args()
    data = args.firmware.read_bytes()
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            data = archive.read("app_update.bin")
    if hashlib.sha256(data).hexdigest() != APP_SHA256:
        parser.error("Expected the pinned G1 1.5.6 app_update.bin; offsets are version-specific")

    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(["code_point", "character", "glyph_width"])
    for index in range(ENTRY_COUNT):
        code_point, width, reserved = struct.unpack_from("<HBB", data, TABLE_OFFSET + index * 4)
        if reserved != 0 or not 0 < width < 30 or not 0 < code_point < 0x2714:
            parser.error(f"Invalid glyph record {index}")
        writer.writerow([f"U+{code_point:04X}", chr(code_point), width])


if __name__ == "__main__":
    main()
