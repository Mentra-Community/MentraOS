import struct
import json
from types import SimpleNamespace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from nimo_symbol_sections import macho_layout, normalize_demangled, symbol_windows, normalize_window, imported_stubs, archive_symbol_sections, persist_trace, symbol_rows, file_backed_reader, data_imports_from_indirect, rebase_pointers, symbol_roster, owned_symbol_rows, BoundedRebaseLookup

UUID = bytes(range(16))
def macho():
    offset = 32 + 24 + 152
    header = struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 2, 176, 0, 0)
    uuid = struct.pack('<II', 0x1b, 24) + UUID
    segment = struct.pack('<II16sQQQQiiII', 0x19, 152, b'__TEXT', 0x1000, 16, offset, 16, 7, 5, 1, 0)
    section = struct.pack('<16s16sQQIIIIIIII', b'__text', b'__TEXT', 0x1000, 16, offset, 2, 0, 0, 0x80000400, 0, 0, 0)
    return header + uuid + segment + section + bytes(16)

def macho_got():
    data=bytearray(macho())
    text=bytes(data[32+24:32+24+152])
    got=bytearray(text)
    struct.pack_into('<16sQQQQ',got,8,b'__DATA_CONST',0x2000,16,32+24+304+16,16)
    struct.pack_into('<16s16sQQI',got,72,b'__got',b'__DATA_CONST',0x2000,16,32+24+304+16)
    struct.pack_into('<I',got,72+64,6)
    text=bytearray(text)
    struct.pack_into('<QQQQ',text,24,0x1000,16,32+24+304,16)
    struct.pack_into('<I',text,72+48,32+24+304)
    header=bytearray(data[:32]);struct.pack_into('<II',header,16,3,24+304)
    return bytes(header+data[32:56]+text+got+bytes(32))

