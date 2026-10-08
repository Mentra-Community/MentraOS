import {createHash} from 'node:crypto';
import {expect, test, mock} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {testRoutineSource} from '../testing/framework-fixtures';
import {requestInputDigest} from './test-request.service';
import {RoutineJobService, isAutomaticPrRoutineJob, routineJobRepository, routineLaneDescriptorRevision, routineRequirementLabels, compatibleRoutineLane, type RoutineJobRepository} from './routine-job.service';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {ReceivedTestHostState} from './test-host-state.service';
const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:2};
const selection = {requestId:'job-one',routineId:'new-routine',platform:'android' as const,source,routineRevision:'a'.repeat(40)};
const definition = {id:'new-routine',minimumRoutineApiVersion:1,title:'A check',purpose:'Verify independently',platforms:['android'],entry:'home',account:'lane',
  requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],
  execution:{resourceKinds:['phone','app','recorder','network']},resourceRequirements:[{kind:'phone',capabilities:[]},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']}],
  source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:selection.routineRevision,path:'routines/new-routine/routine.ts'}};
function fixture(selectedDefinition: Omit<typeof definition, 'resourceRequirements'> & {resourceRequirements: {kind: string; capabilities: string[]}[]; glasses?: {models: string[]}} = definition) {
  let time = Date.parse('2026-10-08T00:00:00Z'), row:StoredRoutineJob|null=null, resolves=0, sources=0;
  let offeredHosts: ReceivedTestHostState[] | undefined;
  const copy = <T>(value:T):T => structuredClone(value);
  const rows:RoutineJobRepository={
    async get(id){return row?.requestId===id?copy(row):null},async insert(value){if(row)throw Object.assign(Error('duplicate'),{code:11000});row=copy(value)},
    async prepare(id,digest,prepared,inputSha256,now){if(!row||row.requestId!==id||row.state!=='awaiting-source'||row.fleetSelectionSha256!==digest||row.fleetCancellation||row.fleetDeadline<=now)return null;
      row={...row,fleetPreparation:copy(prepared),fleetInputSha256:inputSha256,state:'awaiting-runner'};return copy(row)},
    async bind(id,digest,binding,intent,now){if(!row||row.requestId!==id||row.state!=='awaiting-runner'||row.fleetBinding||row.fleetInputSha256!==digest||row.fleetCancellation||row.fleetDeadline<=now)return null;
      row={...row,hostId:binding.hostId,fleetBinding:copy(binding),dispatchIntent:copy(intent),dispatchIntentSha256:requestInputDigest(intent),state:'preparing'};return copy(row)},
    async dispatch(id,previous,value){if(!row||requestInputDigest(row.fleetDispatch??null)!==requestInputDigest(previous??null)||row.fleetCancellation||row.fleetBinding)return null;row={...row,fleetDispatch:copy(value)};return copy(row)},
    async actions(id,digest,value){if(!row||(row.fleetInputSha256!==digest && row.fleetSelectionSha256!==digest))return null;if(!row.fleetActions?.some(action=>action.actionsRunId===value.actionsRunId))row={...row,fleetActions:[...row.fleetActions??[],copy(value)]};return copy(row)},
    async complete(id,hostId,inputSha256,value) {if(!row||row.requestId!==id||row.hostId!==hostId||(row as any).inputSha256!==inputSha256||row.dispatchCompletion)return null;row={...row,dispatchCompletion:copy(value),...(row.fleetCancellation && row.state!=='terminal'?{state:'terminal',terminalStatus:'cancelled'}:{})};return copy(row)},
    async cancel(id,digest,value){if(!row||row.requestId!==id||row.fleetSelectionSha256!==digest||row.fleetCancellation)return null;row={...row,fleetCancellation:copy(value),...(row.dispatchCompletion && row.state!=='terminal'?{state:'terminal',terminalStatus:'cancelled'}:{})};return copy(row)},
  };
  const lane:ReceivedTestHostState['lanes'][number]={id:'android',platform:'android',state:'idle',dispatchMode:'automatic',resources:[
    {id:'phone:android',kind:'phone'}, {id:'app:android',kind:'app'}, {id:'recorder:android',kind:'recorder'}, {id:'network:uplink',kind:'network',capabilities:['independent-uplink']}]};
  lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  const host=(hostId:string):ReceivedTestHostState=>({hostId,incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString(),lanes:[copy(lane)]});
  const service=new RoutineJobService(rows,{async resolve(value,platform){resolves++;return {source:value,platform,availability:'available',title:'App',headSha:'c'.repeat(40),createdAt:new Date(time).toISOString(),buildUrl:'https://github.com/Mentra-Community/MentraOS/actions/runs/55',
    archive:{name:'app.apk',size:100,sha256:'d'.repeat(64),url:'https://artifactscdn.mentraglass.com/app.apk'},receipt:{size:10,sha256:'e'.repeat(64),url:'https://artifactscdn.mentraglass.com/receipt.json'}}}},
    {async resolve(revision){sources++;return revision??selection.routineRevision},async inventory(commit){return {commit,files:[]}},async blob(){return new Uint8Array()}},
    {async getExact(){return null}}, {async get(hostId){return offeredHosts?.find(host => host.hostId === hostId) ?? host(hostId)}, async list(){return offeredHosts ?? []}}, {async cancel(){if(row && row.state!=='terminal')row={...row,state:'terminal',terminalStatus:'cancelled'};return null}},
    {async detail(){throw Object.assign(new Error('missing'),{status:404})}},()=>time);
  // Result lookup intentionally uses the same 404 class as existing Core result APIs.
  const prepare=async()=>{const first=await service.submit(selection);await service.prepared(selection.requestId,{inputSha256:first.fleetSelectionSha256,
    routineSource:testRoutineSource(selection.routineRevision),definitionSha256:requestInputDigest(selectedDefinition),definition:selectedDefinition});return service.preparation(selection.requestId)};
  return {service,rows,lane,prepare,offer(hosts: ReceivedTestHostState[]){offeredHosts=copy(hosts)},settle(inputSha256:string){if(row)row={...row,state:'terminal',terminalStatus:'pass',inputSha256} as any},accepted(inputSha256:string){if(row)row={...row,state:'accepted',inputSha256} as any},get row(){return row},get resolves(){return resolves},get sources(){return sources},advance(ms:number){time+=ms}};
}
test('run routing chooses an accepting alternate model, refreshes availability and retains exact target and input', async () => {
  const f = fixture({...definition, resourceRequirements: [...definition.resourceRequirements,{kind:'glasses',capabilities:['connection']}], glasses: {models: ['g1', 'mentra-live']}, execution: {resourceKinds: ['phone', 'app', 'recorder', 'network', 'glasses']}});
  const time = Date.parse('2026-10-08T00:00:00Z');
  const lane = (model: string, state: ReceivedTestHostState['lanes'][number]['state'], dispatchMode: ReceivedTestHostState['lanes'][number]['dispatchMode']) => ({...f.lane,
    id: model, state, dispatchMode, resources: [...f.lane.resources, {id: `glasses:${model}`, kind: 'glasses' as const, capabilities: ['connection']}],
    glasses: [{resourceId: `glasses:${model}`, deviceId: model, model, capabilities: ['connection']}]});
  const host: ReceivedTestHostState = {hostId: 'healthy', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(time).toISOString(), receivedAt: new Date(time).toISOString(), lanes: [lane('g1', 'idle', 'paused'), lane('mentra-live', 'idle', 'automatic')]};
  f.offer([host]);
  const prepared = await f.prepare(), digest = prepared.inputSha256, frozen = structuredClone(f.row!.fleetSelection);
  expect(prepared.chosenModel).toBe('mentra-live'); expect(prepared.waitingReason).toBeUndefined();
  expect(prepared.routingLabels).toEqual(routineRequirementLabels(prepared.prepared!.requirements, 'mentra-live'));
  host.lanes[0]!.dispatchMode = 'automatic'; host.lanes[0]!.state = 'in-repair'; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).chosenModel).toBe('mentra-live');
  host.lanes[0]!.state = 'running'; host.lanes[1]!.state = 'running'; f.offer([host]);
  expect(await f.service.preparation(selection.requestId)).toMatchObject({state: 'awaiting-runner', waitingReason: 'Awaiting an idle compatible enrolled runner', inputSha256: digest});
  host.lanes[0]!.state = 'idle'; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).chosenModel).toBe('g1');
  expect(f.row!.fleetSelection).toEqual(frozen); expect(f.row!.fleetInputSha256).toBe(digest);
  const {routineJobRouting} = await import('./routine-job.service');
  expect(routineJobRouting(prepared.prepared!.requirements, [host], time, {hostId: 'elsewhere'})).toMatchObject({waitingReason: 'Awaiting a compatible enrolled runner'});
  expect(routineJobRouting(prepared.prepared!.requirements, [host], time, {hostId: host.hostId, laneId: 'mentra-live'})).toMatchObject({waitingReason: 'Awaiting an idle compatible enrolled runner'});
});
test('offline requirements and exact app/source freeze before host selection; retries preserve them',async()=>{
  const f=fixture(),prepared=await f.prepare();expect(prepared).toMatchObject({state:'awaiting-runner',prepared:{requirements:{platform:'android',resources:[{kind:'phone',capabilities:[]},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']}]}}});
  const calls=f.sources;await f.service.submit(selection);expect(f.sources).toBe(calls);expect(f.resolves).toBe(1);expect(f.row?.hostId).toBeUndefined();
  await expect(f.service.submit({...selection,source:{...source,buildRunId:56}})).rejects.toThrow('changed');
  await expect(f.service.prepared(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,routineSource:testRoutineSource(selection.routineRevision),definitionSha256:requestInputDigest({...definition,minimumRoutineApiVersion:2}),definition:{...definition,minimumRoutineApiVersion:2}})).rejects.toThrow();
});
test('concurrent automatic source choices have one insert winner and its cancellation fences default retries',async()=>{
  const f=fixture(),choices=await Promise.allSettled([f.service.submit(selection),
    f.service.submit({...selection,routineRevision:'b'.repeat(40)})]);
  expect(choices.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  const loser=choices.find(row=>row.status==='rejected');
  expect(loser && loser.status==='rejected' ? loser.reason.message : '').toContain('changed');
  const frozen=structuredClone(f.row!.fleetSelection),sourceCalls=f.sources,buildCalls=f.resolves;
  await f.service.cancel(selection.requestId,{reason:'Original automatic occurrence cancelled'});
  const {routineRevision:_,...defaultRetry}=selection;
  await f.service.submit(defaultRetry);
  expect(f.row!.fleetSelection).toEqual(frozen);expect(f.row!.fleetCancellation!.reason).toBe('Original automatic occurrence cancelled');
  expect(f.row!.fleetBinding).toBeUndefined();expect(f.sources).toBe(sourceCalls);expect(f.resolves).toBe(buildCalls);
});
test('single CAS binding retains winner across hosts and duplicate Actions deliveries',async()=>{
  const f=fixture(),prepared=await f.prepare(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  const bindings=await Promise.all([f.service.bind(selection.requestId,'mini',input),f.service.bind(selection.requestId,'air',{...input,actionsRunId:'11',actionsJobId:'21'})]);
  expect(bindings.filter(value=>value.execute)).toHaveLength(1);expect(bindings[0]!.binding).toEqual(bindings[1]!.binding);expect(f.row?.hostId).toBe(bindings[0]!.binding.hostId);
  const winner=bindings.find(value=>value.execute)!;const repeated=await f.service.bind(selection.requestId,winner.binding.hostId,{...input,actionsRunId:winner.binding.actionsRunId,actionsJobId:'99'});expect(repeated.execute).toBe(false);
});
test('descriptor/capability and target fences reject incompatible assignments before binding',async()=>{
  const f=fixture(),prepared=await f.prepare(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  await expect(f.service.bind(selection.requestId,'mini',{...input,descriptorRevision:'f'.repeat(64)})).rejects.toThrow('descriptor');
  f.lane.resources.find(resource => resource.kind === 'network')!.capabilities=[];f.lane.descriptorRevision=routineLaneDescriptorRevision(f.lane);
  await expect(f.service.bind(selection.requestId,'mini',{...input,descriptorRevision:f.lane.descriptorRevision})).rejects.toThrow('compatible');expect(f.row?.fleetBinding).toBeUndefined();
});
test('cancel and deadline before bind never revive after preparation retry or observer restart',async()=>{
  const f=fixture(),prepared=await f.prepare();await f.service.cancel(selection.requestId,{reason:'Cancel before runner'});
  const input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  await expect(f.service.bind(selection.requestId,'mini',input)).rejects.toThrow('Cancelled');expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,terminalStatus:'not-run',waitingReason:'Cancel before runner'});
  const expired=fixture(),before=await expired.prepare();expired.advance(3*3600_000);
  await expect(expired.service.bind(selection.requestId,'mini',{...input,inputSha256:before.inputSha256})).rejects.toThrow('expired');expect(await expired.service.observation(selection.requestId)).toMatchObject({terminal:true,waitingReason:expect.stringContaining('deadline')});
});
test('Mongo bind predicate guards absent host/binding, uncancelled prepared identity and deadline in one write',async()=>{
  const original=TestRequestModel.collection.findOneAndUpdate,cas=mock(async(..._args:unknown[])=>null);
  TestRequestModel.collection.findOneAndUpdate=cas as any;
  try {await routineJobRepository.bind('job-one','a'.repeat(64),{jobId:'job-one',requestId:'job-one',hostId:'mini',laneId:'android',descriptorRevision:'b'.repeat(64),actionsRunId:'10',actionsJobId:'20',boundAt:'2026-10-08T00:00:00Z'}, {requestId:'job-one'},new Date('2026-10-08T00:00:00Z'));
    expect(cas.mock.calls[0]?.[0]).toMatchObject({requestId:'job-one',fleetInputSha256:'a'.repeat(64),state:'awaiting-runner',fleetBinding:{$exists:false},hostId:{$exists:false},fleetCancellation:{$exists:false},fleetDeadline:{$gt:new Date('2026-10-08T00:00:00Z')}});
  } finally {TestRequestModel.collection.findOneAndUpdate=original;}
});

test('Mongo cancellation settlement cannot overwrite a concurrent late Actions registration',async()=>{
 const original=TestRequestModel.updateOne,write=mock(async(..._args:unknown[])=>({modifiedCount:0}));
 TestRequestModel.updateOne=write as any;
 try {
  await routineJobRepository.cancellationProgress!('job-one',{checkedAt:'2026-10-08T00:01:00Z',settled:true},['10']);
  expect(write.mock.calls[0]?.[0]).toEqual({requestId:'job-one',fleetCancellation:{$exists:true},
   $expr:{$setIsSubset:[{$ifNull:['$fleetActions.actionsRunId',[]]},{$literal:['10']}]}});
  await routineJobRepository.cancellationProgress!('job-one',{checkedAt:'2026-10-08T00:01:00Z',settled:false});
  expect(write.mock.calls[1]?.[0]).toEqual({requestId:'job-one',fleetCancellation:{$exists:true}});
 } finally {TestRequestModel.updateOne=original;}
});

test('recorded outcome does not finish the observer before immutable cleanup disposition',async()=>{
  const f=fixture(),prepared=await f.prepare(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  await f.service.bind(selection.requestId,'mini',input);f.settle('c'.repeat(64));
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'terminal',terminal:false});
  const completion={inputSha256:'c'.repeat(64),disposition:'repair' as const,completedAt:'2026-10-08T00:01:00Z'};
  await expect(f.service.complete(selection.requestId,'air',completion)).rejects.toThrow('host');
  expect(await f.service.complete(selection.requestId,'mini',completion)).toEqual(completion);
  expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,cleanupDisposition:'repair'});
  await expect(f.service.complete(selection.requestId,'mini',{...completion,disposition:'clean'})).rejects.toThrow('original');
});

test('same Actions owner cannot execute again after clean or repair custody completion before a result arrives',async()=>{
 for(const disposition of ['clean','repair'] as const) {
  const f=fixture(),prepared=await f.prepare(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,
   descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'result still uploading')}};
  const first=await f.service.bind(selection.requestId,'mini',input);expect(first.execute).toBe(true);
  f.accepted('c'.repeat(64));await f.service.complete(selection.requestId,'mini',{inputSha256:'c'.repeat(64),disposition,completedAt:'2026-10-08T00:01:00Z'});
  const retry=await f.service.bind(selection.requestId,'mini',input);
  expect(retry.execute).toBe(false);expect(retry.binding).toEqual(first.binding);expect(retry.observation.state).toBe('accepted');
  expect(retry.observation.terminal).toBe(false);expect(retry.observation.cleanupDisposition).toBe(disposition);
 }
});

