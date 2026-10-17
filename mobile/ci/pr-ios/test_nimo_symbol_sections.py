import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from nimo_symbol_sections import macho_layout, normalize_demangled, symbol_windows, normalize_window, imported_stubs, archive_symbol_sections, persist_trace

UUID = bytes(range(16))
def macho():
    offset = 32 + 24 + 152
    header = struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 2, 176, 0, 0)
    uuid = struct.pack('<II', 0x1b, 24) + UUID
    segment = struct.pack('<II16sQQQQiiII', 0x19, 152, b'__TEXT', 0x1000, 16, offset, 16, 7, 5, 1, 0)
    section = struct.pack('<16s16sQQIIIIIIII', b'__text', b'__TEXT', 0x1000, 16, offset, 2, 0, 0, 0x80000400, 0, 0, 0)
    return header + uuid + segment + section + bytes(16)

class SectionsTests(unittest.TestCase):
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
