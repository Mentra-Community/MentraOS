#!/usr/bin/env python3
"""Prepare the debug receiver's exact-base MTK route; never contact a device."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version(value):
    match = re.fullmatch(r"(?:[A-Za-z][A-Za-z0-9_.-]*_)?([0-9]{8}(?:\.[0-9]{1,9})?)", value) if isinstance(value, str) else None
    require(match is not None,
            "Firmware must be an exact identifier ending in YYYYMMDD[.N]")
    return match[1]


def fields(data):
    """Read bounded protobuf wire fields without generated Android dependencies."""
    offset = 0

    def varint():
        nonlocal offset
        value = 0
        for shift in range(0, 70, 7):
            require(offset < len(data), "Truncated payload manifest")
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError("Invalid payload manifest varint")

    while offset < len(data):
        key = varint()
        number, wire = key >> 3, key & 7
        require(number > 0, "Invalid payload manifest field")
        if wire == 0:
            value = varint()
        else:
            require(wire in (1, 2, 5), "Unsupported payload manifest wire type")
            size = varint() if wire == 2 else {1: 8, 5: 4}[wire]
            require(size <= len(data) - offset, "Truncated payload manifest field")
            value = data[offset:offset + size]
            offset += size
        yield number, wire, value


def properties(archive, name):
    info = archive.getinfo(name)
    require(info.file_size <= 64 * 1024, "Oversized OTA metadata")
    result = {}
    for line in archive.read(info).decode("utf8").splitlines():
        if not line:
            continue
        require("=" in line, "Malformed OTA metadata")
        key, value = line.split("=", 1)
        require(key and key not in result, "Duplicate OTA metadata key")
        result[key] = value
    return result


def singleton(entries, number, wire, label):
    values = [(kind, value) for field, kind, value in entries if field == number]
    require(len(values) == 1 and values[0][0] == wire, f"Invalid {label}")
    return values[0][1]


def inspect_full(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Duplicate ZIP entries")
        metadata = properties(archive, "META-INF/com/android/metadata")
        payload_properties = properties(archive, "payload_properties.txt")
        require(metadata.get("ota-type") == "AB", "--full requires an A/B OTA ZIP")
        require(metadata.get("ota-wipe", "no") in ("yes", "no"), "Invalid ota-wipe metadata")
        require(metadata.get("ota-downgrade", "no") in ("yes", "no"), "Invalid ota-downgrade metadata")
        require(payload_properties.get("POWERWASH", "0") in ("0", "1"), "Invalid POWERWASH property")
        wipe = payload_properties.get("POWERWASH", "0") == "1"
        require(wipe == (metadata.get("ota-wipe") == "yes"), "POWERWASH and ota-wipe disagree")
        payload_size = archive.getinfo("payload.bin").file_size
        require(0 < payload_size <= 1024 ** 3, "Oversized A/B payload")
        require(payload_properties.get("FILE_SIZE") == str(payload_size), "Incorrect payload FILE_SIZE")
        with archive.open("payload.bin") as payload:
            header = payload.read(24)
            require(len(header) == 24 and header[:4] == b"CrAU", "Invalid A/B payload header")
            major, length, signature_size = struct.unpack(">QQI", header[4:])
            require(major == 2 and 0 < length <= 16 * 1024 * 1024, "Unsupported A/B payload manifest")
            require(24 + length + signature_size <= payload_size,
                    "Truncated A/B payload")
            manifest_bytes = payload.read(length)
            metadata_bytes = header + manifest_bytes
            require(payload_properties.get("METADATA_SIZE") == str(len(metadata_bytes)), "Incorrect METADATA_SIZE")
            encoded = lambda digest: base64.b64encode(digest).decode("ascii")
            require(payload_properties.get("METADATA_HASH") == encoded(hashlib.sha256(metadata_bytes).digest()),
                    "Incorrect payload METADATA_HASH")
            digest = hashlib.sha256(metadata_bytes)
            for chunk in iter(lambda: payload.read(1024 * 1024), b""):
                digest.update(chunk)
            require(payload_properties.get("FILE_HASH") == encoded(digest.digest()), "Incorrect payload FILE_HASH")
            manifest = list(fields(manifest_bytes))
        minor = [(wire, value) for number, wire, value in manifest if number == 12]
        require(not minor or minor == [(0, 0)], "--full refuses incremental payloads")
        partitions = [value for number, wire, value in manifest if number == 13 and wire == 2]
        require(all(wire == 2 for number, wire, _ in manifest if number == 13), "Malformed partition entry")
        require(partitions, "A/B payload has no partitions")
        partition_names = set()
        for partition in partitions:
            entries = list(fields(partition))
            name = singleton(entries, 1, 2, "partition name")
            require(re.fullmatch(rb"[a-z0-9_]+", name) and name not in partition_names, "Duplicate or invalid partition name")
            partition_names.add(name)
            require(not any(number == 6 for number, _, _ in entries), "Full payload references an old partition")
            new_info = list(fields(singleton(entries, 7, 2, "new partition info")))
            require(singleton(new_info, 1, 0, "new partition size") > 0, "Empty new partition")
            require(len(singleton(new_info, 2, 2, "new partition hash")) == 32, "Invalid new partition hash")
            operations = [value for number, wire, value in entries if number == 8 and wire == 2]
            require(all(wire == 2 for number, wire, _ in entries if number == 8), "Malformed partition operation")
            require(operations, "Full partition has no operations")
            for operation in operations:
                values = list(fields(operation))
                require(not any(number in (4, 5, 9) for number, _, _ in values),
                        "Full operation references source data")
                kind = [(wire, value) for number, wire, value in values if number == 1]
                require(kind in ([(0, 0)], [(0, 1)], [(0, 8)]),
                        "Full payload contains a source-dependent operation")
        return {"powerwash": wipe, "downgrade": metadata.get("ota-downgrade") == "yes"}


def prepare(path, device_version, end=None, start=None, port=9876, full=False):
    path = Path(path)
    require(path.is_file(), "OTA file not found")
    require(1 <= port <= 65535, "Invalid HTTP port")
    device = version(device_version)
    start = start or device_version
    start_suffix = version(start)
    if full:
        require(start == device_version, "Full OTA start must equal the observed device version")
        require(end is not None, "--full requires --end-firmware")
        end_suffix = version(end)
        info = inspect_full(path)
        numeric = lambda item: tuple(map(int, (item + ".0").split(".")[:2]))
        if numeric(end_suffix) < numeric(device):
            require(info["downgrade"], "Full downgrade requires ota-downgrade=yes")
        print(f"Full A/B payload: POWERWASH={int(info['powerwash'])}; target={end}", file=sys.stderr)
    else:
        match = re.search(r"([0-9]{8}(?:\.[0-9]+)?)_([0-9]{8}(?:\.[0-9]+)?)\.zip$", path.name)
        require(match is not None, "Could not parse patch start/end versions from filename")
        require(match[1] == start_suffix, "Patch start version does not match start_firmware")
        end = end or start[:-len(start_suffix)] + match[2]
        require(version(end) == match[2], "Patch end version does not match end_firmware")
    size = path.stat().st_size
    require(0 < size <= 1024 ** 3, "MTK OTA must be between 1 byte and 1 GiB")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    # An explicit maintenance full image uses the receiver's exact-base route.
    # The normal newer-only mtk_full_ota fallback policy is unchanged.
    return {"apps": {}, "mtk_patches": [{"start_firmware": start, "end_firmware": end,
            "url": f"http://localhost:{port}/mtk_firmware.zip", "sha256": digest.hexdigest(), "size": size}]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--device-version", required=True)
    parser.add_argument("--start-firmware")
    parser.add_argument("--end-firmware")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.path, args.device_version, args.end_firmware,
                                 args.start_firmware, args.port, args.full), indent=2))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Invalid MTK OTA: {error}\n")


if __name__ == "__main__":
    main()