test('Core descriptor and portable labels preserve Harness contract canonical vectors',()=>{
  const lane={id:'android',platform:'android' as const,resources:[{id:'network',kind:'network' as const,capabilities:['uplink','local']},{id:'app',kind:'app' as const}],
    glasses:[{resourceId:'glasses',deviceId:'physical-id',model:'mentra-live',capabilities:['camera','glasses-ble']}]};
  const requirements={platform:'android' as const,resources:[{kind:'app' as const,capabilities:[]},{kind:'glasses' as const,capabilities:[]},{kind:'network' as const,capabilities:['uplink']}],
    glasses:{models:['mentra-live'],capabilities:['camera']}};
  expect(routineLaneDescriptorRevision({...lane,state:'idle',dispatchMode:'automatic'})).toBe('1125ed39610b4f5e0608a03c004034a81a391de8d918ad084770d853fe5e93ad');
  expect(routineRequirementLabels(requirements,'mentra-live',{hostId:'mini',laneId:'android'})).toEqual(["mentra-cap-88fd66625b6607cf73ef6514", "mentra-glasses-8b982bc38a1cd2c23060fc28", "mentra-glasses-cap-e1cd3be513538367f4a65804", "mentra-host-0e35b86da19b45127d398a2d", "mentra-lane-79e50f81f24836c05823b540", "mentra-platform-android", "mentra-resource-app", "mentra-resource-glasses", "mentra-resource-network"]);
});

