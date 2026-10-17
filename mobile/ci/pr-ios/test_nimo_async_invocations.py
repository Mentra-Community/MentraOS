import copy
import json
import re
from pathlib import Path
import unittest
from nimo_async_invocations import prove_async_edges
from unittest.mock import patch

FIXTURE=Path(__file__).parent/'fixtures/nimo-async-libpeer.json'

class AsyncInvocationTests(unittest.TestCase):
    def setUp(self):
        self.f=json.loads(FIXTURE.read_text())
        self.symbols={int(a):tuple(v) for a,v in self.f['symbols'].items()}
        self.imports={int(a):n for a,n in self.f['imports'].items()}
        self.windows=self.f['windows']
        self.init=self.symbols[0x1da8][0];self.serve=self.symbols[0x3c00][0]
        self.dispatch=self.symbols[0x8ff0][0];self.task=self.symbols[0x9f28][0]
        self.body=self.symbols[0x6c90][0];self.continuation=self.symbols[0x6d00][0]
        self.requested=[]

    def prove(self):
        def get(a):
            self.requested.append(a)
            return self.windows[self.symbols[a][0]]
        def read(a,n):
            self.assertIn(n,(6,8,40))
            return bytes.fromhex(self.f['bytes'][str(a)])[:n]
        return prove_async_edges({s:self.windows[s] for s in self.f['initial']},self.symbols,self.imports,read,get,{int(a):n for a,n in self.f['data_imports'].items()},lambda a:self.f['rebases'][str(a)])

    def replace(self,addr,old,new):
        window=self.windows[self.symbols[addr][0]]
        self.assertIn(old,window[2]);window[2]=window[2].replace(old,new,1)

    def test_actual_compiler_blocks_tasks_and_continuations_are_consumed(self):
        self.assertEqual(self.prove(),{(self.init,self.dispatch),(self.serve,self.task),(self.body,self.continuation)})
        self.assertLessEqual(len(self.requested),16)

    def test_dead_named_closure_cannot_replace_missing_consumed_dispatch(self):
        dead='__dead_closure_99';self.symbols[0xf000]=(dead,'closure #99 in MentraBluetoothSDK.NimoMacResourceTransport.init(process:)')
        self.windows[dead]=[0xf000,0xf004,dead+':\nf000 b 0x3c00']
        self.replace(0x1da8,'33f0 mov x3, x23','33f0 mov x3, x24')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.assertNotIn(0xf000,self.requested)

    def test_block_copy_call_and_real_import_and_invoke_thunk_required(self):
        for address,old,new in [(0x1da8,'3334 bl 0xaaf4','3334 mov x0, x19'),(0x5898,'58b0 blr x19','58b0 blr x18'),(0x5898,'58a0 add x29, sp, #0x10','58a0 b 0x58b0'),(0x5898,'58a0 add x29, sp, #0x10','58a0 str x1, [x0, #0x20]'),(0x1da8,'330c str x8, [x19, #0x100]','330c str x8, [x19, #0x120]')]:
            with self.subTest(new=new):
                before=copy.deepcopy(self.windows)
                self.replace(address,old,new)
                self.assertNotIn((self.init,self.dispatch),self.prove())
                self.windows=before
        del self.imports[0xa950]
        self.assertNotIn((self.init,self.dispatch),self.prove())

    def test_unknown_alias_store_or_field_clobber_omits_dispatch(self):
        for old,new in [('330c str x8, [x19, #0x100]','330c str x8, [x17]'),('3338 str x0, [x19, #0xe0]','3338 str x0, [x19, #0xe8]'),('3358 str x8, [x19, #0xf8]','3358 str x8, [x17]')]:
            before=copy.deepcopy(self.windows);self.replace(0x1da8,old,new)
            self.assertNotIn((self.init,self.dispatch),self.prove());self.windows=before

    def test_task_descriptor_must_be_consumed_by_actual_initializer_and_runtime(self):
        self.replace(0x3c00,'4f88 bl 0x6e98','4f88 mov x1, x0')
        self.assertNotIn((self.serve,self.task),self.prove())
        self.setUp();del self.imports[0xad94]
        self.assertNotIn((self.serve,self.task),self.prove())
        self.setUp();self.f['bytes'][str(0xb3e0)]='0000000020000000'
        with self.assertRaises(ValueError):self.prove()

    def test_task_saved_argument_and_wrapper_register_clobbers_rejected(self):
        for address,old,new in [(0x6e98,'6ebc mov x22, x0','6ebc mov x21, x0'),(0xa0f0,'a13c mov x0, x19','a13c mov x21, x0'),(0x7130,'7168 str x0, [x22, #0x10]','7168 str x0, [sp, #0x8]'),(0x7130,'714c mov x19, x0','714c mov x1, x0'),(0xa0f0,'a108 mov x19, x0','a108 mov x20, x0'),(0xa0f0,'a108 mov x19, x0','a108 str x0, [x20, #0x10]'),(0xa0f0,'a108 mov x19, x0','a108 bl 0xdead')]:
            with self.subTest(new=new):
                before=copy.deepcopy(self.windows);self.replace(address,old,new)
                self.assertNotIn((self.serve,self.task),self.prove());self.windows=before

    def test_block_header_flags_signature_and_copy_semantics_are_proven(self):
        original=copy.deepcopy(self.f)
        self.f['data_imports'][str(0x10020)]='__UnrelatedObject'
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.f=copy.deepcopy(original)
        self.f['bytes'][str(0xaf40)]='0000004000000000' # No copy/dispose flag.
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.f=copy.deepcopy(original)
        raw=bytearray.fromhex(self.f['bytes'][str(0x10878)]);raw[8]=64
        self.f['bytes'][str(0x10878)]=raw.hex()
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.f=copy.deepcopy(original)
        self.f['bytes'][str(0xbac4)]='6938403f3000' # Wrong block signature.
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.f=copy.deepcopy(original)
        self.replace(0x9040,'9048 str q0, [x0, #0x20]','9048 str q0, [x0, #0x28]')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.windows=copy.deepcopy(original['windows'])
        self.replace(0x9040,'9044 ldr q0, [x1, #0x20]','9044 ldr q0, [x1, #0x28]')
        self.assertNotIn((self.init,self.dispatch),self.prove())

    def test_header_load_store_must_be_adjacent_no_integer_or_simd_alias_gap(self):
        for address,writer in [(0x330c,'mov x8, x0'),(0x3318,'movi.16b v0, #0x0'),(0x3318,'mov d0, x0')]:
            before=copy.deepcopy(self.windows)
            # Expand this synthetic mutated instruction stream by one ARM64
            # instruction; no original function/descriptor target is fabricated.
            window=self.windows[self.init]
            lines=[]
            for line in window[2].splitlines():
                m=re.match(r'^([0-9a-f]+) (.*)$',line)
                if m and int(m[1],16)>=address:
                    if int(m[1],16)==address:lines.append(f'{address:x} {writer}')
                    line=f'{int(m[1],16)+4:x} {m[2]}'
                lines.append(line)
            window[1]+=4;window[2]='\n'.join(lines)
            self.assertNotIn((self.init,self.dispatch),self.prove())
            self.windows=before

    def test_each_task_argument_save_is_preserved_from_its_own_assignment(self):
        # Move context save earlier and overwrite it before descriptor save.
        # Both original MOVs and the final STP still exist: max(save) is unsafe.
        self.replace(0x6e98,'6eb0 sub sp, sp, #0x20','6eb0 mov x19, x2')
        self.replace(0x6e98,'6eb4 mov x19, x2','6eb4 mov x19, x0')
        self.assertNotIn((self.serve,self.task),self.prove())

    def test_postindexed_store_cannot_hide_saved_descriptor_or_context_write(self):
        for old,new in [('6ebc mov x22, x0','6ebc str x0, [x21], #0x8'),('6ebc mov x22, x0','6ebc str x0, [x19], #0x8'),('6ebc mov x22, x0','6ebc cas x0, x21, [x3]')]:
            before=copy.deepcopy(self.windows);self.replace(0x6e98,old,new)
            self.assertNotIn((self.serve,self.task),self.prove());self.windows=before
        self.setUp();self.replace(0xa0f0,'a13c mov x0, x19','a13c str x0, [x21], #0x8')
        self.assertNotIn((self.serve,self.task),self.prove())

    def test_actor_continuation_requires_exact_consumed_argument(self):
        self.replace(0x6c90,'6ce8 add x0, x0, #0xd00','6ce8 add x1, x0, #0xd00')
        with self.assertRaises(ValueError):self.prove()

    def test_unknown_call_or_external_jump_cannot_skip_original_registration(self):
        self.replace(0x1da8,'3310 adrp x8, 0xa000','3310 bl 0xdead')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.setUp();self.replace(0x1da8,'3374 bl 0xa1a4','3374 bl 0xdead')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.setUp();self.replace(0x1da8,'32c8 bl 0xa734','32c8 b 0x3330')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.setUp();self.replace(0xa0f0,'a15c br x3','a15c br x4')
        self.assertNotIn((self.serve,self.task),self.prove())

    def test_private_work_budget_fails_closed_without_timing_assumptions(self):
        with patch('nimo_async_invocations.MAX_ANALYSIS_WORK',1):
            with self.assertRaisesRegex(ValueError,'work bound exhausted'):self.prove()

    def test_out_of_text_and_unsupported_descriptor_omit_not_names_fallback(self):
        del self.symbols[0x9f28]
        with self.assertRaises(ValueError):self.prove()


