"""Bounded delivered-instruction proof of the fixed retrieval argument.

This supplements reviewed source, not a general Swift/ObjC verifier. Unknown
instruction/call shapes omit discovery support instead of borrowing literals.
"""
import re
import struct

SERVICE = b'00007033-0000-1000-8000-00805F9B34FB'
DISCOVERY_SELECTORS = {
    'discoveryStart': 'NimoResourceConnectedDiscovery.discoverConnected(',
    'discoveryRetrieve': 'NimoResourceConnectedDiscovery.retrieveConnected(',
    'discoveryStop': 'NimoResourceConnectedDiscovery.stopDiscovery(',
}
RETRIEVAL_SPECIALIZATION = 'function signature specialization <Arg[1] = Dead> of '
RETRIEVAL_SIGNATURE = 'MentraBluetoothSDK.NimoResourceConnectedDiscovery.retrieveConnected(__C.CBCentralManager) -> [__C.CBPeripheral]'


def retrieval_entry(name):
    return name in (RETRIEVAL_SIGNATURE, RETRIEVAL_SPECIALIZATION + RETRIEVAL_SIGNATURE)


def distinct_witnesses(lifecycle, discovery):
    symbols = [item.split(':', 1)[1] for item in lifecycle + discovery]
    if any(len(item) > 4096 for item in lifecycle + discovery) or any(not re.fullmatch(r'_?\$s[A-Za-z0-9_$]+', symbol) for symbol in symbols) or len({s.removeprefix('_') for s in symbols}) != len(symbols):
        raise ValueError('discovery cannot reuse any lifecycle or discovery method witness')


def compiled_discovery(nm, names, assembly, edges, facts):
    if facts.get('fixedServiceArgument') is not True:
        raise ValueError('fixed compiled discovery argument unavailable')
    rows = [match.groups() for line in nm.splitlines()
            if (match := re.fullmatch(r'([0-9a-f]+) t (\S+)', line))]
    if len(rows) != len(names) or len(rows) > 200000:
        raise ValueError('inconsistent discovery compiler roster')
    selectors = {'fixturePerform': 'NimoResourceFixture.perform(', **DISCOVERY_SELECTORS,
                 'discoveryFinish': 'NimoResourceConnectedDiscovery.finishDiscovery('}
    roots, families = {}, {}
    for role, selector in selectors.items():
        roots[role] = {symbol for (_, symbol), name in zip(rows, names)
                       if (retrieval_entry(name) if role == 'discoveryRetrieve' else name.startswith('MentraBluetoothSDK.' + selector))}
        families[role] = {symbol for (_, symbol), name in zip(rows, names)
                          if re.search(r'(?<![A-Za-z0-9_.])MentraBluetoothSDK\.' + re.escape(selector), name)}
        if len(roots[role]) != 1:
            raise ValueError('unique compiled discovery entry unavailable: ' + role)
    if len(set.union(*roots.values())) != len(roots) or facts.get('retrievalSymbol') not in roots['discoveryRetrieve']:
        raise ValueError('discovery method identity reused or changed')
    addresses = {int(address, 16): symbol for address, symbol in rows}
    graph = {symbol: set() for _, symbol in rows}
    current = None
    for line in assembly.splitlines():
        if (label := re.fullmatch(r'(\S+):', line.strip())):
            current = label[1] if label[1] in graph else None
        elif current and (call := re.search(r'\b(?:b|bl) 0x([0-9a-f]+)\b', line)):
            if (target := addresses.get(int(call[1], 16))) is not None: graph[current].add(target)
    for source, target in edges:
        if source not in graph or target not in graph: raise ValueError('unbacked discovery async edge')
        graph[source].add(target)
    for source, target in (('fixturePerform', 'discoveryStart'), ('discoveryStart', 'discoveryRetrieve'),
                           ('fixturePerform', 'discoveryStop'), ('discoveryStart', 'discoveryFinish'),
                           ('discoveryStop', 'discoveryFinish')):
        allowed = families[source] | families[target]
        pending, visited, reached = list(roots[source]), set(), False
        while pending and len(visited) < 4096:
            node = pending.pop()
            if node in visited: continue
            visited.add(node)
            if graph[node] & roots[target]: reached = True; break
            pending.extend((graph[node] & allowed) - visited)
        if not reached: raise ValueError('unproven discovery edge ' + source + '->' + target)
    result = sorted(role + ':' + next(iter(roots[role])) for role in DISCOVERY_SELECTORS)
    distinct_witnesses([], result)
    return {'protocol': 'nimo-connected-service-discovery-v1', 'proof': 'compiled-retrieval-wiring-v1', 'symbols': result}