test('associated Actions deliveries reconcile the same run without restarting or growing retries',async()=>{
  const f=fixture(),prepared=await f.prepare();
  const first=await f.service.actions(selection.requestId,{inputSha256:prepared.inputSha256,actionsRunId:'10'});
  const retried=await f.service.actions(selection.requestId,{inputSha256:prepared.inputSha256,actionsRunId:'10'});
  expect(first.actionsRuns).toHaveLength(1);expect(retried.actionsRuns).toEqual(first.actionsRuns);
  await expect(f.service.actions(selection.requestId,{inputSha256:'f'.repeat(64),actionsRunId:'11'})).rejects.toThrow('exact');
  expect(f.row?.fleetBinding).toBeUndefined();
});

test('lost dispatch response retries retained logical job after backoff and acknowledgement prevents replay',async()=>{
  const f=fixture();let attempts=0;
  (f.service as any).actionsTransport={async dispatch(id:string){expect(id).toBe(selection.requestId);attempts++;if(attempts===1)throw new Error('lost response')},async runs(){return attempts>=2?[{actionsRunId:'10',status:'queued',conclusion:null}]:[]},async cancel(){}};
  const first=await f.service.submit(selection);expect(first.fleetDispatch?.error).toContain('unavailable');expect(attempts).toBe(1);
  await f.service.submit(selection);expect(attempts).toBe(1);f.advance(30_001);
  const retried=await f.service.submit(selection);expect(retried.fleetDispatch?.acknowledgedAt).toBeDefined();expect(attempts).toBe(2);
  f.advance(30_001);await f.service.submit(selection);expect(attempts).toBe(2);expect(f.row?.fleetSelectionSha256).toBe(first.fleetSelectionSha256);
});


