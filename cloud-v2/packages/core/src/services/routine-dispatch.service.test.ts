import {expect, test} from 'bun:test';
import {testRoutineSource} from '../testing/framework-fixtures';
import {routineEnrollmentSchema, type RoutineEnrollment} from '../types/routine-definition.types';
import {RoutineDispatchService, recordedRoutineBuild} from './routine-dispatch.service';
import {TestRequestService, requestInputDigest, isExecutableRequest, type StoredRequest, type TestRequestRepository} from './test-request.service';
import {TestRunError} from './test-result-error';
const source = {channel: 'pr' as const, prNumber: 12, buildRunId: 55, publicationAttempt: 2};
const selected = {requestId: 'pr:12:routine', routineId: 'arbitrary.new-routine', platform: 'android' as const, source};
function fixture() {
  let revision = 'a'.repeat(40), resolves = 0, sourceResolves = 0, enrollments = 0, available = true, automatic = true;
  let row: StoredRequest | null = null;
  const definitions = new Map<string, RoutineEnrollment>();
  const repository: TestRequestRepository = {
    async get() {return structuredClone(row);}, async insert(value) {if(row)throw Object.assign(Error('duplicate'),{code:11000});row=structuredClone(value);},
    async insertPreparation(value) {if(row)throw Object.assign(Error('duplicate'),{code:11000});row=structuredClone(value);},
    async completePreparation(id,host,digest,input,inputSha256) {if(!row||row.state!=='preparing'||row.hostId!==host||row.dispatchIntentSha256!==digest)return null;row={...row,state:'queued',input,inputSha256};return structuredClone(row);},
    async preparations(host) {return row?.state==='preparing'&&row.hostId===host?[structuredClone(row) as any]:[];},
    async queued(host) {return row&&isExecutableRequest(row)&&row.state==='queued'&&row.hostId===host?[{...structuredClone(row),createdAt:new Date('2026-10-06T12:00:00Z')}]:[];},
    async cancelPreparation(id,digest,value) {if(!row||row.state!=='preparing'||row.dispatchIntentSha256!==digest)return null;row={...row,state:'terminal',terminalStatus:'cancelled',preparationCancellation:value} as any;return structuredClone(row) as any;},
    async updatePreparation(id,host,digest,value) {if(!row||row.state!=='preparing')return null;row={...row,preparation:value} as any;return structuredClone(row) as any;},
    async rejectPreparation(id,host,digest,value) {if(!row||row.state!=='preparing')return null;row={...row,state:'terminal',terminalStatus:'not-run',preparationRejection:value} as any;return structuredClone(row) as any;},
    async accept(){return null;},async reject(){return null;},async cancel(){return null;},async acknowledgeCancellation(){return null;},async cancellations(){return []},
  };
  const requests = new TestRequestService(repository);
  const definition = (commit=revision) => {const body={id:selected.routineId,minimumRoutineApiVersion:1,title:'New routine',purpose:'Check',platforms:['android'],entry:'home',account:'lane',requires:[],requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],execution:{resourceKinds:['app']},source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:commit,path:`routines/${selected.routineId}/routine.ts`}};
    return routineEnrollmentSchema.parse({routineId:selected.routineId,platform:selected.platform,definitionRevision:commit,definitionSha256:requestInputDigest(body),routineSource:testRoutineSource(commit),definition:body});};
  const service = new RoutineDispatchService({async current(){return []},async getCurrent(){throw Error('no current fallback')},async getExact(id,platform,commit){return definitions.get(commit)??null},async enroll(value){const parsed=routineEnrollmentSchema.parse(value);enrollments++;definitions.set(parsed.definitionRevision,parsed);return parsed}},
    {async resolve(value,platform){resolves++;return {source:value,platform,availability:'available',title:'App',headSha:'c'.repeat(40),createdAt:'2026-10-03T11:00:00Z',buildUrl:'https://github.com/Mentra-Community/MentraOS/actions/runs/55',archive:{name:'app.apk',size:100,sha256:'d'.repeat(64),url:'https://artifactscdn.mentraglass.com/app.apk'},receipt:{size:10,sha256:'e'.repeat(64),url:'https://artifactscdn.mentraglass.com/receipt.json'}}}},
    {async get(hostId){return available?{hostId,incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:new Date().toISOString(),receivedAt:new Date().toISOString(),lanes:[{id:'android-lane',platform:'android',dispatchMode:automatic?'automatic':'paused',state:'idle',resources:[{id:'app:android',kind:'app'}]}]}:null}},requests,
    {async detail(){throw new TestRunError(404,'not published')}},()=>({android:{hostId:'mini',laneId:'android-lane'}}),
    {async resolve(override){sourceResolves++;return override??revision},async inventory(commit){return {commit,files:[{path:`routines/${selected.routineId}/routine.ts`,gitBlobSha1:'f'.repeat(40),size:10}]}}}, null);
  return {service,requests,repository,definition,definitions,get resolves(){return resolves},get sourceResolves(){return sourceResolves},get enrollments(){return enrollments},set revision(value:string){revision=value},set available(value:boolean){available=value},set automatic(value:boolean){automatic=value}};
}
test('new routine is retained with exact main and app references before publication; retries never substitute newer source',async()=>{
  const f=fixture();expect(await f.service.catalog()).toMatchObject({routineRevision:'a'.repeat(40),routines:[{routineId:selected.routineId}]});
  const first=await f.service.submit(selected);expect(first).toMatchObject({state:'preparing',dispatchIntent:{routineRevision:'a'.repeat(40),source,build:{headSha:'c'.repeat(40)}}});
  expect(first).not.toHaveProperty('input');expect(first).not.toHaveProperty('inputSha256');
  const page=await f.requests.queued('mini',undefined,50);expect(page.requests).toEqual([]);expect(page.preparations).toHaveLength(1);
  f.revision='b'.repeat(40);const calls=f.sourceResolves;expect(await f.service.submit(selected)).toEqual(first);expect(f.sourceResolves).toBe(calls);expect(f.resolves).toBe(1);
  for(const changed of [{...selected,source:{...source,buildRunId:56}},{...selected,routineRevision:'b'.repeat(40)},{...selected,routineId:'changed'}])await expect(f.service.submit(changed)).rejects.toThrow('changed');
});
test('host exact source completion enrolls then commits executable input once and preserves original binding',async()=>{
  const f=fixture(),waiting=await f.service.submit(selected),row=f.definition();
  const body={dispatchIntentSha256:waiting.dispatchIntentSha256,routineSource:row.routineSource,definitionSha256:row.definitionSha256,definition:row.definition};
  const queued=await f.service.prepared(selected.requestId,'mini',body);expect(queued).toMatchObject({state:'queued',input:{definitionRevision:'a'.repeat(40),laneId:'android-lane',build:{source}}});
  expect(queued.inputSha256).toBe(requestInputDigest(queued.input));expect(f.enrollments).toBe(1);f.available=false;
  expect(await f.service.prepared(selected.requestId,'mini',body)).toEqual(queued);expect(f.resolves).toBe(1);
  await expect(f.service.prepared(selected.requestId,'other',body)).rejects.toMatchObject({status:404});
  await expect(f.service.prepared(selected.requestId,'mini',{...body,routineSource:testRoutineSource('b'.repeat(40))})).rejects.toThrow();
});
test('cancellation before preparation survives restart and cannot become executable',async()=>{
  const f=fixture(),waiting=await f.service.submit(selected),row=f.definition();
  const cancelled=await f.requests.cancel(selected.requestId,'2026-10-06T12:00:00Z','User cancelled');expect(cancelled).toMatchObject({state:'terminal',terminalStatus:'cancelled',preparationCancellation:{reason:'User cancelled'}});
  expect(cancelled).not.toHaveProperty('inputSha256');
  const restarted=new TestRequestService(f.repository);expect((await restarted.queued('mini',undefined,50)).preparations).toEqual([]);
  expect(await f.service.prepared(selected.requestId,'mini',{dispatchIntentSha256:waiting.dispatchIntentSha256,routineSource:row.routineSource,definitionSha256:row.definitionSha256,definition:row.definition})).toEqual(cancelled!);
  expect(f.enrollments).toBe(0);
});
test('unsupported platform is only an input-free preparation disposition',async()=>{
  const f=fixture(),waiting=await f.service.submit(selected);
  const rejected=await f.requests.rejectPreparation(selected.requestId,'mini',{dispatchIntentSha256:waiting.dispatchIntentSha256,code:'not-applicable',reason:'Exact routine supports Mac only',rejectedAt:'2026-10-06T12:00:00Z',disposition:'not-applicable'});
  expect(rejected).toMatchObject({state:'terminal',terminalStatus:'not-run',preparationRejection:{disposition:'not-applicable'},dispatchIntent:{platform:'android',routineRevision:'a'.repeat(40)}});
  expect(rejected).not.toHaveProperty('runId');expect(rejected).not.toHaveProperty('input');
});
test('explicit source override and framework floor remain separate and immutable',async()=>{
  const f=fixture(),routineSource=testRoutineSource('d'.repeat(40));const row=await f.service.submit({...selected,routineSource,minimumFrameworkVersion:42});
  expect(row).toMatchObject({dispatchIntent:{routineRevision:routineSource.commit,routineSource,minimumFrameworkVersion:42}});
  await expect(f.service.submit({...selected,routineSource,routineRevision:'e'.repeat(40)})).rejects.toMatchObject({status:400});
  await expect(f.service.submit({...selected,routineSource,minimumFrameworkVersion:43})).rejects.toThrow('changed');
});
test('existing exact enrollment is optional warm cache and frozen historical app reuse is strict',async()=>{
  const f=fixture(),definition=f.definition();f.definitions.set(definition.definitionRevision,definition);
  const queued=await f.service.submit(selected);expect(queued.state).toBe('queued');
  const input=queued.input as any;expect(recordedRoutineBuild(input.build,source,'android').headSha).toBe('c'.repeat(40));
  const sourceCalls=f.sourceResolves;
  await expect(f.service.prepareIntent({...selected,routineSource:definition.routineSource},{hostId:'mini',laneId:input.laneId,build:input.build})).resolves.toMatchObject({dispatchIntent:{routineRevision:definition.definitionRevision}});expect(f.resolves).toBe(1);expect(f.sourceResolves).toBe(sourceCalls);
  expect(()=>recordedRoutineBuild({...input.build,archive:undefined},source,'android')).toThrow('incomplete');
});


test('exact preparation completes on its frozen explicitly assigned paused lane without asserting a start',async()=>{
  const f=fixture();f.automatic=false;const waiting=await f.service.submit(selected),definition=f.definition();
  const prepared=await f.service.prepared(selected.requestId,'mini',{dispatchIntentSha256:waiting.dispatchIntentSha256,routineSource:definition.routineSource,definitionSha256:definition.definitionSha256,definition:definition.definition});
  expect(prepared.state).toBe('queued');expect(prepared).not.toHaveProperty('hostReceipt');expect(prepared).not.toHaveProperty('runId');expect((prepared.input as any).laneId).toBe('android-lane');
});


test('known candidate-only source is a precise validation refusal without ordinary promotion',async()=>{
  const f=fixture(),definition=f.definition();let enrolls=0;
  (f.service as any).definitions={async getExact(_id:string,_platform:string,_revision:string,ordinary:boolean){return ordinary?null:definition},async enroll(){enrolls++}};
  await expect(f.service.submit({...selected,routineRevision:definition.definitionRevision})).rejects.toMatchObject({status:422,message:expect.stringContaining('accepted authoring job')});
  expect(enrolls).toBe(0);expect(await f.requests.get(selected.requestId)).toBeNull();
});