def observer_calls(functions, names, targets, is_objc, selector):
    """Diagnostic direct-call inventory, NOT a closed-world no-effects proof.

    A known forbidden operation refuses qualification, but its absence says
    nothing about indirect/runtime calls. The no-scan policy is established by
    reviewed source and native tests, bound by the enclosing source digest.
    """
    forbidden = {'scanForPeripheralsWithServices:options:', 'connectPeripheral:options:',
                 'registerForConnectionEventsWithOptions:', 'discoverServices:',
                 'discoverCharacteristics:forService:', 'writeValue:forCharacteristic:type:'}
    observed, unresolved, indirect = set(), [], []
    truncated = False
    def retain(destination, item):
        nonlocal truncated
        if len(unresolved) + len(indirect) >= 256: truncated = True
        else:
            bounded = {}
            for key, value in item.items():
                if isinstance(value, str) and len(value) > 2048:
                    value = value[:2048]; truncated = True
                bounded[key] = value
            destination.append(bounded)
    for symbol, (_, _, body) in functions.items():
        if not re.search(r'(?<![A-Za-z0-9_.])MentraBluetoothSDK\.NimoResourceConnectedDiscovery\.', names.get(symbol, '')):
            continue
        for match in re.finditer(r'\b(br|blr)\s+(x[0-9]+)\b', body):
            retain(indirect, {'owner': symbol, 'instruction': match[1], 'register': match[2]})
        for match in re.finditer(r'\b(?:b|bl) 0x([0-9a-f]+)(?: ; (\S+))?', body):
            address = int(match[1], 16)
            if is_objc(address):
                actual = selector(address)
                if actual in forbidden: raise ValueError('forbidden discovery observer call: ' + actual)
                observed.add(actual)
            elif match[2] == '_objc_msgSend':
                raise ValueError('unresolved generic observer ObjC dispatch')
            elif re.match(r'MentraBluetoothSDK\.(?:Nimo|DeviceManager|MentraBluetoothSDK)\.', targets.get(address, '')):
                raise ValueError('discovery observer calls product connection owner')
            elif address not in targets:
                retain(unresolved, {'owner': symbol, 'target': hex(address), 'import': match[2]})
    return {'kind': 'observer-direct-calls-diagnostic-only-v1', 'provesNoEffects': False,
            'resolvedSelectors': sorted(observed), 'unresolvedDirectCalls': unresolved,
            'indirectTransfers': indirect, 'truncated': truncated}


def instructions(body):
    result, expected = [], None
    for line in body.splitlines():
        line = line.strip()
        if not result and expected is None and line.endswith(':'): continue
        match = re.fullmatch(r'([0-9a-f]+)\s+([a-z][a-z0-9.]*)\s*(.*?)', line)
        if not match: raise ValueError('unparsed discovery instruction')
        address = int(match[1], 16)
        if address % 4 or expected is not None and address != expected:
            raise ValueError('noncontiguous discovery instructions')
        expected = address + 4
        result.append((address, match[2] + (' ' + match[3].split(';', 1)[0].strip() if match[3].split(';', 1)[0].strip() else '')))
    if not result or len(result) > 128: raise ValueError('discovery helper instruction bound')
    return result


