"""UUID-bound archive compiler symbols, bounded disassembly of delivered bytes.

The signed Release executable is stripped. Its matching compiler dSYM supplies
names/addresses, never instructions. Every instruction is read from the exact
published executable. Missing/reused archives omit optional qualification.
"""
from pathlib import Path
import re
import struct
import hashlib
import json
import os
import stat
import subprocess
import time

MAX_SYMBOLS = 200000
MAX_FUNCTIONS = 512
PROOF_SECONDS = 120
MAX_WINDOW = 1024 * 1024
MAX_TOTAL_TEXT = 16 * 1024 * 1024
MAX_ASSEMBLY = 64 * 1024 * 1024


def macho_layout(data):
    if len(data) < 32 or struct.unpack_from('<I', data)[0] != 0xfeedfacf:
        raise ValueError('symbol proof requires thin little-endian Mach-O')
    count, size = struct.unpack_from('<II', data, 16)
    if count > 4096 or size > 1048576 or 32 + size > len(data):
        raise ValueError('invalid symbol proof load commands')
    offset, uuids, texts = 32, [], []
    for _ in range(count):
        if offset + 8 > 32 + size:
            raise ValueError('truncated symbol proof command')
        command, length = struct.unpack_from('<II', data, offset)
        if length < 8 or offset + length > 32 + size:
            raise ValueError('invalid symbol proof command size')
        if command == 0x1b:
            if length != 24:
                raise ValueError('invalid Mach-O UUID')
            uuids.append(data[offset + 8:offset + 24].hex())
        if command == 0x19:
            if length < 72:
                raise ValueError('invalid Mach-O segment')
            sections = struct.unpack_from('<I', data, offset + 64)[0]
            if sections > 4096 or 72 + sections * 80 > length:
                raise ValueError('invalid Mach-O section roster')
            for index in range(sections):
                start = offset + 72 + index * 80
                name, segment, address, extent, file_offset = struct.unpack_from('<16s16sQQI', data, start)
                if name.rstrip(b'\0') == b'__text' and segment.rstrip(b'\0') == b'__TEXT':
                    if not extent or file_offset + extent > len(data):
                        raise ValueError('invalid delivered text extent')
                    texts.append((address, address + extent))
        offset += length
    if offset != 32 + size or len(uuids) != 1 or len(texts) != 1:
        raise ValueError('ambiguous delivered UUID or text section')
    return uuids[0], texts[0]


def normalize_demangled(name):
    # swift-demangle's private-method spelling, observed from the real compiler.
    name = re.sub(r'(?<=\.)\(([A-Za-z_][A-Za-z0-9_]*) in _[A-Fa-f0-9]+\)(?=\()', r'\1', name)
    # Both compiler constructor entries represent the same source initializer.
    # Any surrounding closure/thunk prefix remains intact and cannot be a root.
    return re.sub(r'(?<=\.)__allocating_init(?=\()', 'init', name)


def symbol_rows(nm):
    rows = [(int(match[1], 16), match[2]) for line in nm.splitlines()
            if (match := re.fullmatch(r'([a-fA-F0-9]{1,16})\s+[tT]\s+(\S+)', line.strip()))]
    if not rows or len(rows) > MAX_SYMBOLS:
        raise ValueError('archive compiler text symbols unavailable or unbounded')
    return rows


def symbol_windows(rows, demangled, selectors, text):
    if len(rows) != len(demangled):
        raise ValueError('compiler demangle roster changed')
    addresses = sorted({address for address, _ in rows if text[0] <= address < text[1]})
    next_address = dict(zip(addresses, addresses[1:] + [text[1]]))
    selected = [(address, symbol) for (address, symbol), name in zip(rows, demangled)
                if any(selector in name for selector in selectors)]
    if not selected or len(selected) > MAX_FUNCTIONS:
        raise ValueError('fixture compiler symbol windows unavailable or unbounded')
    windows = []
    total = 0
    for address, symbol in selected:
        if address not in next_address:
            raise ValueError('fixture compiler symbol lies outside delivered text')
        stop = next_address[address]
        if stop - address > MAX_WINDOW:
            raise ValueError('fixture compiler symbol extent exceeds bound')
        total += stop - address
        if total > MAX_TOTAL_TEXT:
            raise ValueError('fixture compiler selected text exceeds bound')
        windows.append((address, stop, symbol))
    return windows


def imported_stubs(output):
    if len(output) > 16 * 1024 * 1024:
        raise ValueError('delivered import table exceeds bound')
    active, imports = False, {}
    for line in output.splitlines():
        if line.startswith('Indirect symbols for '):
            active = line.startswith('Indirect symbols for (__TEXT,__stubs) ')
            continue
        if active and (match := re.fullmatch(r'\s*0x([0-9a-fA-F]+)\s+[0-9]+\s+(\S+)\s*', line)):
            address, name = int(match[1], 16), match[2]
            if address in imports and imports[address] != name:
                raise ValueError('ambiguous delivered import stub')
            imports[address] = name
    return imports