test('Actions registration after cancellation cancels the late workflow without creating a binding',async()=>{
  const f=fixture(),prepared=await f.prepare(),cancelled:string[]=[];
  (f.service as any).actionsTransport={async dispatch(){},async cancel(id:string){cancelled.push(id)}};
  await f.service.cancel(selection.requestId,{reason:'Cancelled before dispatch acknowledged'});
  expect(await f.service.actions(selection.requestId,{inputSha256:prepared.inputSha256,actionsRunId:'10'})).toMatchObject({terminal:true});
  expect(cancelled).toEqual(['10']);expect(f.row?.fleetBinding).toBeUndefined();
});


test('frozen suite admissions retain expired members and reject deadlines beyond the three-hour policy',async()=>{
  const expired=fixture(),frozen=await expired.service.freezeSelection(selection);
  expect(await expired.service.submitFrozen(frozen,'2026-10-07T23:59:59Z')).toMatchObject({fleetCancellation:{reason:expect.stringContaining('deadline')}});
  const future=fixture();await expect(future.service.submitFrozen(frozen,'2026-10-08T04:00:00Z')).rejects.toThrow('three hours');
  expect(future.row).toBeNull();
});

test('cancelling an absent frozen member inserts its fence atomically and no retry can dispatch or bind it',async()=>{
 const f=fixture(),frozen=await f.service.freezeSelection(selection),deadline='2026-10-08T03:00:00Z';let dispatches=0;
 (f.service as any).actionsTransport={async dispatch(){dispatches++},async runs(){return []},async cancel(){}};
 const insert=f.rows.insert.bind(f.rows);f.rows.insert=async row=>{
  if(f.row)return insert(row);
  expect(row).toMatchObject({state:'terminal',terminalStatus:'not-run',fleetCancellation:{reason:'Suite cancelled'}});
  await insert(row);
  // A reconciliation read can observe the first durable row immediately after insertion.
  expect(await f.service.observation(row.requestId)).toMatchObject({terminal:true,terminalStatus:'not-run'});
 };
 const first=await f.service.cancelFrozen(frozen,deadline,{reason:'Suite cancelled'});
 expect(first).toMatchObject({terminal:true,terminalStatus:'not-run',waitingReason:'Suite cancelled'});expect(dispatches).toBe(0);
 const original=f.row!.fleetCancellation;await f.service.cancelFrozen(frozen,deadline,{reason:'Suite cancelled'});
 await f.service.submitFrozen(frozen,deadline);expect(f.row!.fleetCancellation).toEqual(original);expect(dispatches).toBe(0);
 await f.service.prepared(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,routineSource:testRoutineSource(selection.routineRevision),
  definitionSha256:requestInputDigest(definition),definition});
 await expect(f.service.bind(selection.requestId,'mini',{inputSha256:f.row!.fleetSelectionSha256,laneId:f.lane.id,
  descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'})).rejects.toThrow();
 expect(f.row?.fleetBinding).toBeUndefined();expect(dispatches).toBe(0);
 await expect(f.service.cancelFrozen({...frozen,routineRevision:'b'.repeat(40)},deadline,{reason:'Suite cancelled'})).rejects.toThrow('different exact inputs');
 const lost=fixture(),save=lost.rows.insert.bind(lost.rows);
 (lost.service as any).actionsTransport={async dispatch(){dispatches++},async runs(){return []},async cancel(){}};
 lost.rows.insert=async row=>{await save(row);throw Error('Insert acknowledgement lost')};
 await expect(lost.service.cancelFrozen(frozen,deadline,{reason:'Suite cancelled'})).rejects.toThrow('Insert acknowledgement lost');
 expect(lost.row).toMatchObject({state:'terminal',fleetCancellation:{reason:'Suite cancelled'}});
 await lost.service.cancelFrozen(frozen,deadline,{reason:'Suite cancelled'});await lost.service.submitFrozen(frozen,deadline);
 expect(dispatches).toBe(0);expect(lost.row?.fleetBinding).toBeUndefined();
});


test('cancelFrozen reconciles an existing bound member through its original host cancellation and custody receipt',async()=>{
 const f=fixture(),prepared=await f.prepare(),cancelled:unknown[][]=[];let dispatches=0;
 const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
 (f.service as any).requests={async cancel(...args:unknown[]){cancelled.push(args);return f.row}};
 (f.service as any).actionsTransport={async dispatch(){dispatches++},async runs(){return []},async cancel(){}};
 const bound=await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,
  descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
 f.accepted('c'.repeat(64));const frozen=f.row!.fleetSelection,deadline=f.row!.fleetDeadline.toISOString();
 expect(await f.service.cancelFrozen(frozen,deadline,{reason:'Suite cancelled'})).toMatchObject({state:'accepted',terminal:false});
 expect(cancelled).toHaveLength(1);expect(cancelled[0]?.[0]).toBe(selection.requestId);
 expect(cancelled[0]?.[1]).toBe(f.row!.fleetCancellation!.requestedAt);expect(cancelled[0]?.[2]).toBe('Suite cancelled');
 expect(f.row!.fleetBinding).toEqual(bound.binding);
 const cancellation=f.row!.fleetCancellation;await f.service.cancelFrozen(frozen,deadline,{reason:'Suite cancelled'});
 expect(f.row!.fleetCancellation).toEqual(cancellation);expect(dispatches).toBe(0);
 await f.service.complete(selection.requestId,'mini',{inputSha256:'c'.repeat(64),disposition:'clean',completedAt:'2026-10-08T00:01:00Z'});
 expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,terminalStatus:'cancelled',cleanupDisposition:'clean'});
 expect(f.row!.fleetBinding).toEqual(bound.binding);expect(dispatches).toBe(0);
});