class StorageMetadata:
    """Exact observed reference-storage ABI, not arbitrary metadata authority.

    Both runtime policy branches are checked. Cache facts describe delivered
    initialization and the actual helper's writes, not absence of other writes
    across the whole binary. Aliased helper bodies supply no method identity.
    """
    def __init__(self, body, name, imports, bind, read_static):
        self.body, self.name, self.imports = body, name, imports
        self.bind, self.read_static = bind, read_static
        self.caches, self.roles = {}, {}
        self.invocations = 0
        self.context_slot = None

    def cache(self, address, role):
        if not isinstance(address, int) or address % 8 or self.read_static(address, 8, 'zero-cache') != b'\0' * 8:
            raise ValueError('discovery metadata cache is not exact initialized zero storage')
        if address in self.caches and self.caches[address] != role or role in self.roles and self.roles[role] != address:
            raise ValueError('discovery metadata cache roles alias or change')
        self.caches[address] = role; self.roles[role] = address

    def template(self, address, patterns):
        rows = instructions(self.body(address))
        if len(rows) != len(patterns): raise ValueError('unsupported discovery metadata body extent')
        captures = {}
        for (_, line), pattern in zip(rows, patterns):
            match = re.fullmatch(pattern, line)
            if not match: raise ValueError('unsupported discovery metadata body instruction: ' + line)
            captures.update(match.groupdict())
        return rows, {key: int(value, 16) for key, value in captures.items()}

    def class_metadata(self, address, cache, class_slot):
        binding = self.bind(class_slot)
        classes = {'_OBJC_CLASS_$_CBUUID': 'CBUUID', '_OBJC_CLASS_$_CBPeripheral': 'CBPeripheral'}
        if binding.get('library') != 'CoreBluetooth' or binding.get('symbol') not in classes:
            raise ValueError('discovery class metadata has wrong actual class bind')
        kind = classes[binding['symbol']]
        self.cache(cache, 'class:' + kind)
        rows, values = self.template(address, [
            r'ldr x0, \[x1\]', r'cbz x0, 0x(?P<slow>[0-9a-f]+)', r'mov x1, #0x0', r'ret',
            r'stp x20, x19, \[sp, #-0x20\]!', r'stp x29, x30, \[sp, #0x10\]', r'add x29, sp, #0x10',
            r'mov x19, x1', r'ldr x0, \[x2\]', r'bl 0x(?P<self>[0-9a-f]+)', r'bl 0x(?P<metadata>[0-9a-f]+)',
            r'stlr x0, \[x19\]', r'ldp x29, x30, \[sp, #0x10\]', r'ldp x20, x19, \[sp\], #0x20', r'mov x1, #0x0', r'ret'])
        if values['slow'] != rows[4][0] or self.imports.get(values['self']) != '_objc_opt_self' or self.imports.get(values['metadata']) != '_swift_getObjCClassMetadata':
            raise ValueError('discovery class metadata cache/slowpath targets changed')
        return ('class-metadata', kind)

    def descriptor(self, address, kind):
        relative, length = struct.unpack('<iI', self.read_static(address, 8, 'descriptor'))
        expected = b'ySo6CBUUIDCG' if kind == 'CBUUID' else b'yyXlG'
        if length != 5 + len(expected): raise ValueError('wrong discovery storage typeref length')
        target = address + relative
        payload = self.read_static(target, length, 'typeref')
        if payload[:1] != b'\x02' or payload[5:] != expected:
            raise ValueError('wrong discovery storage typeref policy')
        slot = target + 1 + struct.unpack('<i', payload[1:5])[0]
        if self.bind(slot) != {'library': 'libswiftCore', 'symbol': '_$ss23_ContiguousArrayStorageCMn'}:
            raise ValueError('discovery storage descriptor has wrong actual context bind')
        if self.context_slot is not None and self.context_slot != slot:
            raise ValueError('discovery storage branches use different context bind slots')
        self.context_slot = slot

    def instantiate(self, address):
        rows, values = self.template(address, [
            r'stp x20, x19, \[sp, #-0x20\]!', r'stp x29, x30, \[sp, #0x10\]', r'add x29, sp, #0x10',
            r'mov x19, x0', r'ldr x0, \[x0\]', r'and x8, x0, #0x1', r'cmp x0, #0x0', r'ccmp x8, #0x0, #0x0, ne',
            r'b.eq 0x(?P<cached>[0-9a-f]+)', r'ldr x9, \[x1\]', r'asr x8, x9, #32', r'add x0, x1, w9, sxtw',
            r'mov x1, x8', r'mov x2, #0x0', r'mov x3, #0x0', r'bl 0x(?P<instantiate>[0-9a-f]+)', r'str x0, \[x19\]',
            r'ldp x29, x30, \[sp, #0x10\]', r'ldp x20, x19, \[sp\], #0x20', r'ret'])
        if values['cached'] != rows[17][0] or self.imports.get(values['instantiate']) != '_swift_getTypeByMangledNameInContext':
            raise ValueError('discovery storage cache instantiate target changed')

    def storage(self, address):
        if self.name(address) != 'generic specialization <__C.CBUUID> of Swift.getContiguousArrayStorageType<A>(for: A.Type) -> Swift._ContiguousArrayStorage<A>.Type':
            raise ValueError('discovery storage entry is not exact unaliased CBUUID policy')
        _, first = self.template(address, [
            r'adrp x0, 0x(?P<classpage>[0-9a-f]+)', r'add x0, x0, #0x(?P<classoff>[0-9a-f]+)',
            r'adrp x1, 0x(?P<bindpage>[0-9a-f]+)', r'add x1, x1, #0x(?P<bindoff>[0-9a-f]+)',
            r'adrp x2, 0x(?P<cachepage>[0-9a-f]+)', r'add x2, x2, #0x(?P<cacheoff>[0-9a-f]+)',
            r'adrp x3, 0x(?P<descpage>[0-9a-f]+)', r'add x3, x3, #0x(?P<descoff>[0-9a-f]+)',
            r'b 0x(?P<runtime>[0-9a-f]+)'])
        class_cache = first['classpage'] + first['classoff']; class_slot = first['bindpage'] + first['bindoff']
        cache = first['cachepage'] + first['cacheoff']; descriptor = first['descpage'] + first['descoff']
        rows, values = self.template(first['runtime'], [
            r'stp x22, x21, \[sp, #-0x30\]!', r'stp x20, x19, \[sp, #0x10\]', r'stp x29, x30, \[sp, #0x20\]',
            r'add x29, sp, #0x20', r'mov x19, x3', r'mov x20, x2', r'mov x21, x1', r'mov x22, x0',
            r'mov w0, #0x2', r'mov w1, #0x10', r'mov w2, #0x0', r'mov w3, #0x0', r'bl 0x(?P<platform>[0-9a-f]+)',
            r'cbz w0, 0x(?P<fallback1>[0-9a-f]+)', r'mov x0, #0x0', r'mov x1, x22', r'mov x2, x21',
            r'bl 0x(?P<classhelper>[0-9a-f]+)', r'cbz x0, 0x(?P<fallback2>[0-9a-f]+)',
            r'adrp x0, 0x(?P<moderncachepage>[0-9a-f]+)', r'add x0, x0, #0x(?P<moderncacheoff>[0-9a-f]+)',
            r'adrp x1, 0x(?P<moderndescpage>[0-9a-f]+)', r'add x1, x1, #0x(?P<moderndescoff>[0-9a-f]+)',
            r'b 0x(?P<join>[0-9a-f]+)', r'mov x0, x20', r'mov x1, x19',
            r'ldp x29, x30, \[sp, #0x20\]', r'ldp x20, x19, \[sp, #0x10\]', r'ldp x22, x21, \[sp\], #0x30',
            r'b 0x(?P<instantiate>[0-9a-f]+)'])
        if values['fallback1'] != rows[24][0] or values['fallback2'] != rows[24][0] or values['join'] != rows[26][0]:
            raise ValueError('discovery storage policy branch targets changed')
        if self.name(values['platform']) != '___isPlatformVersionAtLeast':
            raise ValueError('discovery storage platform predicate identity unavailable')
        # Retain the bounded real body; its boolean remains unknown. Both
        # outcomes below must qualify, so no runtime-version inference is used.
        instructions(self.body(values['platform']))
        if self.class_metadata(values['classhelper'], class_cache, class_slot) != ('class-metadata', 'CBUUID'):
            raise ValueError('discovery storage policy is not CBUUID')
        modern_cache = values['moderncachepage'] + values['moderncacheoff']
        modern_descriptor = values['moderndescpage'] + values['moderndescoff']
        self.cache(cache, 'storage:CBUUID'); self.cache(modern_cache, 'storage:AnyObject')
        self.descriptor(descriptor, 'CBUUID'); self.descriptor(modern_descriptor, 'AnyObject')
        self.instantiate(values['instantiate'])
        self.invocations += 1
        if self.invocations > 16: raise ValueError('discovery storage invocation bound')
        return ('storage-metadata', 'CBUUID-reference-policy', self.invocations)


