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
import io
import itertools
from collections import Counter

MAX_SYMBOLS = 200000
MAX_NM_BYTES = 64 * 1024 * 1024
MAX_ROSTER_ROWS = 500000
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


def file_backed_reader(data):
    # Runtime descriptors are read only from the same delivered Mach-O bytes.
    # Zero-fill memory and overlapping file mappings are not proof authority.
    macho_layout(data)
    count, size = struct.unpack_from('<II', data, 16)
    offset, segments = 32, []
    for _ in range(count):
        command, length = struct.unpack_from('<II', data, offset)
        if command == 0x19:
            vmaddr, vmsize, fileoff, filesize = struct.unpack_from('<QQQQ', data, offset + 24)
            if filesize > vmsize or fileoff + filesize > len(data):
                raise ValueError('invalid delivered file-backed segment')
            if filesize:
                segments.append((vmaddr, vmaddr + filesize, fileoff))
        offset += length
    budget = 65536
    def read(address, count):
        nonlocal budget
        if not isinstance(address, int) or not isinstance(count, int) or count <= 0 or count > 256 or count > budget:
            raise ValueError('async delivered-byte read exceeds bound')
        matches = [(start, fileoff) for start, stop, fileoff in segments if start <= address and address + count <= stop]
        if len(matches) != 1:
            raise ValueError('async descriptor is not uniquely file-backed')
        budget -= count
        start, fileoff = matches[0]
        return data[fileoff + address - start:fileoff + address - start + count]
    return read


def delivered_sections(data):
    macho_layout(data)
    count = struct.unpack_from('<I', data, 16)[0]
    offset, sections = 32, {}
    for _ in range(count):
        command, length = struct.unpack_from('<II', data, offset)
        if command == 0x19:
            for index in range(struct.unpack_from('<I', data, offset + 64)[0]):
                start = offset + 72 + index * 80
                name, segment, address, size, fileoff = struct.unpack_from('<16s16sQQI', data, start)
                key = (segment.rstrip(b'\0').decode('ascii'), name.rstrip(b'\0').decode('ascii'))
                if key in sections:
                    raise ValueError('ambiguous delivered section identity')
                flags = struct.unpack_from('<I', data, start + 64)[0]
                sections[key] = (address, address + size, fileoff, flags)
        offset += length
    return sections


def data_imports_from_indirect(output, data):
    if len(output) > 16 * 1024 * 1024:
        raise ValueError('delivered data import table exceeds bound')
    sections, active, result = delivered_sections(data), None, {}
    reader = file_backed_reader(data)
    for line in output.splitlines():
        if line.startswith('Indirect symbols for '):
            active = None
        header = re.fullmatch(r'Indirect symbols for \(([^,]+),([^)]+)\) [0-9]+ entries', line)
        if header:
            key = header.groups()
            candidate = sections.get(key)
            active = candidate if (key[0] in ('__DATA', '__DATA_CONST', '__AUTH', '__AUTH_CONST') and candidate is not None and candidate[3] & 0xff == 6) else None
            continue
        match = re.fullmatch(r'\s*0x([0-9a-fA-F]+)\s+[0-9]+\s+(\S+)\s*', line)
        if active is not None and match:
            address, name = int(match[1], 16), match[2]
            if address % 8 or not active[0] <= address or address + 8 > active[1]:
                raise ValueError('data import is outside exact delivered pointer section')
            if name != '__NSConcreteStackBlock':
                continue
            if address in result:
                raise ValueError('duplicate delivered data import')
            reader(address, 8)
            result[address] = name
    return result


def rebase_pointers(output, data):
    if len(output) > 16 * 1024 * 1024:
        raise ValueError('delivered fixup table exceeds bound')
    sections, result, seen = delivered_sections(data), {}, set()
    for line in output.splitlines():
        match = re.fullmatch(r'\s*(\S+)\s+(\S+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s+(.*?)\s*', line)
        if not match:
            continue
        segment, section, slot, kind, target = match.groups()
        slot = int(slot, 16)
        bounds = sections.get((segment, section))
        if slot in seen or slot % 8 or bounds is None or not bounds[0] <= slot or slot + 8 > bounds[1]:
            raise ValueError('ambiguous or out-of-section delivered fixup')
        seen.add(slot)
        if kind == 'rebase':
            if not re.fullmatch(r'0x[0-9a-fA-F]+', target):
                raise ValueError('unsupported delivered rebase target')
            # Validate file backing without interpreting chained-pointer bits.
            # The public dyld tool resolves them from this same executable.
            if bounds[3] & 0xff in (1, 12, 18) or bounds[2] + slot - bounds[0] + 8 > len(data):
                raise ValueError('delivered rebase is not file-backed')
            result[slot] = int(target, 16)
    return result


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
        raise ValueError(f'archive compiler text symbols unavailable or unbounded: parsed={len(rows)} limit={MAX_SYMBOLS} nmBytes={len(nm.encode())}')
    return rows


