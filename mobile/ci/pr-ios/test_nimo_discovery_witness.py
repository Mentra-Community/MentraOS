import copy
import json
from pathlib import Path
import unittest
from nimo_discovery_witness import retrieval_argument, objc_selector, compiled_discovery, DISCOVERY_SELECTORS, observer_calls, distinct_witnesses, RETRIEVAL_SIGNATURE, RETRIEVAL_SPECIALIZATION, StorageMetadata


class DiscoveryWitnessTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads((Path(__file__).parent / 'fixtures/nimo-connected-retrieval.json').read_text())

    def prove(self, body=None, fixture=None, metadata=None):
        f = fixture or self.fixture
        def read(address, count): return bytes.fromhex(f['reads'][f'{address:x}:{count}'])
        def pointer(slot): return f['pointers'][hex(slot)]
        def imported(slot): return f['imports'].get(hex(slot))
        def section(address, count, segment, name):
            b = f['sections'].get(segment + ',' + name)
            return b is not None and b[0] <= address and address + count <= b[1]
        def selector(address): return objc_selector(address, read, pointer, imported, section)
        return retrieval_argument(body or f['body'], read, imported, selector, set(f['metadataCalls']),
                                  lambda address, count, name: section(address, count, '__TEXT', name), metadata)

    def actual_fixture(self):
        return json.loads((Path(__file__).parent / 'fixtures/nimo-connected-retrieval-ios-10a04.json').read_text())

    def prove_actual(self, fixture=None):
        f = fixture or self.actual_fixture()
        def read(address, count):
            try: return bytes.fromhex(f['reads'][f'{address:x}:{count}'])
            except KeyError: raise ValueError('unavailable actual selected bytes')
        def bind(slot):
            try: return f['bindings'][hex(slot)]
            except KeyError: raise ValueError('unavailable actual selected bind')
        def imported(slot): return bind(slot)['symbol']
        def pointer(slot):
            try: return f['pointers'][hex(slot)]
            except KeyError: raise ValueError('unavailable actual selected rebase')
        def section(address, count, segment, name):
            b = f['sections'].get(segment + ',' + name)
            return b is not None and b[0] <= address and address + count <= b[1]
        def static(address, count, kind):
            if kind == 'zero-cache':
                b = f['sections'].get('__DATA,__data')
                valid = address % 8 == 0 and count == 8 and f['segmentProtections'].get('__DATA', 0) & 3 == 3 and b is not None and b[3] & 0xff == 0 and section(address, count, '__DATA', '__data')
            else:
                name = {'descriptor': '__const', 'typeref': '__swift5_typeref'}[kind]
                b = f['sections'].get('__TEXT,' + name)
                valid = f['segmentProtections'].get('__TEXT', 0) & 1 and not f['segmentProtections'].get('__TEXT', 0) & 2 and b is not None and b[3] & 0xff == 0 and section(address, count, '__TEXT', name)
            if not valid: raise ValueError('wrong actual static section')
            return read(address, count)
        def body(address):
            try: return f['functions'][hex(address)]
            except KeyError: raise ValueError('unavailable exact delivered helper body')
        metadata = StorageMetadata(body, lambda address: f['names'].get(hex(address)),
                                   {int(a, 16): v for a, v in f['imports'].items()}, bind, static)
        return retrieval_argument(body(f['retrievalAddress']), read, imported,
            lambda address: objc_selector(address, read, pointer, imported, section), set(),
            lambda address, count, name: bool(f['segmentProtections'].get('__TEXT', 0) & 1 and not f['segmentProtections'].get('__TEXT', 0) & 2 and section(address, count, '__TEXT', name)), metadata)

    def test_actual_ios_storage_policy_both_branches_and_aliased_helper_bodies(self):
        self.assertTrue(self.prove_actual())
        f = self.actual_fixture()
        # The class helper has no usable compiler identity; names do not grant
        # authority. Its entire delivered body still must match.
        f['names']['0x10002a694'] = 'an arbitrary aliased helper name'
        self.assertTrue(self.prove_actual(f))
        f['functions']['0x10002a694'] = f['functions']['0x10002a694'].replace('ldr x0, [x2]', 'mov x0, #0x0')
        with self.assertRaises(ValueError): self.prove_actual(f)

    def test_actual_metadata_wrong_bind_descriptors_caches_and_layout_are_refused(self):
        mutations = [
            ('binding', '0x10385c828', 'CoreBluetooth', '_OBJC_CLASS_$_CBPeripheral'),
            ('binding', '0x103570948', 'libswiftCore', '_$sWrongStorageContext'),
            ('binding', '0x103570948', 'Foreign', '_$ss23_ContiguousArrayStorageCMn'),
            ('read', '10304de6a:17'), ('read', '10302fb1e:10'), ('read', '103920058:8'),
            ('body', '0x100dbd498', 'ldr w8, [x0, #0x30]', 'ldr x8, [x0, #0x30]'),
            ('body', '0x100dbd498', 'ldrh w9, [x0, #0x34]', 'ldr w9, [x0, #0x34]'),
            ('body', '0x100dbd498', 'and x8, x8, #0x1fffffff8', 'and x8, x8, #0xfffffff8'),
            ('body', '0x100dbd498', 'orr x2, x9, #0x7', 'orr x2, x9, #0xf'),
            ('body', '0x100dbd498', 'add x1, x1, #0x58', 'add x1, x1, #0x50'),
            ('body', '0x100b8cd28', 'adrp x0, 0x103920000', 'adrp x0, 0x10304d000'),
            ('body', '0x100b8cd28', 'add x0, x0, #0x58', 'add x0, x0, #0x50'),
            ('body', '0x10002a694', 'stlr x0, [x19]', 'stlr x0, [x20]'),
            ('body', '0x10063002c', 'cbz w0, 0x10063008c', 'cbz w0, 0x100630094'),
            ('body', '0x100005b7c', 'mov x3, #0x0', 'mov x3, x19'),
        ]
        for mutation in mutations:
            f = self.actual_fixture()
            if mutation[0] == 'binding': f['bindings'][mutation[1]] = {'library': mutation[2], 'symbol': mutation[3]}
            elif mutation[0] == 'read':
                value = bytes.fromhex(f['reads'][mutation[1]])
                f['reads'][mutation[1]] = (bytes([value[0] ^ 1]) + value[1:]).hex()
            else:
                self.assertIn(mutation[2], f['functions'][mutation[1]])
                f['functions'][mutation[1]] = f['functions'][mutation[1]].replace(mutation[2], mutation[3])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.prove_actual(f)

    def test_actual_early_releases_and_w_pointer_truncation_still_refuse(self):
        for before, after in [('100dbd554 mov x0, x20', '100dbd554 mov x0, x19'),
                              ('100dbd524 mov x0, x21', '100dbd524 mov x0, x20'),
                              ('100dbd524 mov x0, x21', '100dbd524 mov x0, x23'),
                              ('100dbd554 mov x0, x20', '100dbd554 mov x0, x21'),
                              ('mov x19, x0', 'mov w19, w0')]:
            f = self.actual_fixture();key=hex(f['retrievalAddress'])
            self.assertIn(before, f['functions'][key])
            f['functions'][key] = f['functions'][key].replace(before, after)
            with self.subTest(before=before, after=after), self.assertRaises(ValueError): self.prove_actual(f)

    def test_cache_must_be_writable_and_descriptors_must_be_readonly_regular_data(self):
        for segment, protection in (('__DATA', 1), ('__DATA', 2), ('__TEXT', 3)):
            f = self.actual_fixture();f['segmentProtections'][segment] = protection
            with self.subTest(segment=segment, protection=protection), self.assertRaises(ValueError): self.prove_actual(f)
        for section in ('__DATA,__data', '__TEXT,__const', '__TEXT,__swift5_typeref'):
            f = self.actual_fixture();f['sections'][section][3] = 1
            with self.subTest(section=section), self.assertRaises(ValueError): self.prove_actual(f)

    def test_allocator_cannot_mix_two_recognized_storage_returns(self):
        f = self.actual_fixture();key=hex(f['retrievalAddress'])
        lines = f['functions'][key].splitlines()[1:]
        index = next(i for i, line in enumerate(lines) if '; _swift_allocObject' in line)
        operations = [line.split(' ', 1)[1] for line in lines]
        operations[index:index] = ['mov x21, x1', 'mov x22, x2', 'bl 0x100b8cd28', 'mov x1, x21', 'mov x2, x22']
        f['functions'][key] = '[mutated-body]:\n' + '\n'.join(f'{f["retrievalAddress"]+4*i:x} {op}' for i, op in enumerate(operations))
        with self.assertRaisesRegex(ValueError, 'allocation changed'): self.prove_actual(f)

    def test_actual_optimized_fixed_service_expression(self):
        self.assertTrue(self.prove())

    def test_production_requires_validated_dynamic_metadata_not_legacy_constant_layout(self):
        def unavailable(*_): raise ValueError('unsupported prototype metadata shape')
        production = StorageMetadata(unavailable, lambda _: None, {}, unavailable, unavailable)
        with self.assertRaises(ValueError): self.prove(metadata=production)

    def test_cross_capability_method_reuse_including_macho_underscore_is_refused(self):
        distinct_witnesses(['fixturePerform:_$sLifecycle'], ['discoveryStart:_$sDiscovery'])
        for symbol in ('_$sLifecycle', '$sLifecycle'):
            with self.subTest(symbol=symbol), self.assertRaises(ValueError):
                distinct_witnesses(['fixturePerform:_$sLifecycle'], ['discoveryStart:' + symbol])

    def test_service_literal_header_array_and_receiver_must_flow_to_retrieval(self):
        for before, after in [('mov x2, x21\ne94', 'mov x2, x19\ne94'),
                              ('mov x0, x19\ne90', 'mov x0, x20\ne90'),
                              ('str x23, [x20, #0x20]', 'str x21, [x20, #0x20]'),
                              ('mov x0, #0x24', 'mov x0, #0x23'),
                              ('mov w1, #0x28', 'mov w1, #0x30')]:
            body = self.fixture['body']
            self.assertIn(before, body)
            with self.subTest(before=before), self.assertRaises(ValueError): self.prove(body.replace(before, after))
        for key in ('10f0:37', '10a0:16'):
            f = copy.deepcopy(self.fixture)
            original = bytes.fromhex(f['reads'][key])
            f['reads'][key] = (bytes([original[0] ^ 1]) + original[1:]).hex()
            with self.subTest(key=key), self.assertRaises(ValueError): self.prove(fixture=f)

    def test_unknown_writes_control_flow_or_decoy_call_refuse(self):
        for instruction in ('b 0xe94', 'mov x2, xzr', 'ldp x0, x1, [sp]', 'bl 0xdead'):
            changed = self.fixture['body'].replace('e94 bl', 'e92 ' + instruction + '\ne94 bl')
            with self.subTest(instruction=instruction), self.assertRaises((ValueError, KeyError)): self.prove(changed)

    def test_w_register_moves_cannot_preserve_pointer_authority(self):
        for before, after in [('mov x19, x0', 'mov w19, w0'), ('mov x0, x19', 'mov w0, w19'),
                              ('mov x23, x0', 'mov w23, w0'), ('mov x2, x21', 'mov w2, w21')]:
            self.assertIn(before, self.fixture['body'])
            with self.subTest(before=before), self.assertRaises(ValueError): self.prove(self.fixture['body'].replace(before, after))
        for changed in (self.fixture['body'].replace('e94 bl', 'e92 .word 0\ne94 bl'),
                        self.fixture['body'].replace('e94 bl', 'e90 bl')):
            with self.assertRaises(ValueError): self.prove(changed)

    def test_actual_release_sites_cannot_retire_values_before_their_use(self):
        # Mutate existing compiler instructions rather than inventing a new
        # cleanup path. Actual releases are NSString after UUID construction,
        # raw array after bridging, services after retrieval and result after
        # output bridging; that original witness remains valid.
        mutations = [('e84 mov x0, x20', 'e84 mov x0, x19'),
                     ('e54 mov x0, x21', 'e54 mov x0, x20'),
                     ('e54 mov x0, x21', 'e54 mov x0, x23'),
                     ('e84 mov x0, x20', 'e84 mov x0, x21'),
                     ('e84 mov x0, x20', 'e84 mov x0, x23')]
        self.assertTrue(self.prove())
        for before, after in mutations:
            self.assertIn(before, self.fixture['body'])
            with self.subTest(before=before, after=after), self.assertRaises(ValueError):
                self.prove(self.fixture['body'].replace(before, after))

    def test_objc_label_is_not_selector_authority(self):
        for modification in ('selector', 'import', 'stub', 'class', 'readonly'):
            f = copy.deepcopy(self.fixture)
            if modification == 'selector': f['pointers']['0x8098'] = 0x119c
            elif modification == 'import': f['imports']['0x4028'] = '_untrusted'
            elif modification == 'class': f['imports']['0x4008'] = '_OBJC_CLASS_$_CBPeripheral'
            elif modification == 'readonly': f['sections'].pop('__TEXT,__cstring')
            else: f['reads']['1080:32'] = '00' * 32
            with self.subTest(modification=modification), self.assertRaises((ValueError, KeyError)): self.prove(fixture=f)

    def test_discovery_requires_real_calls_and_unambiguous_actual_entries(self):
        selectors = {'fixturePerform': 'NimoResourceFixture.perform(', **DISCOVERY_SELECTORS,
                     'discoveryFinish': 'NimoResourceConnectedDiscovery.finishDiscovery('}
        names = ['MentraBluetoothSDK.' + value + ')' for value in selectors.values()]
        names[list(selectors).index('discoveryRetrieve')] = RETRIEVAL_SIGNATURE
        symbols = {key: '_$sProof' + key for key in selectors}
        addresses = {key: 0x1000 + index * 0x100 for index, key in enumerate(selectors)}
        nm = '\n'.join(f'{addresses[key]:x} t {symbols[key]}' for key in selectors)
        assembly = symbols['fixturePerform'] + ':\n1000 bl 0x1100\n1004 bl 0x1300\n' + symbols['discoveryStart'] + ':\n1100 bl 0x1200\n1104 bl 0x1400\n' + symbols['discoveryStop'] + ':\n1300 bl 0x1400\n'
        facts = {'fixedServiceArgument': True, 'retrievalSymbol': symbols['discoveryRetrieve']}
        self.assertEqual(len(compiled_discovery(nm, names, assembly, (), facts)['symbols']), 3)
        specialized = names.copy();specialized[list(selectors).index('discoveryRetrieve')] = RETRIEVAL_SPECIALIZATION + RETRIEVAL_SIGNATURE
        self.assertEqual(len(compiled_discovery(nm, specialized, assembly, (), facts)['symbols']), 3)
        with self.assertRaisesRegex(ValueError, 'unproven discovery edge'):
            compiled_discovery(nm, specialized, assembly.replace('bl 0x1200', 'nop'), (), facts)
        for bad_name in ('function signature specialization <Arg[0] = Dead> of ' + RETRIEVAL_SIGNATURE,
                         'arbitrary prefix ' + RETRIEVAL_SIGNATURE,
                         RETRIEVAL_SPECIALIZATION + RETRIEVAL_SIGNATURE.replace('__C.CBCentralManager', 'Swift.Int')):
            bad = specialized.copy();bad[list(selectors).index('discoveryRetrieve')] = bad_name
            with self.subTest(name=bad_name), self.assertRaises(ValueError): compiled_discovery(nm, bad, assembly, (), facts)
        for bad in (assembly.replace('bl 0x1100', 'nop'), assembly.replace('bl 0x1200', 'nop'), assembly.replace('bl 0x1300', 'nop'), assembly.replace('bl 0x1400', 'nop')):
            with self.assertRaisesRegex(ValueError, 'unproven discovery edge'): compiled_discovery(nm, names, bad, (), facts)
        with self.assertRaises(ValueError): compiled_discovery(nm, names, assembly, (), {})
        with self.assertRaises(ValueError): compiled_discovery(nm+'\nf000 t _$sDuplicate', names+[names[1]], assembly, (), facts)
        with self.assertRaises(ValueError): compiled_discovery(nm, [name if index != 1 else 'closure #99 in ' + name for index, name in enumerate(names)], assembly, (), facts)

    def test_forbidden_selectors_are_scoped_to_actual_observer_bodies(self):
        functions = {'observer': (0x100, 0x104, '100 bl 0x200'), 'nimo': (0x300, 0x304, '300 bl 0x400')}
        names = {'observer': 'closure #1 in MentraBluetoothSDK.NimoResourceConnectedDiscovery.discoverConnected()',
                 'nimo': 'MentraBluetoothSDK.Nimo.startScan()'}
        methods = {0x200: 'retrieveConnectedPeripheralsWithServices:', 0x400: 'scanForPeripheralsWithServices:options:'}
        diagnostic = observer_calls(functions, names, {}, lambda a: a in methods, methods.__getitem__)
        self.assertEqual(diagnostic['resolvedSelectors'], [methods[0x200]])
        self.assertIs(diagnostic['provesNoEffects'], False)
        for forbidden in ('scanForPeripheralsWithServices:options:', 'connectPeripheral:options:', 'registerForConnectionEventsWithOptions:'):
            with self.subTest(forbidden=forbidden), self.assertRaises(ValueError):
                observer_calls(functions, names, {}, lambda a: a in methods, lambda _: forbidden)
        for target in ('MentraBluetoothSDK.Nimo.connectById()', 'MentraBluetoothSDK.DeviceManager.connectByName()'):
            with self.assertRaises(ValueError): observer_calls(functions, names, {0x200: target}, lambda _: False, methods.__getitem__)
        with self.assertRaises(ValueError):
            observer_calls({'observer': (0, 4, '0 bl 0x200 ; _objc_msgSend')}, names, {}, lambda _: False, methods.__getitem__)

    def test_indirect_or_unknown_calls_never_become_no_effects_authority(self):
        names = {'observer': 'MentraBluetoothSDK.NimoResourceConnectedDiscovery.discoverConnected()'}
        body = '100 blr x19\n104 br x20\n108 bl 0xdead'
        result = observer_calls({'observer': (0x100, 0x10c, body)}, names, {}, lambda _: False, lambda _: '')
        self.assertIs(result['provesNoEffects'], False)
        self.assertEqual([row['instruction'] for row in result['indirectTransfers']], ['blr', 'br'])
        self.assertEqual(result['unresolvedDirectCalls'][0]['target'], '0xdead')
        self.assertIs(result['truncated'], False)
        result = observer_calls({'observer': (0, 4096, '0 blr x19\n' * 300)}, names, {}, lambda _: False, lambda _: '')
        self.assertEqual(len(result['indirectTransfers']), 256)
        self.assertIs(result['truncated'], True)
        owner = 'owner' * 1000
        result = observer_calls({owner: (0, 4, '0 blr x19')}, {owner: names['observer']}, {}, lambda _: False, lambda _: '')
        self.assertEqual(len(result['indirectTransfers'][0]['owner']), 2048)
        self.assertIs(result['truncated'], True)


if __name__ == '__main__': unittest.main()
