import copy
import json
from pathlib import Path
import unittest
from nimo_async_invocations import prove_async_edges

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
            self.assertEqual(n,8)
            return bytes.fromhex(self.f['bytes'][str(a)])
        return prove_async_edges({s:self.windows[s] for s in self.f['initial']},self.symbols,self.imports,read,get)

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
        for address,old,new in [(0x1da8,'3334 bl 0xaaf4','3334 mov x0, x19'),(0x5898,'58b0 blr x19','58b0 blr x18'),(0x5898,'58a0 add x29, sp, #0x10','58a0 b 0x58b0'),(0x1da8,'330c str x8, [x19, #0x100]','330c str x8, [x19, #0x120]')]:
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
        for address,old,new in [(0x6e98,'6ebc mov x22, x0','6ebc mov x21, x0'),(0xa0f0,'a13c mov x0, x19','a13c mov x21, x0'),(0x7130,'7168 str x0, [x22, #0x10]','7168 str x0, [sp, #0x8]'),(0x7130,'714c mov x19, x0','714c mov x1, x0'),(0xa0f0,'a108 mov x19, x0','a108 mov x20, x0')]:
            with self.subTest(new=new):
                before=copy.deepcopy(self.windows);self.replace(address,old,new)
                self.assertNotIn((self.serve,self.task),self.prove());self.windows=before

    def test_actor_continuation_requires_exact_consumed_argument(self):
        self.replace(0x6c90,'6ce8 add x0, x0, #0xd00','6ce8 add x1, x0, #0xd00')
        with self.assertRaises(ValueError):self.prove()

    def test_unknown_call_or_external_jump_cannot_skip_original_registration(self):
        self.replace(0x1da8,'3374 bl 0xa1a4','3374 bl 0xdead')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.setUp();self.replace(0x1da8,'32c8 bl 0xa734','32c8 b 0x3330')
        self.assertNotIn((self.init,self.dispatch),self.prove())
        self.setUp();self.replace(0xa0f0,'a15c br x3','a15c br x4')
        self.assertNotIn((self.serve,self.task),self.prove())

    def test_out_of_text_and_unsupported_descriptor_omit_not_names_fallback(self):
        del self.symbols[0x9f28]
        with self.assertRaises(ValueError):self.prove()

if __name__=='__main__':unittest.main()
