import {expect,test,spyOn} from 'bun:test';
import {TestRerunService,type RerunRepository,type RerunRecord} from './test-rerun.service';
import {requestInputDigest} from './test-request.service';
import {TestRunError} from './test-result-error';
import {testRoutineSource} from '../testing/framework-fixtures';
const source={channel:'dev' as const,buildRunId:123,publicationAttempt:1};
const nativeInput={routineId:'captions',routineSource:testRoutineSource(),platform:'android' as const,definitionRevision:'a'.repeat(40),laneId:'android',resources:[{id:'app',kind:'app' as const}],build:{repository:'Mentra-Community/MentraOS',headSha:'b'.repeat(40),channel:'dev' as const,source}};
function fixture(){
 const rows=new Map<string,RerunRecord>(),claims=new Set<string>(),requests=new Map<string,any>(),results=new Map<string,any>();
 let time=Date.parse('2026-10-06T12:00:00Z'),prepared=0,failId='',executions=0;
 const members=Array.from({length:28},(_,i)=>({memberId:`member-${i}`,requestId:`original-${i}`,routineId:'captions',platform:'android',status:i<20?'pass':i<22?'failed':'setup-failed',publicationComplete:true}));
 const store:RerunRepository={async get(id){return structuredClone(rows.get(id)??null)},async insert(row){if(rows.has(row.rerunId))throw Object.assign(new Error(),{code:11000});rows.set(row.rerunId,structuredClone(row));},async accept(id,digest,keys,acceptedAt){const row=rows.get(id)!;if(row.state==='accepted')return null;if(keys.some(k=>claims.has(k)))throw Object.assign(new Error(),{code:11000});keys.forEach(k=>claims.add(k));row.state='accepted';row.acceptedAt=acceptedAt;return structuredClone(row);},async history(root,before,limit){return [...rows.values()].filter(r=>r.state==='accepted'&&r.plan.members.some(m=>m.rootKey===root&&m.attemptNumber<before)).sort((a,b)=>b.plan.members.find(m=>m.rootKey===root)!.attemptNumber-a.plan.members.find(m=>m.rootKey===root)!.attemptNumber).slice(0,limit).map(r=>structuredClone(r));},async children(id,before,limit){const cursor=before?JSON.parse(Buffer.from(before,"base64url").toString()):null;return [...rows.values()].filter(r=>r.state==='accepted'&&'suiteId' in r.plan.parent&&r.plan.parent.suiteId===id&&(!cursor||r.acceptedAt!<cursor.acceptedAt||(r.acceptedAt===cursor.acceptedAt&&r.rerunId<cursor.rerunId))).sort((a,b)=>b.acceptedAt!.localeCompare(a.acceptedAt!)||b.rerunId.localeCompare(a.rerunId)).slice(0,limit)},async byRequest(id){return [...rows.values()].find(r=>r.state==='accepted'&&r.plan.members.some(m=>m.requestId===id))??null}};
 const service=new TestRerunService(store,{async detail(){return {members} as any}},{async prepare(selected:any){prepared++;return {hostId:'mini',input:{...structuredClone(nativeInput),build:{...structuredClone(nativeInput.build),source:selected.source}}}}},{async get(id){return requests.get(id)??null},async submit(id,hostId,input){if(id===failId)throw new Error('transport');if(!requests.has(id)){executions++;requests.set(id,{requestId:id,hostId,input,inputSha256:requestInputDigest(input),state:'queued'})}return requests.get(id)}},{async summary(id){if(!results.has(id))throw new TestRunError(404,'missing');return results.get(id)}},()=>time);
 const preview=(rerunId='repair',selection:any={filter:{statuses:['failed','setup-failed','teardown-failed']}})=>service.preview({rerunId,parent:{suiteId:'nightly'},selection,source,reason:'Verify fix'},'admin:philippe');
 const complete=(id:string,status='pass',evidenceStatus='complete')=>{requests.get(id).state='terminal';results.set(id,{...nativeInput,runId:`run-${id}`,outcome:status,uploadsComplete:true,evidenceStatus})};
 return {service,preview,rows,requests,results,members,complete,get prepared(){return prepared},get executions(){return executions},set failId(id:string){failId=id},advance(){time+=600001}};
}
test('28-member suite selects only its eight failures; preview queues nothing and immutable retries resolve once',async()=>{
 const f=fixture(),original=structuredClone(f.members),p=await f.preview();expect(p.plan.members).toHaveLength(8);expect(f.executions).toBe(0);expect(f.prepared).toBe(8);
 expect(await f.preview()).toEqual(p);expect(f.prepared).toBe(8);
 const input={rerunId:p.rerunId,previewDigest:p.previewDigest};await f.service.submit(input);await f.service.submit(input);expect(f.executions).toBe(8);expect(f.members).toEqual(original);
 await expect(f.service.preview({rerunId:'repair',parent:{suiteId:'nightly'},selection:{memberIds:['member-20']},source,reason:'different'},'admin')).rejects.toThrow('different selection');
});
test('one member, exclusions, unknown duplicates empty and nonterminal selections',async()=>{
 const f=fixture();expect((await f.preview('one',{memberIds:['member-20']})).plan.members).toHaveLength(1);
 expect((await f.preview('excluded',{filter:{statuses:['failed'],excludeMemberIds:['member-20']}})).plan.members.map(m=>m.memberId)).toEqual(['member-21']);
 for(const selection of [{memberIds:[]},{memberIds:['unknown']},{memberIds:['member-20','member-20']},{filter:{statuses:['cancelled']}}])await expect(f.preview('bad',selection)).rejects.toThrow();
 f.members[20]!.status='running';await expect(f.preview('active',{memberIds:['member-20']})).rejects.toThrow('terminal');
});
test('partial admission retries retain exact request IDs and app source; wrong digest never admits',async()=>{
 const f=fixture(),p=await f.preview();f.failId=p.plan.members[0]!.requestId;
 await expect(f.service.submit({rerunId:'repair',previewDigest:'0'.repeat(64)})).rejects.toThrow();expect(f.executions).toBe(0);
 const input={rerunId:'repair',previewDigest:p.previewDigest};expect((await f.service.submit(input)).admissions.filter(a=>!a.admitted)).toHaveLength(1);
 f.failId='';await f.service.submit(input);expect(f.executions).toBe(8);expect([...f.requests.values()].every(r=>r.input.build.source.buildRunId===123)).toBe(true);
});
test('concurrent successor claims accept one entire batch; active rerun conflicts',async()=>{
 const f=fixture(),a=await f.preview('a'),b=await f.preview('b');const submissions=await Promise.allSettled([f.service.submit({rerunId:'a',previewDigest:a.previewDigest}),f.service.submit({rerunId:'b',previewDigest:b.previewDigest})]);
 expect(submissions.filter(s=>s.status==='fulfilled')).toHaveLength(1);expect(f.executions).toBe(8);await expect(f.preview('c')).rejects.toThrow('active rerun');
});
test('terminal history orders by attempt number and incomplete evidence never repairs a pass',async()=>{
 const f=fixture(),a=await f.preview('a',{memberIds:['member-20']});await f.service.submit({rerunId:'a',previewDigest:a.previewDigest});f.complete(a.plan.members[0]!.requestId);
 const b=await f.preview('b',{memberIds:['member-20']});expect(b.plan.members[0]!.predecessorAttemptId).toBe(a.plan.members[0]!.requestId);await f.service.submit({rerunId:'b',previewDigest:b.previewDigest});f.complete(b.plan.members[0]!.requestId,'pass','failed');
 expect((await f.service.detail('b')).passed).toBe(0);const history=await f.service.history({suiteId:'nightly'},'member-20',undefined,1);expect(history.original.status).toBe('failed');expect(history.attempts[0]!.attemptNumber).toBe(2);expect(history.nextBefore).toBe(2);expect((await f.service.history({suiteId:'nightly'},'member-20',2)).attempts[0]!.attemptNumber).toBe(1);
});
test('preview expires and corrupted frozen inputs or result provenance fail closed',async()=>{
 const f=fixture(),p=await f.preview('expired');f.advance();await expect(f.service.submit({rerunId:'expired',previewDigest:p.previewDigest})).rejects.toThrow('expired');
 const q=await f.preview('corrupt',{memberIds:['member-20']});f.rows.get('corrupt')!.plan.reason='tampered';await expect(f.service.submit({rerunId:'corrupt',previewDigest:q.previewDigest})).rejects.toThrow('integrity');
 const r=await f.preview('result',{memberIds:['member-21']});await f.service.submit({rerunId:'result',previewDigest:r.previewDigest});f.complete(r.plan.members[0]!.requestId);f.results.get(r.plan.members[0]!.requestId).build={...nativeInput.build,headSha:'c'.repeat(40)};await expect(f.service.detail('result')).rejects.toThrow('differs');
});
test('members that never admitted have a stable original identity and individual previews require latest predecessor',async()=>{
 const f=fixture();delete (f.members[20] as any).requestId;const p=await f.preview('no-request',{memberIds:['member-20']});expect(p.plan.members[0]!.predecessorAttemptId).toStartWith('original-');
 await expect(f.service.individual({requestId:'new',parent:{suiteId:'nightly',memberId:'member-20'},predecessorAttemptId:'stale',source,reason:'Fix'},'admin')).rejects.toThrow('Predecessor changed');
});
test('artifact override is optional; default reuses original while a new rerun may choose another build',async()=>{
 const f=fixture();f.members[20]={...f.members[20]!,build:structuredClone(nativeInput.build)} as any;
 const input={rerunId:'default',parent:{suiteId:'nightly'},selection:{memberIds:['member-20']},reason:'Framework fix only'};
 const p=await f.service.preview(input,'admin');expect(p.plan.source).toBeUndefined();expect(p.plan.members[0]!.input.build.source).toEqual(source);
 await f.service.submit({rerunId:p.rerunId,previewDigest:p.previewDigest});f.complete(p.plan.members[0]!.requestId);
 const replacement={...input,rerunId:'replacement',source:{...source,buildRunId:456}};
 const next=await f.service.preview(replacement,'admin');expect(next.plan.members[0]!.input.build.source).toEqual(replacement.source);expect(next.plan.members[0]!.attemptNumber).toBe(2);
 delete (f.members[21] as any).build;await expect(f.service.preview({...input,rerunId:'missing',selection:{memberIds:['member-21']}},'admin')).rejects.toThrow('explicit replacement');
});