test('cancelled accepted custody finishes only after exact host cleanup receipt without claiming a passing run',async()=>{
  const f=fixture(),prepared=await f.prepare();
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  (f.service as any).requests={async cancel(){return f.row}};
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  f.accepted('c'.repeat(64));await f.service.cancel(selection.requestId,{reason:'Stop accepted work'});
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'accepted',terminal:false});
  await f.service.complete(selection.requestId,'mini',{inputSha256:'c'.repeat(64),disposition:'clean',completedAt:'2026-10-08T00:01:00Z'});
  const observed=await f.service.observation(selection.requestId);expect(observed).toMatchObject({state:'terminal',terminal:true,terminalStatus:'cancelled'});
  expect(observed).not.toHaveProperty('result');
});

test('ordinary cleanup without cancellation cannot invent an outcome while later cancellation settles clean custody',async()=>{
  const f=fixture(),prepared=await f.prepare();
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  (f.service as any).requests={async cancel(){return f.row}};
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  f.accepted('c'.repeat(64));await f.service.complete(selection.requestId,'mini',{inputSha256:'c'.repeat(64),disposition:'repair',completedAt:'2026-10-08T00:01:00Z'});
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'accepted',terminal:false});
  await f.service.cancel(selection.requestId,{reason:'Cancel settled custody'});
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'terminal',terminal:true,terminalStatus:'cancelled'});
});


