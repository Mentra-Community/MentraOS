"""Conservative, consumed-argument witnesses for the observed Swift ARM64 ABI.

Only the two emitted scheduler shapes below are modeled. This is not a closure
name graph or a general ARM emulator. Unsupported optimizer/alias shapes add no
edge. Names identify exact runtime contracts; instructions establish invocation.
The caller owns delivered-byte/window/deadline budgets for both callbacks.
"""
import re
import struct

MAX_EXTRA_FUNCTIONS = 64
MAX_SLICE = 128
MAX_ANALYSIS_WORK = 1_000_000
# Explicit modeled write sets. Unknown multi-destination/implicit-write opcodes
# cannot be treated as an irrelevant first-operand-only instruction.
MODELED_OPS={'add','sub','adr','adrp','mov','movk','movz','and','orr','bfxil','sxtw','ldr','ldur','ldrsw','ldp','ldpsw','str','stur','stp','b','bl','blr','br','ret','cmp','cmn','tst','cbz','cbnz','tbz','tbnz','nop'}

def modeled(ins):
    return ins[1] in MODELED_OPS or ins[1].startswith('b.')


def instructions(window):
    result = []
    for line in window[2].splitlines():
        m = re.fullmatch(r'\s*([0-9a-fA-F]+)\s+([a-z][a-z0-9.]*)\s*(.*?)\s*', line)
        if m:
            result.append((int(m[1], 16), m[2], m[3].split(';', 1)[0].strip()))
    return result


def target(ins):
    return int(ins[2], 16) if ins[1] in ('b', 'bl') and re.fullmatch(r'0x[0-9a-f]+', ins[2]) else None


def writes(ins):
    op, args = ins[1:]
    if op in ('b', 'bl', 'blr', 'br', 'ret', 'cmp', 'cmn', 'tst', 'cbz', 'cbnz', 'tbz', 'tbnz') or op.startswith('b.'):
        return set()
    writeback=set(re.findall(r'\[(x\d+|sp)[^]]*\](?:!|,\s*#)',args))
    if op.startswith(('st', 'prfm')):
        # Both pre-index and post-index forms change the address register.
        return writeback
    regs = args.split(',')[:2 if op in ('ldp', 'ldpsw') else 1]
    return writeback | {r.strip().replace('w', 'x', 1) for r in regs if re.fullmatch(r'[wx]\d+|sp', r.strip())}


def boundary(ins):
    return ins[1] in ('b', 'br', 'ret', 'cbz', 'cbnz', 'tbz', 'tbnz') or ins[1].startswith('b.')


