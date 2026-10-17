"""Optional, conservative proof of the shipped NIMO iOS-on-Mac fixture.

No source/string marker constitutes a capability. Stripping or optimizer changes
which prevent reconstructing the required direct-call witnesses omit the feature;
ordinary app publication remains available.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
from nimo_symbol_sections import archive_symbol_sections

PROTOCOL = 'nimo-macos-resource-v1'
SOURCE_FILES = tuple('mobile/modules/bluetooth-sdk/ios/' + path for path in (
    'BluetoothSdkModule.swift', 'Source/DeviceManager.swift', 'Source/MentraBluetoothSDK.swift',
    'Source/sgcs/Nimo.swift', 'Source/sgcs/NimoCanvasCoordinator.swift',
    'Source/sgcs/NimoCanvasSession.swift', 'Source/sgcs/NimoMacResourceTransport.swift',
    'Source/sgcs/NimoResourceFixture.swift', 'Source/sgcs/NimoResourceSession.swift'))
# Values select demangled method identities, never guessed mangled ABI names.
ROLES = {
    'bridgeExecute': 'NimoResourceFixtureBridge.execute(',
    'fixtureExecute': 'NimoResourceFixture.execute(',
    'fixtureStart': 'NimoResourceFixture.start(',
    'fixturePerform': 'NimoResourceFixture.perform(',
    'transportInit': 'NimoMacResourceTransport.init(',
    'transportServe': 'NimoMacResourceTransport.serve(',
    'peerAllowed': 'NimoMacResourceTransport.peerAllowed(',
    'fixtureAdmit': 'NimoResourceFixture.admit(',
    'preserveScan': 'NimoResourceFixture.preserveScan(',
    'beginTransport': 'NimoResourceFixture.beginTransport(',
    'releaseResource': 'Nimo.releaseResource(',
    'sessionRelease': 'NimoResourceSession.beginRelease(',
    'managerConnect': 'DeviceManager.connectByName(',
    'nimoConnect': 'Nimo.connectById(',
    'peerConnect': 'Nimo.onDeviceFound(',
    'uuidConnect': 'Nimo.connectByUUID(',
    'sdkInit': 'MentraBluetoothSDK.init(',
}
EDGES = (
    ('bridgeExecute', 'fixtureExecute'), ('fixtureExecute', 'fixtureStart'),
    ('fixtureExecute', 'fixturePerform'), ('fixtureStart', 'transportInit'),
    ('transportInit', 'transportServe'), ('transportServe', 'peerAllowed'),
    ('transportServe', 'fixtureExecute'), ('fixturePerform', 'releaseResource'),
    ('fixturePerform', 'sessionRelease'), ('nimoConnect', 'fixtureAdmit'),
    ('managerConnect', 'preserveScan'), ('peerConnect', 'beginTransport'),
    ('uuidConnect', 'beginTransport'),
    ('sdkInit', 'fixtureStart'),
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_digest(root):
    rows = [{'path': path, 'sha256': sha((root / path).read_bytes())} for path in sorted(SOURCE_FILES)]
    return sha(json.dumps(rows, separators=(',', ':'), sort_keys=True).encode())


def ios_arm64(data):
    if len(data) < 32:
        raise ValueError('missing Mach-O header')
    magic, cpu, _, _, count, size, _, _ = struct.unpack_from('<8I', data)
    if magic != 0xfeedfacf or cpu != 0x100000c or count > 4096 or size > 1048576 or 32 + size > len(data):
        raise ValueError('expected bounded thin arm64 Mach-O')
    offset = 32
    platforms = []
    for _ in range(count):
        if offset + 8 > 32 + size:
            raise ValueError('truncated load command')
        command, length = struct.unpack_from('<II', data, offset)
        if length < 8 or length % 4 or offset + length > 32 + size:
            raise ValueError('invalid load command')
        if command == 0x32:
            if length < 24:
                raise ValueError('invalid build version')
            platforms.append(struct.unpack_from('<I', data, offset + 8)[0])
        offset += length
    if offset != 32 + size or platforms != [2]:
        raise ValueError('expected unique iOS build platform')


def select_role_witnesses(roots):
    if set(roots) != set(ROLES) or any(not values for values in roots.values()):
        raise ValueError('compiled capability requires every exact method role')
    selected = {role: sorted(values)[0] for role, values in roots.items()}
    canonical = [symbol.removeprefix('_') for symbol in selected.values()]
    if len(set(canonical)) != len(ROLES):
        raise ValueError('one compiled method symbol cannot witness multiple roles')
    if any(not re.fullmatch(r'_?\$s[A-Za-z0-9_$]+', symbol) or len(role + ':' + symbol) > 4096
           for role, symbol in selected.items()):
        raise ValueError('invalid compiled Swift method witness')
    return sorted(f'{role}:{symbol}' for role, symbol in selected.items())


def compiled_witness(nm, demangled, disassembly):
    """Accept only actual text symbols with reconstructible direct call edges.

    Outlined async methods may supply multiple symbols for a role; every selected
    witness belongs to the actual nm table. No substring-only binary scan is used.
    """
    rows = []
    for line in nm.splitlines():
        match = re.fullmatch(r'([0-9a-fA-F]{1,16})\s+[tT]\s+(\S+)', line.strip())
        if match:
            rows.append((int(match[1], 16), match[2]))
    if not rows or len(rows) > 200000 or len(demangled) != len(rows):
        raise ValueError('missing or inconsistent text symbol table')
    roles = {role: {symbol for (_, symbol), name in zip(rows, demangled) if selector in name}
             for role, selector in ROLES.items()}
    # A selector in a demangled closure/thunk is not an entry point. In
    # particular an uninvoked closure inside SDK.init cannot witness SDK.init.
    roots = {role: {symbol for (_, symbol), name in zip(rows, demangled)
                    if re.match(r'^(?:static )?[A-Za-z_][A-Za-z0-9_]*\.' + re.escape(selector), name)}
             for role, selector in ROLES.items()}
    missing = sorted(role for role, values in roots.items() if not values)
    if missing:
        raise ValueError('required native method entries unavailable: ' + ','.join(missing))
    by_address = {address: symbol for address, symbol in rows}
    graph = {symbol: set() for _, symbol in rows}
    current = None
    for line in disassembly.splitlines():
        label = re.fullmatch(r'(\S+):', line.strip())
        if label:
            current = label[1] if label[1] in graph else None
            continue
        if current is None:
            continue
        call = re.search(r'\b(?:bl|b)\s+(?:0x)?([0-9a-fA-F]+)\b', line)
        if call and int(call[1], 16) in by_address:
            graph[current].add(by_address[int(call[1], 16)])
        # otool symbol annotations must resolve to the same actual symbol table.
        for target in re.findall(r';\s*(\S+)', line):
            if re.search(r'\b(?:bl|b)\s', line) and target in graph:
                graph[current].add(target)
    def reaches(source, target):
        # Follow only actual direct-call edges through compiler-emitted method/
        # closure families, never infer invocation from a closure's name alone.
        allowed = roles[source] | roles[target]
        pending, visited = list(roots[source]), set()
        while pending and len(visited) < 4096:
            symbol = pending.pop()
            if symbol in visited:
                continue
            visited.add(symbol)
            children = graph[symbol]
            if children & roots[target]:
                return True
            pending.extend((children & allowed) - visited)
        return False
    for source, target in EDGES:
        if not reaches(source, target):
            raise ValueError(f'unproven compiled edge {source}->{target}')
    # Kernel peer authentication is independently visible at the peer method.
    peer_body = []
    active = False
    for line in disassembly.splitlines():
        if re.fullmatch(r'\S+:', line.strip()):
            active = line.strip()[:-1] in roots['peerAllowed']
        elif active:
            peer_body.append(line)
    body = '\n'.join(peer_body)
    if not all(re.search(r'\b_?' + name + r'\b', body) for name in ('getsockopt', 'getpeereid')):
        raise ValueError('kernel peer authentication calls unavailable')
    registers, options = {}, set()
    for line in peer_body:
        instruction = re.fullmatch(r'\s*(?:[0-9a-fA-F]+\s+)?([a-z][a-z0-9.]*)\s+(.*?)\s*', line)
        if not instruction:
            registers.clear()
            continue
        mnemonic, operands = instruction.groups()
        if mnemonic == 'bl':
            if re.search(r'\b_?getsockopt\b', operands) and registers.get('1') == 0:
                options.add(registers.get('2'))
            registers.clear()  # ARM64 argument registers are caller-saved.
            continue
        move = re.fullmatch(r'([wx][0-9]+),\s*([^,]+)', operands) if mnemonic == 'mov' else None
        if move:
            if move[1] in ('w1', 'x1', 'w2', 'x2'):
                immediate = re.fullmatch(r'#(0x[0-9a-f]+|[0-9]+)', move[2].strip())
                registers[move[1][1:]] = int(immediate[1], 0) if immediate else None
            # A recognized single-destination MOV to another register cannot
            # overwrite the two socket-option arguments.
            continue
        # Unknown instructions may write multiple destinations (LDP x0,x1),
        # alias argument registers, or transfer control. Never retain constants
        # through an instruction whose full writes/control are not modeled.
        registers.clear()
    if not {2, 6}.issubset(options):
        raise ValueError('peer PID/token socket option call arguments unavailable')
    return select_role_witnesses(roots)


def optional_nimo_capability(executable, source_root, expected_revision=None, run=None):
    supplied_run = run
    run = run or (lambda *args: subprocess.check_output([str(arg) for arg in args], timeout=60))
    try:
        if not isinstance(expected_revision, str) or not re.fullmatch(r'[a-f0-9]{40}', expected_revision):
            raise ValueError('missing exact compilation revision')
        for path in SOURCE_FILES:
            committed = run('git', '-C', source_root, 'show', expected_revision + ':' + path)
            if committed != (source_root / path).read_bytes():
                raise ValueError('fixture source differs from compilation revision')
        data = executable.read_bytes()
        ios_arm64(data)
        log_root = os.environ.get('IOS_BUILD_LOG_DIR')
        diagnostic = Path(log_root) / 'xcodebuild-attempt-nimo-capability.log' if log_root else None
        nm, demangled, assembly = archive_symbol_sections(executable, source_root, tuple(ROLES.values()), supplied_run, diagnostic_path=diagnostic)
        witnesses = compiled_witness(nm, demangled, assembly)
        return {'protocol': PROTOCOL, 'sourceSha256': source_digest(source_root),
                'executableSha256': sha(data), 'platform': 'ios-on-mac',
                'proof': 'compiled-symbols-v1', 'symbols': witnesses}
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError) as error:
        print(f'NIMO Mac capability omitted: {type(error).__name__}: {error}', file=sys.stderr)
        return None