test('deadline cancels an Actions observer still awaiting cleanup after result publication',async()=>{
  const f=fixture(),prepared=await f.prepare(),cancelled:string[]=[];
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  (f.service as any).actionsTransport={async dispatch(){},async cancel(id:string){cancelled.push(id)}};
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  f.settle('c'.repeat(64));f.advance(3*3600_000);
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'terminal',terminal:false,terminalStatus:'pass',waitingReason:expect.stringContaining('deadline')});
  expect(cancelled).toEqual(['10']);
});


test('acknowledged preparer failure is retried before bind while queued deliveries and bound work never reoffer',async()=>{
 const f=fixture();let attempts=0,status='queued';
 (f.service as any).actionsTransport={async dispatch(){attempts++},async runs(){return [{actionsRunId:String(attempts),status,conclusion:status==='completed'?'failure':null}]},async cancel(){}};
 await f.service.submit(selection);expect(attempts).toBe(1);f.advance(30_001);await f.service.observation(selection.requestId);expect(attempts).toBe(1);expect(f.row?.fleetActions).toHaveLength(1);
 status='completed';f.advance(30_001);await f.service.observation(selection.requestId);expect(attempts).toBe(2);
 const prepared=await f.prepare();const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
 await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'2',actionsJobId:'20'});
 f.advance(30_001);await f.service.observation(selection.requestId);expect(attempts).toBe(2);
});