class AsyncProof:
    def __init__(self, functions, symbols, imports, read_bytes, get_function, data_imports=None, read_pointer=None):
        self.functions = dict(functions)
        self.symbols = symbols
        self.imports = imports
        self.read_bytes = read_bytes
        self.get_function = get_function
        self.data_imports=data_imports or {}
        self.read_pointer=read_pointer
        self.extra = 0
        self.work = MAX_ANALYSIS_WORK

    def charge(self, count):
        self.work -= count
        if self.work < 0:raise ValueError('async analysis work bound exhausted')

    def decode(self, window):
        self.charge(len(window[2]))
        return instructions(window)

    def load(self, address):
        if address not in self.symbols:
            raise ValueError('async target is not an exact compiler function entry')
        symbol = self.symbols[address][0]
        if symbol not in self.functions:
            self.extra += 1
            if self.extra > MAX_EXTRA_FUNCTIONS:
                raise ValueError('async function witness exceeds bound')
            window = self.get_function(address)
            if window[0] != address or window[1] <= address:
                raise ValueError('async function window changed entry')
            self.functions[symbol] = window
        return symbol, self.decode(self.functions[symbol])

    def runtime(self, ins, name):
        return self.imports.get(target(ins)) == name

    def constant_witness(self, code, end, reg):
        """Bounded straight-line ADRP/ADD or MOV value; no branch/call clobber."""
        offset = 0
        self.charge(min(end,MAX_SLICE))
        for i in range(end - 1, max(-1, end - MAX_SLICE), -1):
            ins = code[i]
            if not modeled(ins) or boundary(ins):
                return None
            if ins[1] in ('bl', 'blr') and int(reg[1:]) < 19:
                return None
            if reg not in writes(ins):
                continue
            m = re.fullmatch(r'(x\d+),\s*(x\d+),\s*#(0x[0-9a-f]+|[0-9]+)', ins[2])
            if ins[1] == 'add' and m and m[1] == reg:
                offset += int(m[3], 0); reg = m[2]; continue
            m = re.fullmatch(r'(x\d+),\s*(0x[0-9a-f]+)', ins[2])
            if ins[1] in ('adrp', 'adr') and m and m[1] == reg:
                return int(m[2], 16) + offset, i
            return None
        return None

    def constant(self, code, end, reg):
        found=self.constant_witness(code,end,reg)
        return found[0] if found is not None else None

    def descriptor(self, address):
        if not isinstance(address, int) or address % 4:
            raise ValueError('async descriptor address unavailable')
        data = self.read_bytes(address, 8)
        if len(data) != 8:
            raise ValueError('truncated async descriptor')
        relative, size = struct.unpack('<iI', data)
        if not relative or size > 1024 * 1024:
            raise ValueError('invalid async descriptor')
        entry = address + relative
        self.load(entry)
        return entry

    def unchanged(self, code, begin, end, regs):
        self.charge(max(0,end-begin))
        # Caller-saved arguments cannot survive calls. Callee-saved values must
        # still have no explicit writer on *any* instruction in this span.
        for ins in code[begin:end]:
            if not modeled(ins):
                return False
            if writes(ins) & set(regs):
                return False
            if ins[1] in ('bl', 'blr') and any(int(r[1:]) < 19 for r in regs):
                return False
        return True

    @staticmethod
    def last_write(code, end, reg):
        for i in range(end-1, -1, -1):
            if reg in writes(code[i]) or code[i][1] in ('bl','blr') and int(reg[1:]) < 19:
                return i
        return None

    def single_entry(self, code, begin, end):
        self.charge(len(code))
        start, stop = code[begin][0], code[end][0]
        for i, ins in enumerate(code):
            if boundary(ins):
                jump = re.search(r'(0x[0-9a-f]+)$', ins[2])
                if jump and start <= int(jump[1],16) <= stop and not begin <= i <= end:
                    return False
        return True

    def block_header(self, code, stores, frame, base, copy):
        if self.read_pointer is None: return False
        # Exact observed 64-bit stack-block ABI: isa/flags followed by
        # invoke/descriptor and the captured Swift function/context pair.
        fields={}
        for off in (base,base+8):
            candidates=[]
            for i in range(max(0,copy-MAX_SLICE),copy):
                m=re.fullmatch(r'([xd]\d+), \['+frame+r', #0x'+format(off,'x')+r'\]',code[i][2])
                if code[i][1]=='str' and m:candidates.append((i,m[1]))
            if not candidates:return False
            at,reg=candidates[-1]
            definitions=[i for i in range(max(0,at-MAX_SLICE),at) if code[i][2].split(',',1)[0]==reg and code[i][1] not in ('str','stp','stur')]
            if not definitions:return False
            load=definitions[-1]
            # The supported emitted shape is an adjacent load/store pair.
            # Do not infer SIMD aliasing or preserve flags through other ops.
            if at!=load+1:return False
            m=re.fullmatch(re.escape(reg)+r', \[(x\d+), #(0x[0-9a-f]+|[0-9]+)\]',code[load][2])
            if code[load][1]!='ldr' or not m:return False
            pointer=self.constant(code,load,m[1])
            if pointer is None:return False
            if any(boundary(x) or x[1] in ('bl','blr') for x in code[load+1:at]):return False
            fields[off]=(load,pointer+int(m[2],0))
        if self.data_imports.get(fields[base][1])!='__NSConcreteStackBlock':return False
        flags=self.read_bytes(fields[base+8][1],8)
        if flags!=bytes.fromhex('0000004200000000'):return False
        store,_,descriptor_reg=stores[base+16]
        descriptor=self.constant(code,store,descriptor_reg)
        if descriptor is None:return False
        raw=self.read_bytes(descriptor,40)
        if len(raw)!=40 or struct.unpack_from('<QQ',raw)!=(0,48):return False
        # Resolve pointer slots through actual delivered dyld rebase metadata,
        # never by treating chained pointer encoding as a plain VM address.
        copier=self.read_pointer(descriptor+16)
        disposer=self.read_pointer(descriptor+24)
        signature=self.read_pointer(descriptor+32)
        if self.read_bytes(signature,6)!=b'v8@?0\0':return False
        _,body=self.load(copier)
        expected=[('ldr','x8, [x1, #0x28]'),('ldr','q0, [x1, #0x20]'),('str','q0, [x0, #0x20]'),('mov','x0, x8')]
        if len(body)!=5 or [(x[1],x[2]) for x in body[:4]]!=expected or body[-1][1]!='b' or not self.runtime(body[-1],'_swift_retain'):return False
        _,body=self.load(disposer)
        if len(body)!=2 or body[0][1:]!=('ldr','x0, [x0, #0x28]') or body[1][1]!='b' or not self.runtime(body[1],'_swift_release'):return False
        return True

    def dispatch(self, symbol, code):
        edges = set()
        for call, ins in enumerate(code):
            name = self.imports.get(target(ins), '')
            if not (name.startswith('_$sSo17OS_dispatch_queueC8DispatchE5async') and 'executey' in name):
                continue
            # Observed Swift Dispatch overlay: copied block is the fourth ABI
            # argument. The adjacent load is tied to the original Block_copy.
            if call < 2 or code[call-1][1] != 'mov':
                continue
            arg = re.fullmatch(r'x3,\s*(x\d+)', code[call-1][2])
            load = re.fullmatch(r'(x\d+),\s*(x\d+),\s*\[(x\d+),\s*#(0x[0-9a-f]+|[0-9]+)\]', code[call-2][2])
            if not arg or code[call-2][1] != 'ldp' or not load or load[1] != arg[1]:
                continue
            frame, slot = load[3], int(load[4], 0)
            copies = [i for i in range(max(0,call-MAX_SLICE),call-2) if self.runtime(code[i], '__Block_copy')]
            if not copies:
                continue
            copy = copies[-1]
            if code[copy+1][1:] != ('str', f'x0, [{frame}, #0x{slot:x}]'):
                continue
            block = re.fullmatch(r'x0,\s*'+frame+r',\s*#(0x[0-9a-f]+|[0-9]+)', code[copy-1][2]) if code[copy-1][1]=='add' else None
            if not block:
                continue
            base = int(block[1],0)
            # No later store, control jump, or alias-taking call may modify the
            # copied-block saved slot; only the fixed overlay metadata sequence.
            if not self.single_entry(code,copy-1,call) or not self.unchanged(code,copy+1,call,[frame]):
                continue
            if any(boundary(x) or (x[1].startswith('st') and not (x[1]=='str' and re.fullmatch(r'x\d+, \['+frame+r', #0x'+format(base-8,'x')+r'\]',x[2]))) for x in code[copy+2:call-2]):
                continue
            safe_overlay_calls={
                '_swift_retain', '_$s8Dispatch0A3QoSV11unspecifiedACvgZ',
                '_$ss10SetAlgebraPyxqd__ncSTRd__7ElementQyd__ACRtzlufCTj',
                '___swift_instantiateConcreteTypeFromMangledNameV2',
                '_$sSo17OS_dispatch_queueC8DispatchE10AttributesVAEs10SetAlgebraACWlTm',
                '_$sSaySo17OS_dispatch_queueC8DispatchE10AttributesVGSayxGSTsWlTm',
            }
            if any(x[1] in ('bl','blr') and self.imports.get(target(x),self.symbols.get(target(x),('', ''))[0]) not in safe_overlay_calls for x in code[copy+2:call-2]):
                continue
            stores = {}
            for i in range(max(0,copy-MAX_SLICE),copy):
                m = re.fullmatch(r'(x\d+),\s*(x\d+),\s*\['+frame+r',\s*#(0x[0-9a-f]+|[0-9]+)\]', code[i][2])
                if code[i][1]=='stp' and m:
                    stores[int(m[3],0)] = (i,m[1],m[2])
            if base+16 not in stores or base+32 not in stores:
                continue
            invoke_store,invoke_reg,_ = stores[base+16]
            closure_store,closure_reg,_ = stores[base+32]
            invoke_proof = self.constant_witness(code,invoke_store,invoke_reg)
            closure_proof = self.constant_witness(code,closure_store,closure_reg)
            if invoke_proof is None or closure_proof is None:
                continue
            invoke,closure=invoke_proof[0],closure_proof[0]
            if not self.single_entry(code,min(invoke_proof[1],closure_proof[1]),call):continue
            if not self.unchanged(code,min(invoke_store,closure_store),copy,[frame]):
                continue
            if any(boundary(x) or x[1] in ('bl','blr') for x in code[min(invoke_store,closure_store):copy]):
                continue
            # Every store to these block fields after their definition must be
            # the witnessed store itself, never an unknown/multi-field clobber.
            valid_fields={base,base+8,base+16,base+32}
            bad_store=False
            for j in range(min(invoke_store,closure_store)+1,copy):
                x=code[j]
                if not x[1].startswith('st'): continue
                field=re.search(r'\['+frame+r',\s*#(0x[0-9a-f]+|[0-9]+)\]$',x[2])
                if not field or int(field[1],0) not in valid_fields: bad_store=True;break
                off=int(field[1],0)
                if off in (base+16,base+32) and j not in (invoke_store,closure_store): bad_store=True;break
                if off in (base,base+8) and x[1]!='str':bad_store=True;break
            if bad_store: continue
            if not self.block_header(code,stores,frame,base,copy):continue
            invoke_symbol, thunk = self.load(invoke)
            # Exact observed Swift block reabstraction shape. The runtime invokes
            # block+16; that thunk must actually call captured block+32 function.
            body = [(x[1],x[2]) for x in thunk]
            wanted = [('ldp','x19, x20, [x0, #0x20]'),('mov','x0, x20')]
            k = next((i for i in range(len(body)-3) if body[i:i+2]==wanted),None)
            if k is None or any(x[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',x[2]) for x in thunk[:k]) or any(boundary(x) for x in thunk[:k+4]) or not self.unchanged(thunk,0,k,['x0']) or not self.runtime(thunk[k+2],'_swift_retain') or body[k+3] != ('blr','x19'):
                continue
            self.load(closure)
            edges.add((symbol,self.symbols[closure][0]))
        return edges

    def task(self, symbol, code):
        edges = set()
        for call,ins in enumerate(code):
            address=target(ins)
            name=self.symbols.get(address,('', ''))[1]
            if 'Swift.Task<' not in name or '.init(priority:' not in name or 'operation:' not in name:
                continue
            original_proof=self.constant_witness(code,call,'x1')
            if original_proof is None or not self.single_entry(code,original_proof[1],call):
                continue
            original_descriptor=original_proof[0]
            original_entry=self.descriptor(original_descriptor)
            _, init=self.load(address)
            # The observed specialization saves its descriptor/context in x21 /
            # x19 before any branch, then stores both in a new runtime context.
            prefix=[(x[1],x[2]) for x in init[:12]]
            if any(boundary(x) for x in init[:12]) or ('mov','x21, x1') not in prefix or ('mov','x19, x2') not in prefix:
                continue
            one=prefix.index(('mov','x21, x1'));two=prefix.index(('mov','x19, x2'))
            if not self.unchanged(init,0,one,['x1']) or not self.unchanged(init,0,two,['x2']):continue
            saved=max(one,two)
            for create,x in enumerate(init):
                if not self.runtime(x,'_swift_task_create'):
                    continue
                self.charge(max(0,create-saved))
                stores=[i for i in range(saved+1,create) if init[i][1:]==('stp','x21, x19, [x0, #0x10]')]
                if not stores:
                    continue
                store=stores[-1]
                if not self.unchanged(init,one+1,store,['x21']) or not self.unchanged(init,two+1,store,['x19']):
                    continue
                if store<2 or init[store-1][1:]!=('mov','x4, x0') or not self.runtime(init[store-2],'_swift_allocObject'):
                    continue
                if not self.single_entry(init,store-2,create) or not self.unchanged(init,store+1,create,['x4']):
                    continue
                if any(z[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',z[2]) for z in init[store+1:create]):
                    continue
                wrapper_descriptor=self.constant(init,create,'x3')
                if wrapper_descriptor is None:
                    continue
                wrapper=self.descriptor(wrapper_descriptor)
                _, wrap=self.load(wrapper)
                # Wrapper loads the *same* retained original descriptor/context
                # and tail-invokes a delivered relative-pointer reabstraction.
                pairs=[(z[1],z[2]) for z in wrap]
                if ('ldp','x21, x20, [x20, #0x10]') not in pairs or pairs[-1]!=('br','x3'):
                    continue
                load=pairs.index(('ldp','x21, x20, [x20, #0x10]'))
                if not self.unchanged(wrap,0,load,['x20']):continue
                if any(z[1] in ('bl','blr') or z[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',z[2]) for z in wrap[:load]):continue
                branch=len(wrap)-1
                if ('mov','x1, x21') not in pairs[load:branch] or ('mov','x2, x20') not in pairs[load:branch]:
                    continue
                # Exact descriptor decode feeding BR x3, not a globally present
                # async descriptor or a nearby dead method.
                decode=next((i for i in range(load,branch-1) if pairs[i]==('ldrsw','x9, [x23]') and pairs[i+1]==('add','x3, x9, x23')),None)
                if decode is None: continue
                one=self.last_write(wrap,branch,'x1');two=self.last_write(wrap,branch,'x2')
                if one is None or two is None or pairs[one]!=('mov','x1, x21') or pairs[two]!=('mov','x2, x20'):continue
                if not self.unchanged(wrap,load+1,one,['x21']) or not self.unchanged(wrap,load+1,two,['x20']):continue
                if not self.unchanged(wrap,decode+2,branch,['x3']):continue
                if any(boundary(z) for z in wrap[:branch]):continue
                if any(z[1] in ('bl','blr') and not self.runtime(z,'_swift_task_alloc') for z in wrap):continue
                bridge_descriptor=self.constant(wrap,decode,'x23')
                bridge=self.descriptor(bridge_descriptor)
                _, bridge_code=self.load(bridge)
                ops=[(z[1],z[2]) for z in bridge_code]
                required=[('ldp','w8, w0, [x1]'),('sxtw','x8, w8'),('add','x1, x8, x1'),('str','x1, [sp, #0x8]')]
                begin=next((i for i in range(len(ops)-3) if ops[i:i+4]==required),None)
                if begin is None or any(z[1] in ('bl','blr') or z[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',z[2]) for z in bridge_code[:begin]) or not self.unchanged(bridge_code,0,begin,['x1']) or ops[-1]!=('br','x1') or ('ldp','x1, x19, [sp, #0x8]') not in ops[begin+4:]:
                    continue
                # The bridge calls only actual task allocation, then resumes the
                # original supplied entry. Unsupported wrappers omit the edge.
                if any(z[1] in ('bl','blr') and not self.runtime(z,'_swift_task_alloc') for z in bridge_code[begin+4:]): continue
                if any(boundary(z) for z in bridge_code[:-1]):continue
                restore=ops.index(('ldp','x1, x19, [sp, #0x8]'),begin+4)
                if self.last_write(bridge_code,len(ops)-1,'x1')!=restore:continue
                if any(z[1].startswith('st') and re.search(r'\[sp[,\]]',z[2]) for z in bridge_code[begin+4:restore]):continue
                edges.add((symbol,self.symbols[original_entry][0]))
        return edges

    def switches(self, symbol, code):
        edges=set()
        for i,ins in enumerate(code):
            if not self.runtime(ins,'_swift_task_switch'):
                continue
            witness=self.constant_witness(code,i,'x0')
            if witness is not None and self.single_entry(code,witness[1],i):
                continuation=witness[0]
                self.load(continuation)
                edges.add((symbol,self.symbols[continuation][0]))
        return edges


def prove_async_edges(functions, symbols, imports, read_bytes, get_function, data_imports=None, read_pointer=None):
    """Return only verified scheduler edges; callbacks share caller budgets.

    functions: {symbol: (start, stop, normalizedAssembly)}
    symbols: {exactFunctionEntry: (mangled, normalizedDemangled)}
    imports: {deliveredStubAddress: exactImportName}
    read_bytes(vmAddress, count): exact delivered file-backed bytes
    get_function(exactEntry): same tuple, shared caller limits/deadline
    data_imports: exact delivered data import slots (separate from call stubs)
    read_pointer(slot): exact delivered dyld rebase target; no opaque bit masks
    """
    proof=AsyncProof(functions,symbols,imports,read_bytes,get_function,data_imports,read_pointer)
    edges=set()
    for symbol,window in list(functions.items()):
        code=proof.decode(window)
        edges.update(proof.dispatch(symbol,code))
        edges.update(proof.task(symbol,code))
    # Newly proven closure entrypoints can actor-hop via a consumed continuation.
    # Do not inspect unrelated named closures as roots.
    pending=[b for _,b in edges];seen=set()
    while pending:
        symbol=pending.pop()
        if symbol in seen:
            continue
        seen.add(symbol)
        code=proof.decode(proof.functions[symbol])
        added=proof.switches(symbol,code)
        edges.update(added);pending.extend(b for _,b in added)
        # Actual direct branch/call edges remain the existing graph's authority;
        # load only reached owned entries so their continuation can be inspected.
        for ins in code:
            address=target(ins)
            if address in symbols and 'NimoMacResourceTransport.' in symbols[address][1] and 'closure #' in symbols[address][1]:
                child,_=proof.load(address)
                pending.append(child)
    return edges