test('child batches use acceptance time with stable pagination rather than arbitrary IDs',async()=>{
 const f=fixture();for(let i=0;i<22;i++){const p=await f.preview(`batch-${i%2?"a":"z"}-${i}`,{memberIds:['member-20']});await f.service.submit({rerunId:p.rerunId,previewDigest:p.previewDigest});f.complete(p.plan.members[0]!.requestId);f.advance();}
 const page=await f.service.children('nightly');expect(page.children).toHaveLength(20);expect(page.children[0]!.rerunId).toBe('batch-a-21');expect(page.nextCursor).toBeTruthy();const older=await f.service.children('nightly',page.nextCursor!);expect(older.children).toHaveLength(2);expect(older.nextCursor).toBeNull();await expect(f.service.children('nightly','bad')).rejects.toThrow('cursor');
});
test('default glasses rerun prefers complete admitted build over compact nightly app references',async()=>{
 const f=fixture();const manifest={url:'https://artifactscdn.mentraglass.com/firmware.json',size:100,sha256:'c'.repeat(64)};
 const build={...nativeInput.build,archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',size:100,sha256:'d'.repeat(64)},receipt:{url:'https://artifactscdn.mentraglass.com/receipt.json',size:100,sha256:'e'.repeat(64)},manifest,manifestSha256:manifest.sha256};
 const input={...nativeInput,resources:[...nativeInput.resources,{id:'glasses',kind:'glasses' as const}],build,glassesStart:{model:'mentra-live' as const,manifest},glassesReturn:{model:'mentra-live' as const,manifest}};
 f.requests.set('original-20',{input,inputSha256:requestInputDigest(input),hostId:'mini',state:'terminal'});(f.members[20] as any).build=nativeInput.build;
 let recorded:any;const {RoutineDispatchService}=await import('./routine-dispatch.service');
const {routineEnrollmentSchema}=await import('../types/routine-definition.types');
 const definition=routineEnrollmentSchema.parse({routineId:'captions',platform:'android',routineSource:nativeInput.routineSource,definitionRevision:nativeInput.definitionRevision,definitionSha256:'a'.repeat(64),definition:{id:'captions',minimumRoutineApiVersion:1,title:'Camera',purpose:'Check',platforms:['android'],entry:'home',account:'lane',requires:['camera'],requirements:[],fixtures:[],glasses:{models:['mentra-live']},steps:[{id:'check',instruction:'Check',expected:'Seen'}],execution:{resourceKinds:['app','glasses']},source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:nativeInput.definitionRevision,path:'routines/captions/routine.ts'}}});
 const dispatch=new RoutineDispatchService({async current(){return [definition]},async getCurrent(){return definition},async getExact(){return definition}},{async resolve(){throw Error('must not resolve current PR')}},{async get(){return {hostId:'mini',receivedAt:new Date().toISOString(),lanes:[{id:'android',platform:'android',dispatchMode:'automatic',state:'idle',resources:input.resources,glasses:[{resourceId:'glasses',deviceId:'live',model:'mentra-live',capabilities:['camera']}]}]} as any}},undefined,undefined,()=>({android:{hostId:'mini',laneId:'android'}}));
 const wrapped={async prepare(selected:any,original:any){recorded=original;return dispatch.prepare(selected,original)}};
 const service=new TestRerunService({async get(id:string){return f.rows.get(id)??null},async insert(row:RerunRecord){f.rows.set(row.rerunId,row)},async history(){return []},async byRequest(){return null}} as any,{async detail(){return {members:f.members} as any}},wrapped,{async get(id:string){return f.requests.get(id)??null},async submit(){throw Error('unused')}} as any,undefined);
 const {nightlySuiteProjection}=await import('./test-suite.service');
 const suite={suiteId:'nightly',channel:'dev',trigger:'nightly',startedAt:'2026-10-06T11:00:00Z',build:{headSha:build.headSha},members:f.members.map(m=>({memberId:m.memberId,requestId:m.requestId,routineId:m.routineId,platform:m.platform}))};
 const members=f.members.map(m=>({...m,definitionRevision:nativeInput.definitionRevision,definitionSha256:'a'.repeat(64),build:nativeInput.build,...(m.memberId==='member-20'?{input}: {})}));
 const plan={occurrenceId:'occurrence',suiteId:'nightly',startedAt:suite.startedAt,trigger:'nightly',suite,members};
 const result={...plan,members:members.map(m=>({...m,publicationComplete:false})),expectedCount:28,passed:0,status:'running'};
 const projected=nightlySuiteProjection(suite as any,plan as any,result as any);(service as any).suites={async detail(){return projected}};
 const p=await service.preview({rerunId:'glasses',parent:{suiteId:'nightly'},selection:{memberIds:['member-20']},reason:'Harness fix'},'admin');expect(recorded.manifest).toEqual(manifest);expect(p.plan.members[0]!.input.build.manifest).toEqual(manifest);expect(p.plan.members[0]!.input.glassesReturn?.manifest).toEqual(manifest);
});

test('repository history uses MongoDB 4.2 array selection and sorts the matching member before limiting',async()=>{
 const {TestRerunModel}=await import('../models/test-rerun.model');const {testRerunRepository}=await import('./test-rerun.service');let pipeline:any[]=[];
 const aggregate=spyOn(TestRerunModel,'aggregate').mockImplementation((stages:any)=>{pipeline=stages;return {read(){return this},readConcern(){return Promise.resolve([])}} as any});
 try {await testRerunRepository.history('root',4,2);expect(pipeline).toEqual([
 {$match:{state:'accepted','plan.members':{$elemMatch:{rootKey:'root',attemptNumber:{$lt:4}}}}},
 {$set:{historyMember:{$arrayElemAt:[{$filter:{input:'$plan.members',as:'member',cond:{$eq:['$$member.rootKey','root']}}},0]}}},
 {$sort:{'historyMember.attemptNumber':-1}},{$limit:2},{$unset:'historyMember'}]);expect(JSON.stringify(pipeline)).not.toContain('$first');}
 finally{aggregate.mockRestore()}
});