test('cancellation discovers queued workflows before offline preparation and cancels all duplicates',async()=>{
 const f=fixture(),cancelled:string[]=[];
 (f.service as any).actionsTransport={async dispatch(){},async runs(){return [{actionsRunId:'10',status:'queued',conclusion:null},{actionsRunId:'11',status:'queued',conclusion:null}]},async cancel(id:string){cancelled.push(id)}};
 await f.service.submit(selection);await f.service.cancel(selection.requestId,{reason:'Cancel queued prep'});
 expect(cancelled).toEqual(['10','11']);expect(f.row?.fleetActions).toHaveLength(2);expect(f.row?.fleetPreparation).toBeUndefined();
});


test('dispatch compatibility refuses capabilities unioned across physical pairs or duplicate resource providers',()=>{
 const f=fixture(),requirements={platform:'android' as const,resources:[{kind:'network' as const,capabilities:['independent-uplink']}]};
 expect(compatibleRoutineLane(requirements,f.lane)).toBe(true);
 expect(compatibleRoutineLane(requirements,{...f.lane,resources:[...f.lane.resources,{id:'other-uplink',kind:'network'}]})).toBe(false);
 expect(compatibleRoutineLane(requirements,{...f.lane,glasses:[{resourceId:'one',deviceId:'one',model:'mentra-live',capabilities:['camera']},{resourceId:'two',deviceId:'two',model:'mentra-live',capabilities:['glasses-ble']}]})).toBe(false);
});

