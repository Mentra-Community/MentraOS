import copy
import json
from pathlib import Path
import unittest
from nimo_discovery_witness import retrieval_argument, objc_selector, compiled_discovery, DISCOVERY_SELECTORS, observer_calls, distinct_witnesses


class DiscoveryWitnessTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads((Path(__file__).parent / 'fixtures/nimo-connected-retrieval.json').read_text())

    def prove(self, body=None, fixture=None):
        f = fixture or self.fixture
        def read(address, count): return bytes.fromhex(f['reads'][f'{address:x}:{count}'])
        def pointer(slot): return f['pointers'][hex(slot)]
        def imported(slot): return f['imports'].get(hex(slot))
        def section(address, count, segment, name):
            b = f['sections'].get(segment + ',' + name)
            return b is not None and b[0] <= address and address + count <= b[1]
        def selector(address): return objc_selector(address, read, pointer, imported, section)
        return retrieval_argument(body or f['body'], read, imported, selector, set(f['metadataCalls']),
                                  lambda address, count, name: section(address, count, '__TEXT', name))

    def test_actual_optimized_fixed_service_expression(self):
        self.assertTrue(self.prove())

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
        symbols = {key: '_$sProof' + key for key in selectors}
        addresses = {key: 0x1000 + index * 0x100 for index, key in enumerate(selectors)}
        nm = '\n'.join(f'{addresses[key]:x} t {symbols[key]}' for key in selectors)
        assembly = symbols['fixturePerform'] + ':\n1000 bl 0x1100\n1004 bl 0x1300\n' + symbols['discoveryStart'] + ':\n1100 bl 0x1200\n1104 bl 0x1400\n' + symbols['discoveryStop'] + ':\n1300 bl 0x1400\n'
        facts = {'fixedServiceArgument': True, 'retrievalSymbol': symbols['discoveryRetrieve']}
        self.assertEqual(len(compiled_discovery(nm, names, assembly, (), facts)['symbols']), 3)
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
