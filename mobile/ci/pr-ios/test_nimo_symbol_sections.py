import struct
import json
from types import SimpleNamespace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from nimo_symbol_sections import macho_layout, normalize_demangled, symbol_windows, normalize_window, imported_stubs, archive_symbol_sections, persist_trace, symbol_rows, file_backed_reader

UUID = bytes(range(16))
def macho():
    offset = 32 + 24 + 152
    header = struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 2, 176, 0, 0)
    uuid = struct.pack('<II', 0x1b, 24) + UUID
    segment = struct.pack('<II16sQQQQiiII', 0x19, 152, b'__TEXT', 0x1000, 16, offset, 16, 7, 5, 1, 0)
    section = struct.pack('<16s16sQQIIIIIIII', b'__text', b'__TEXT', 0x1000, 16, offset, 2, 0, 0, 0x80000400, 0, 0, 0)
    return header + uuid + segment + section + bytes(16)

class SectionsTests(unittest.TestCase):
    def test_symbol_rejection_names_actual_count_and_bound(self):
        with self.assertRaisesRegex(ValueError, r'parsed=0 limit=200000 nmBytes=4'):
            symbol_rows('none')
        with patch('nimo_symbol_sections.MAX_SYMBOLS', 1):
            with self.assertRaisesRegex(ValueError, r'parsed=2 limit=1'):
                symbol_rows('1000 t _one\n1004 t _two\n')

    def test_async_descriptor_reads_only_exact_file_backed_bytes_with_finite_budget(self):
        data=bytearray(macho())
        # The fixture header maps __text at the section file offset.
        struct.pack_into('<QQQQ',data,32+24+24,0x1000,16,len(data)-16,16)
        read=file_backed_reader(bytes(data))
        self.assertEqual(read(0x1000,16),bytes(16))
        for address,count in ((0xfff,1),(0x100f,2),(0x1000,0),(0x1000,257)):
            with self.assertRaises(ValueError):read(address,count)
        for _ in range(4095):read(0x1000,16)
        with self.assertRaisesRegex(ValueError,'bound'):read(0x1000,1)
        # Zero-fill VM space cannot supply compiler descriptors.
        struct.pack_into('<QQQQ',data,32+24+24,0x1000,32,len(data)-16,16)
        with self.assertRaisesRegex(ValueError,'file-backed'):file_backed_reader(bytes(data))(0x1010,1)

    def test_delivered_uuid_and_exact_text_extent(self):
        self.assertEqual(macho_layout(macho()), (UUID.hex(), (0x1000, 0x1010)))
        for data in (macho()[:-1], b'fake UUID', macho()[:40]):
            with self.assertRaises(ValueError): macho_layout(data)

    def test_only_private_method_spelling_normalized_never_closure_root(self):
        name='SDK.Nimo.(releaseResource in _ABC123)(Object)'
        self.assertEqual(normalize_demangled(name),'SDK.Nimo.releaseResource(Object)')
        closure='closure #1 in ' + name
        self.assertTrue(normalize_demangled(closure).startswith('closure #1 in '))
        self.assertEqual(normalize_demangled('(releaseResource in _ABC123)(Object)'), '(releaseResource in _ABC123)(Object)')
        self.assertEqual(normalize_demangled('SDK.Transport.__allocating_init(process:)'),'SDK.Transport.init(process:)')
        self.assertTrue(normalize_demangled('closure #1 in SDK.Transport.__allocating_init(process:)').startswith('closure #1 in '))

    def test_compiler_windows_require_actual_text_addresses_and_next_symbol_bound(self):
        rows=[(0x1000,'_entry'),(0x1008,'_unrelated')]
        self.assertEqual(symbol_windows(rows,['SDK.Entry.method()','SDK.Other()'],['Entry.method('],(0x1000,0x1010)),[(0x1000,0x1008,'_entry')])
        for changed in ([(0x999,'_entry'),(0x1008,'_other')],[(0x1010,'_entry'),(0x1008,'_other')]):
            with self.assertRaises(ValueError):symbol_windows(changed,['SDK.Entry.method()','SDK.Other()'],['Entry.method('],(0x1000,0x1010))
        with patch('nimo_symbol_sections.MAX_TOTAL_TEXT', 4), self.assertRaises(ValueError):symbol_windows(rows,['SDK.Entry.method()','SDK.Other()'],['Entry.method('],(0x1000,0x1010))

    def test_ignored_ranges_missing_instructions_and_forged_annotations_rejected(self):
        imports=imported_stubs('Indirect symbols for (__TEXT,__stubs) 1 entries\naddress index name\n0x0000000000002000 1 _getsockopt\n')
        result=normalize_window('1000: mov w1, #0x0 ; =0\n1004: bl 0x2000 <_fake>\n',0x1000,0x1008,'_entry',imports)
        self.assertIn('1004 bl 0x2000 ; _getsockopt',result);self.assertNotIn('_fake',result)
        self.assertNotIn('getsockopt',normalize_window('1000: bl 0x3000 <_getsockopt>\n',0x1000,0x1004,'_entry',imports))
        for output in ('0ffc: nop\n1000: nop\n1004: ret\n','1000: nop\n','1000: nop\n1008: ret\n'):
            with self.assertRaises(ValueError):normalize_window(output,0x1000,0x1008,'_entry',imports)

    def test_trace_is_private_idempotent_and_never_overwrites_changed_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();path=root/'xcodebuild-attempt-nimo-capability.log'
            trace={'kind':'sections-only','assembly':'1000 ret'}
            persist_trace(path,trace);original=path.read_bytes();persist_trace(path,trace)
            self.assertEqual(path.read_bytes(),original)
            with self.assertRaisesRegex(ValueError,'bytes changed|identity changed'):persist_trace(path,{'kind':'different'})
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'identity changed'):persist_trace(path,trace)
            path.unlink();path.symlink_to(root/'foreign')
            with self.assertRaises(OSError):persist_trace(path,trace)

    def test_async_failure_retains_selected_delivered_sections_without_qualifying(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();exe=root/'Mentra';data=bytearray(macho())
            struct.pack_into('<QQQQ',data,32+24+24,0x1000,16,len(data)-16,16);exe.write_bytes(data)
            dwarf=root/'mobile/build/pr-ios/Mentra.xcarchive/dSYMs/Mentra.app.dSYM/Contents/Resources/DWARF/Mentra';dwarf.parent.mkdir(parents=True);dwarf.write_bytes(b'dsym')
            def run(*args,timeout):
                if 'dwarfdump' in args:return ('UUID: '+UUID.hex()[:8]+'-'+UUID.hex()[8:12]+'-'+UUID.hex()[12:16]+'-'+UUID.hex()[16:20]+'-'+UUID.hex()[20:]+' (arm64) file\n').encode()
                if 'nm' in args:return b'1000 t _entry\n'
                if '--indirect-symbols' in args:return b''
                return b'1000: nop\n1004: nop\n1008: nop\n100c: ret\n'
            trace=root/'xcodebuild-attempt-nimo-capability.log'
            with patch('nimo_symbol_sections.subprocess.run',return_value=SimpleNamespace(stdout=b'SDK.Entry.method()\n')), patch('nimo_async_invocations.prove_async_edges',side_effect=ValueError('exact scheduler unsupported')):
                with self.assertRaisesRegex(ValueError,'scheduler unsupported'):
                    archive_symbol_sections(exe,root,['Entry.method('],run,diagnostic_path=trace,async_edges=set())
            saved=json.loads(trace.read_text());self.assertFalse(saved['capabilityVerified'])
            self.assertEqual(saved['asyncProofError'],'exact scheduler unsupported')
            self.assertIn('100c ret',saved['assembly'])
            stage=json.loads((root/'xcodebuild-attempt-nimo-symbol-stage.log').read_text())
            self.assertEqual(stage['parsedTextCount'],1)

    def test_uuid_mismatch_and_finite_remaining_timeout_before_disassembly(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);exe=root/'Mentra';exe.write_bytes(macho())
            dwarf=root/'mobile/build/pr-ios/Mentra.xcarchive/dSYMs/Mentra.app.dSYM/Contents/Resources/DWARF/Mentra';dwarf.parent.mkdir(parents=True);dwarf.write_bytes(b'compiler dSYM fixture')
            calls=[]
            def wrong(*args,timeout):calls.append((args,timeout));return b'UUID: FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF (arm64) file\n'
            with self.assertRaisesRegex(ValueError,'UUID differs'):archive_symbol_sections(exe,root,['Entry.method('],wrong)
            self.assertEqual(len(calls),1);self.assertLessEqual(calls[0][1],60)
            times=iter([0,80])
            with self.assertRaisesRegex(ValueError,'UUID differs'):archive_symbol_sections(exe,root,['Entry.method('],wrong,lambda:next(times))
            self.assertEqual(calls[-1][1],40)
            times=iter([0,121])
            with self.assertRaisesRegex(ValueError,'deadline expired'):archive_symbol_sections(exe,root,['Entry.method('],wrong,lambda:next(times))
            self.assertEqual(len(calls),2)

if __name__=='__main__':unittest.main()