def objc_selector(address, read, pointer, import_name, in_section, retrieval_only=True):
    """Resolve only the actual fixed ARM64 objc stub, never its label."""
    if address % 4 or not in_section(address, 32, '__TEXT', '__objc_stubs'):
        raise ValueError('discovery call is not a delivered ObjC stub')
    words = struct.unpack('<8I', read(address, 32))
    def page(word, pc, reg):
        if word & 0x9f00001f != 0x90000000 | reg:
            raise ValueError('unsupported discovery selector ADRP')
        value = ((word >> 5) & 0x7ffff) << 2 | ((word >> 29) & 3)
        if value & 0x100000: value -= 0x200000
        return (pc & ~0xfff) + (value << 12)
    def slot(word, base, reg):
        if word & 0xffc003ff != 0xf9400000 | (reg << 5) | reg:
            raise ValueError('unsupported discovery selector LDR')
        return base + ((word >> 10) & 0xfff) * 8
    selector_slot = slot(words[1], page(words[0], address, 1), 1)
    msg_slot = slot(words[3], page(words[2], address + 8, 16), 16)
    if words[4:] != (0xd61f0200, 0xd4200020, 0xd4200020, 0xd4200020):
        raise ValueError('unsupported discovery selector branch')
    if not in_section(selector_slot, 8, '__DATA', '__objc_selrefs') or import_name(msg_slot) != '_objc_msgSend':
        raise ValueError('discovery selector lacks exact delivered references')
    target = pointer(selector_slot)
    if not retrieval_only:
        value = bytearray()
        for offset in range(128):
            if not in_section(target + offset, 1, '__TEXT', '__objc_methname'):
                break
            byte = read(target + offset, 1)
            if byte == b'\0':
                if value and re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_:]*', value): return value.decode()
                break
            value += byte
        raise ValueError('bounded discovery selector string unavailable')
    for value in (b'UUIDWithString:', b'retrieveConnectedPeripheralsWithServices:'):
        if in_section(target, len(value) + 1, '__TEXT', '__objc_methname') and read(target, len(value) + 1) == value + b'\0':
            return value.decode()
    raise ValueError('unexpected discovery selector')