def symbol_roster(nm):
    # The complete app roster supplies addresses/identities only. It is not a
    # demangle or traversal budget; the observed app has 213,569 text entries.
    if len(nm.encode()) > MAX_NM_BYTES:
        raise ValueError('archive raw symbol metadata exceeds 64MiB bound')
    rows = []
    for line in io.StringIO(nm):
        if (m := re.fullmatch(r'([a-fA-F0-9]{1,16})\s+[tT]\s+(\S+)', line.strip())):
            rows.append((int(m[1], 16), m[2]))
            if len(rows) > MAX_ROSTER_ROWS:
                raise ValueError(f'archive address roster exceeds bound: parsed={len(rows)} limit={MAX_ROSTER_ROWS}')
    if not rows:
        raise ValueError('archive address roster unavailable: parsed=0')
    return rows


def owned_symbol_rows(roster):
    # Exact observed Swift module ABI plus the standard Task specialization
    # family used to validate consumed runtime descriptors. Other methods can
    # enter only through the bounded exact-entry lazy callback.
    counts = Counter(address for address, _ in roster)
    names = Counter(symbol for _, symbol in roster)
    rows = [(address, symbol) for address, symbol in roster
            if counts[address] == 1 and names[symbol] == 1 and symbol.removeprefix('_').startswith(('$s18MentraBluetoothSDK', '$sScT'))]
    if not rows or len(rows) > MAX_SYMBOLS:
        raise ValueError(f'owned compiler symbols unavailable or unbounded: parsed={len(rows)} limit={MAX_SYMBOLS}')
    return rows


def symbol_windows(rows, demangled, selectors, text, roster=None):
    if len(rows) != len(demangled):
        raise ValueError('compiler demangle roster changed')
    addresses = sorted({address for address, _ in (roster if roster is not None else rows) if text[0] <= address < text[1]})
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