function automaticId() {
  return `routine-${createHash('sha256').update(JSON.stringify(['source-pr-55-2', selection.routineId, selection.platform,
    {channel: 'pr', buildRunId: 55, publicationAttempt: 2, prNumber: 12}, null])).digest('hex')}`;
}
test('superseded automatic PR jobs are fenced before delivery and retries preserve cancellation', async () => {
  const f = fixture(), automatic = {...selection, requestId: automaticId()};
  let changed = false, dispatches = 0, checks = 0;
  const builds = {async resolve() {throw Error('frozen only')}, async isPrSuperseded() {checks++; return changed;}};
  const service = new RoutineJobService(f.rows, builds, undefined, undefined, undefined, undefined, undefined,
    () => Date.parse('2026-10-08T00:00:00Z'), {async dispatch(){dispatches++}, async cancel(){}, async runs(){return []}});
  const first = await f.service.submit({...selection, requestId: automatic.requestId});
  expect(isAutomaticPrRoutineJob(first)).toBe(true);
  changed = true;
  await service.submit(automatic);
  expect(dispatches).toBe(0); expect(f.row!.fleetCancellation!.reason).toContain('Superseded');
  const receipt = structuredClone(f.row!.fleetCancellation);
  await service.submit(automatic);
  expect(f.row!.fleetCancellation).toEqual(receipt); expect(checks).toBe(1);
});
test('manual PR runs never consult current head for cancellation', async () => {
  const f = fixture(); await f.service.submit(selection);
  const service = new RoutineJobService(f.rows, {async resolve(){throw Error('frozen only')},
    async isPrSuperseded(){throw Error('Manual request must retain exact source')}});
  await service.preparation(selection.requestId);
  expect(f.row!.fleetCancellation).toBeUndefined();
});
test('supersession refresh includes bound jobs and failed metadata checks do not fabricate cancellation', async () => {
  const f = fixture(), id = automaticId(); await f.service.submit({...selection, requestId: id});
  let checked = 0;
  f.rows.supersessionCandidates = async () => [f.row!]; f.rows.supersessionChecked = async () => {checked++;};
  const service = new RoutineJobService(f.rows, {async resolve(){throw Error('frozen only')},
    async isPrSuperseded(){throw Error('GitHub unavailable')}});
  await service.reconcilePending();
  expect(checked).toBe(1); expect(f.row!.fleetCancellation).toBeUndefined();
});

test('automatic PR supersession blocks binding even when a lane is idle and compatible', async () => {
  const f = fixture(), id = automaticId(), first = await f.service.submit({...selection,requestId:id});
  await f.service.prepared(id,{inputSha256:first.fleetSelectionSha256,routineSource:testRoutineSource(selection.routineRevision),
    definitionSha256:requestInputDigest(definition),definition});
  const service = new RoutineJobService(f.rows,{async resolve(){throw Error('frozen only')},async isPrSuperseded(){return true;}},
    undefined,undefined,undefined,undefined,undefined,()=>Date.parse('2026-10-08T00:00:00Z'));
  await expect(service.bind(id,'mini',{inputSha256:f.row!.fleetInputSha256,laneId:f.lane.id,
    descriptorRevision:f.lane.descriptorRevision,actionsRunId:'123',actionsJobId:'124'})).rejects.toThrow('Cancelled');
  expect(f.row!.fleetBinding).toBeUndefined(); expect(f.row!.fleetCancellation!.reason).toContain('Superseded');
});