def retrieval_argument(body, read, import_name, selector, metadata_calls, readonly, metadata=None):
    """Follow the one-element CBUUID array from literal to retrieval x2.

    Registers are values, not names. Every unknown write/control flow refuses.
    Caller-saved values are invalidated at every call. Metadata helpers must
    already be exact compiler entries selected by the caller.
    """
    registers = {'x0': ('central',)}
    vector = None
    arrays = {}
    objects = 0
    retrieved = False
    def reg(name): return 'x' + name[1:] if name.startswith('w') else name
    def get(name):
        value = registers.get(reg(name))
        if name.startswith('w'):
            if isinstance(value, int): return value & 0xffffffff
            if isinstance(value, tuple) and value[0] in ('instance-size32', 'align-mask16'): return value
            return None
        return value
    def number(value):
        return int(value[1:], 0) if re.fullmatch(r'#(?:0x[0-9a-f]+|[0-9]+)', value) else None
    def storage_value(value):
        return isinstance(value, tuple) and len(value) == 3 and value[:2] == ('storage-metadata', 'CBUUID-reference-policy')
    instructions = []
    expected = None
    for line in body.splitlines():
        line = line.strip()
        if not instructions and expected is None and re.fullmatch(r'\S+:', line): continue
        match = re.fullmatch(r'([0-9a-f]+)\s+([a-z][a-z0-9.]*)\s*(.*?)', line)
        if not match: raise ValueError('unparsed discovery retrieval instruction')
        address = int(match[1], 16)
        if address % 4 or expected is not None and address != expected:
            raise ValueError('noncontiguous discovery retrieval instructions')
        expected = address + 4
        instructions.append((match[2], match[3]))
    if not instructions or len(instructions) > 128:
        raise ValueError('discovery retrieval instruction bound')
    for op, raw in instructions:
        operands = raw.split(';', 1)[0].strip()
        if op in ('stp', 'ldp'):
            # Only the fixed function prologue/epilogue touches stack. No
            # argument authority can be restored from arbitrary stack bytes.
            if not re.fullmatch(r'x(?:19|20|21|22|23|24|29|30), x(?:19|20|21|22|23|24|29|30), \[sp(?:, #-?0x[0-9a-f]+)?\]!?', operands) and not re.fullmatch(r'x(?:19|20|21|22|23|24|29|30), x(?:19|20|21|22|23|24|29|30), \[sp\], #0x[0-9a-f]+', operands):
                raise ValueError('unsupported retrieval stack operation')
            if op == 'ldp':
                for destination in operands.split(', ')[:2]: registers.pop(destination, None)
            continue
        if op == 'mov' and operands == 'x29, x29': continue
        if op == 'add' and re.fullmatch(r'x29, sp, #0x[0-9a-f]+', operands): continue
        move = re.fullmatch(r'([wx][0-9]+), (.+)', operands) if op == 'mov' else None
        if move:
            value = number(move[2])
            value = value if value is not None else get(move[2])
            if move[1].startswith('w'):
                value = value & 0xffffffff if isinstance(value, int) else value if isinstance(value, tuple) and value[0] in ('instance-size32', 'align-mask16') else None
            registers[reg(move[1])] = value
            continue
        immediate = re.fullmatch(r'(x[0-9]+), #(0x[0-9a-f]+), lsl #48', operands) if op == 'movk' else None
        if immediate and isinstance(get(immediate[1]), int):
            registers[immediate[1]] = (get(immediate[1]) & ~(0xffff << 48)) | (int(immediate[2], 16) << 48); continue
        page = re.fullmatch(r'(x[0-9]+), (0x[0-9a-f]+)', operands) if op == 'adrp' else None
        if page: registers[page[1]] = int(page[2], 16); continue
        arithmetic = re.fullmatch(r'(x[0-9]+), (x[0-9]+), #(0x[0-9a-f]+)', operands) if op in ('add', 'sub', 'orr') else None
        if arithmetic and isinstance(get(arithmetic[2]), int):
            value, literal = get(arithmetic[2]), int(arithmetic[3], 16)
            registers[arithmetic[1]] = value + literal if op == 'add' else value - literal if op == 'sub' else value | literal
            continue
        scalar = re.fullmatch(r'(x[0-9]+), (x[0-9]+), #(0x[0-9a-f]+)', operands) if op in ('add', 'and', 'orr') else None
        if scalar and isinstance(get(scalar[2]), tuple):
            value, literal = get(scalar[2]), int(scalar[3], 16)
            steps = {('add', 'instance-size32', 7): 'size-plus-seven',
                     ('and', 'size-plus-seven', 0x1fffffff8): 'aligned-size',
                     ('add', 'aligned-size', 8): 'array-size',
                     ('orr', 'align-mask16', 7): 'array-alignment'}
            kind = steps.get((op, value[0], literal))
            if kind is None: raise ValueError('unsupported discovery array layout operation')
            registers[scalar[1]] = (kind, value[1]); continue
        field = re.fullmatch(r'(w[0-9]+), \[(x[0-9]+), #(0x[0-9a-f]+)\]', operands) if op in ('ldr', 'ldrh') else None
        if field and storage_value(get(field[2])):
            kind = 'instance-size32' if op == 'ldr' and int(field[3], 16) == 0x30 else 'align-mask16' if op == 'ldrh' and int(field[3], 16) == 0x34 else None
            if kind is None: raise ValueError('wrong discovery metadata field width or offset')
            registers[reg(field[1])] = (kind, get(field[2])); continue
        load = re.fullmatch(r'(x[0-9]+|q0), \[(x[0-9]+)(?:, #(0x[0-9a-f]+))?\]', operands) if op == 'ldr' else None
        if load and isinstance(get(load[2]), int):
            address = get(load[2]) + int(load[3] or '0', 16)
            if load[1] == 'q0':
                if not readonly(address, 16, '__const'): raise ValueError('discovery array header is not readonly delivered data')
                vector = read(address, 16)
            else: registers[load[1]] = ('class',) if import_name(address) == '_OBJC_CLASS_$_CBUUID' else None
            continue
        store = re.fullmatch(r'(x[0-9]+|q0), \[(x[0-9]+), #(0x[0-9a-f]+)\]', operands) if op == 'str' else None
        if store and get(store[2]) in arrays:
            array = arrays[get(store[2])]
            offset = int(store[3], 16)
            if store[1] == 'q0' and offset == 16 and vector == struct.pack('<QQ', 1, 3): array['count'] = True
            elif offset == 32 and get(store[1]) == ('uuid',): array['uuid'] = True
            else: raise ValueError('discovery array element or header changed')
            continue
        call = re.fullmatch(r'0x([0-9a-f]+)', operands) if op == 'bl' else None
        if call:
            target = int(call[1], 16)
            name = raw.split(';', 1)[1].strip() if ';' in raw else None
            result = None
            if name == '_$sSS10FoundationE19_bridgeToObjectiveCSo8NSStringCyF':
                tagged = get('x1')
                address = (tagged & ~(1 << 63)) + 32 if isinstance(tagged, int) else -1
                if get('x0') != 0xd000000000000024 or not isinstance(tagged, int) or not tagged & (1 << 63) or not readonly(address, 37, '__cstring') or read(address, 37) != SERVICE + b'\0':
                    raise ValueError('discovery fixed service literal argument unavailable')
                result = ('string',)
            elif name == '_swift_allocObject':
                dynamic = metadata is not None and storage_value(get('x0')) and get('x1') == ('array-size', get('x0')) and get('x2') == ('array-alignment', get('x0'))
                if not dynamic and (metadata is not None or get('x1') != 40 or get('x2') != 7): raise ValueError('discovery array allocation changed')
                objects += 1; result = ('array', objects); arrays[result] = {}
            elif name == '_objc_opt_self': result = get('x0')
            elif name == '_objc_retainAutoreleasedReturnValue': result = get('x0')
            elif name == '_$sSa10FoundationE19_bridgeToObjectiveCSo7NSArrayCyF':
                if arrays.get(get('x0')) != {'count': True, 'uuid': True}: raise ValueError('discovery single service array unavailable')
                if metadata is not None and get('x1') != ('class-metadata', 'CBUUID'): raise ValueError('discovery services bridge has wrong class metadata')
                result = ('services', 'uuid')
            elif name == '_$sSa10FoundationE36_unconditionallyBridgeFromObjectiveCySayxGSo7NSArrayCSgFZ':
                if get('x0') != ('retrieved',): raise ValueError('discovery retrieved result discarded')
                if metadata is not None and get('x1') != ('class-metadata', 'CBPeripheral'): raise ValueError('discovery output bridge has wrong class metadata')
                result = ('output',)
            elif name in ('_objc_release', '_swift_release'):
                released = get('x0')
                if released is not None:
                    # This is the observed single-ownership template, not a
                    # general ARC model. Release retires every known alias.
                    for register, value in list(registers.items()):
                        if value == released: registers.pop(register, None)
                    arrays.pop(released, None)
                    if released == ('uuid',):
                        # The raw element store transfers the one owned UUID
                        # into the array; a separate release invalidates that
                        # element, including a previously bridged container.
                        for array in arrays.values(): array.pop('uuid', None)
                        for register, value in list(registers.items()):
                            if value == ('services', 'uuid'): registers.pop(register, None)
            elif metadata is None and target in metadata_calls: result = ('metadata',)
            elif metadata is not None and metadata.name(target) == 'generic specialization <__C.CBUUID> of Swift.getContiguousArrayStorageType<A>(for: A.Type) -> Swift._ContiguousArrayStorage<A>.Type':
                result = metadata.storage(target)
            elif metadata is not None and isinstance(get('x1'), int) and isinstance(get('x2'), int):
                result = metadata.class_metadata(target, get('x1'), get('x2'))
            else:
                method = selector(target)
                if method == 'UUIDWithString:' and get('x0') == ('class',) and get('x2') == ('string',): result = ('uuid',)
                elif method == 'retrieveConnectedPeripheralsWithServices:' and get('x0') == ('central',) and get('x2') == ('services', 'uuid') and not retrieved:
                    result = ('retrieved',); retrieved = True
                else: raise ValueError('discovery selector arguments unavailable')
            for index in range(19): registers.pop('x' + str(index), None)
            registers['x0'] = result
            vector = None
            continue
        if op == 'ret' and retrieved and get('x0') == ('output',): return True
        raise ValueError('unsupported discovery retrieval instruction: ' + op)
    raise ValueError('discovery retrieval output unavailable')
