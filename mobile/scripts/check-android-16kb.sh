#!/usr/bin/env bash
# Fail if any 64-bit native library in an APK or AAB has an ELF LOAD segment
# aligned below 16 KB. 32-bit ABIs are ignored: Play's page-size rule applies
# to arm64-v8a and x86_64 only.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: check-android-16kb.sh path/to/app.apk [more.apk|more.aab ...]" >&2
  exit 2
fi

python3 - "$@" <<'PY'
import struct
import sys
import zipfile

MIN_ALIGN = 0x4000
ABIS = ("arm64-v8a", "x86_64")


def load_alignments(blob, name):
    if len(blob) < 64 or blob[:4] != b"\x7fELF":
        raise ValueError(f"{name} is not an ELF file")
    if blob[4] != 2:
        raise ValueError(f"{name} is not a 64-bit ELF file")
    endian = "<" if blob[5] == 1 else ">"
    phoff = struct.unpack_from(endian + "Q", blob, 32)[0]
    phentsize, phnum = struct.unpack_from(endian + "HH", blob, 54)
    alignments = []
    for index in range(phnum):
        off = phoff + index * phentsize
        if off + 56 > len(blob):
            raise ValueError(f"{name} has a truncated program header")
        p_type = struct.unpack_from(endian + "I", blob, off)[0]
        if p_type == 1:  # PT_LOAD
            alignments.append(struct.unpack_from(endian + "Q", blob, off + 48)[0])
    if not alignments:
        raise ValueError(f"{name} has no LOAD segments")
    return alignments


failures = 0
for archive_path in sys.argv[1:]:
    checked = 0
    try:
        archive = zipfile.ZipFile(archive_path)
    except (FileNotFoundError, zipfile.BadZipFile) as error:
        print(f"FAIL {archive_path} ({error})", file=sys.stderr)
        failures += 1
        continue
    with archive:
        libraries = []
        for info in archive.infolist():
            parts = info.filename.split("/")
            if len(parts) >= 2 and parts[-2] in ABIS and info.filename.endswith(".so"):
                libraries.append(info.filename)
        if not libraries:
            print(f"FAIL {archive_path} (no arm64-v8a or x86_64 native libraries)", file=sys.stderr)
            failures += 1
            continue
        for name in sorted(libraries):
            checked += 1
            try:
                bad = [align for align in load_alignments(archive.read(name), name) if align < MIN_ALIGN]
            except ValueError as error:
                print(f"FAIL {archive_path}: {error}", file=sys.stderr)
                failures += 1
                continue
            if bad:
                shown = " ".join(hex(align) for align in bad)
                print(f"FAIL {archive_path}: {name} (LOAD alignment: {shown})", file=sys.stderr)
                failures += 1
            else:
                print(f"PASS {name}")
    print(f"Checked {checked} 64-bit native libraries in {archive_path}")

if failures:
    print(f"{failures} 16 KB page-alignment checks failed.", file=sys.stderr)
    sys.exit(1)
PY
