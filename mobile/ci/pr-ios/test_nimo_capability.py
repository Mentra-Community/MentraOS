import contextlib
import io
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from nimo_capability import EDGES, ROLES, SOURCE_FILES, compiled_witness, select_role_witnesses, ios_arm64, optional_nimo_capability, source_digest


def macho(platform=2):
    return struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 1, 24, 0, 0) + struct.pack('<6I', 0x32, 24, platform, 0, 0, 0)


def witnesses():
    names = {role: '_$sSynthetic' + role for role in ROLES}
    addresses = {role: 0x1000 + index * 0x100 for index, role in enumerate(ROLES)}
    nm = '\n'.join(f'{addresses[role]:016x} t {names[role]}' for role in ROLES)
    demangled = ['BluetoothSDK.' + selector + ')' for selector in ROLES.values()]
    blocks = []
    for role in ROLES:
        body = [names[role] + ':']
        body += [f'0000 bl 0x{addresses[target]:x}' for source, target in EDGES if source == role]
        if role == 'peerAllowed':
            body += ['0000 mov w1, #0x0', '0000 mov w2, #0x2', '0000 bl 0x2 ; _getsockopt',
                     '0000 bl 0x3 ; _getpeereid', '0000 mov w1, #0x0', '0000 mov w2, #0x6',
                     '0000 bl 0x2 ; _getsockopt']
        blocks += body
    return nm, demangled, '\n'.join(blocks)


class CapabilityTests(unittest.TestCase):
    def test_one_symbol_cannot_witness_multiple_roles(self):
        for alias in (False, True):
            roots = {role: {('' if alias and index % 2 else '_') + '$sReusedMethod'}
                     for index, role in enumerate(ROLES)}
            with self.assertRaisesRegex(ValueError, 'multiple roles'):
                select_role_witnesses(roots)

    def test_platform_is_actual_bounded_macho_not_a_string(self):
        ios_arm64(macho())
        for data in (b'ios-on-mac', macho(1), macho()[:-1], macho()[:16]):
            with self.assertRaises(ValueError):
                ios_arm64(data)

    def test_actual_symbol_call_graph_required(self):
        nm, demangled, assembly = witnesses()
        proof = compiled_witness(nm, demangled, assembly)
        self.assertEqual(len(proof), 17)
        self.assertEqual({item.split(':')[0] for item in proof}, set(ROLES))
        for bad in (assembly.replace('bl ', 'nop ', 1), assembly.replace('_getpeereid', '_unrelated'), ''):
            with self.assertRaises(ValueError):
                compiled_witness(nm, demangled, bad)
        with self.assertRaises(ValueError):
            compiled_witness('', demangled, assembly)

    def test_unknown_multiwrite_or_control_flow_invalidates_kernel_arguments(self):
        nm, demangled, assembly = witnesses()
        call = '0000 bl 0x2 ; _getsockopt'
        self.assertEqual(assembly.count(call), 2)
        for index in range(2):
            for instruction in ('ldp x0,x1,[sp]', 'ldp x1,x2,[sp]', 'b 0xdead', 'mystery x0,x1'):
                parts = assembly.split(call)
                parts[index] += '0000 ' + instruction + '\n'
                changed = call.join(parts)
                with self.subTest(index=index, instruction=instruction), self.assertRaises(ValueError):
                    compiled_witness(nm, demangled, changed)

    def test_uninvoked_closure_cannot_replace_real_entry_call(self):
        nm, demangled, assembly = witnesses()
        target_index = list(ROLES).index('fixtureStart')
        target_address = 0x1000 + target_index * 0x100
        sdk = '_$sSyntheticsdkInit:'
        real = sdk + '\n' + f'0000 bl 0x{target_address:x}'
        self.assertIn(real, assembly)
        assembly = assembly.replace(real, sdk + '\n0000 nop')
        nm += '\n000000000000ffff t _$sDeadSdkClosure'
        demangled += ['closure #99 in BluetoothSDK.MentraBluetoothSDK.init()']
        assembly += '\n_$sDeadSdkClosure:\n' + f'0000 bl 0x{target_address:x}'
        with self.assertRaises(ValueError):
            compiled_witness(nm, demangled, assembly)

    def test_real_compiler_peer_window_satisfies_unchanged_kernel_arguments(self):
        # Only peerAllowed is actual compiled transport code; all other roles
        # remain the explicit synthetic graph fixture, not full APK evidence.
        nm, demangled, assembly = witnesses()
        index = list(ROLES).index('peerAllowed')
        old_address = 0x1000 + index * 0x100
        actual = (Path(__file__).parent / 'fixtures/nimo-peer-bounded.txt').read_text()
        symbol = actual.splitlines()[0][:-1]
        nm = nm.replace(f'{old_address:016x} t _$sSyntheticpeerAllowed', f'{0x62a8:016x} t {symbol}')
        demangled[index] = 'MentraBluetoothSDK.NimoMacResourceTransport.peerAllowed(Swift.Int32) -> Swift.Bool'
        start = assembly.index('_$sSyntheticpeerAllowed:')
        end = assembly.find('\n_$sSynthetic', start + 1)
        assembly = assembly[:start] + actual + (assembly[end:] if end >= 0 else '')
        assembly = assembly.replace(f'bl 0x{old_address:x}', 'bl 0x62a8')
        self.assertEqual(len(compiled_witness(nm, demangled, assembly)), len(ROLES))
        with self.assertRaisesRegex(ValueError, 'socket option call arguments'):
            compiled_witness(nm, demangled, assembly.replace('6300 bl ', '6300 ldp x0,x1,[sp]\n6300 bl ', 1))

    def test_source_hash_binds_all_fixed_source_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for path in SOURCE_FILES:
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(path.encode())
            original = source_digest(root)
            (root / SOURCE_FILES[-1]).write_bytes(b'changed')
            self.assertNotEqual(original, source_digest(root))
            (root / SOURCE_FILES[-1]).unlink()
            with self.assertRaises(FileNotFoundError):
                source_digest(root)

    def test_descriptor_binds_exact_executable_and_compilation_source(self):
        import hashlib
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for path in SOURCE_FILES:
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(path.encode())
            executable = root / 'Mentra'
            executable.write_bytes(macho())
            nm, demangled, assembly = witnesses()
            def run(*args):
                if args[0] == 'git':
                    return args[-1].split(':', 1)[1].encode()
                return (nm if args[1] == 'nm' else assembly).encode()
            result = subprocess.CompletedProcess([], 0, stdout=('\n'.join(demangled)+'\n').encode())
            with patch('nimo_capability.archive_symbol_sections', return_value=(nm, demangled, assembly)):
                descriptor = optional_nimo_capability(executable, root, 'a'*40, run)
                self.assertEqual(descriptor['executableSha256'], hashlib.sha256(macho()).hexdigest())
                self.assertEqual(descriptor['sourceSha256'], source_digest(root))
                (root / SOURCE_FILES[0]).write_bytes(b'drifted fixture')
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertIsNone(optional_nimo_capability(executable, root, 'a'*40, run))

    def test_optional_missing_proof_does_not_break_ordinary_publication(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stderr(io.StringIO()) as diagnostic:
            executable = Path(temp) / 'Mentra'
            executable.write_bytes(macho())
            with patch('nimo_capability.subprocess.check_output', side_effect=OSError('tool unavailable')):
                self.assertIsNone(optional_nimo_capability(executable, Path(temp)))
            self.assertIn('capability omitted', diagnostic.getvalue())


if __name__ == '__main__':
    unittest.main()