class ActualIosAsyncInvocationTests(unittest.TestCase):
    def setUp(self):
        self.f=json.loads((FIXTURE.parent/'nimo-async-af32-ios.json').read_text())
        self.symbols={int(a):tuple(v) for a,v in self.f['symbols'].items()}
        self.serve=self.symbols[0x100dac170][0]
        self.task=self.symbols[0x100db02d4][0]

    def prove(self):
        f=self.f
        return prove_async_edges({s:f['windows'][s] for s in f['initial']},self.symbols,{int(a):n for a,n in f['imports'].items()},lambda a,n:bytes.fromhex(f['reads'][f'{a:x}:{n}']),lambda a:f['windows'][self.symbols[a][0]],{int(a,16):n for a,n in f['data_imports'].items()},lambda a:f['pointers'][str(a)],lambda a:f['bodies'][str(a)])

    def mutate_body(self,old,new):
        body=self.f['bodies'][str(0x100685da8)]
        self.assertIn(old,body[2]);body[2]=body[2].replace(old,new,1)

    def test_actual_optimized_ios_partial_edges_not_complete_capability(self):
        self.assertEqual(self.prove(),{tuple(x) for x in self.f['expected_edges']})
        self.assertFalse(any(a==self.symbols[0x100daa82c][0] for a,b in self.prove()))

    def test_each_task_sink_requires_original_pair_and_consumed_context(self):
        for old,new in [
            ('100685f80 stp x22, x19, [x0, #0x10]','100685f80 stp x22, x18, [x0, #0x10]'),
            ('100685fc8 mov x4, x24','100685fc8 mov x4, x25'),
            ('100685f34 stp xzr, xzr, [x29, #-0x90]','100685f34 mov x24, x0'),
        ]:
            with self.subTest(new=new):
                self.setUp();self.mutate_body(old,new)
                self.assertNotIn((self.serve,self.task),self.prove())

    def test_branch_only_setters_and_actual_cycles_refused(self):
        for old,new in [
            ('100685fc4 mov x0, x23','100685fc4 cbz x0, 0x100685fcc'),
            ('100685f0c add x0, x0, #0x6c0','100685f0c b 0x100685f1c'),
            ('100686010 adrp x3, 0x102d13000','100686010 cbz x0, 0x100686018'),
            ('100685f40 b 0x100685fa0','100685f40 b 0x100685f30'),
        ]:
            with self.subTest(new=new):
                self.setUp();self.mutate_body(old,new)
                try:edges=self.prove()
                except ValueError:continue
                self.assertNotIn((self.serve,self.task),edges)

    def test_relative_entry_stack_alias_and_sp_changes_refused(self):
        address=0x100db05f0;symbol=self.symbols[address][0]
        original=self.f['windows'][symbol][2]
        # Replace an actual task-context write in the spill-to-restore span.
        lines=original.splitlines()
        candidate=next(line for line in lines if ' str ' in line and '[x' in line)
        at=candidate.split()[0]
        for op in ['mov sp, x9','str x0, [sp, #0x8]','str x0, [x9, #0x8]']:
            with self.subTest(op=op):
                self.setUp();self.f['windows'][symbol][2]=original.replace(candidate,at+' '+op,1)
                self.assertFalse(any(a==symbol for a,b in self.prove()))

    def test_dispatch_ldr_argument_and_unrelated_load_preserve_exact_block(self):
        old=AsyncInvocationTests();old.setUp()
        window=old.windows[old.init]
        self.assertIn('33ec ldp x23, x20, [x19, #0xe0]',window[2])
        window[2]=window[2].replace('33ec ldp x23, x20, [x19, #0xe0]','33ec ldr x23, [x19, #0xe0]')
        self.assertIn((old.init,old.dispatch),old.prove())
        for replacement in ['33f0 mov x3, x24','33f0 str x0, [x19, #0xe0]']:
            copy_window=window[2]
            window[2]=copy_window.replace('33f0 mov x3, x23',replacement)
            self.assertNotIn((old.init,old.dispatch),old.prove())
            window[2]=copy_window

    def test_wrapper_relative_spill_cannot_change_stack_or_borrow_alias(self):
        for replacement in ['7168 mov sp, x9','7168 str x0, [x9, #0x8]','7168 str x0, [sp, #0x8]!']:
            old=AsyncInvocationTests();old.setUp()
            old.replace(0x7130,'7168 str x0, [x22, #0x10]',replacement)
            self.assertNotIn((old.serve,old.task),old.prove())

    def test_backward_layout_poststore_unknown_effects_refused(self):
        for effect in ['str x0, [x9]','bl 0xdead']:
            self.setUp()
            self.mutate_body('100685f40 b 0x100685fa0','100685f40 b 0x100685e6c')
            self.mutate_body('100685e6c adrp x1, 0x1038c8000','100685e6c '+effect)
            self.mutate_body('100685e70 add x1, x1, #0x660','100685e70 b 0x100685fa0')
            self.assertNotIn((self.serve,self.task),self.prove())

