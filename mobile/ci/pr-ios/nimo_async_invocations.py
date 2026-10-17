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
    def __init__(self, functions, symbols, imports, read_bytes, get_function, data_imports=None, read_pointer=None, get_body=None):
        self.functions = dict(functions)
        self.symbols = symbols
        self.imports = imports
        self.read_bytes = read_bytes
        self.get_function = get_function
        self.get_body = get_body
        self.bodies = {}
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

    def body(self, address):
        # Anonymous ABI bodies never acquire a compiler identity/graph endpoint.
        if address in self.symbols:return self.load(address)[1]
        if self.get_body is None:raise ValueError('anonymous ABI entry unavailable')
        if address not in self.bodies:
            self.extra+=1
            if self.extra>MAX_EXTRA_FUNCTIONS:raise ValueError('async function witness exceeds bound')
            window=self.get_body(address)
            if window[0]!=address or window[1]<=address:raise ValueError('anonymous ABI window changed entry')
            self.bodies[address]=window
        return self.decode(self.bodies[address])

    def tail_body(self, address):
        seen=set()
        for _ in range(4):
            if address in seen:raise ValueError('cyclic anonymous ABI forwarder')
            seen.add(address);code=self.body(address)
            if len(code)==1 and code[0][1]=='b' and target(code[0]) is not None:
                address=target(code[0]);continue
            return code
        raise ValueError('anonymous ABI forwarder depth exceeded')

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
            if ins[1] in ('bl', 'blr') and reg != 'sp' and int(reg[1:]) < 19:
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

    def descriptor(self, address, endpoint=True):
        if not isinstance(address, int) or address % 4:
            raise ValueError('async descriptor address unavailable')
        data = self.read_bytes(address, 8)
        if len(data) != 8:
            raise ValueError('truncated async descriptor')
        relative, size = struct.unpack('<iI', data)
        if not relative or size > 1024 * 1024:
            raise ValueError('invalid async descriptor')
        entry = address + relative
        if endpoint:self.load(entry)
        else:self.body(entry)
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
            if ins[1] in ('bl', 'blr') and any(r != 'sp' and int(r[1:]) < 19 for r in regs):
                return False
        return True

    @staticmethod
    def last_write(code, end, reg):
        for i in range(end-1, -1, -1):
            if reg in writes(code[i]) or code[i][1] in ('bl','blr') and reg != 'sp' and int(reg[1:]) < 19:
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
        body=self.tail_body(copier)
        expected=[('ldr','x8, [x1, #0x28]'),('ldr','q0, [x1, #0x20]'),('str','q0, [x0, #0x20]'),('mov','x0, x8')]
        if len(body)!=5 or [(x[1],x[2]) for x in body[:4]]!=expected or body[-1][1]!='b' or not self.runtime(body[-1],'_swift_retain'):return False
        body=self.tail_body(disposer)
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
            arg_at=self.last_write(code,call,'x3')
            if arg_at is None or code[arg_at][1]!='mov':continue
            arg=re.fullmatch(r'x3,\s*(x\d+)',code[arg_at][2])
            if not arg or not self.unchanged(code,arg_at+1,call,['x3']):continue
            load_at=self.last_write(code,arg_at,arg[1])
            if load_at is None:continue
            ins_load=code[load_at]
            load=re.fullmatch(r'(x\d+),\s*(?:(x\d+),\s*)?\[(x\d+),\s*#(0x[0-9a-f]+|[0-9]+)\]',ins_load[2])
            if not load or load[1]!=arg[1] or ins_load[1] not in ('ldr','ldp'):continue
            if not self.unchanged(code,load_at+1,arg_at,[arg[1]]):continue
            frame,slot=load[3],int(load[4],0)
            copies = [i for i in range(max(0,call-MAX_SLICE),load_at) if self.runtime(code[i], '__Block_copy')]
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
            if any(boundary(x) or (x[1].startswith('st') and not (x[1]=='str' and re.fullmatch(r'x\d+, \['+frame+r', #0x'+format(base-8,'x')+r'\]',x[2]))) for x in code[copy+2:load_at]):
                continue
            safe_overlay_calls={
                '_swift_retain', '_$s8Dispatch0A3QoSV11unspecifiedACvgZ',
                '_$ss10SetAlgebraPyxqd__ncSTRd__7ElementQyd__ACRtzlufCTj',
                '___swift_instantiateConcreteTypeFromMangledNameV2',
                '_$sSo17OS_dispatch_queueC8DispatchE10AttributesVAEs10SetAlgebraACWlTm',
                '_$sSaySo17OS_dispatch_queueC8DispatchE10AttributesVGSayxGSTsWlTm',
            }
            if any(x[1] in ('bl','blr') and self.imports.get(target(x),self.symbols.get(target(x),('', ''))[0]) not in safe_overlay_calls for x in code[copy+2:load_at]):
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
            thunk = self.tail_body(invoke)
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

    def wrapper_uses_original(self, wrapper):
        wrap=self.body(wrapper)
        # Wrapper loads the *same* retained original descriptor/context
        # and tail-invokes a delivered relative-pointer reabstraction.
        pairs=[(z[1],z[2]) for z in wrap]
        if ('ldp','x21, x20, [x20, #0x10]') not in pairs or pairs[-1]!=('br','x3'):
            return False
        load=pairs.index(('ldp','x21, x20, [x20, #0x10]'))
        if not self.unchanged(wrap,0,load,['x20']):return False
        if any(z[1] in ('bl','blr') or z[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',z[2]) for z in wrap[:load]):return False
        branch=len(wrap)-1
        if ('mov','x1, x21') not in pairs[load:branch] or ('mov','x2, x20') not in pairs[load:branch]:
            return False
        # Exact descriptor decode feeding BR x3, not a globally present
        # async descriptor or a nearby dead method.
        decode=next((i for i in range(load,branch-1) if pairs[i]==('ldrsw','x9, [x23]') and pairs[i+1]==('add','x3, x9, x23')),None)
        if decode is None: return False
        one=self.last_write(wrap,branch,'x1');two=self.last_write(wrap,branch,'x2')
        if one is None or two is None or pairs[one]!=('mov','x1, x21') or pairs[two]!=('mov','x2, x20'):return False
        if not self.unchanged(wrap,load+1,one,['x21']) or not self.unchanged(wrap,load+1,two,['x20']):return False
        if not self.unchanged(wrap,decode+2,branch,['x3']):return False
        if any(boundary(z) for z in wrap[:branch]):return False
        if any(z[1] in ('bl','blr') and not self.runtime(z,'_swift_task_alloc') for z in wrap):return False
        bridge_descriptor=self.constant(wrap,decode,'x23')
        bridge=self.descriptor(bridge_descriptor,endpoint=False)
        bridge_code=self.body(bridge)
        ops=[(z[1],z[2]) for z in bridge_code]
        required=[('ldp','w8, w0, [x1]'),('sxtw','x8, w8'),('add','x1, x8, x1'),('str','x1, [sp, #0x8]')]
        begin=next((i for i in range(len(ops)-3) if ops[i:i+4]==required),None)
        if begin is None or any(z[1] in ('bl','blr') or z[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',z[2]) for z in bridge_code[:begin]) or not self.unchanged(bridge_code,0,begin,['x1']) or ops[-1]!=('br','x1') or ('ldp','x1, x19, [sp, #0x8]') not in ops[begin+4:]:
            return False
        # The bridge calls only actual task allocation, then resumes the
        # original supplied entry. Unsupported wrappers omit the edge.
        if any(z[1] in ('bl','blr') and not self.runtime(z,'_swift_task_alloc') for z in bridge_code[begin+4:]): return False
        if any(boundary(z) for z in bridge_code[:-1]):return False
        restore=ops.index(('ldp','x1, x19, [sp, #0x8]'),begin+4)
        if self.last_write(bridge_code,len(ops)-1,'x1')!=restore:return False
        if not self.unchanged(bridge_code,begin+4,restore+1,['sp']):return False
        if not self.safe_spill_span(bridge_code,begin+4,restore):return False
        return True

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
                wrapper=self.descriptor(wrapper_descriptor,endpoint=False)
                if not self.wrapper_uses_original(wrapper):continue
                edges.add((symbol,self.symbols[original_entry][0]))
        return edges

    def flow(self, code):
        # Scoped instruction reachability only, not a condition/ABI interpreter.
        # Literal branches may select either path; indirect control is terminal.
        if len(code)>8192:raise ValueError('async branch slice exceeds bound')
        self.charge(len(code))
        indices={x[0]:i for i,x in enumerate(code)}
        graph={i:set() for i in range(len(code))}
        for i,ins in enumerate(code):
            if boundary(ins):
                m=re.search(r'(0x[0-9a-f]+)$',ins[2])
                if m and int(m[1],16) in indices:
                    child=indices[int(m[1],16)]
                    graph[i].add(child)
                if ins[1] not in ('b','br','ret') and i+1<len(code):graph[i].add(i+1)
            elif i+1<len(code):graph[i].add(i+1)
        return graph

    def reachable(self, graph, start, omit=None):
        pending=[start];seen=set()
        while pending:
            i=pending.pop();self.charge(1)
            if i==omit or i in seen:continue
            seen.add(i);pending.extend(graph[i]-seen)
        return seen

    def path_indices(self, code, begin, end):
        graph=self.flow(code)
        forward=self.reachable(graph,begin)
        reverse={i:set() for i in graph}
        for i,children in graph.items():
            for child in children:reverse[child].add(i)
        selected=forward & self.reachable(reverse,end)
        indegree={i:0 for i in selected}
        for i in selected:
            for child in graph[i] & selected:indegree[child]+=1
        ready=[i for i,n in indegree.items() if not n];visited=0
        while ready:
            i=ready.pop();visited+=1
            for child in graph[i] & selected:
                indegree[child]-=1
                if not indegree[child]:ready.append(child)
        if visited!=len(selected):raise ValueError('cyclic async proof path unsupported')
        return sorted(selected)

    def dominates(self, code, node, sink):
        graph=self.flow(code)
        return sink in self.reachable(graph,0) and sink not in self.reachable(graph,0,node)

    def direct_task_arguments(self, runtime, sinks):
        prefix=[z[1:] for z in runtime[:16]]
        if ('mov','x21, x3') not in prefix or ('mov','x19, x4') not in prefix:return False
        saves=[(prefix.index(('mov','x21, x3')),'x21','x3'),(prefix.index(('mov','x19, x4')),'x19','x4')]
        for save,reg,argument in saves:
            if any(boundary(z) for z in runtime[:save+1]) or not self.unchanged(runtime,0,save,[argument]):return False
        for sink in sinks:
            for save,reg,argument in saves:
                if not self.dominates(runtime,save,sink):return False
                span=self.path_indices(runtime,save,sink)
                setters=[i for i in span if runtime[i][1:]==('mov',argument+', '+reg) and self.dominates(runtime,i,sink)]
                if len(setters)!=1:return False
                setter=setters[0]
                before=[runtime[i] for i in self.path_indices(runtime,save,setter) if i not in (save,setter)]
                after=[runtime[i] for i in self.path_indices(runtime,setter,sink) if i not in (setter,sink)]
                if not self.unchanged(before,0,len(before),[reg]) or not self.unchanged(after,0,len(after),[argument]):return False
        return True

    def registered_task(self, symbol, code):
        edges=set()
        for call,ins in enumerate(code):
            callee=target(ins)
            if ins[1]!='bl' or callee is None or callee in self.imports:continue
            proof=self.constant_witness(code,call,'x3')
            arg=self.last_write(code,call,'x4')
            if proof is None or arg is None or code[arg][1:]!=('mov','x4, x0') or arg==0 or not self.runtime(code[arg-1],'_swift_allocObject'):continue
            if not self.unchanged(code,arg+1,call,['x4']) or not self.single_entry(code,arg-1,call):continue
            runtime=self.body(callee)
            # Actual generic throwing-Task specialization supplies only x5
            # metadata, preserving original descriptor/context arguments.
            forwarded=False
            if len(runtime)==3 and runtime[0][1]=='adrp' and re.fullmatch(r'x5, 0x[0-9a-f]+',runtime[0][2]) and runtime[1][1]=='ldr' and re.fullmatch(r'x5, \[x5, #0x[0-9a-f]+\]',runtime[1][2]) and runtime[2][1]=='b':
                forward=target(runtime[2])
                if forward is None or forward==callee:continue
                runtime=self.body(forward);forwarded=True
            sinks=[i for i,z in enumerate(runtime) if self.runtime(z,'_swift_task_create')]
            if not sinks:continue
            original=self.descriptor(proof[0]) # Compiler identity required at endpoint.
            if forwarded:
                if self.direct_task_arguments(runtime,sinks):edges.add((symbol,self.symbols[original][0]))
                continue
            prefix=[(x[1],x[2]) for x in runtime[:16]]
            if ('mov','x22, x3') not in prefix or ('mov','x19, x4') not in prefix:continue
            descriptor_save=prefix.index(('mov','x22, x3'));context_save=prefix.index(('mov','x19, x4'))
            if any(boundary(z) for z in runtime[:max(descriptor_save,context_save)+1]):continue
            if not self.unchanged(runtime,0,descriptor_save,['x3']) or not self.unchanged(runtime,0,context_save,['x4']):continue
            valid=True
            for sink in sinks:
                # All real task-create branches must consume the original pair.
                stores=[i for i in range(max(descriptor_save,context_save)+1,sink) if runtime[i][1:]==('stp','x22, x19, [x0, #0x10]') and self.dominates(runtime,i,sink)]
                if len(stores)!=1:valid=False;break
                store=stores[0]
                if store<2 or runtime[store-1][1]!='mov' or not self.runtime(runtime[store-2],'_swift_allocObject'):valid=False;break
                match=re.fullmatch(r'(x\d+), x0',runtime[store-1][2])
                if not match:valid=False;break
                context_reg=match[1]
                if not self.dominates(runtime,store-2,store) or not self.dominates(runtime,store-1,store) or not self.single_entry(runtime,store-2,store):valid=False;break
                for save,reg in [(descriptor_save,'x22'),(context_save,'x19')]:
                    if not self.dominates(runtime,save,store):valid=False;break
                    between=[runtime[i] for i in self.path_indices(runtime,save,store) if i not in (save,store)]
                    if not self.unchanged(between,0,len(between),[reg]):valid=False;break
                if not valid:break
                path=self.path_indices(runtime,store-2,sink)
                if not path or path[-1]!=sink:valid=False;break
                # Only all-path invariants may use a DAG union. Consumed
                # setters must themselves dominate the real runtime call.
                after=[runtime[i] for i in self.path_indices(runtime,store,sink) if i not in (store,sink)]
                if any(z[1] in ('bl','blr') and not self.runtime(z,'_swift_retain') for z in after):valid=False;break
                if any(z[1].startswith('st') and not re.search(r'\[(?:sp|x29)[,\]]',z[2]) for z in after):valid=False;break
                setters=[i for i in path if runtime[i][1:]==('mov','x4, '+context_reg) and self.dominates(runtime,i,sink)] if context_reg!='x4' else [store-1]
                if len(setters)!=1:valid=False;break
                setter=setters[0]
                if not self.dominates(runtime,setter,sink):valid=False;break
                source_span=[runtime[i] for i in self.path_indices(runtime,store-1,setter) if i not in (store-1,setter)]
                target_span=[runtime[i] for i in self.path_indices(runtime,setter,sink) if i not in (setter,sink)]
                if not self.unchanged(source_span,0,len(source_span),[context_reg]) or not self.unchanged(target_span,0,len(target_span),['x4']):valid=False;break
                descriptor_proof=self.constant_witness(runtime,sink,'x3')
                if descriptor_proof is None:valid=False;break
                descriptor,start=descriptor_proof
                # The actual ADRP/ADD argument tail is linear and dominates;
                # branch-only constants cannot be borrowed from another path.
                if not self.dominates(runtime,start,sink) or not self.single_entry(runtime,start,sink) or any(boundary(z) for z in runtime[start:sink]):valid=False;break
                if not self.wrapper_uses_original(self.descriptor(descriptor,endpoint=False)):valid=False;break
            if valid:edges.add((symbol,self.symbols[original][0]))
        return edges

    def safe_spill_span(self, code, begin, end):
        # Only stores through the fresh task-allocation result are accepted;
        # arbitrary aliases could target the saved stack entry.
        allocated=False
        for index in range(begin,end):
            ins=code[index]
            if self.runtime(ins,'_swift_task_alloc'):allocated=True;continue
            if ins[1] in ('bl','blr'):allocated=False
            if ins[1].startswith('st'):
                if re.search(r'\[x22, #0x10\]',ins[2]):
                    # Swift async context is the incoming x22 ABI register.
                    if not self.unchanged(code,0,begin,['x22']):return False
                    if not self.unchanged(code,begin,index,['x22']):return False
                elif not allocated or not re.search(r'\[x0(?:,|\])',ins[2]):return False
            if 'x0' in writes(ins):allocated=False
        return True

    def relative_branches(self, symbol, code):
        edges=set()
        # Actual Swift async call entry: relative descriptor load, signed add,
        # spill across task allocation, restore, and consumed indirect branch.
        for begin,z in enumerate(code):
            m=re.fullmatch(r'w(\d+), w0, \[(x\d+)\]',z[2]) if z[1]=='ldp' else None
            if not m or begin+3>=len(code):continue
            relative,base='x'+m[1],m[2]
            if code[begin+1][1:]!=('sxtw',relative+', w'+m[1]):continue
            add=re.fullmatch(r'(x\d+), '+relative+r', '+base,code[begin+2][2]) if code[begin+2][1]=='add' else None
            if not add:continue
            entry_reg=add[1]
            spill=re.fullmatch(entry_reg+r', \[sp, #(0x[0-9a-f]+|[0-9]+)\]',code[begin+3][2]) if code[begin+3][1]=='str' else None
            if not spill:continue
            descriptor=self.constant(code,begin,base)
            if descriptor is None:continue
            for end in range(begin+4,min(len(code),begin+MAX_SLICE)):
                if code[end][1]!='br':continue
                branch=code[end][2]
                last=self.last_write(code,end,branch)
                if last is None:continue
                load=re.fullmatch(branch+r', x\d+, \[sp, #'+re.escape(spill[1])+r'\]',code[last][2]) if code[last][1]=='ldp' else None
                if not load or not self.unchanged(code,last+1,end,[branch]):continue
                between=code[begin+4:last]
                if any(boundary(i) or i[1] in ('bl','blr') and not self.runtime(i,'_swift_task_alloc') for i in between):continue
                if not self.unchanged(code,begin+4,last+1,['sp']):continue
                if not self.safe_spill_span(code,begin+4,last):continue
                if not self.single_entry(code,begin,end):continue
                endpoint=self.descriptor(descriptor)
                edges.add((symbol,self.symbols[endpoint][0]))
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


def prove_async_edges(functions, symbols, imports, read_bytes, get_function, data_imports=None, read_pointer=None, get_body=None):
    """Return only verified scheduler edges; callbacks share caller budgets.

    functions: {symbol: (start, stop, normalizedAssembly)}
    symbols: {exactFunctionEntry: (mangled, normalizedDemangled)}
    imports: {deliveredStubAddress: exactImportName}
    read_bytes(vmAddress, count): exact delivered file-backed bytes
    get_function(exactEntry): same tuple, shared caller limits/deadline
    data_imports: exact delivered data import slots (separate from call stubs)
    read_pointer(slot): exact delivered dyld rebase target; no opaque bit masks
    get_body(exactMachOEntry): address-only ABI window, never a graph identity
    """
    proof=AsyncProof(functions,symbols,imports,read_bytes,get_function,data_imports,read_pointer,get_body)
    edges=set()
    for symbol,window in list(functions.items()):
        code=proof.decode(window)
        edges.update(proof.switches(symbol,code))
        edges.update(proof.dispatch(symbol,code))
        edges.update(proof.task(symbol,code))
        edges.update(proof.registered_task(symbol,code))
        edges.update(proof.relative_branches(symbol,code))
    # Newly proven closure entrypoints can actor-hop via a consumed continuation.
    # Do not inspect unrelated named closures as roots.
    pending=[b for _,b in edges];seen=set()
    while pending:
        symbol=pending.pop()
        if symbol in seen:
            continue
        seen.add(symbol)
        code=proof.decode(proof.functions[symbol])
        added=proof.switches(symbol,code) | proof.relative_branches(symbol,code)
        edges.update(added);pending.extend(b for _,b in added)
        # Actual direct branch/call edges remain the existing graph's authority;
        # load only reached owned entries so their continuation can be inspected.
        for ins in code:
            address=target(ins)
            if address in symbols and 'NimoMacResourceTransport.' in symbols[address][1] and 'closure #' in symbols[address][1]:
                child,_=proof.load(address)
                pending.append(child)
    return edges