def normalize_window(output, start, stop, symbol, imports):
    if len(output) > MAX_WINDOW * 128:
        raise ValueError('fixture disassembly window exceeds output bound')
    lines, expected = [symbol + ':'], start
    for line in output.splitlines():
        match = re.fullmatch(r'\s*([0-9a-fA-F]+):\s+([a-z][a-z0-9.]*)\s*(.*?)\s*', line)
        if not match:
            continue
        address, instruction, operands = int(match[1], 16), match[2], match[3]
        if address < start or address >= stop or address != expected:
            raise ValueError('disassembler ignored exact fixture address window')
        expected += 4
        # Generic objdump's guessed symbol+offset annotations are not authority.
        operands = operands.split(';', 1)[0].split('<', 1)[0].rstrip()
        target = re.fullmatch(r'0x([0-9a-fA-F]+)', operands) if instruction in ('b', 'bl') else None
        if target and (name := imports.get(int(target[1], 16))):
            operands += ' ; ' + name
        lines.append(f'{address:x} {instruction} {operands}'.rstrip())
    if expected != stop:
        raise ValueError('disassembler did not cover exact fixture symbol extent')
    return '\n'.join(lines)


def persist_trace(path, trace):
    path = Path(path)
    parent = path.parent
    info = parent.lstat()
    if not parent.is_absolute() or parent.resolve() != parent or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('compiler trace parent is not the original owned log directory')
    expected = json.dumps(trace, separators=(',', ':'), sort_keys=True).encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as file:
            before = os.fstat(file.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size != len(expected):
                raise ValueError('original compiler trace file identity changed')
            if file.read() != expected:
                raise ValueError('original compiler trace bytes changed')
            after = os.fstat(file.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('original compiler trace changed during readback')
    else:
        with os.fdopen(fd, 'wb') as file:
            file.write(expected); file.flush(); os.fsync(file.fileno())
    current = parent.lstat()
    if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
        raise ValueError('compiler trace parent changed during persistence')


def archive_symbol_sections(executable, source_root, selectors, run=None, clock=None, diagnostic_path=None):
    clock = clock or time.monotonic
    deadline = clock() + PROOF_SECONDS
    def remaining():
        value = deadline - clock()
        if value <= 0:
            raise ValueError('bounded compiler proof deadline expired')
        return min(60, value)
    def bounded(*args):
        timeout = remaining()
        if run is not None:
            return run(*args, timeout=timeout)
        return subprocess.check_output([str(arg) for arg in args], timeout=timeout)
    executable, source_root = Path(executable), Path(source_root)
    dwarf = source_root / 'mobile/build/pr-ios/Mentra.xcarchive/dSYMs/Mentra.app.dSYM/Contents/Resources/DWARF/Mentra'
    if not dwarf.is_file() or dwarf.is_symlink() or dwarf.stat().st_size > 512 * 1024 * 1024:
        raise ValueError('matching ordinary archive dSYM is unavailable')
    uuid, text = macho_layout(executable.read_bytes())
    identity = bounded('xcrun', 'dwarfdump', '--uuid', dwarf).decode('utf-8', errors='strict')
    matches = re.findall(r'^UUID: ([a-fA-F0-9-]{36}) \(([^)]+)\) ', identity, re.MULTILINE)
    if len(matches) != 1 or matches[0][1] != 'arm64' or matches[0][0].replace('-', '').lower() != uuid:
        raise ValueError('archive dSYM UUID differs from delivered arm64 executable')
    nm = bounded('xcrun', 'nm', '-anU', dwarf).decode('utf-8', errors='strict')
    rows = symbol_rows(nm)
    result = subprocess.run(['xcrun', 'swift-demangle', '--compact'], input=('\n'.join(symbol for _, symbol in rows)+'\n').encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=remaining())
    if len(result.stdout) > 64 * 1024 * 1024:
        raise ValueError('archive demangled symbols exceed bound')
    demangled = [normalize_demangled(name) for name in result.stdout.decode('utf-8', errors='strict').splitlines()]
    windows = symbol_windows(rows, demangled, selectors, text)
    imports = imported_stubs(bounded('xcrun', 'llvm-objdump', '--macho', '--indirect-symbols', executable).decode('utf-8', errors='strict'))
    blocks, size = [], 0
    for start, stop, symbol in windows:
        output = bounded('xcrun', 'llvm-objdump', '--disassemble', '--arch=arm64', '--no-show-raw-insn', f'--start-address=0x{start:x}', f'--stop-address=0x{stop:x}', executable).decode('utf-8', errors='strict')
        block = normalize_window(output, start, stop, symbol, imports)
        size += len(block)
        if size > MAX_ASSEMBLY:
            raise ValueError('selected fixture disassembly exceeds proof bound')
        blocks.append(block)
    remaining()
    if diagnostic_path is not None:
        by_symbol = {symbol: name for (_, symbol), name in zip(rows, demangled)}
        trace = {'kind': 'nimo-compiler-sections-only-v1', 'capabilityVerified': False, 'uuid': uuid,
                 'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                 'symbols': [{'start': start, 'stop': stop, 'symbol': symbol, 'demangled': by_symbol[symbol]} for start, stop, symbol in windows],
                 'imports': imports, 'assembly': '\n'.join(blocks)}
        # Fixed producer log basename; normal workflow already retains this glob.
        persist_trace(diagnostic_path, trace)
    print(f'NIMO compiler witness UUID {uuid}: {len(windows)} bounded symbol sections, {size} disassembly bytes')
    return nm, demangled, '\n'.join(blocks)