class InitialActorHopTests(unittest.TestCase):
    def test_actual_initial_actor_hop_reaches_exact_start_call(self):
        f=json.loads((FIXTURE.parent/'nimo-async-dca-initial-switch.json').read_text())
        symbols={int(a):tuple(v) for a,v in f['symbols'].items()}
        entry=symbols[0x100db13e0][0];continuation=symbols[0x100db148c][0]
        windows=f['windows'];imports={int(a):n for a,n in f['imports'].items()}
        def prove():
            return prove_async_edges({entry:windows[entry]},symbols,imports,lambda a,n:None,lambda a:windows[symbols[a][0]])
        self.assertEqual(prove(),{(entry,continuation)})
        self.assertIn('100db14b8 bl 0x100db0a50',windows[continuation][2])
        original=windows[entry][2]
        # A real dead continuation body remains present in each negative.
        for old,new in [('100db1478 mov x1, x8','100db1478 mov x0, x8'),('100db1488 b 0x102c0ba80','100db1488 b 0xdead')]:
            with self.subTest(new=new):
                windows[entry][2]=original.replace(old,new)
                self.assertNotIn((entry,continuation),prove())
        windows[entry][2]=original

class ThrowingTaskInvocationTests(unittest.TestCase):
    def setUp(self):
        self.f=json.loads((FIXTURE.parent/'nimo-async-dca-throwing-task.json').read_text())
        self.symbols={int(a):tuple(v)for a,v in self.f['symbols'].items()}
        self.caller=self.symbols[0x100db148c][0];self.endpoint=self.symbols[0x100db77c8][0]
    def prove(self):
        f=self.f
        return prove_async_edges({self.caller:f['windows'][self.caller]},self.symbols,{int(a):n for a,n in f['imports'].items()},lambda a,n:bytes.fromhex(f['reads'][f'{a:x}:{n}']),lambda a:f['windows'][self.symbols[a][0]],get_body=lambda a:f['bodies'][str(a)])
    def test_actual_throwing_task_consumes_original_descriptor_in_both_sinks(self):
        self.assertIn((self.caller,self.endpoint),self.prove())
    def test_either_sink_clobber_or_branch_only_setter_refused(self):
        original=self.f['bodies'][str(0x1009e3578)][2]
        for old,new in [('1009e3754 mov x3, x21','1009e3754 mov x3, x20'),('1009e37a4 mov x4, x19','1009e37a4 mov x4, x20'),('1009e3750 mov x2, x22','1009e3750 cbz x0, 0x1009e3758'),('1009e36ec stp xzr, xzr, [x29, #-0x90]','1009e36ec mov x21, x0'),('1009e3598 mov x22, x5','1009e3598 mov x4, x5'),('1009e37a0 mov x3, x21','1009e37a0 mov x19, x0'),('1009e3734 b 0x1009e3798','1009e3734 b 0x1009e3720')]:
            with self.subTest(new=new):
                self.f['bodies'][str(0x1009e3578)][2]=original.replace(old,new)
                try:edges=self.prove()
                except ValueError:continue
                self.assertNotIn((self.caller,self.endpoint),edges)
    def test_forwarding_thunk_cannot_clobber_arguments_or_select_dead_runtime(self):
        symbol=self.symbols[0x100ccf2c0][0];original=self.f['windows'][symbol][2]
        for old,new in [('100ccf2c0 adrp x5, 0x103566000','100ccf2c0 adrp x3, 0x103566000'),('100ccf2c4 ldr x5, [x5, #0x6f0]','100ccf2c4 ldr x4, [x5, #0x6f0]'),('100ccf2c8 b 0x1009e3578','100ccf2c8 b 0x100ccf2c0'),('100ccf2c8 b 0x1009e3578','100ccf2c8 b 0x100db148c')]:
            with self.subTest(new=new):
                self.f['windows'][symbol][2]=original.replace(old,new)
                self.assertNotIn((self.caller,self.endpoint),self.prove())

if __name__=='__main__':unittest.main()