class SectionsTests(unittest.TestCase):
    def test_actual_scale_fixup_metadata_resolves_only_consumed_slots(self):
        # Generated actual record count, not a 29MB repository fixture.
        metadata=''.join(f' __DATA_CONST __const 0x{0x300000000+8*i:016x} rebase 0x0000000100000000\n' for i in range(326917))
        metadata+=' __DATA_CONST __got 0x2000 rebase 0x1004\n'
        self.assertGreater(len(metadata),16*1024*1024)
        gate={'expired':False}
        def check():
            if gate['expired']:raise ValueError('original deadline expired')
        lookup=BoundedRebaseLookup(metadata,macho_got(),check)
        self.assertEqual(lookup.metrics['records'],326918)
        self.assertEqual(lookup(0x2000),0x1004);self.assertEqual(lookup.cache,{0x2000:0x1004})
        gate['expired']=True
        with self.assertRaisesRegex(ValueError,'deadline'):lookup(0x2000)
        with patch('nimo_symbol_sections.MAX_NM_BYTES',16),self.assertRaisesRegex(ValueError,'64MiB'):
            BoundedRebaseLookup(metadata,macho_got())
        with patch('nimo_symbol_sections.MAX_ROSTER_ROWS',2),self.assertRaisesRegex(ValueError,'500k'):
            BoundedRebaseLookup(metadata,macho_got())

    def test_selected_fixup_rejects_bind_duplicate_unknown_and_exhausted_scan(self):
        valid=' __DATA_CONST __got 0x2000 rebase 0x1004\n'
        for text in (valid+valid,valid.replace('rebase 0x1004','bind lib/__Block_copy'),valid.replace('rebase','auth-rebase'),''):
            lookup=BoundedRebaseLookup(text,macho_got())
            with self.assertRaises(ValueError):lookup(0x2000)
            self.assertEqual(lookup.cache,{})
        state={'active':False,'count':0}
        def check():
            if state['active']:
                state['count']+=1
                if state['count']==3:raise ValueError('expired at scan completion')
        lookup=BoundedRebaseLookup(valid,macho_got(),check);state['active']=True
        with self.assertRaisesRegex(ValueError,'scan completion'):lookup(0x2000)
        self.assertEqual(lookup.cache,{})
        lookup=BoundedRebaseLookup('',macho_got())
        for i in range(64):
            with self.assertRaisesRegex(ValueError,'no supported'):lookup(0x2000+8*i)
        with self.assertRaisesRegex(ValueError,'64-slot'):lookup(0x5000)

    def test_data_imports_and_rebases_are_exact_delivered_sections_not_call_stubs(self):
        data=macho_got()
        indirect='Indirect symbols for (__DATA_CONST,__got) 1 entries\n0x2000 9 __NSConcreteStackBlock\n'
        self.assertEqual(data_imports_from_indirect(indirect,data),{0x2000:'__NSConcreteStackBlock'})
        self.assertEqual(imported_stubs(indirect),{})
        for changed in (indirect.replace('0x2000','0x2001'),indirect.replace('0x2000','0x2010'),indirect+'0x2000 9 __NSConcreteStackBlock\n'):
            with self.assertRaises(ValueError):data_imports_from_indirect(changed,data)
        line=' __DATA_CONST __got 0x2000 rebase 0x1004\n'
        self.assertEqual(rebase_pointers(line,data),{0x2000:0x1004})
        self.assertEqual(rebase_pointers(line.replace('rebase 0x1004','bind lib/__Block_copy'),data),{})
        for changed in (line+line,line.replace('0x2000','0x2001'),line.replace('0x2000','0x2010'),line.replace('0x1004','authenticated 0x1004')):
            with self.assertRaises(ValueError):rebase_pointers(changed,data)
        with patch('nimo_symbol_sections.MAX_WINDOW',4):
            # Data-table validation is section-based, independent of code windows.
            self.assertEqual(rebase_pointers(line,data),{0x2000:0x1004})

    def test_actual_scale_unrelated_roster_never_expands_owned_demangle_budget(self):
        raw=''.join(f'{0x2000+4*i:x} t _unrelated_{i}\n' for i in range(213569))
        raw+='1000 t _$s18MentraBluetoothSDK5Entry6methodyyF\n1004 t _$sScTtask\n'
        roster=symbol_roster(raw);owned=owned_symbol_rows(roster)
        self.assertEqual(len(roster),213571);self.assertEqual(len(owned),2)
        self.assertEqual(owned_symbol_rows(roster+[(0x1000,'_foreign_alias')]),[owned[1]])
        self.assertEqual(owned_symbol_rows(roster+[(0x1008,owned[0][1])]),[owned[1]])
        with self.assertRaisesRegex(ValueError,'owned compiler symbols'):
            owned_symbol_rows([(0x1000,owned[0][1]),(0x1000,'_foreign_alias')])
        self.assertEqual(symbol_windows(owned,['SDK.Entry.method()','Swift.Task.init()'],['Entry.method('],(0x1000,0x200000),roster),[(0x1000,0x1004,owned[0][1])])
        with self.assertRaisesRegex(ValueError,'owned compiler symbols'):owned_symbol_rows([(0x1000,'_notSDK')])
        with patch('nimo_symbol_sections.MAX_SYMBOLS',1),self.assertRaisesRegex(ValueError,'owned compiler symbols'):owned_symbol_rows(roster)
        with patch('nimo_symbol_sections.MAX_ROSTER_ROWS',2),self.assertRaisesRegex(ValueError,'roster exceeds bound'):symbol_roster(raw)
        with patch('nimo_symbol_sections.MAX_NM_BYTES',10),self.assertRaisesRegex(ValueError,'64MiB'):symbol_roster(raw)
        with self.assertRaisesRegex(ValueError,'parsed=0'):symbol_roster('no text symbols')

    def test_required_aliased_root_is_omitted_but_unused_alias_is_never_adopted(self):
        from test_nimo_capability import witnesses
        from nimo_capability import compiled_witness
        nm,names,assembly=witnesses()
        nm=nm.replace('_$sSynthetic','_$s18MentraBluetoothSDK')
        assembly=assembly.replace('_$sSynthetic','_$s18MentraBluetoothSDK')
        roster=symbol_roster(nm)
        by_name={symbol:name for (_,symbol),name in zip(roster,names)}
        required=next(address for address,symbol in roster if symbol.endswith('sdkInit'))
        selected=owned_symbol_rows(roster+[(required,'_unrelated_alias')])
        filtered='\n'.join(f'{a:x} t {symbol}' for a,symbol in selected)
        with self.assertRaisesRegex(ValueError,'entries unavailable: sdkInit'):
            compiled_witness(filtered,[by_name[symbol] for _,symbol in selected],assembly)
        duplicate_name=next(symbol for _,symbol in roster if symbol.endswith('sdkInit'))
        selected=owned_symbol_rows(roster+[(0xfffc,duplicate_name)])
        with self.assertRaisesRegex(ValueError,'entries unavailable: sdkInit'):
            compiled_witness('\n'.join(f'{a:x} t {symbol}' for a,symbol in selected),[by_name[symbol] for _,symbol in selected],assembly)
        changed=roster+[(0xffff,'_$s18MentraBluetoothSDKunused'),(0xffff,'_foreign_unused_alias')]
        selected=owned_symbol_rows(changed)
        self.assertEqual(selected,roster)
        self.assertEqual(len(compiled_witness('\n'.join(f'{a:x} t {symbol}' for a,symbol in selected),[by_name[symbol] for _,symbol in selected],assembly)),17)

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

    def test_lazy_duplicate_name_cannot_substitute_an_already_cached_body(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();exe=root/'Mentra';exe.write_bytes(macho())
            dwarf=root/'mobile/build/pr-ios/Mentra.xcarchive/dSYMs/Mentra.app.dSYM/Contents/Resources/DWARF/Mentra';dwarf.parent.mkdir(parents=True);dwarf.write_bytes(b'dsym')
            def run(*args,timeout):
                if 'dwarfdump' in args:return b'UUID: 00010203-0405-0607-0809-0a0b0c0d0e0f (arm64) file\n'
                if 'nm' in args:return b'1000 t _$s18MentraBluetoothSDK5Entry6methodyyF\n1004 t _copyHelper\n1008 t _copyHelper\n'
                if '--indirect-symbols' in args or 'dyld_info' in args:return b''
                return b'1000: ret\n'
            def proof(functions,symbols,imports,reader,get_function,*unused):
                functions['_copyHelper']=(0x1004,0x1008,'_copyHelper:\n1004 ret')
                self.assertNotIn(0x1004,symbols);self.assertNotIn(0x1008,symbols)
                for entry in (0x1004,0x1008):
                    with self.assertRaisesRegex(ValueError,'ambiguous'):get_function(entry)
                return set()
            with patch('nimo_symbol_sections.subprocess.run',return_value=SimpleNamespace(stdout=b'SDK.Entry.method()\n')),patch('nimo_async_invocations.prove_async_edges',side_effect=proof):
                archive_symbol_sections(exe,root,['Entry.method('],run,async_edges=set())

    def test_async_failure_retains_selected_delivered_sections_without_qualifying(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();exe=root/'Mentra';data=bytearray(macho())
            struct.pack_into('<QQQQ',data,32+24+24,0x1000,16,len(data)-16,16);exe.write_bytes(data)
            dwarf=root/'mobile/build/pr-ios/Mentra.xcarchive/dSYMs/Mentra.app.dSYM/Contents/Resources/DWARF/Mentra';dwarf.parent.mkdir(parents=True);dwarf.write_bytes(b'dsym')
            def run(*args,timeout):
                if 'dwarfdump' in args:return ('UUID: '+UUID.hex()[:8]+'-'+UUID.hex()[8:12]+'-'+UUID.hex()[12:16]+'-'+UUID.hex()[16:20]+'-'+UUID.hex()[20:]+' (arm64) file\n').encode()
                if 'nm' in args:return b'1000 t _$s18MentraBluetoothSDK5Entry6methodyyF\n'
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