def archive_symbol_sections(executable, source_root, selectors, run=None, clock=None, diagnostic_path=None, async_edges=None):
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
    delivered = executable.read_bytes()
    uuid, text = macho_layout(delivered)
    identity = bounded('xcrun', 'dwarfdump', '--uuid', dwarf).decode('utf-8', errors='strict')
    matches = re.findall(r'^UUID: ([a-fA-F0-9-]{36}) \(([^)]+)\) ', identity, re.MULTILINE)
    if len(matches) != 1 or matches[0][1] != 'arm64' or matches[0][0].replace('-', '').lower() != uuid:
        raise ValueError('archive dSYM UUID differs from delivered arm64 executable')
    nm = bounded('xcrun', 'nm', '-anU', dwarf).decode('utf-8', errors='strict')
    # Preserve bounded causal metadata even if symbol selection fails before
    # full sections can be emitted. This is diagnostic evidence, never proof.
    if diagnostic_path is not None:
        stage = {'kind': 'nimo-compiler-symbol-stage-v1', 'capabilityVerified': False,
                 'uuid': uuid, 'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                 'nmBytes': len(nm.encode()), 'nmSha256': hashlib.sha256(nm.encode()).hexdigest(),
                 'parsedTextCount': sum(bool(re.fullmatch(r'([a-fA-F0-9]{1,16})\s+[tT]\s+(\S+)', line.strip())) for line in io.StringIO(nm)),
                 'firstLines': [line.rstrip('\n')[:512] for line in itertools.islice(io.StringIO(nm), 16)]}
        persist_trace(Path(diagnostic_path).with_name('xcodebuild-attempt-nimo-symbol-stage.log'), stage)
    roster = symbol_roster(nm)
    rows = owned_symbol_rows(roster)
    initial_owned_count = len(rows)
    print(f'NIMO compiler roster: {len(roster)} metadata entries, {initial_owned_count} unaliased owned/Task candidates')
    demangle_size = 0
    def demangle(selected):
        nonlocal demangle_size
        if not selected or len(selected) > MAX_SYMBOLS:
            raise ValueError('selected compiler demangle budget exceeded')
        result = subprocess.run(['xcrun', 'swift-demangle', '--compact'], input=('\n'.join(symbol for _, symbol in selected)+'\n').encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=remaining())
        demangle_size += len(result.stdout)
        if demangle_size > 64 * 1024 * 1024:
            raise ValueError('archive total demangled symbols exceed bound')
        names = [normalize_demangled(name) for name in result.stdout.decode('utf-8', errors='strict').splitlines()]
        if len(names) != len(selected):
            raise ValueError('compiler demangle roster changed')
        return names
    demangled = demangle(rows)
    windows = symbol_windows(rows, demangled, selectors, text, roster)
    indirect = bounded('xcrun', 'llvm-objdump', '--macho', '--indirect-symbols', executable).decode('utf-8', errors='strict')
    imports = imported_stubs(indirect)
    blocks, size, functions = [], 0, {}
    by_symbol = {symbol: name for (_, symbol), name in zip(rows, demangled)}
    address_rows = {}
    for address, symbol in roster:
        name = by_symbol.get(symbol, symbol)
        if text[0] <= address < text[1]:
            address_rows.setdefault(address, []).append((symbol, name))
    symbol_counts = Counter(symbol for _, symbol in roster)
    addresses = sorted(address_rows)
    stops = dict(zip(addresses, addresses[1:] + [text[1]]))
    def disassemble(start, stop, symbol):
        nonlocal size
        remaining()
        if symbol in functions:
            return functions[symbol]
        if len(functions) >= MAX_FUNCTIONS or stop <= start or stop - start > MAX_WINDOW:
            raise ValueError('lazy compiler function window exceeds bound')
        if sum(window[1] - window[0] for window in functions.values()) + stop - start > MAX_TOTAL_TEXT:
            raise ValueError('lazy compiler selected text exceeds bound')
        output = bounded('xcrun', 'llvm-objdump', '--disassemble', '--arch=arm64', '--no-show-raw-insn', f'--start-address=0x{start:x}', f'--stop-address=0x{stop:x}', executable).decode('utf-8', errors='strict')
        block = normalize_window(output, start, stop, symbol, imports)
        size += len(block)
        if size > MAX_ASSEMBLY:
            raise ValueError('selected fixture disassembly exceeds proof bound')
        functions[symbol] = (start, stop, block)
        blocks.append(block)
        return functions[symbol]
    for start, stop, symbol in windows:
        if len(address_rows[start]) != 1:
            raise ValueError('initial compiler function entry is aliased')
        disassemble(start, stop, symbol)
    async_error = None
    async_data_imports, async_reads, async_pointers = {}, {}, {}
    if async_edges is not None:
        from nimo_async_invocations import prove_async_edges
        # Aliased addresses cannot select an arbitrary compiler identity.
        symbols = {address: values[0] for address, values in address_rows.items()
                   if len(values) == 1 and symbol_counts[values[0][0]] == 1}
        def get_function(address):
            if address not in symbols:
                raise ValueError('async compiler function entry is absent or ambiguous')
            return disassemble(address, stops[address], symbols[address][0])
        try:
            data_imports = data_imports_from_indirect(indirect, delivered)
            async_data_imports = {hex(slot): name for slot, name in data_imports.items() if name == '__NSConcreteStackBlock'}
            fixups = rebase_pointers(bounded('xcrun', 'dyld_info', '-fixups', executable).decode('utf-8', errors='strict'), delivered)
            delivered_reader = file_backed_reader(delivered)
            def read_bytes(address, count):
                remaining()
                value = delivered_reader(address, count)
                async_reads[f'{address:x}:{count}'] = value.hex()
                return value
            def read_pointer(slot):
                remaining()
                if slot not in fixups:
                    raise ValueError('async pointer is not an exact delivered rebase slot')
                delivered_reader(slot, 8)
                async_pointers[hex(slot)] = hex(fixups[slot])
                return fixups[slot]
            async_edges.update(prove_async_edges(functions, symbols, imports, read_bytes, get_function, data_imports, read_pointer))
        except (OSError, ValueError, UnicodeError, subprocess.SubprocessError) as error:
            async_error = error
    # Only actually disassembled consumed entries can extend the processed
    # roster. Exact names are demangled under the original total deadline.
    known = {symbol for _, symbol in rows}
    loaded = [(start, symbol) for symbol, (start, _, _) in functions.items() if symbol not in known]
    if loaded and async_error is None:
        try:
            if len(rows) + len(loaded) > MAX_SYMBOLS:
                raise ValueError('owned and lazy compiler roster exceeds bound')
            names = demangle(loaded)
            rows.extend(loaded);demangled.extend(names)
            by_symbol.update({symbol: name for (_, symbol), name in zip(loaded, names)})
        except (OSError, ValueError, UnicodeError, subprocess.SubprocessError) as error:
            async_error = error
    if diagnostic_path is not None:
        trace = {'kind': 'nimo-compiler-sections-only-v1', 'capabilityVerified': False, 'uuid': uuid,
                 'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                 'rosterRows': len(roster), 'initialOwnedRows': initial_owned_count, 'processedRows': len(rows),
                 'symbols': [{'start': start, 'stop': stop, 'symbol': symbol, 'demangled': by_symbol.get(symbol, symbol)} for symbol, (start, stop, _) in functions.items()],
                 'imports': imports, 'assembly': '\n'.join(blocks),
                 'asyncProofError': str(async_error)[:1024] if async_error is not None else None,
                 'asyncDataImports': async_data_imports, 'asyncDescriptorReads': async_reads, 'asyncPointerReads': async_pointers}
        # Fixed producer log basename; normal workflow already retains this glob.
        persist_trace(diagnostic_path, trace)
    if async_error is not None:
        raise async_error
    remaining()
    print(f'NIMO compiler witness UUID {uuid}: {len(windows)} bounded symbol sections, {size} disassembly bytes')
    processed_nm = '\n'.join(f'{address:016x} t {symbol}' for address, symbol in rows)
    return processed_nm, demangled, '\n'.join(blocks)
