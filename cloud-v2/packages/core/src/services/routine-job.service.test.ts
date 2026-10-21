import {TestRunError} from './test-result-error';
import {createHash} from 'node:crypto';
import {expect, test, mock, spyOn} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {TestHostStateModel} from '../models/test-host-state.model';
import {resourceReservationRepository, ResourceReservationsService} from './resource-reservations.service';
import {hostStateSchema} from './test-host-state.service';
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types';
import {resourceAvailable} from './resource-readiness';
import {createRoutineJobsApi} from '../api/internal/routine-jobs.api';
import {testRoutineSource} from '../testing/framework-fixtures';
import {requestInputDigest, TestRequestService, type TestRequestRepository, type HostAcceptance} from './test-request.service';
import {RoutineJobService, isAutomaticPrRoutineJob, routineJobRepository, routineJobInputDigest, orderedRoutineCandidates, routineLaneDescriptorRevision, routineRequirementLabels, compatibleRoutineLane, type RoutineJobRepository} from './routine-job.service';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {ReceivedTestHostState, RoutingTestHostState} from './test-host-state.service';
import type {ExclusiveHostReservation} from '../types/resource-reservations.types';
import {RESOURCE_ADMISSION_WAIT, RECORDER_CAPACITY_WAIT, RECORDER_OBSERVATION_WAIT, sharedResourceWait} from './routine-resource-wait';
const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:2};
const selection = {requestId:'job-one',routineId:'new-routine',platform:'android' as const,source,routineRevision:'a'.repeat(40)};
const definition = {id:'new-routine',minimumRoutineApiVersion:1,title:'A check',purpose:'Verify independently',platforms:['android'],entry:'home',account:'lane',
  requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],
  execution:{resourceKinds:['phone','app','recorder','network'],policy:{estimatedOutputBytes:1024 ** 3}},resourceRequirements:[{kind:'phone',capabilities:[]},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']}],
  source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:selection.routineRevision,path:'routines/new-routine/routine.ts'}};
function fixture(selectedDefinition: Omit<typeof definition, 'resourceRequirements' | 'fixtures'> & {resourceRequirements: {kind: string; capabilities: string[]}[]; fixtures: {provider: string; description: string}[]; glasses?: {models: string[]}} = definition) {
  let time = Date.parse('2026-10-08T00:00:00Z'), row:StoredRoutineJob|null=null, resolves=0, sources=0;
  let offeredHosts: (ReceivedTestHostState & Pick<RoutingTestHostState, 'authorityReservations'>)[] | undefined, resultFound = false;
  const copy = <T>(value:T):T => structuredClone(value);
  const rows:RoutineJobRepository={
    async get(id){return row?.requestId===id?copy(row):null},async insert(value){if(row)throw Object.assign(Error('duplicate'),{code:11000});row=copy(value)},
    async prepare(id,digest,prepared,inputSha256,now){if(!row||row.requestId!==id||row.state!=='awaiting-source'||row.fleetSelectionSha256!==digest||row.fleetCancellation||row.fleetDeadline<=now)return null;
      row={...row,fleetPreparation:copy(prepared),fleetInputSha256:inputSha256,state:'awaiting-runner'};return copy(row)},
    async exhaustPreparation(id,completed,now){if(!row||row.requestId!==id||row.fleetPreparation||row.fleetBinding||row.fleetCancellation||row.fleetDispatch?.attempts!==20||row.fleetActions?.some(run=>!completed.includes(run.actionsRunId)))return null;row={...row,state:'terminal',terminalStatus:'not-run',fleetCancellation:{requestedAt:now.toISOString(),reason:'Routine preparation exhausted 20 delivery attempts; inspect preparation diagnostics and submit corrected work.'}};return copy(row)},
    async preparationStatus(id,value,now){if(!row||row.requestId!==id||row.fleetPreparation||row.fleetBinding||row.fleetCancellation||row.state==='terminal'||row.fleetActions?.some(run=>BigInt(run.actionsRunId)>BigInt(value.actionsRunId)))return null;
      row={...row,fleetPreparationStatus:copy(value),...(!value.retryable?{state:'terminal' as const,terminalStatus:value.code==='not-applicable'?'not-applicable':'not-run',fleetCancellation:{requestedAt:now.toISOString(),reason:value.reason}}:{})};return copy(row)},
    async reserveResources(id,digest,hostId,laneId,now) {if(!row||row.requestId!==id||row.fleetInputSha256!==digest||row.fleetCancellation||row.fleetDeadline<=now)return null;
      if(row.fleetResourceReservation)return row.fleetResourceReservation.hostId===hostId&&row.fleetResourceReservation.laneId===laneId?copy(row):null;
      row={...row,fleetResourceReservation:{id:'591e0c34-ee97-41df-a0ec-5e2d0c7503ee',requestId:id,fleetInputSha256:digest,hostId,laneId,poolId:`${hostId}:disk:1`,minimumAvailableBytes:3*1024**3,reservedAt:now.toISOString(), ...(row.fleetPreparation?.requirements.glasses ? {chosenModel: offeredHosts?.find(host=>host.hostId===hostId)?.lanes.find(lane=>lane.id===laneId)?.glasses?.[0]?.model} : {})}};return copy(row)},
    async bind(id,digest,binding,intent,now){if(!row||row.requestId!==id||row.state!=='awaiting-runner'||row.fleetBinding||row.fleetInputSha256!==digest||row.fleetCancellation||row.fleetDeadline<=now)return null;
      row={...row,hostId:binding.hostId,fleetBinding:copy(binding),dispatchIntent:copy(intent),dispatchIntentSha256:requestInputDigest(intent),state:'preparing'};return copy(row)},
    async dispatch(id,previous,value){if(!row||requestInputDigest(row.fleetDispatch??null)!==requestInputDigest(previous??null)||row.fleetCancellation||row.fleetBinding)return null;row={...row,fleetDispatch:copy(value)};return copy(row)},
    async actions(id,digest,value){if(!row||(row.fleetInputSha256!==digest && row.fleetSelectionSha256!==digest))return null;if(!row.fleetActions?.some(action=>action.actionsRunId===value.actionsRunId))row={...row,fleetActions:[...row.fleetActions??[],copy(value)]};return copy(row)},
    async complete(id,hostId,inputSha256,value) {if(!row||row.requestId!==id||row.hostId!==hostId||(row as any).inputSha256!==inputSha256||row.dispatchCompletion)return null;row={...row,dispatchCompletion:copy(value),...(row.fleetCancellation && row.state!=='terminal'?{state:'terminal',terminalStatus:'cancelled'}:{})};return copy(row)},
    async hasResult(){return resultFound},
    async publicationFailed(id,hostId,completion,failure){if(!row||row.requestId!==id||row.hostId!==hostId||row.hostReceipt?.requestId!==id||row.hostReceipt.hostId!==hostId||row.hostReceipt.inputSha256!==completion.inputSha256||row.runId||row.publicationFailure||requestInputDigest(row.dispatchCompletion)!==requestInputDigest(completion))return null;
      row={...row,publicationFailure:copy(failure),state:'terminal',terminalStatus:'incomplete'};return copy(row)},
    async cancel(id,digest,value){if(!row||row.requestId!==id||row.fleetSelectionSha256!==digest||row.fleetCancellation)return null;row={...row,fleetCancellation:copy(value),...(row.dispatchCompletion && row.state!=='terminal'?{state:'terminal',terminalStatus:'cancelled'}:{})};return copy(row)},
  };
  const lane:ReceivedTestHostState['lanes'][number]={id:'android',platform:'android',state:'idle',dispatchMode:'automatic',resources:[
    {id:'phone:android',kind:'phone'}, {id:'app:android',kind:'app'}, {id:'recorder:android',kind:'recorder',storage:{poolId:'mini:disk:1',observedAt:new Date(time).toISOString(),availableBytes:64*1024**3,stagingBudgetBytes:10*1024**3,pendingEvidenceBytes:0,reservations:[]}}, {id:'network:uplink',kind:'network',capabilities:['independent-uplink']}]};
  lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  const host=(hostId:string):ReceivedTestHostState=>({hostId,incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString(),lanes:[{...copy(lane),resources:lane.resources.map(resource=>resource.storage?{...resource,storage:{...resource.storage,observedAt:new Date(time).toISOString()}}:resource)}]});
  const service=new RoutineJobService(rows,{async resolve(value,platform){resolves++;return {source:value,platform,availability:'available',title:'App',headSha:'c'.repeat(40),createdAt:new Date(time).toISOString(),buildUrl:'https://github.com/Mentra-Community/MentraOS/actions/runs/55',
    archive:{name:'app.apk',size:100,sha256:'d'.repeat(64),url:'https://artifactscdn.mentraglass.com/app.apk'},receipt:{size:10,sha256:'e'.repeat(64),url:'https://artifactscdn.mentraglass.com/receipt.json'}}}},
    {async resolve(revision){sources++;return revision??selection.routineRevision},async inventory(commit){return {commit,files:[]}},async blob(){return new Uint8Array()}},
    {async getExact(){return null}}, {async get(hostId){return offeredHosts?.find(host => host.hostId === hostId) ?? host(hostId)}, async list(){return offeredHosts ?? [host('mini')]}}, {async cancel(){if(row && row.state!=='terminal')row={...row,state:'terminal',terminalStatus:'cancelled'};return null}},
    {async detail(){throw new TestRunError(404,'missing')}},()=>time);
  // Result lookup intentionally uses the same 404 class as existing Core result APIs.
  const prepare=async()=>{const first=await service.submit(selection);await service.prepared(selection.requestId,{inputSha256:first.fleetSelectionSha256,
    routineSource:testRoutineSource(selection.routineRevision),definitionSha256:requestInputDigest(selectedDefinition),definition:selectedDefinition});return service.preparation(selection.requestId)};
  return {service,rows,lane,prepare,offer(hosts: (ReceivedTestHostState & Pick<RoutingTestHostState, 'authorityReservations'>)[]){offeredHosts=copy(hosts)}, restore(value:StoredRoutineJob){row=copy(value)},settle(inputSha256:string){if(row)row={...row,state:'terminal',terminalStatus:'pass',inputSha256} as any},queued(inputSha256:string){if(row)row={...row,state:'queued',inputSha256,hostReceipt:undefined} as any},accepted(inputSha256:string){if(row)row={...row,state:'accepted',inputSha256,hostReceipt:{requestId:row.requestId,hostId:row.hostId!,inputSha256,acceptedAt:new Date(time).toISOString()}} as any},result(insertedOnly=false){resultFound=true;if(row&&!insertedOnly)row={...row,runId:selection.requestId,state:'terminal',terminalStatus:'pass'}},get row(){return row},get resolves(){return resolves},get sources(){return sources},advance(ms:number){time+=ms}};
}
test('bound observation never substitutes prepared input before executable preparation', async () => {
  const f = fixture(), prepared = await f.prepare();
  expect(await f.service.observation(selection.requestId)).not.toHaveProperty('boundInputSha256');
  const input = {inputSha256: prepared.inputSha256, laneId: f.lane.id, descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'};
  const bound = await f.service.bind(selection.requestId, 'mini', input);
  expect(bound.observation).toMatchObject({inputSha256: prepared.inputSha256, state: 'preparing', terminal: false});
  expect(bound.observation).not.toHaveProperty('boundInputSha256');
});
test('portable preparation preserves an actual resource blocker instead of inventing recorder shortage when admission returns no winner', async () => {
  const f = fixture(), original = f.rows.reserveResources!; await f.prepare();
  const frozen = structuredClone(f.row);
  f.rows.reserveResources = async (_id, _digest, _host, _lane, _now, onWaiting) => {onWaiting?.(sharedResourceWait('google-authentication'), true); return null;};
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(sharedResourceWait('google-authentication'));
  expect(f.row).toEqual(frozen);
  f.rows.reserveResources = async () => null;
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT);
  f.rows.reserveResources = original;
});
test('existing observation reports a staged authority blocker without changing custody or manufacturing a recorder reason', async () => {
  const f = fixture(); await f.prepare();
  const row = {...f.row!, fleetResourceReservation: undefined};
  row.fleetResourceAdmission = {intent: {operationId: `run:${row.requestId}`, hostId: 'mini', laneId: f.lane.id,
    owner: {id: row.requestId, kind: 'run'}, inputSha256: row.fleetInputSha256!, controller: {incarnation: 'one', generation: 1, sequence: 1},
    resources: [{id: 'fixture', capabilities: ['google-authentication']}]},
    dependencies: [{resourceId: 'private-account', authorityHostId: 'mini', capability: 'google-authentication'}]};
  f.restore(row);
  f.offer([{hostId: 'mini', receivedAt: '2026-10-08T00:00:00Z', lanes: [f.lane], authorityReservations: [{kind: 'exclusive',
    resourceId: 'private-account', authorityHostId: 'mini', borrowerHostId: 'elsewhere', laneId: 'other', owner: {id: 'other-owner', kind: 'run'}}]} as any]);
  expect((await f.service.observation(row.requestId)).waitingReason).toBe(sharedResourceWait('google-authentication'));
  expect(f.row).toEqual(row);
});
test('portable routing distinguishes known capacity shortage, missing measurements and mixed unknowns before authority admission', async () => {
  const f = fixture(); await f.prepare();
  const row = {...f.row!, fleetResourceReservation: undefined}; f.restore(row);
  const now = Date.parse('2026-10-08T00:00:00Z');
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), lanes: [structuredClone(f.lane)]};
  host.lanes[0]!.resources.find(value => value.kind === 'recorder')!.storage!.availableBytes = 0; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RECORDER_CAPACITY_WAIT);
  delete host.lanes[0]!.resources.find(value => value.kind === 'recorder')!.storage; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RECORDER_OBSERVATION_WAIT);
  host.lanes.push({...structuredClone(f.lane), id: 'other'});
  host.lanes[1]!.resources.find(value => value.kind === 'recorder')!.storage!.availableBytes = 0; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT);
});

test('an observed exclusive blocker cannot be overwritten by a later candidate after its immutable target is staged', async () => {
  const f = fixture(); await f.prepare();
  const row = {...f.row!, fleetResourceReservation: undefined}; f.restore(row);
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: '2026-10-08T00:00:00Z', receivedAt: '2026-10-08T00:00:00Z', lanes: [structuredClone(f.lane), {...structuredClone(f.lane), id: 'other'}]};
  f.offer([host]);
  const candidates: string[] = [];
  f.rows.reserveResources = async (_id, _digest, hostId, laneId, _now, onWaiting) => {
    candidates.push(laneId);
    f.restore({...row, fleetResourceAdmission: {intent: {operationId: `run:${row.requestId}`, hostId, laneId,
      owner: {id: row.requestId, kind: 'run'}, inputSha256: row.fleetInputSha256!, controller: {incarnation: 'one', generation: 1, sequence: 1},
      resources: [{id: 'fixture', capabilities: ['google-authentication']}]},
      dependencies: [{resourceId: 'private-account', authorityHostId: 'mini', capability: 'google-authentication'}]}});
    onWaiting?.(candidates.length === 1 ? sharedResourceWait('google-authentication') : RECORDER_CAPACITY_WAIT, candidates.length === 1);
    return null;
  };
  expect((await f.service.preparation(row.requestId)).waitingReason).toBe(sharedResourceWait('google-authentication'));
  expect(candidates).toHaveLength(1);
  expect(f.row!.fleetResourceAdmission!.intent.laneId).toBe(candidates[0]!);
  expect(f.row!.fleetBinding).toBeUndefined(); expect(f.row!.fleetResourceReservation).toBeUndefined();
});

test('staged target disk shortage or absent observation is not hidden by another available lane', async () => {
  const f = fixture(); await f.prepare();
  const row = {...f.row!, fleetResourceReservation: undefined};
  row.fleetResourceAdmission = {intent: {operationId: `run:${row.requestId}`, hostId: 'mini', laneId: f.lane.id,
    owner: {id: row.requestId, kind: 'run'}, inputSha256: row.fleetInputSha256!, controller: {incarnation: 'one', generation: 1, sequence: 1},
    resources: [{id: 'recorder', capabilities: []}]}, dependencies: []};
  f.restore(row);
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: '2026-10-08T00:00:00Z', receivedAt: '2026-10-08T00:00:00Z', lanes: [structuredClone(f.lane), {...structuredClone(f.lane), id: 'other'}]};
  let calls = 0; f.rows.reserveResources = async () => {calls++; return null;};
  host.lanes[0]!.resources.find(resource => resource.kind === 'recorder')!.storage!.availableBytes = 0; f.offer([host]);
  expect((await f.service.preparation(row.requestId)).waitingReason).toBe(RECORDER_CAPACITY_WAIT);
  delete host.lanes[0]!.resources.find(resource => resource.kind === 'recorder')!.storage; f.offer([host]);
  expect((await f.service.preparation(row.requestId)).waitingReason).toBe(RECORDER_OBSERVATION_WAIT);
  expect(calls).toBe(0); expect(f.row).toEqual(row);
});

test('mixed candidate refusal and skipped recorder observations use truthful general wording regardless of order', async () => {
  const f = fixture(); await f.prepare(); f.restore({...f.row!, fleetResourceReservation: undefined});
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: '2026-10-08T00:00:00Z', receivedAt: '2026-10-08T00:00:00Z', lanes: [structuredClone(f.lane), {...structuredClone(f.lane), id: 'other'}]};
  f.rows.reserveResources = async (_id, _digest, _host, _lane, _now, onWaiting) => {onWaiting?.(RECORDER_CAPACITY_WAIT); return null;};
  delete host.lanes[1]!.resources.find(resource => resource.kind === 'recorder')!.storage;
  for (const lanes of [host.lanes, [...host.lanes].reverse()]) {
    f.offer([{...host, lanes}]); expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT);
  }
  host.lanes[1]!.resources.find(resource => resource.kind === 'recorder')!.storage = {...f.lane.resources.find(resource => resource.kind === 'recorder')!.storage!, availableBytes: 0};
  f.offer([host]); expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RECORDER_CAPACITY_WAIT);
});

test('observation phase diagnostics follow existing reads without changing original custody or outcome',async()=>{
  const f=fixture(),prepared=await f.prepare(), phases:string[]=[];
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  const before=structuredClone(f.row),result=await f.service.observation(selection.requestId,value=>phases.push(value));
  expect(phases).toEqual(['request','delivery','result','projection']);expect(f.row).toEqual(before);
  expect(result).toMatchObject({state:'preparing',terminal:false});expect(result).not.toHaveProperty('result');
});

test('deadline cancellation propagates phase through its nested observation and subsequent outer reload',async()=>{
  const f=fixture(),prepared=await f.prepare(),phases:string[]=[];
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  f.advance(3*3600000+1);
  const result=await f.service.observation(selection.requestId,value=>phases.push(value));
  expect(phases).toEqual(['request','delivery','cancellation','request','delivery','result','projection','request','result','projection']);
  expect(result).toMatchObject({state:'terminal',terminal:false});expect(f.row?.fleetCancellation?.reason).toContain('three-hour deadline');
  expect(result).not.toHaveProperty('dispatchCompletion');
});

for (const state of ['queued', 'accepted'] as const) {
  test(`${state} observation exposes the retained executable digest without changing prepared identity or custody`, async () => {
    const f = fixture(), prepared = await f.prepare(), executableDigest = 'c'.repeat(64);
    const input = {inputSha256: prepared.inputSha256, laneId: f.lane.id, descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'};
    const bound = await f.service.bind(selection.requestId, 'mini', input);
    f[state](executableDigest);
    const original = structuredClone(f.row);
    const previousToken = process.env.TEST_RUN_INGEST_TOKEN, token = 'routine-observation-regression-token-at-least-thirty-two-characters';
    let observation: unknown;
    try {
      process.env.TEST_RUN_INGEST_TOKEN = token;
      const response = await createRoutineJobsApi(f.service).request(`/${selection.requestId}/observation`,
        {headers: {authorization: `Bearer ${token}`}});
      expect(response.status).toBe(200);
      observation = await response.json();
    } finally {
      if (previousToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN;
      else process.env.TEST_RUN_INGEST_TOKEN = previousToken;
    }
    expect(observation).toMatchObject({inputSha256: prepared.inputSha256, boundInputSha256: executableDigest,
      state, terminal: false, binding: bound.binding});
    expect(executableDigest).not.toBe(prepared.inputSha256);
    const duplicate = await f.service.bind(selection.requestId, 'mini', input);
    expect(duplicate.observation).toMatchObject({inputSha256: prepared.inputSha256, boundInputSha256: executableDigest,
      state, terminal: false, binding: bound.binding});
    expect(f.row).toEqual(original);
    expect(observation).not.toHaveProperty('result');
    expect(f.row).not.toHaveProperty('fleetCancellation');
    expect(f.row).not.toHaveProperty('dispatchCompletion');
  });
}

test('run routing chooses an accepting alternate model, refreshes availability and retains exact target and input', async () => {
  const f = fixture({...definition, resourceRequirements: [...definition.resourceRequirements,{kind:'glasses',capabilities:['connection']}], glasses: {models: ['g1', 'mentra-live']}, execution: {resourceKinds: ['phone', 'app', 'recorder', 'network', 'glasses'], policy: {estimatedOutputBytes:1024**3}}});
  const time = Date.parse('2026-10-08T00:00:00Z');
  const lane = (model: string, state: ReceivedTestHostState['lanes'][number]['state'], dispatchMode: ReceivedTestHostState['lanes'][number]['dispatchMode']) => ({...f.lane,
    id: model, state, dispatchMode, resources: [...f.lane.resources, {id: `glasses:${model}`, kind: 'glasses' as const, capabilities: ['connection']}],
    glasses: [{resourceId: `glasses:${model}`, deviceId: model, model, capabilities: ['connection']}]});
  const host: ReceivedTestHostState = {hostId: 'healthy', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(time).toISOString(), receivedAt: new Date(time).toISOString(), lanes: [lane('g1', 'idle', 'paused'), lane('mentra-live', 'idle', 'automatic')]};
  f.offer([host]);
  const prepared = await f.prepare(), digest = prepared.inputSha256, frozen = structuredClone(f.row!.fleetSelection);
  expect(prepared.chosenModel).toBe('mentra-live'); expect(prepared.waitingReason).toBeUndefined();
  expect(prepared.routingLabels).toEqual(routineRequirementLabels(prepared.prepared!.requirements, 'mentra-live', {hostId:'healthy',laneId:'mentra-live'}));
  host.lanes[0]!.dispatchMode = 'automatic'; host.lanes[0]!.state = 'in-repair'; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).chosenModel).toBe('mentra-live');
  host.lanes[0]!.state = 'running'; host.lanes[1]!.state = 'running'; f.offer([host]);
  expect(await f.service.preparation(selection.requestId)).toMatchObject({state: 'awaiting-runner', resourceTarget: {hostId:'healthy',laneId:'mentra-live'}, inputSha256: digest});
  host.lanes[0]!.state = 'idle'; f.offer([host]);
  expect((await f.service.preparation(selection.requestId)).chosenModel).toBe('mentra-live');
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
test('a prepared request from before capacity admission retains its exact digest while the same policy gains a current claim', async () => {
  const f=fixture(); await f.prepare();
  const original=structuredClone(f.row!);
  original.fleetPreparation!.requirements.resources=original.fleetPreparation!.requirements.resources.map(({storage:_,...resource})=>resource);
  delete original.fleetResourceReservation;
  original.fleetInputSha256=routineJobInputDigest(original); f.restore(original);
  await f.service.prepared(selection.requestId,{inputSha256:original.fleetSelectionSha256,
    routineSource:testRoutineSource(selection.routineRevision),definitionSha256:requestInputDigest(definition),definition});
  expect(f.row).toEqual(original);
  const input={inputSha256:original.fleetInputSha256!,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  expect((await f.service.bind(selection.requestId,'mini',input)).execute).toBe(true);
  expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);
  expect(f.row!.fleetPreparation).toEqual(original.fleetPreparation);
  expect(f.row!.fleetResourceReservation).toMatchObject({requestId:selection.requestId,hostId:'mini',minimumAvailableBytes:3*1024**3});
});
test('a retained target never changes runner labels when another host becomes available', async () => {
  const f=fixture(), prepared=await f.prepare(), time=Date.parse('2026-10-08T00:00:00Z');
  const report=(hostId:string,state:'idle'|'offline'):ReceivedTestHostState=>({hostId,incarnation:'one',incarnationGeneration:1,sequence:1,
    observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString(),lanes:[{...structuredClone(f.lane),state}]});
  f.offer([report('mini','offline'),report('other','idle')]);
  const reserve=f.rows.reserveResources!;
  f.rows.reserveResources=async()=>null;
  const waiting=await f.service.preparation(selection.requestId);
  expect(waiting).toMatchObject({inputSha256:prepared.inputSha256,resourceTarget:{hostId:'mini',laneId:'android'},
    waitingReason:'Awaiting a compatible enrolled runner'});
  expect(waiting.routingLabels).toEqual(prepared.routingLabels);
  f.rows.reserveResources=reserve;
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
  const attempts=await Promise.allSettled([f.service.bind(selection.requestId,'mini',input),f.service.bind(selection.requestId,'air',{...input,actionsRunId:'11',actionsJobId:'21'})]);
  const bindings=attempts.flatMap(value=>value.status==='fulfilled'?[value.value]:[]);
  expect(bindings.filter(value=>value.execute)).toHaveLength(1);expect(f.row?.hostId).toBe('mini');
  const winner=bindings.find(value=>value.execute)!;const repeated=await f.service.bind(selection.requestId,winner.binding.hostId,{...input,actionsRunId:winner.binding.actionsRunId,actionsJobId:'99'});expect(repeated.execute).toBe(false);
});
test('descriptor/capability and target fences reject incompatible assignments before binding',async()=>{
  const f=fixture(),prepared=await f.prepare(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  await expect(f.service.bind(selection.requestId,'mini',{...input,descriptorRevision:'f'.repeat(64)})).rejects.toThrow('descriptor');
  f.lane.resources.find(resource => resource.kind === 'network')!.capabilities=[];f.lane.descriptorRevision=routineLaneDescriptorRevision(f.lane);
  await expect(f.service.bind(selection.requestId,'mini',{...input,descriptorRevision:f.lane.descriptorRevision})).rejects.toThrow('compatible');expect(f.row?.fleetBinding).toBeUndefined();
});
test('phone backend readiness capability cannot be supplied by the host uplink or an older phone provider', async () => {
  const f = fixture({...definition, resourceRequirements: definition.resourceRequirements.map(resource =>
    resource.kind === 'phone' ? {...resource, capabilities: ['backend-connectivity']} : resource)});
  const waiting = await f.prepare();
  expect(waiting.waitingReason).toBe('Awaiting a compatible enrolled runner');
  expect(f.row?.fleetPreparation?.requirements.resources.find(resource => resource.kind === 'phone')?.capabilities)
    .toEqual(['backend-connectivity']);
  f.lane.resources.find(resource => resource.kind === 'phone')!.capabilities = ['backend-connectivity'];
  f.lane.descriptorRevision = routineLaneDescriptorRevision(f.lane);
  const prepared = await f.service.preparation(selection.requestId);
  expect(prepared.state).toBe('awaiting-runner');
  const phone = prepared.prepared!.requirements.resources.find(resource => resource.kind === 'phone')!;
  expect(phone.capabilities).toEqual(['backend-connectivity']);
  f.lane.resources.find(resource => resource.kind === 'phone')!.capabilities = [];
  f.lane.descriptorRevision = routineLaneDescriptorRevision(f.lane);
  await expect(f.service.bind(selection.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: f.lane.id,
    descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'})).rejects.toThrow('compatible');
});
test('reviewed fixture operations exclude generic fixtures from routing and binding while preserving exact source', async () => {
  const selectedDefinition = {...definition,
    fixtures: [{provider: 'miniapp-appearance', description: 'Owned reviewed references and decoder'}],
    execution: {resourceKinds: [...definition.execution.resourceKinds, 'fixture-data'],policy:definition.execution.policy},
    resourceRequirements: [...definition.resourceRequirements, {kind: 'fixture-data', capabilities: ['reviewed-miniapp-appearance', 'media-decode']}]};
  const f = fixture(selectedDefinition);
  const lane = (capabilities: string[]): ReceivedTestHostState['lanes'][number] => {
    const value = {...f.lane, resources: [...f.lane.resources, {id: 'host-fixture', kind: 'fixture-data' as const, capabilities}]};
    return {...value, descriptorRevision: routineLaneDescriptorRevision(value)};
  };
  const observed = (hostId: string, offered: ReceivedTestHostState['lanes'][number]): ReceivedTestHostState => ({
    hostId, incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: '2026-10-08T00:00:00.000Z', receivedAt: '2026-10-08T00:00:00.000Z', lanes: [offered],
  });
  const generic = lane([]), decoderOnly = lane(['media-decode']);
  f.offer([observed('air', generic), observed('decoder-only', decoderOnly)]);
  const prepared = await f.prepare(), frozen = structuredClone(f.row!.fleetPreparation);
  expect(prepared.waitingReason).toBe('Awaiting a compatible enrolled runner');
  expect(prepared.prepared!.requirements.resources.find(resource => resource.kind === 'fixture-data')!.capabilities)
    .toEqual(['reviewed-miniapp-appearance', 'media-decode']);
  expect(prepared.routingLabels).toContain('mentra-cap-3d8d7338377d1ab81665e28e');
  expect(prepared.routingLabels).toContain('mentra-cap-a8e5ce48dfc27e77cac4aaf5');
  for (const [hostId, offered] of [['air', generic], ['decoder-only', decoderOnly]] as const)
    await expect(f.service.bind(selection.requestId, hostId, {inputSha256: prepared.inputSha256, laneId: offered.id,
      descriptorRevision: offered.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'})).rejects.toThrow('compatible lane descriptor');
  expect(f.row!.fleetBinding).toBeUndefined();
  const capable = lane(['reviewed-miniapp-appearance', 'media-decode']);
  expect(capable.descriptorRevision).not.toBe(generic.descriptorRevision);
  f.offer([observed('air', generic), observed('mini', capable)]);
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBeUndefined();
  expect(f.row!.fleetPreparation).toEqual(frozen);
  expect(f.row!.fleetInputSha256).toBe(prepared.inputSha256);
  const bound = await f.service.bind(selection.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: capable.id,
    descriptorRevision: capable.descriptorRevision!, actionsRunId: '11', actionsJobId: '21'});
  expect(bound.execute).toBe(true);
  expect(bound.binding.hostId).toBe('mini');
  expect(f.row!.fleetPreparation!.definition.fixtures).toEqual(selectedDefinition.fixtures);
});
test('cancel and deadline before bind never revive after preparation retry or observer restart',async()=>{
  const f=fixture(),prepared=await f.prepare();await f.service.cancel(selection.requestId,{reason:'Cancel before runner'});
  const input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  await expect(f.service.bind(selection.requestId,'mini',input)).rejects.toThrow('Cancelled');expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,terminalStatus:'not-run',waitingReason:'Cancel before runner'});
  const expired=fixture(),before=await expired.prepare();expired.advance(3*3600_000);
  await expect(expired.service.bind(selection.requestId,'mini',{...input,inputSha256:before.inputSha256})).rejects.toThrow('expired');expect(await expired.service.observation(selection.requestId)).toMatchObject({terminal:true,waitingReason:expect.stringContaining('deadline')});
});
test('Mongo bind predicate guards absent host/binding, uncancelled prepared identity and deadline in one write',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=f.row!,write=TestRequestModel.collection.findOneAndUpdate;
  const cas=mock(async(..._args:unknown[])=>null);TestRequestModel.collection.findOneAndUpdate=cas as any;
  try {await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt);
   expect(cas.mock.calls[0]?.[0]).toMatchObject({requestId:row.requestId,fleetInputSha256:row.fleetInputSha256,state:'awaiting-runner',fleetBinding:{$exists:false},hostId:{$exists:false},fleetCancellation:{$exists:false},fleetDeadline:{$gt:h.receivedAt}});
   expect(cas.mock.calls[0]?.[0]).toMatchObject({fleetResourceAdmission:row.fleetResourceAdmission,fleetExclusiveReservation:{$exists:false}});
  }finally{TestRequestModel.collection.findOneAndUpdate=write}
 });
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

test('head changing during binding observation cannot return execution permission after cancellation', async () => {
  const f=fixture(), id=automaticId(), first=await f.service.submit({...selection,requestId:id});
  await f.service.prepared(id,{inputSha256:first.fleetSelectionSha256,routineSource:testRoutineSource(selection.routineRevision),
    definitionSha256:requestInputDigest(definition),definition});
  await f.service.preparation(id);
  const input={inputSha256:f.row!.fleetInputSha256!,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'123',actionsJobId:'124'};
  await f.service.bind(id,'mini',input);
  let checks=0;
  const service=new RoutineJobService(f.rows,{async resolve(){throw Error('frozen only')},async isPrSuperseded(){return ++checks>1;}},
    undefined,undefined,undefined,{async cancel(){return f.rows.cancel(id,f.row!.fleetSelectionSha256,{reason:'Superseded',requestedAt:'2026-10-08T00:00:00Z'}) as any}},
    {async detail(){throw new TestRunError(404,'missing')}},()=>Date.parse('2026-10-08T00:00:00Z'));
  const result=await service.bind(id,'mini',input);
  expect(result.execute).toBe(false); expect(f.row!.fleetCancellation!.reason).toContain('Superseded');
});
const publicationFailure = {entityId:selection.requestId,payloadSha256:'d'.repeat(64),manifestSha256:'e'.repeat(64),
  operation:'result-create' as const,status:409 as const,code:'result_conflict' as const,message:'Invalid frozen fixture action',rejectedAt:'2026-10-08T00:00:10.000Z'};
async function publicationFixture(){const f=fixture(),p=await f.prepare();await f.service.bind(selection.requestId,'mini',{
  inputSha256:p.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
 f.accepted('c'.repeat(64));return{f,completion:{inputSha256:'c'.repeat(64),disposition:'clean' as const,completedAt:'2026-10-08T00:00:09.000Z'}}}
test('publication rejection waits for exact host acceptance and the same report succeeds after late acceptance', async () => {
  const {f, completion} = await publicationFixture();
  f.queued(completion.inputSha256);
  const before = structuredClone(f.row), report = {...completion, publicationFailure};
  await expect(f.service.complete(selection.requestId, 'mini', report)).rejects.toThrow('accepted host');
  expect(f.row).toEqual(before);
  const requests = new TestRequestService({
    get: f.rows.get,
    async accept(receipt: HostAcceptance) {
      if (f.row?.state !== 'queued' || f.row.hostReceipt || f.row.hostId !== receipt.hostId
        || (f.row as any).inputSha256 !== receipt.inputSha256) return null;
      f.accepted(receipt.inputSha256);
      return f.row;
    },
  } as unknown as TestRequestRepository);
  const receipt = {requestId: selection.requestId, hostId: 'mini', inputSha256: completion.inputSha256,
    acceptedAt: '2026-10-08T00:00:00.000Z'};
  expect(await requests.accept(receipt, 'mini')).toMatchObject({state: 'accepted', hostReceipt: receipt});
  expect(await f.service.complete(selection.requestId, 'mini', report)).toEqual(report);
  expect(f.row).toMatchObject({state: 'terminal', terminalStatus: 'incomplete', publicationFailure});
});
for(const cleanupFirst of [false,true])test(`publication failure retains exact cleanup in ${cleanupFirst?'cleanup-first':'rejection-first'} order`,async()=>{
 const {f,completion}=await publicationFixture();if(cleanupFirst)await f.service.complete(selection.requestId,'mini',completion);
 const report={...completion,publicationFailure};expect(await f.service.complete(selection.requestId,'mini',report)).toEqual(report);
 expect(await f.service.complete(selection.requestId,'mini',report)).toEqual(report);expect(f.row!.dispatchCompletion).toEqual(completion);
 expect(f.row).toMatchObject({state:'terminal',terminalStatus:'incomplete',publicationFailure});expect(f.row!.runId).toBeUndefined();
 expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,terminalStatus:'incomplete',waitingReason:'Publication failed: Invalid frozen fixture action'});
 for(const change of [{entityId:'wrong'},{payloadSha256:'f'.repeat(64)},{message:'changed'},{rejectedAt:'2026-10-08T00:00:11.000Z'}])
  await expect(f.service.complete(selection.requestId,'mini',{...completion,publicationFailure:{...publicationFailure,...change}})).rejects.toThrow();
 await expect(f.service.complete(selection.requestId,'wrong',report)).rejects.toThrow('accepted host');
 await expect(f.service.complete(selection.requestId,'mini',{...report,completedAt:'2026-10-08T00:00:12.000Z'})).rejects.toThrow('custody');
});
for(const insertedOnly of [false,true])test(`authenticated result ${insertedOnly?'inserted before projection':'already projected'} wins over publication failure`,async()=>{
 const {f,completion}=await publicationFixture();f.result(insertedOnly);
 expect(await f.service.complete(selection.requestId,'mini',{...completion,publicationFailure})).toEqual({...completion,resultFound:true});
 expect(f.row!.publicationFailure).toBeUndefined();
});
test('later accepted result restores its true verdict without deleting the original rejection',async()=>{
 const {f,completion}=await publicationFixture();await f.service.complete(selection.requestId,'mini',{...completion,publicationFailure});f.result();
 expect(await f.service.complete(selection.requestId,'mini',{...completion,publicationFailure})).toEqual({...completion,resultFound:true});
 expect(await f.service.observation(selection.requestId)).toMatchObject({terminalStatus:'pass'});expect(f.row!.publicationFailure).toEqual(publicationFailure);
});
test('result projection racing rejection CAS is preserved',async()=>{
 const {f,completion}=await publicationFixture();f.rows.publicationFailed=async()=>{f.result();return null};
 expect(await f.service.complete(selection.requestId,'mini',{...completion,publicationFailure})).toEqual({...completion,resultFound:true});
 expect(f.row!.terminalStatus).toBe('pass');
});
test('publication failure repository fences retained host/input/cleanup and an existing result in one write',async()=>{
 const original=TestRequestModel.collection.findOneAndUpdate,cas=mock(async(..._args:unknown[])=>null);TestRequestModel.collection.findOneAndUpdate=cas as any;
 const completion={inputSha256:'c'.repeat(64),disposition:'repair' as const,completedAt:'2026-10-08T00:00:09.000Z'};
 try{await routineJobRepository.publicationFailed!(selection.requestId,'mini',completion,publicationFailure);
  expect(cas.mock.calls[0]![0]).toEqual({requestId:selection.requestId,hostId:'mini',inputSha256:completion.inputSha256,'hostReceipt.requestId':selection.requestId,'hostReceipt.hostId':'mini','hostReceipt.inputSha256':completion.inputSha256,runId:{$exists:false},publicationFailure:{$exists:false},
   'dispatchCompletion.inputSha256':completion.inputSha256,'dispatchCompletion.disposition':'repair','dispatchCompletion.completedAt':completion.completedAt});
  expect(cas.mock.calls[0]![1]).toMatchObject({$set:{publicationFailure,state:'terminal',terminalStatus:'incomplete'}});
 }finally{TestRequestModel.collection.findOneAndUpdate=original}
});
test('accepted local ordinary requests use the same failure completion contract without fleet lineage',async()=>{
 const completion={inputSha256:'c'.repeat(64),disposition:'clean' as const,completedAt:'2026-10-08T00:00:09.000Z'};
 const f=fixture();let request:any={requestId:selection.requestId,hostId:'mini',inputSha256:completion.inputSha256,state:'accepted',
  hostReceipt:{requestId:selection.requestId,hostId:'mini',inputSha256:completion.inputSha256,acceptedAt:'2026-10-08T00:00:00.000Z'}};
 f.rows.completionRequest=async()=>structuredClone(request);f.rows.complete=async(_id,_host,_hash,value)=>{request={...request,dispatchCompletion:structuredClone(value)};return request};
 f.rows.publicationFailed=async(_id,_host,_receipt,failure)=>{request={...request,publicationFailure:failure,state:'terminal',terminalStatus:'incomplete'};return request};
 expect(await f.service.complete(selection.requestId,'mini',{...completion,publicationFailure})).toEqual({...completion,publicationFailure});
 expect(request).toMatchObject({state:'terminal',terminalStatus:'incomplete'});expect(request.fleetBinding).toBeUndefined();
 request={...request,hostReceipt:{...request.hostReceipt,inputSha256:'f'.repeat(64)}};
 await expect(f.service.complete(selection.requestId,'mini',{...completion,publicationFailure})).rejects.toThrow('accepted host');
});
test('publication report rejects unknown codes and requires positive result lookup',async()=>{
 const {f,completion}=await publicationFixture();
 for(const change of [{status:500},{operation:'asset-upload'},{code:'unknown'},{message:'x'.repeat(1025)},{rejectedAt:'invalid'}])
  await expect(f.service.complete(selection.requestId,'mini',{...completion,publicationFailure:{...publicationFailure,...change}})).rejects.toThrow();
 f.rows.hasResult=undefined;await expect(f.service.complete(selection.requestId,'mini',{...completion,publicationFailure})).rejects.toThrow('lookup is unavailable');
});


test('offline preparation reports retain exact workflow and cannot overwrite prepared or terminal work', async () => {
  const f=fixture();await f.service.submit(selection)
  await f.service.actions(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'99'})
  const status={inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'99',phase:'Git blobs',code:'source-unavailable',retryable:true}
  await f.service.preparationStatus(selection.requestId,status)
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'awaiting-source',waitingReason:'Routine source preparation failed during Git blobs; retrying the same request.'})
  await expect(f.service.preparationStatus(selection.requestId,{...status,inputSha256:'f'.repeat(64)})).rejects.toThrow('exact workflow')
  await f.service.actions(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'100'})
  await f.service.preparationStatus(selection.requestId,{...status,retryable:false,code:'source-invalid'})
  expect(f.row!.state).toBe('awaiting-source')
  await f.service.actions(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'98'})
  await f.service.preparationStatus(selection.requestId,{...status,actionsRunId:'100',phase:'routine description',code:'not-applicable',retryable:false})
  expect(f.row).toMatchObject({state:'terminal',terminalStatus:'not-applicable',fleetCancellation:{reason:'Routine new-routine does not support android.'}})
  expect((await f.service.observation(selection.requestId)).terminal).toBe(true)
})

test('known exact iOS-only source is refused before Android insertion while unknown source is allowed', async () => {
  const f=fixture();
  (f.service as any).definitions={async getExact(_id:string,platform:string){return platform==='ios-on-mac'?{definition:{platforms:['ios-on-mac']}}:null}};
  await expect(f.service.submit(selection)).rejects.toThrow('does not support android');
  expect(f.row).toBeNull();
  const unknown=fixture();expect((await unknown.service.submit(selection)).state).toBe('awaiting-source');
});
test('completed preparation retries end after twenty deliveries rather than waiting until the deadline', async () => {
  const f=fixture();await f.service.submit(selection);
  await f.rows.dispatch!(selection.requestId,undefined,{attempts:20,lastAttemptAt:'2026-10-07T23:59:00.000Z'});
  (f.service as any).actionsTransport={async dispatch(){throw Error('No twenty-first attempt')},async runs(){return [{actionsRunId:'100',status:'completed',conclusion:'failure'}]},async cancel(){}};
  expect((await f.service.observation(selection.requestId)).terminal).toBe(false);
  f.advance(61_000);
  const observed=await f.service.observation(selection.requestId);
  expect(observed).toMatchObject({terminal:true,state:'terminal',terminalStatus:'not-run'});
  expect(observed.waitingReason).toContain('exhausted 20');
});

test('preparation status database write fences source, custody, deadline and newest numeric workflow', async () => {
 const original=TestRequestModel.collection.findOneAndUpdate;
 const cas=mock(async(_filter:any,_update:any,_options:any)=>null);TestRequestModel.collection.findOneAndUpdate=cas as any;
 const now=new Date('2026-10-08T00:00:00Z'),value={inputSha256:'a'.repeat(64),actionsRunId:'100',phase:'Git blobs' as const,code:'source-unavailable' as const,retryable:true,reason:'Retry',observedAt:now.toISOString()};
 try {
  await routineJobRepository.preparationStatus!('job-one',value,now);
  expect(cas.mock.calls[0]![0]).toMatchObject({requestId:'job-one',fleetSelectionSha256:value.inputSha256,state:'awaiting-source',fleetPreparation:{$exists:false},fleetBinding:{$exists:false},fleetCancellation:{$exists:false},fleetDeadline:{$gt:now},'fleetActions.actionsRunId':'100'});
  expect(cas.mock.calls[0]![0].$expr).toEqual({$eq:[{$max:{$map:{input:'$fleetActions',as:'action',in:{$toDecimal:'$$action.actionsRunId'}}}},{$toDecimal:{$literal:'100'}}]});
  expect(cas.mock.calls[0]![1]).toEqual({$set:{fleetPreparationStatus:value,updatedAt:now}});
 }finally{TestRequestModel.collection.findOneAndUpdate=original}
});

test('retry exhaustion database write cannot cancel concurrently prepared, bound or newer delivered work', async () => {
 const original=TestRequestModel.collection.findOneAndUpdate,cas=mock(async(_filter:any,_update:any,_options:any)=>null);TestRequestModel.collection.findOneAndUpdate=cas as any;
 const now=new Date('2026-10-08T00:00:00Z');
 try {await routineJobRepository.exhaustPreparation!('job-one',['100'],now);
  expect(cas.mock.calls[0]![0]).toMatchObject({requestId:'job-one',state:'awaiting-source',fleetPreparation:{$exists:false},fleetBinding:{$exists:false},fleetCancellation:{$exists:false},'fleetDispatch.attempts':20,fleetDeadline:{$gt:now},$expr:{$setIsSubset:[{$ifNull:['$fleetActions.actionsRunId',[]]},{$literal:['100']}]}});
  expect(cas.mock.calls[0]![1]).toMatchObject({$set:{state:'terminal',terminalStatus:'not-run'}});
 }finally{TestRequestModel.collection.findOneAndUpdate=original}
});

test('frozen Android admissions cannot bypass an exact iOS-only declaration', async () => {
 const f=fixture(),known=await f.service.freezeSelection(selection);
 (f.service as any).definitions={async getExact(_id:string,platform:string){return platform==='ios-on-mac'?{definition:{platforms:['ios-on-mac']}}:null}};
 await expect(f.service.submitFrozen(known,'2026-10-08T01:00:00Z')).rejects.toThrow('does not support android');expect(f.row).toBeNull();
});
test('twenty failed deliveries with no created workflow terminate after the absence window', async () => {
 const f=fixture();await f.service.submit(selection);
 await f.rows.dispatch!(selection.requestId,undefined,{attempts:20,lastAttemptAt:'2026-10-07T23:59:00.000Z'});
 (f.service as any).actionsTransport={async dispatch(){throw Error('No further dispatch')},async runs(){return []},async cancel(){}};
 expect((await f.service.observation(selection.requestId)).terminal).toBe(false);
 f.advance(61_000);
 expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,terminalStatus:'not-run',waitingReason:'Routine preparation exhausted 20 delivery attempts; inspect preparation diagnostics and submit corrected work.'});
});

test('permanent preparation reports use the settled fence consumed by rerun readers', async () => {
 const f=fixture();await f.service.submit(selection);await f.service.actions(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'100'});
 await f.service.preparationStatus(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'100',phase:'routine description',code:'not-applicable',retryable:false});
 const {TestRerunService}=await import('./test-rerun.service');
 const reruns=new TestRerunService(undefined,undefined,undefined,{async get(){return f.row as any},async prepare(){throw Error('No admission')}});
 const attempt=await (reruns as any).requestAttempt(selection.requestId,{parent:{kind:'request',requestId:selection.requestId},memberId:selection.requestId,attemptNumber:1,attemptId:'attempt'});
 expect(attempt).toMatchObject({status:'not-run',publicationComplete:false,reason:'Routine new-routine does not support android.'});
});


test('an expired app grant refuses fleet binding before consuming the pending job; a fresh exact grant admits it', async () => {
  const selected = {...definition, resourceRequirements: definition.resourceRequirements.map(resource => resource.kind === 'app'
    ? {...resource, permissions: [{permission: 'camera', recipient: 'app'}]} : resource)};
  const f = fixture(selected), prepared = await f.prepare(), frozen = structuredClone(f.row), time = Date.parse('2026-10-08T00:00:00Z');
  const binding = {version: 938, revision: 'a'.repeat(40), installationId: 'accepted', configurationSha256: 'b'.repeat(64),
    runtimeSha256: 'c'.repeat(64), routineApiVersion: 37, publicApiSha256: 'd'.repeat(64)};
  const lane = structuredClone(f.lane);
  const observed = {permission: 'camera' as const, status: 'granted' as const, rawStatus: 'authorized', observedAt: new Date(time - 120_001).toISOString(), binding,
    recipient: {kind: 'app' as const, uid: 501, pid: 50, processStartedAt: 'verified lifetime', launchedAt: time - 1000,
      bundleId: 'com.mentra.mentra' as const, bundlePath: '/Applications/Mentra.app', executablePath: '/Applications/Mentra.app/Mentra',
      version: '3.3.0', build: '100', teamId: 'T5XXXL6N36', codeRequirement: 'verified signed requirement',
      selectedBuild: {headSha: 'c'.repeat(40), archiveSha256: 'd'.repeat(64), receiptSha256: 'e'.repeat(64)}}, evidence: {sha256: 'f'.repeat(64)}};
  lane.resources.find(resource => resource.kind === 'app')!.permissionObservations = [observed];
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(time).toISOString(), receivedAt: new Date(time).toISOString(), frameworkBinding: binding, lanes: [lane]};
  f.offer([host]);
  const input = {inputSha256: prepared.inputSha256, laneId: lane.id, descriptorRevision: lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'};
  await expect(f.service.bind(selection.requestId, host.hostId, input)).rejects.toThrow('compatible lane descriptor');
  expect(f.row).toEqual(frozen);
  observed.observedAt = new Date(time).toISOString(); f.offer([host]);
  await f.service.preparation(selection.requestId);
  expect((await f.service.bind(selection.requestId, host.hostId, input)).execute).toBe(true);
  expect(f.row!.fleetBinding!.hostId).toBe(host.hostId);
});

function routingClaim(hostId: string, laneId: string, requestId: string) {
  return {id: '591e0c34-ee97-41df-a0ec-5e2d0c7503ee', requestId, fleetInputSha256: 'a'.repeat(64), hostId, laneId,
    poolId: `${hostId}:disk:1`, minimumAvailableBytes: 3 * 1024 ** 3, reservedAt: '2026-10-16T11:00:00.000Z'};
}

test('simultaneous zero-load selections use request-specific ties independent of host report order', () => {
  const f = fixture(), now = '2026-10-08T00:00:00.000Z';
  const hosts = ['mini', 'air1', 'air2', 'pro1'].map(hostId => ({hostId, receivedAt: now, lanes: [f.lane], authorityReservations: []}));
  const selected = new Set<string>();
  for (let index = 0; index < 26; index++) {
    const id = `scheduled-original-${index}`;
    const first = orderedRoutineCandidates(id, hosts)[0]!;
    selected.add(first.host.hostId);
    expect(orderedRoutineCandidates(id, [...hosts].reverse())[0]!.host.hostId).toBe(first.host.hostId);
  }
  expect(selected.size).toBe(4);
});

test('selected, cancelled-but-unreturned and unknown authority claims remain lane load across host reports', () => {
  const f = fixture(), now = '2026-10-08T00:00:00.000Z';
  const claims = ['selected-not-started', 'cancelled-unreturned', 'unknown-writer'].map(id => routingClaim('air1', 'android', id));
  const hosts = [{hostId: 'air1', receivedAt: now, lanes: [f.lane], authorityReservations: claims},
    {hostId: 'mini', receivedAt: now, lanes: [f.lane], authorityReservations: []}];
  expect(orderedRoutineCandidates('new-original', hosts)[0]!.host.hostId).toBe('mini');
  expect(orderedRoutineCandidates('selected-not-started', hosts).find(value => value.host.hostId === 'air1')!.load).toBe(2);
  const refreshed = hosts.map(host => ({...host, receivedAt: '2026-10-08T00:00:01.000Z'}));
  expect(orderedRoutineCandidates('new-original', refreshed)[0]!.host.hostId).toBe('mini');
  expect(hosts[0]!.authorityReservations).toEqual(claims);
});

test('new routing prefers free compatible lanes while a retained winner survives load and report changes', async () => {
  const f = fixture(), now = '2026-10-08T00:00:00.000Z';
  const host = (hostId: string, claims: ReturnType<typeof routingClaim>[]) => ({hostId, incarnation: 'one', incarnationGeneration: 1,
    sequence: 1, observedAt: now, receivedAt: now, lanes: [f.lane], authorityReservations: claims});
  const busy = host('air1', [routingClaim('air1', 'android', 'waiting-original')]), free = host('mini', []);
  f.offer([busy, free]);
  const prepared = await f.prepare();
  expect(prepared).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}});
  const original = structuredClone(f.row);
  f.offer([{...free, authorityReservations: [routingClaim('mini', 'android', 'another-original')]}, {...busy, authorityReservations: []}]);
  expect(await f.service.preparation(selection.requestId)).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}});
  expect(f.row).toEqual(original);
});

test('an admission interrupted before its byte receipt continues only its frozen candidate', async () => {
  const f = fixture(), prepared = await f.prepare(), original = structuredClone(f.row!);
  const {fleetResourceReservation: _, ...withoutByteReceipt} = original;
  const intent = {operationId: `run:${selection.requestId}`, hostId: 'mini', laneId: 'android', inputSha256: prepared.inputSha256,
    owner: {id: selection.requestId, kind: 'run' as const}, resources: [{id: 'app:android', capabilities: []}],
    controller: {incarnation: 'one', generation: 1, sequence: 1}};
  f.restore({...withoutByteReceipt, fleetResourceAdmission: {intent, dependencies: []}});
  const now = '2026-10-08T00:00:00.000Z', base = {incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: now, receivedAt: now, lanes: [f.lane]};
  f.offer([{...base, hostId: 'mini', authorityReservations: [routingClaim('mini', 'android', 'other-claim')]}, {...base, hostId: 'air1'}]);
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBeDefined();
  expect(f.row!.fleetResourceAdmission).toEqual({intent, dependencies: []});
  expect(f.row!.fleetInputSha256).toBe(prepared.inputSha256);
  expect(f.row!.fleetResourceReservation).toBeUndefined();
});

test('staged selections count before byte receipts and duplicate authority representations count once', () => {
  const f = fixture(), hosts = [{hostId: 'mini', receivedAt: '2026-10-08T00:00:00.000Z', lanes: [f.lane],
    authorityReservations: [routingClaim('mini', 'android', 'same-original')]}];
  const selected = [{requestId: 'same-original', hostId: 'mini', laneId: 'android'},
    {requestId: 'staged-before-byte', hostId: 'mini', laneId: 'android'}, {requestId: 'different-lane', hostId: 'mini', laneId: 'mac'}];
  expect(orderedRoutineCandidates('new-original', hosts, selected)[0]!.load).toBe(2);
});

test('exclusive-only cancelled custody counts on its borrower lane until authority return', () => {
  const f = fixture(), now = '2026-10-08T00:00:00.000Z';
  const claim: ExclusiveHostReservation = {kind: 'exclusive', id: 'a1d9b22e-12c1-4f5b-b210-0bca2b0798c6',
    authorityHostId: 'mini', borrowerHostId: 'air1', laneId: 'android', resourceId: 'google-account',
    operationId: 'run:cancelled-before-byte', owner: {kind: 'run', id: 'cancelled-before-byte'},
    inputSha256: 'a'.repeat(64), intentSha256: 'b'.repeat(64), controllerIncarnation: 'one', controllerGeneration: 1,
    borrowerSequence: 1, reservedAt: now};
  const hosts: RoutingTestHostState[] = [{hostId: 'mini', receivedAt: now, lanes: [f.lane], authorityReservations: [claim]},
    {hostId: 'air1', receivedAt: now, lanes: [f.lane], authorityReservations: []}];
  const load = (values: RoutingTestHostState[]) => orderedRoutineCandidates('new-original', values).find(value => value.host.hostId === 'air1')!.load;
  expect(load(hosts)).toBe(1);
  expect(orderedRoutineCandidates('cancelled-before-byte', hosts).find(value => value.host.hostId === 'air1')!.load).toBe(0);
  expect(orderedRoutineCandidates('new-original', hosts)[0]!.host.hostId).toBe('mini');
  expect(load(hosts.map(host => ({...host, receivedAt: '2026-10-08T00:00:01.000Z'})))).toBe(1);
  hosts[1]!.authorityReservations = [routingClaim('air1', 'android', claim.owner.id)];
  expect(load(hosts)).toBe(1);
  expect(orderedRoutineCandidates('new-original', hosts, [{requestId: claim.owner.id, hostId: 'air1', laneId: 'android'}])
    .find(value => value.host.hostId === 'air1')!.load).toBe(1);
  hosts[0]!.authorityReservations = [];
  hosts[1]!.authorityReservations = [];
  expect(load(hosts)).toBe(0);
});

test('non-run exclusive custody remains lane load and cannot collide with a run identity', () => {
  const f = fixture(), now = '2026-10-08T00:00:00.000Z';
  const claim: ExclusiveHostReservation = {kind: 'exclusive', id: 'a1d9b22e-12c1-4f5b-b210-0bca2b0798c6',
    authorityHostId: 'mini', borrowerHostId: 'air1', laneId: 'android', resourceId: 'glasses-one',
    operationId: 'authoring:one', owner: {kind: 'authoring', id: 'one'}, inputSha256: 'a'.repeat(64),
    intentSha256: 'b'.repeat(64), controllerIncarnation: 'one', controllerGeneration: 1, borrowerSequence: 1, reservedAt: now};
  const hosts: RoutingTestHostState[] = [{hostId: 'mini', receivedAt: now, lanes: [f.lane], authorityReservations: [claim]},
    {hostId: 'air1', receivedAt: now, lanes: [f.lane], authorityReservations: [routingClaim('air1', 'android', 'authoring:one')]}];
  expect(orderedRoutineCandidates('new-original', hosts).find(value => value.host.hostId === 'air1')!.load).toBe(2);
  expect(orderedRoutineCandidates('authoring:one', hosts).find(value => value.host.hostId === 'air1')!.load).toBe(1);
});

test('staged selection read is bounded primary majority and excludes completed history', async () => {
  const filters: unknown[] = [], selections: unknown[] = [], settings: unknown[] = [];
  const selected = {requestId: 'selected-original', fleetResourceAdmission: {intent: {operationId: 'run:selected-original', hostId: 'mini',
    laneId: 'android', inputSha256: 'a'.repeat(64), owner: {id: 'selected-original', kind: 'run'}, resources: [{id: 'app', capabilities: []}],
    controller: {incarnation: 'one', generation: 1, sequence: 1}}, dependencies: []}};
  let records = [selected];
  const find = spyOn(TestRequestModel, 'find').mockImplementation(((filter: unknown) => {
    filters.push(filter);
    const query = {select(value: unknown) {selections.push(value); return query}, limit(value: unknown) {settings.push(value); return query},
      read(value: unknown) {settings.push(value); return query}, readConcern(value: unknown) {settings.push(value); return query},
      setOptions(value: unknown) {settings.push(value); return query}, async lean() {return records}};
    return query;
  }) as never);
  try {
    expect(await routineJobRepository.selectedLanes!(['mini'])).toEqual([{requestId: 'selected-original', hostId: 'mini', laneId: 'android'}]);
    expect(filters).toEqual([{'fleetResourceAdmission.intent.hostId': {$in: ['mini']}, fleetResourceReservation: {$exists: false}, dispatchCompletion: {$exists: false}, fleetCancellation: {$exists: false},
      state: {$in: ['awaiting-runner', 'preparing', 'queued', 'accepted']}}]);
    expect(selections).toEqual([{requestId: 1, fleetResourceAdmission: 1, _id: 0}]);
    expect(settings).toEqual([1001, 'primary', 'majority', {timeoutMS: 5000}]);
    records = Array(1001).fill(selected);
    await expect(routineJobRepository.selectedLanes!(['mini'])).rejects.toThrow('bounded routing read');
  } finally {find.mockRestore()}
});

test('routing consumes staged selections before admission and preserves explicit target constraints', async () => {
  const f = fixture(), now = '2026-10-08T00:00:00.000Z';
  const host = (hostId: string) => ({hostId, incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: now, receivedAt: now, lanes: [f.lane]});
  f.offer([host('air1'), host('mini')]);
  const calls: string[][] = [];
  f.rows.selectedLanes = async hostIds => {calls.push(hostIds); return [{requestId: 'pending-original', hostId: 'air1', laneId: 'android'}]};
  expect(await f.prepare()).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}});
  expect(calls).toEqual([['air1', 'mini']]);
  const original = structuredClone(f.row!);
  const {fleetResourceReservation: _, ...withoutReceipt} = original;
  const targeted = {...withoutReceipt, fleetTarget: {hostId: 'air1', laneId: 'android'}};
  f.restore({...targeted, fleetInputSha256: routineJobInputDigest(targeted)});
  expect(await f.service.preparation(selection.requestId)).toMatchObject({resourceTarget: {hostId: 'air1', laneId: 'android'}});
});

test('offline lost-claim response and restart route only the original provisional phone lane', async () => {
  for (const repositoryProof of [true, false]) {
    const f = fixture(); await f.prepare()
    const original = structuredClone(f.row!), claim = original.fleetResourceReservation!
    delete original.fleetResourceReservation; f.restore(original)
    expect(original.fleetPreparation!.requirements.resources.find(value => value.kind === 'phone')!.capabilities).toEqual([])
    const timestamp = '2026-10-08T00:00:00.000Z', lane = structuredClone(f.lane)
    lane.resources.find(value => value.kind === 'phone')!.capabilities = ['backend-connectivity']
    const host = (hostId: string) => ({hostId, incarnation: 'one', incarnationGeneration: 1, sequence: 1,
      observedAt: timestamp, receivedAt: timestamp, lanes: [lane], authorityReservations: hostId === 'mini' ? [claim] : []})
    f.offer([host('air1'), host('mini')])
    // Same-lane retained load makes the alternate first without original recovery.
    f.rows.selectedLanes = async () => [{requestId: 'queued-other', hostId: 'mini', laneId: 'android'}]
    if (repositoryProof) f.rows.recorderClaims = async () => [structuredClone(claim)]
    const reserve = f.rows.reserveResources!, attempted: string[] = []
    f.rows.reserveResources = async (id, digest, hostId, laneId, now, waiting) => {
      attempted.push(hostId)
      if (hostId !== claim.hostId || laneId !== claim.laneId) {waiting?.(RESOURCE_ADMISSION_WAIT, true); return null}
      return reserve(id, digest, hostId, laneId, now, waiting)
    }
    expect(await f.service.preparation(original.requestId)).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}})
    expect(attempted).toEqual(['mini'])
    expect(f.row!.fleetResourceReservation).toEqual(claim)
    expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256)
    expect(f.row!.fleetBinding).toBeUndefined(); expect(f.row!.inputSha256).toBeUndefined()
    // A restarted delivery reads the same repository/snapshot proof. Changed
    // load cannot move custody or create another target after the lost reply.
    f.restore(original); attempted.length = 0
    expect(await f.service.preparation(original.requestId)).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}})
    expect(attempted).toEqual(['mini']); expect(f.row!.fleetResourceReservation).toEqual(claim)
  }
})
test('offline provisional recovery refuses duplicate or changed original custody without trying a free phone', async () => {
  for (const duplicate of [true, false]) {
    const f = fixture(); await f.prepare(); const original = structuredClone(f.row!), claim = original.fleetResourceReservation!
    delete original.fleetResourceReservation; f.restore(original)
    f.rows.recorderClaims = async () => duplicate ? [claim, {...claim, hostId: 'air1'}] : [{...claim, fleetInputSha256: 'f'.repeat(64)}]
    let attempted = 0; f.rows.reserveResources = async () => {attempted++; throw Error('Ambiguous custody cannot reserve')}
    expect((await f.service.preparation(original.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT)
    expect(attempted).toBe(0); expect(f.row).toEqual(original)
  }
})

/** Real selection/reservation/binding with only the Mongo collection boundary replaced. */
async function withLocalResources(body: (f: ReturnType<typeof fixture>, hosts: Map<string, any>, counters: {host: number; request: number}, pastRows: Map<string, StoredRoutineJob>) => Promise<void>, extraKinds: ('audio'|'browser'|'fixture-data')[] = []) {
 const now=Date.now(),at=new Date(now).toISOString(),f=fixture({...definition,
   resourceRequirements:[...definition.resourceRequirements,{kind:'glasses',capabilities:['connection']},...extraKinds.map(kind=>({kind,capabilities:[]}))],glasses:{models:['mentra-live']},
   fixtures:extraKinds.includes('fixture-data')?[{provider:'synthetic',description:'Independent synthetic fixture'}]:[],
   execution:{resourceKinds:['phone','app','recorder','network','glasses',...extraKinds],policy:{estimatedOutputBytes:1024**3}}});
 f.advance(now-Date.parse('2026-10-08T00:00:00Z'));
 const hosts=new Map<string,any>();
 for(const hostId of ['mini','air1']) {
  const lane:ReceivedTestHostState['lanes'][number]={...structuredClone(f.lane),resources:[...structuredClone(f.lane.resources),{id:'live-local',kind:'glasses' as const,capabilities:['connection']},...extraKinds.map(kind=>({id:`local-${kind}`,kind,capabilities:[]}))],
   glasses:[{resourceId:'live-local',deviceId:`synthetic-live-${hostId}`,model:'mentra-live',capabilities:['connection']}]};
  lane.resources=lane.resources.map(resource=>({...resource,id:`${hostId}:${resource.id}`,
   ...(resource.storage?{storage:{...resource.storage,poolId:`${hostId}:disk:1`,observedAt:at}}:{}),
   idleContract:{version:'synthetic-baseline',maximumAgeMs:120000,qualifiedScope:{kind:'same-controller' as const,controllerId:hostId},conditions:['synthetic-condition'],repairConfigured:true}}));
  lane.glasses![0]!.resourceId=`${hostId}:live-local`;lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  const subjects=lane.resources.map(resource=>resourceLifecycleSubjectSchema.parse({subject:{kind:'resource',id:resource.id,authorityHostId:hostId},generation:7,status:'idle',observedAt:at,receivedAt:null,current:true,reason:null,owner:null,
   idle:{contractVersion:'synthetic-baseline',outcome:'passed',checkedAt:at,acceptedCheck:{operationId:`check:${resource.id}`,subjectGeneration:7,resultSha256:'a'.repeat(64),acceptedAt:at},qualifiedScope:resource.idleContract!.qualifiedScope,evidenceRefs:[]},
   repair:{configured:true,state:'none'},supportedActions:['reserve','check','mark-out-of-service'],resource:{kind:resource.kind,capabilities:resource.capabilities??[],memberships:[{hostId,laneId:lane.id}],dependencies:[],placement:'installed'}}));
  const snapshot=hostStateSchema.parse({hostId,incarnation:`${hostId}:original`,incarnationGeneration:1,sequence:1,observedAt:at,
   laneControls:{schemaVersion:1,receipts:[],resourceControls:true},resourceLifecycle:{schemaVersion:1,subjects,history:[]},lanes:[lane]});
  hosts.set(hostId,{hostId,incarnation:snapshot.incarnation,incarnationGeneration:1,sequence:1,receivedAt:new Date(now),resourceReservationVersion:0,resourceReservations:[],laneControlVersion:0,laneControls:[],snapshot});
 }
 const project=()=>[...hosts.values()].map(h=>({...structuredClone(h.snapshot),receivedAt:h.receivedAt.toISOString(),authorityReservations:structuredClone(h.resourceReservations),resourceControlRecords:structuredClone(h.laneControls),resourceLifecycleCursor:structuredClone(h.resourceLifecycleCursor)}));
 (f.service as any).hosts={async get(id:string){return project().find(h=>h.hostId===id)??null},async list(){return project()}};
 const originals={find:TestRequestModel.collection.find,read:TestRequestModel.collection.findOne,write:TestRequestModel.collection.findOneAndUpdate,
  hostRead:TestHostStateModel.collection.findOne,hostWrite:TestHostStateModel.collection.findOneAndUpdate,get:resourceReservationRepository.get,request:resourceReservationRepository.request,claimed:resourceReservationRepository.claimedHosts,recorderClaims:resourceReservationRepository.recorderClaims,replace:resourceReservationRepository.replace};
 const counters={host:0,request:0},pastRows=new Map<string,StoredRoutineJob>();
 TestRequestModel.collection.find=((filter:any)=>({limit(n:number){expect(n).toBe(1001);expect(filter.requestId.$in.length).toBeLessThanOrEqual(1000);return {async toArray(){return filter.requestId.$in.flatMap((id:string)=>{const row=id===selection.requestId?f.row:pastRows.get(id);return row?[structuredClone(row)]:[]})}}}})) as any;
 TestRequestModel.collection.findOne=(async(filter:any)=>{expect(filter.requestId).toBe(selection.requestId);return structuredClone(f.row)}) as any;
 TestRequestModel.collection.findOneAndUpdate=(async(filter:any,update:any)=>{const row=f.row!;expect(filter.requestId).toBe(row.requestId);if(filter.fleetBinding?.$exists===false&&row.fleetBinding)return null;
  if(filter.fleetDeadline?.$gt&&row.fleetDeadline<=filter.fleetDeadline.$gt||filter.fleetCancellation?.$exists===false&&row.fleetCancellation)return null;
  counters.request++;f.restore({...row,...structuredClone(update.$set)});return structuredClone(f.row)}) as any;
 TestHostStateModel.collection.findOne=(async(filter:any)=>structuredClone(hosts.get(filter.hostId))) as any;
 TestHostStateModel.collection.findOneAndUpdate=(async(filter:any,update:any)=>{const h=hosts.get(filter.hostId);expect(filter.laneControlVersion).toBe(h.laneControlVersion);
  if(filter.sequence!==h.sequence||filter.resourceReservationVersion!==h.resourceReservationVersion)return null;
  counters.host++;Object.assign(h,structuredClone(update.$set));h.resourceReservationVersion++;return structuredClone(h)}) as any;
 resourceReservationRepository.get=async id=>structuredClone(hosts.get(id)??null);
 resourceReservationRepository.replace=async(previous,claims)=>{const h=hosts.get(previous.hostId);if(previous.sequence!==h.sequence||previous.laneControlVersion!==h.laneControlVersion||previous.resourceReservationVersion!==h.resourceReservationVersion)return false;
  expect(claims.every(claim=>h.resourceReservations.some((original:any)=>requestInputDigest(original)===requestInputDigest(claim)))).toBe(true);h.resourceReservations=structuredClone(claims);h.resourceReservationVersion++;return true;};
 resourceReservationRepository.request=async()=>structuredClone(f.row);
 resourceReservationRepository.claimedHosts=async()=>[];
 resourceReservationRepository.recorderClaims=async()=>[...hosts.values()].flatMap(h=>structuredClone(h.resourceReservations)).filter((claim:any)=>claim.requestId===selection.requestId);
 f.rows.reconcileRecorderHost=(...args)=>routineJobRepository.reconcileRecorderHost!.apply(routineJobRepository,args);
 f.rows.reserveResources=(...args)=>routineJobRepository.reserveResources!.apply(routineJobRepository,args);
 f.rows.bind=(...args)=>routineJobRepository.bind.apply(routineJobRepository,args);
 const clock=spyOn(Date,'now').mockReturnValue(now);
 try {await body(f,hosts,counters,pastRows)} finally {clock.mockRestore();TestRequestModel.collection.find=originals.find;TestRequestModel.collection.findOne=originals.read;TestRequestModel.collection.findOneAndUpdate=originals.write;
  TestHostStateModel.collection.findOne=originals.hostRead;TestHostStateModel.collection.findOneAndUpdate=originals.hostWrite;resourceReservationRepository.get=originals.get;resourceReservationRepository.request=originals.request;resourceReservationRepository.claimedHosts=originals.claimed;resourceReservationRepository.recorderClaims=originals.recorderClaims;resourceReservationRepository.replace=originals.replace;}
}
function unavailableLocal(host:any,status:'unknown'|'out-of-service'|'reserved'|'in-repair'|'offline',kind='glasses') {
 const subject=host.snapshot.resourceLifecycle.subjects.find((value:any)=>value.resource.kind===kind);subject.status=status;
 subject.idle.outcome='not-checked';subject.idle.acceptedCheck=null;
 if(status==='reserved')subject.owner={id:'manual-original',kind:'authoring',generation:7,hostId:host.hostId};
 if(status==='in-repair')subject.repair.state='queued';
 return subject;
}
for(const status of ['unknown','out-of-service','reserved','in-repair','offline'] as const)test(`local ${status} glasses are excluded before real assignment and the SAME job uses a ready alternate`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  unavailableLocal(hosts.get('mini'),status);const prepared=await f.prepare(),original=structuredClone(f.row!);
  expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toEqual({hostId:'air1',laneId:'android'});expect(f.row!.fleetResourceReservation!.hostId).toBe('air1');
  expect(hosts.get('mini').resourceReservations).toEqual([]);expect(counters.host).toBe(1);
  const lane=hosts.get('air1').snapshot.lanes[0],result=await f.service.bind(selection.requestId,'air1',{inputSha256:prepared.inputSha256,laneId:lane.id,descriptorRevision:lane.descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
  expect(result.binding.hostId).toBe('air1');expect(f.row!.state).toBe('preparing');
  for(const key of ['requestId','fleetSelection','fleetInputSha256','fleetPreparation','fleetDeadline'] as const)expect(f.row![key]).toEqual(original[key]);
 });
});
test('offline phone with no ready alternate remains unassigned without a claim or native execution',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  for(const h of hosts.values())unavailableLocal(h,'offline','phone');const prepared=await f.prepare();
  expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toBeUndefined();expect(prepared.waitingReason).toBeDefined();expect(f.row!.state).toBe('awaiting-runner');
  expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(f.row!.fleetBinding).toBeUndefined();expect(counters).toEqual({host:0,request:0});
 });
});
test('a manual withdrawal after recorder claim fences binding and retains the original claim without fallback',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const prepared=await f.prepare(),target=(prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget!,h=hosts.get(target.hostId),original=structuredClone(f.row!),lane=h.snapshot.lanes[0];
  h.laneControlVersion++;const subject=unavailableLocal(h,'out-of-service');h.resourceLifecycleCursor=structuredClone(h.snapshot.resourceLifecycle);
  h.laneControls=[{command:{operationId:'84e9ad37-18e0-4dba-b0f8-f10b624b1282',hostId:h.hostId,operatorId:'a'.repeat(64),expiresAt:h.receivedAt.getTime()+60000,
   action:'mark-out-of-service',reason:'Synthetic withdrawal during assignment',subject:{resourceId:subject.subject.id,subjectGeneration:7}}}];
  await expect(f.service.bind(selection.requestId,h.hostId,{inputSha256:prepared.inputSha256,laneId:lane.id,descriptorRevision:lane.descriptorRevision,actionsRunId:'10',actionsJobId:'20'})).rejects.toThrow('accepting');
  await f.service.preparation(selection.requestId);expect(f.row!.fleetResourceReservation).toEqual(original.fleetResourceReservation);expect(f.row!.fleetResourceAdmission).toEqual(original.fleetResourceAdmission);
  expect(f.row!.fleetBinding).toBeUndefined();expect([...hosts.values()].filter(host=>host.hostId!==h.hostId)[0].resourceReservations).toEqual([]);expect(counters.host).toBe(1);
 });
});
test('persisted cursor, old check and manual controls cannot become ready through a fresh report',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const h=hosts.get('mini'),subject=h.snapshot.resourceLifecycle.subjects.find((s:any)=>s.resource.kind==='glasses'),at=h.receivedAt.getTime();
  const available=()=>resourceAvailable({...h,resourceControlRecords:h.laneControls},subject.subject.id,at);
  expect(available()).toBe(true);h.resourceLifecycleCursor=structuredClone(h.snapshot.resourceLifecycle);subject.generation=6;subject.idle.acceptedCheck.subjectGeneration=6;expect(available()).toBe(false);
  subject.generation=7;subject.idle.acceptedCheck.subjectGeneration=7;subject.idle.checkedAt=new Date(at-120001).toISOString();expect(available()).toBe(false);
  subject.idle.checkedAt=new Date(at).toISOString();subject.idle.qualifiedScope={kind:'same-controller',controllerId:'foreign'};expect(available()).toBe(false);
  subject.idle.qualifiedScope={kind:'same-controller',controllerId:h.hostId};subject.idle.acceptedCheck.acceptedAt=new Date(at+1).toISOString();expect(available()).toBe(false);
  subject.idle.acceptedCheck.acceptedAt=new Date(at).toISOString();h.snapshot.resourceLifecycle.subjects=[];expect(resourceAvailable({...h,resourceControlRecords:[]},subject.subject.id,at)).toBe(false);
  expect(f.row).toBeNull();
 });
});
for(const kind of ['phone','app','glasses','recorder','fixture-data','audio','browser'] as const)test(`required local ${kind} failure prevents real Core reservation while independent ready resources cannot cover it`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  for(const h of hosts.values())unavailableLocal(h,'in-repair',kind);const prepared=await f.prepare();
  expect((prepared as {resourceTarget?:unknown}).resourceTarget).toBeUndefined();expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(counters).toEqual({host:0,request:0});
 },['audio','browser','fixture-data']);
});
test('contract, chronology, repair and retained cursor inverses refuse without altering original check timestamps',async()=>{
 await withLocalResources(async(_f,hosts)=>{
  const h=hosts.get('mini'),subject=h.snapshot.resourceLifecycle.subjects.find((s:any)=>s.resource.kind==='glasses'),ref=h.snapshot.lanes[0].resources.find((r:any)=>r.id===subject.subject.id),at=h.receivedAt.getTime();
  const original=structuredClone(subject),contract=structuredClone(ref.idleContract),available=()=>resourceAvailable({...h,resourceControlRecords:h.laneControls},subject.subject.id,at);
  for(const mutate of [()=>delete ref.idleContract,()=>subject.idle.contractVersion='foreign',()=>subject.idle.checkedAt=new Date(at+1).toISOString(),
    ()=>subject.idle.acceptedCheck.acceptedAt=new Date(at-1).toISOString(),()=>subject.observedAt=new Date(at+1).toISOString(),
    ()=>h.snapshot.observedAt=new Date(at+1).toISOString(),()=>subject.current=false,()=>subject.repair.state='halted',
    ()=>subject.subject.authorityHostId='foreign',()=>subject.idle.qualifiedScope={kind:'fleet'}]) {
   Object.assign(subject,structuredClone(original));ref.idleContract=structuredClone(contract);h.snapshot.observedAt=new Date(at).toISOString();mutate();expect(available()).toBe(false);
  }
  Object.assign(subject,structuredClone(original));ref.idleContract=structuredClone(contract);h.snapshot.observedAt=new Date(at).toISOString();
  subject.idle.qualifiedScope=ref.idleContract.qualifiedScope={kind:'same-controller',controllerId:'synthetic-phone-serial'};expect(available()).toBe(true);
  h.resourceLifecycleCursor=structuredClone(h.snapshot.resourceLifecycle);h.snapshot.laneControls=undefined;h.snapshot.resourceLifecycle=undefined;delete ref.idleContract;expect(available()).toBe(false);
 });
});
test('pending lane pause fences real assignment even before its automatic snapshot changes',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  for(const h of hosts.values())h.laneControls=[{command:{operationId:'24d29f35-8460-4968-83f6-b78aa0a5896f',hostId:h.hostId,laneId:'android',operatorId:'b'.repeat(64),expiresAt:h.receivedAt.getTime()+60000,action:'pause'}}];
  const prepared=await f.prepare();expect((prepared as {resourceTarget?:unknown}).resourceTarget).toBeUndefined();expect(counters).toEqual({host:0,request:0});
 });
});
test('newly discovered original recorder custody prevents fallback after an unavailable snapshot',async()=>{
 await withLocalResources(async(f,hosts)=>{
  for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepare();const row=structuredClone(f.row!),at=hosts.get('mini').receivedAt.toISOString(),claim={id:'97b4d2e9-6a03-461e-a4a6-fd314a873619',requestId:row.requestId,fleetInputSha256:row.fleetInputSha256!,hostId:'mini',laneId:'android',poolId:'mini:disk:1',minimumAvailableBytes:1024,reservedAt:at};
  hosts.get('mini').resourceReservations=[claim];const blockers:unknown[]=[];
  expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'air1','android',new Date(at),(...args)=>blockers.push(args))).toBeNull();
  expect(blockers).toEqual([[RESOURCE_ADMISSION_WAIT,true]]);expect(hosts.get('mini').resourceReservations).toEqual([claim]);expect(hosts.get('air1').resourceReservations).toEqual([]);
  expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(f.row!.fleetBinding).toBeUndefined();
 });
});
test('ordinary Mac repository binding reads local readiness and refuses unavailable glasses',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';f.restore(row);h.snapshot.lanes[0].platform='ios-on-mac';
  unavailableLocal(h,'out-of-service');const before=structuredClone(h.resourceReservations);
  expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeNull();
  expect(f.row!.fleetBinding).toBeUndefined();expect(h.resourceReservations).toEqual(before);
 });
});
for(const timing of ['before-cas','after-cas','cancel-after-cas','lost-request-reply','short-contract','expired-deadline'] as const)test(`final admission ${timing} preserves the original target and exact claims`,async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),original=structuredClone(f.row!),claims=structuredClone(h.resourceReservations),at=h.receivedAt.getTime(),binding={jobId:original.requestId,requestId:original.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()};
  const replace=resourceReservationRepository.replace,requestWrite=TestRequestModel.collection.findOneAndUpdate,requestRead=TestRequestModel.collection.findOne;
  let casAttempts=0,casAccepted=0,lost=true,reads=0;
  resourceReservationRepository.replace=async(previous,values)=>{casAttempts++;
   if(timing==='before-cas'){h.laneControlVersion++;h.laneControls=[{command:{operationId:'24d29f35-8460-4968-83f6-b78aa0a5896f',hostId:h.hostId,laneId:'android',operatorId:'b'.repeat(64),expiresAt:at+60000,action:'pause'}}]}
   const accepted=await replace(previous,values);if(!accepted)return false;casAccepted++;
   if(timing==='after-cas')unavailableLocal(h,'out-of-service');
   if(timing==='cancel-after-cas')f.restore({...f.row!,fleetCancellation:{requestedAt:new Date(at).toISOString(),reason:'Synthetic late cancellation'}});
   return true;
  };
  if(timing==='lost-request-reply')TestRequestModel.collection.findOneAndUpdate=(async(filter:any,update:any,options:any)=>{const answer=await (requestWrite as any).call(TestRequestModel.collection,filter,update,options);if(lost){lost=false;throw Error('Original request reply lost')}return answer}) as any;
  if(timing==='short-contract'||timing==='expired-deadline') {
   if(timing==='short-contract')for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
   TestRequestModel.collection.findOne=(async(filter:any,options:any)=>{const answer=await requestRead.call(TestRequestModel.collection,filter,options);if(++reads===2)spyOn(Date,'now').mockReturnValue(timing==='short-contract'?at+2:original.fleetDeadline.getTime()+1);return answer}) as any;
  }
  try {
   if(timing==='lost-request-reply') {
    await expect(routineJobRepository.bind(original.requestId,original.fleetInputSha256!,binding,{},h.receivedAt)).rejects.toThrow('reply lost');
    expect(f.row!.fleetBinding).toEqual(binding);const after=await f.service.bind(original.requestId,h.hostId,{inputSha256:original.fleetInputSha256!,laneId:'android',descriptorRevision:binding.descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
    expect(after.binding).toEqual(binding);expect(casAccepted).toBe(1);
   }else{
    const answer=await routineJobRepository.bind(original.requestId,original.fleetInputSha256!,binding,{},h.receivedAt);
    if(timing==='after-cas'){expect(answer?.fleetBinding).toEqual(binding);expect(casAccepted).toBe(1)}else{expect(answer).toBeNull();expect(f.row!.fleetBinding).toBeUndefined();expect(casAccepted).toBe(timing==='cancel-after-cas'?1:0)}
   }
   expect(h.resourceReservations).toEqual(claims);expect(f.row!.fleetResourceReservation).toEqual(original.fleetResourceReservation);expect(f.row!.fleetResourceAdmission).toEqual(original.fleetResourceAdmission);
   expect(hosts.get(h.hostId==='mini'?'air1':'mini').resourceReservations).toEqual([]);
   if(timing==='short-contract'||timing==='expired-deadline')expect(casAttempts).toBe(0);
  }finally{resourceReservationRepository.replace=replace;TestRequestModel.collection.findOneAndUpdate=requestWrite;TestRequestModel.collection.findOne=requestRead;mock.restore()}
 });
});
test('a failed final host CAS retries only the same original claim without allocating an alternate',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),binding={jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()},replace=resourceReservationRepository.replace;
  let lose=true;resourceReservationRepository.replace=async(...args)=>{if(lose){lose=false;return false}return replace(...args)};
  try {expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,binding,{},h.receivedAt)).toBeNull();expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);
   expect((await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,binding,{},h.receivedAt))?.fleetBinding).toEqual(binding);expect(h.resourceReservations).toHaveLength(1);
   expect(hosts.get(h.hostId==='mini'?'air1':'mini').resourceReservations).toEqual([]);
  }finally{resourceReservationRepository.replace=replace}
 });
});
test('a committed resource-check claim blocks allocation before the local idle status advances',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const h=hosts.get('mini'),phone=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone'),at=h.receivedAt.getTime();
  const claim:ExclusiveHostReservation={kind:'exclusive',id:'1f3c2122-d572-40e3-81b6-028e3b186f94',authorityHostId:'mini',borrowerHostId:'mini',laneId:'android',resourceId:phone.id,
   operationId:'resource-check:original',intentSha256:'a'.repeat(64),inputSha256:'b'.repeat(64),owner:{id:'original-check',kind:'boundary-cleanup'},controllerIncarnation:h.incarnation,controllerGeneration:1,borrowerSequence:1,reservedAt:new Date(at).toISOString()};
  h.resourceReservations=[claim];await f.prepare();const original=structuredClone(f.row!);f.restore({...original,fleetResourceReservation:undefined,fleetResourceAdmission:undefined});
  const waiting:unknown[]=[];expect(await routineJobRepository.reserveResources!(original.requestId,original.fleetInputSha256!,'mini','android',new Date(at),(...args)=>waiting.push(args))).toBeNull();
  expect(waiting).toEqual([[RESOURCE_ADMISSION_WAIT,true]]);expect(h.resourceReservations).toEqual([claim]);expect(h.snapshot.resourceLifecycle.subjects.find((s:any)=>s.subject.id===phone.id).status).toBe('idle');
  expect(f.row!.fleetResourceReservation).toBeUndefined();expect(counters.host).toBe(1); // the healthy alternate's prior preparation is separate
 });
});
test('service recovers the SAME own exclusive claim after a lost reply without excluding or relocating its retained target',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),phone=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone'),at=h.receivedAt.toISOString();
  const own:ExclusiveHostReservation={kind:'exclusive',id:'4352be9d-1116-4b81-90e2-6b12885c7174',authorityHostId:h.hostId,borrowerHostId:h.hostId,laneId:'android',resourceId:phone.id,
   operationId:`run:${row.requestId}`,intentSha256:'a'.repeat(64),inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run'},controllerIncarnation:h.incarnation,controllerGeneration:1,borrowerSequence:1,reservedAt:at,origin:{kind:'fleet',fleetInputSha256:row.fleetInputSha256!}};
  h.resourceReservations.push(own);const claims=structuredClone(h.resourceReservations),reserve=f.rows.reserveResources;
  // Existing authority returned its immutable own winner but its first response was lost.
  let lose=true;f.rows.reserveResources=async()=>{if(lose){lose=false;throw Error('Own winner reply lost')}return structuredClone(f.row)};
  try {await expect(f.service.preparation(row.requestId)).rejects.toThrow('reply lost');const recovered=await f.service.preparation(row.requestId);
   expect((recovered as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget).toEqual(target);expect(recovered.waitingReason).toBeUndefined();
   expect(h.resourceReservations).toEqual(claims);expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);expect(f.row!.fleetResourceAdmission).toEqual(row.fleetResourceAdmission);
   expect(hosts.get(h.hostId==='mini'?'air1':'mini').resourceReservations).toEqual([]);
  }finally{f.rows.reserveResources=reserve}
 });
});
test('short baseline expiry during successful final CAS response retains custody without binding',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),replace=resourceReservationRepository.replace,at=h.receivedAt.getTime();
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  resourceReservationRepository.replace=async(...args)=>{const result=await replace(...args);spyOn(Date,'now').mockReturnValue(at+2);return result};
  try {expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeNull();
   expect(f.row!.fleetBinding).toBeUndefined();expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);expect(h.resourceReservations).toHaveLength(1);
  }finally{resourceReservationRepository.replace=replace;mock.restore()}
 });
});
test('ordinary Mac assignment refuses a foreign same-lane recorder claim before local idle status advances',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),own=structuredClone(h.resourceReservations[0]);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';f.restore(row);h.snapshot.lanes[0].platform='ios-on-mac';
  h.resourceReservations.push({...own,id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'foreign-mac-original',fleetInputSha256:'c'.repeat(64)});const claims=structuredClone(h.resourceReservations);
  expect(h.snapshot.lanes[0].state).toBe('idle');expect(h.snapshot.resourceLifecycle.subjects.every((subject:any)=>subject.status==='idle')).toBe(true);
  expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:own.laneId,descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeNull();
  expect(f.row!.fleetBinding).toBeUndefined();expect(h.resourceReservations).toEqual(claims);
 });
});
test('an ordinary claim on another Mac lane sharing the disk does not prevent this lane assignment',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),own=structuredClone(h.resourceReservations[0]);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';f.restore(row);h.snapshot.lanes[0].platform='ios-on-mac';
  h.resourceReservations.push({...own,id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'foreign-mac-original',fleetInputSha256:'c'.repeat(64),laneId:'other-lane'});const claims=structuredClone(h.resourceReservations);
  expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:own.laneId,descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeDefined();
  expect(h.resourceReservations).toEqual(claims);
 });
});
for(const platform of ['android','ios-on-mac'] as const)for(const expiry of ['baseline','deadline'] as const)test(`preclaim ${platform} ${expiry} expiry refuses before the first recorder claim or stage`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const originals=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepare();
  for(const[id,h]of hosts)h.snapshot=structuredClone(originals.get(id));const row=structuredClone(f.row!),h=hosts.get('mini'),at=h.receivedAt.getTime();
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;f.restore(row);h.snapshot.lanes[0].platform=platform;
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const claimRead=resourceReservationRepository.recorderClaims;resourceReservationRepository.recorderClaims=async id=>{const claims=await claimRead!(id);spyOn(Date,'now').mockReturnValue(expiry==='baseline'?at+2:row.fleetDeadline.getTime()+1);return claims};
  try {expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'mini','android',h.receivedAt)).toBeNull();expect(counters).toEqual({host:0,request:0});
   expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(h.resourceReservations).toEqual([]);
  }finally{resourceReservationRepository.recorderClaims=claimRead;mock.restore()}
 });
});
test('serialized stage rechecks the original baseline after its recorder authority read settles',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),at=h.receivedAt.getTime(),claim=structuredClone(h.resourceReservations[0]);
  const phone=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone');phone.capabilities=['backend-connectivity'];delete row.fleetResourceAdmission;f.restore(row);
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;let now=at,stages=0;
  const reservations=new ResourceReservationsService({async request(){return structuredClone(row)},async get(){return structuredClone(h)},async recorderClaims(){now=at+2;return[claim]},
   async stageBackend(){stages++;throw Error('Expired stage must not start')},async claimedHosts(){return[]},async replace(){throw Error('No exclusive claim may start')}},()=>now);
  expect(await reservations.reserveFleet(row.requestId,row.fleetInputSha256!,h.hostId,'android')).toBeNull();expect(stages).toBe(0);expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(h.resourceReservations).toEqual([claim]);
 });
});

for(const platform of ['android','ios-on-mac'] as const)test(`a completed ${platform} recorder claim reconciles before selecting the next SAME job`,async()=>{
 await withLocalResources(async(f,hosts,_counters,pastRows)=>{
  const at=hosts.get('mini').receivedAt.toISOString();
  for(const h of hosts.values()) {
   h.snapshot.lanes[0].platform=platform;h.snapshot.lanes[0].descriptorRevision=routineLaneDescriptorRevision(h.snapshot.lanes[0]);
   const claim={id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:`prior-${h.hostId}`,fleetInputSha256:'c'.repeat(64),hostId:h.hostId,laneId:'android',poolId:`${h.hostId}:disk:1`,minimumAvailableBytes:3*1024**3,reservedAt:at};
   h.resourceReservations=[claim];pastRows.set(claim.requestId,{requestId:claim.requestId,fleetInputSha256:claim.fleetInputSha256,inputSha256:'d'.repeat(64),dispatchCompletion:{inputSha256:'d'.repeat(64),disposition:'clean',completedAt:at}} as StoredRoutineJob);
  }
  const first=await f.service.submit(selection), selectedDefinition={...definition,platforms:[platform],execution:{resourceKinds:['phone','app','recorder','network'],policy:{estimatedOutputBytes:1024**3}},source:definition.source};
  if(platform==='ios-on-mac'){const row=structuredClone(f.row!);row.fleetSelection.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);f.restore(row)}
  const row=f.row!;await f.service.prepared(selection.requestId,{inputSha256:row.fleetSelectionSha256,routineSource:testRoutineSource(selection.routineRevision),definitionSha256:requestInputDigest(selectedDefinition),definition:selectedDefinition});
  const prepared=await f.service.preparation(selection.requestId);
  expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toBeDefined();
  expect([...hosts.values()].flatMap(h=>h.resourceReservations).some(claim=>claim.requestId.startsWith('prior-'))).toBe(false);
  expect(f.row!.requestId).toBe(selection.requestId);expect(f.row!.fleetSelection.build).toEqual(row.fleetSelection.build);expect(f.row!.fleetDeadline).toEqual(row.fleetDeadline);expect(f.row!.fleetBinding).toBeUndefined();
  const target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),current=f.row!,
   binding={jobId:current.requestId,requestId:current.requestId,hostId:h.hostId,laneId:target.laneId,
    descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:at};
  expect((await routineJobRepository.bind(current.requestId,current.fleetInputSha256!,binding,{},h.receivedAt))?.fleetBinding).toEqual(binding);
  expect(h.resourceReservations.map((claim:any)=>claim.requestId)).toEqual([current.requestId]);
 });
});

for(const refusal of ['missing-request','changed-digest','active-offer','wrong-pool','stale-offer','future-offer','before-cancellation','cancellation-before-claim','completion-before-claim','invalid-completion','completion-input','candidate-held','report-race','lost-cas'] as const)test(`recorder return reconciliation retains ${refusal} custody`,async()=>{
 await withLocalResources(async(f,hosts,_counters,pastRows)=>{
  const h=hosts.get('mini'),at=h.receivedAt.toISOString(),offer=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='recorder').storage,
   claim={id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'prior-mini',fleetInputSha256:'c'.repeat(64),hostId:h.hostId,laneId:'android',poolId:'mini:disk:1',minimumAvailableBytes:3*1024**3,reservedAt:at},
   prior={requestId:claim.requestId,fleetInputSha256:claim.fleetInputSha256,inputSha256:'d'.repeat(64),dispatchCompletion:{inputSha256:'d'.repeat(64),disposition:'clean',completedAt:at}} as StoredRoutineJob;
  h.resourceReservations=[claim];pastRows.set(prior.requestId,prior);
  if(refusal==='missing-request')pastRows.delete(prior.requestId);
  if(refusal==='changed-digest')prior.fleetInputSha256='e'.repeat(64);
  if(refusal==='active-offer')offer.reservations=[{requestId:prior.requestId,inputSha256:prior.inputSha256,remainingOutputBytes:0}];
  if(refusal==='wrong-pool')offer.poolId='mini:disk:other';
  if(refusal==='stale-offer')offer.observedAt=new Date(h.receivedAt.getTime()-120001).toISOString();
  if(refusal==='future-offer')offer.observedAt=new Date(h.receivedAt.getTime()+1).toISOString();
  if(refusal==='before-cancellation'){delete prior.dispatchCompletion;prior.fleetCancellation={requestedAt:new Date(h.receivedAt.getTime()+1).toISOString(),reason:'Original cancellation'};}
  if(refusal==='cancellation-before-claim'){delete prior.dispatchCompletion;prior.fleetCancellation={requestedAt:new Date(h.receivedAt.getTime()-1).toISOString(),reason:'Older cancellation'};}
  if(refusal==='completion-before-claim')prior.dispatchCompletion!.completedAt=new Date(h.receivedAt.getTime()-1).toISOString();
  if(refusal==='invalid-completion')prior.dispatchCompletion!.completedAt='invalid';
  if(refusal==='completion-input')prior.dispatchCompletion!.inputSha256='e'.repeat(64);
  if(refusal==='candidate-held')prior.fleetCandidatePreparation={} as any;
  const replace=resourceReservationRepository.replace;
  if(refusal==='report-race')resourceReservationRepository.replace=async(host,claims)=>{h.sequence++;return replace(host,claims)};
  if(refusal==='lost-cas')resourceReservationRepository.replace=async()=>{throw Error('Original CAS reply lost')};
  try {
   if(refusal==='lost-cas')await expect(routineJobRepository.reconcileRecorderHost!('mini',h.receivedAt)).rejects.toThrow('Original CAS reply lost');
   else await routineJobRepository.reconcileRecorderHost!('mini',h.receivedAt);
   expect(h.resourceReservations).toEqual([claim]);expect(f.row).toBeNull();
  }finally{resourceReservationRepository.replace=replace}
 });
});


for(const platform of ['android','ios-on-mac'] as const)for(const phase of ['request','host'] as const)for(const boundary of ['baseline-exact','baseline-expired','deadline'] as const)test(`offline ${platform} repository stage after ${phase} ${boundary} preserves the unclaimed SAME job for a ready alternate`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepare();
  for(const[id,h]of hosts)h.snapshot=structuredClone(snapshots.get(id));const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!);
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  for(const host of hosts.values())host.snapshot.lanes[0].platform=platform;
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),request=resourceReservationRepository.request,get=resourceReservationRepository.get,clock=spyOn(Date,'now').mockReturnValue(at);
  let delayed=false;
  const delay=()=>{if(delayed)return;delayed=true;const after=boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2);clock.mockReturnValue(after)};
  resourceReservationRepository.request=async id=>{const value=await request!(id);if(phase==='request')delay();return value};
  resourceReservationRepository.get=async id=>{const value=await get(id);if(phase==='host')delay();return value};
  const admission={intent:{operationId:`run:${row.requestId}`,hostId:h.hostId,laneId:'android',inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run' as const},
    controller:{incarnation:h.incarnation,generation:h.incarnationGeneration,sequence:h.sequence},resources:h.snapshot.lanes[0].resources.map((resource:any)=>({id:resource.id,capabilities:resource.capabilities??[]}))},dependencies:[]};
  try {
   const staged=await resourceReservationRepository.stage!(row.requestId,row.fleetInputSha256!,admission,h.receivedAt);
   if(boundary==='baseline-exact'){expect(staged?.fleetResourceAdmission).toEqual(admission);expect(counters.request).toBe(1)}
   else{expect(staged).toBeNull();expect(counters).toEqual({host:0,request:0});expect(f.row).toEqual(original);expect(h.resourceReservations).toEqual([]);
    if(boundary==='baseline-expired'){
     const alternate=hosts.get('air1'),now=Date.now();alternate.receivedAt=new Date(now);alternate.snapshot.observedAt=new Date(now).toISOString();
     for(const subject of alternate.snapshot.resourceLifecycle.subjects){subject.observedAt=alternate.snapshot.observedAt;subject.idle.checkedAt=alternate.snapshot.observedAt;subject.idle.acceptedCheck.acceptedAt=alternate.snapshot.observedAt}
     resourceReservationRepository.request=request;resourceReservationRepository.get=get;
     expect(await new ResourceReservationsService(resourceReservationRepository,()=>Date.now()).reserveFleet(row.requestId,row.fleetInputSha256!,'air1','android')).toBeUndefined();
     expect(f.row!.fleetResourceAdmission!.intent.hostId).toBe('air1');expect(f.row!.fleetSelection).toEqual(original.fleetSelection);expect(f.row!.fleetPreparation).toEqual(original.fleetPreparation);
    }
   }
   expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{resourceReservationRepository.request=request;resourceReservationRepository.get=get;clock.mockRestore()}
 });
});
for(const phase of ['request','recorder','host','final-request','final-host'] as const)for(const boundary of ['baseline-exact','baseline-expired','deadline'] as const)test(`offline serialized Android repository stage after ${phase} ${boundary} retains its original provisional claim`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const prepared=await f.prepare(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),at=h.receivedAt.getTime(),row=structuredClone(f.row!),claim=structuredClone(h.resourceReservations[0]);
  delete row.fleetResourceAdmission;delete row.fleetResourceReservation;f.restore(row);h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='phone').capabilities=['backend-connectivity'];
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),request=resourceReservationRepository.request,get=resourceReservationRepository.get,recorder=resourceReservationRepository.recorderClaims,clock=spyOn(Date,'now').mockReturnValue(at),initialWrites={...counters};
  let requestReads=0,hostReads=0,delayed=false;
  const delay=()=>{if(delayed)return;delayed=true;clock.mockReturnValue(boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2))};
  resourceReservationRepository.request=async id=>{const value=await request!(id);if(phase===(++requestReads===1?'request':'final-request'))delay();return value};
  resourceReservationRepository.get=async id=>{const value=await get(id);if(phase===(++hostReads===1?'host':'final-host'))delay();return value};
  resourceReservationRepository.recorderClaims=async id=>{const value=await recorder!(id);if(phase==='recorder')delay();return value};
  const admission={intent:{operationId:`run:${row.requestId}`,hostId:h.hostId,laneId:'android',inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run' as const},
   controller:{incarnation:h.incarnation,generation:h.incarnationGeneration,sequence:h.sequence},resources:h.snapshot.lanes[0].resources.map((resource:any)=>({id:resource.id,capabilities:resource.capabilities??[]}))},dependencies:[]};
  try {
   const staged=await resourceReservationRepository.stageBackend!(row.requestId,row.fleetInputSha256!,admission,structuredClone(h),h.receivedAt);
   if(boundary==='baseline-exact'){expect(staged?.fleetResourceAdmission).toEqual(admission);expect(counters.request).toBe(initialWrites.request+1)}
   else{expect(staged).toBeNull();expect(counters).toEqual(initialWrites);expect(f.row).toEqual(original)}
   expect(h.resourceReservations).toEqual([claim]);expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{resourceReservationRepository.request=request;resourceReservationRepository.get=get;resourceReservationRepository.recorderClaims=recorder;clock.mockRestore()}
 });
});


for(const laneKind of ['mac','android','serialized-android'] as const)for(const phase of (laneKind==='serialized-android'?['admission-request','admission-recorder','admission-host']:['admission-request','recorder-cas']) as ('admission-request'|'admission-recorder'|'admission-host'|'recorder-cas')[])for(const boundary of ['baseline-exact','baseline-expired','deadline'] as const)test(`ordinary offline ${laneKind} post-stage ${phase} ${boundary} never publishes a stale recorder receipt`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepare();
  for(const[id,h]of hosts)h.snapshot=structuredClone(snapshots.get(id));const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!),platform=laneKind==='mac'?'ios-on-mac':'android';
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);h.snapshot.lanes[0].platform=platform;
  if(laneKind==='serialized-android')h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='phone').capabilities=['backend-connectivity'];
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),read=TestRequestModel.collection.findOne,hostWrite=TestHostStateModel.collection.findOneAndUpdate,get=resourceReservationRepository.get,recorder=resourceReservationRepository.recorderClaims,clock=spyOn(Date,'now').mockReturnValue(at);
  const originalReserveFleet=ResourceReservationsService.prototype.reserveFleet, fleetClock=spyOn(ResourceReservationsService.prototype,'reserveFleet').mockImplementation(function(...args){return originalReserveFleet.apply(new ResourceReservationsService(resourceReservationRepository,()=>Date.now()),args)});
  let delayed=false;
  const delay=()=>{if(delayed)return;delayed=true;clock.mockReturnValue(boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2))};
  TestRequestModel.collection.findOne=mock(async(...args:any[])=>{const value=await read.apply(TestRequestModel.collection,args as never);if(phase==='admission-request'&&f.row?.fleetResourceAdmission)delay();return value}) as never;
  resourceReservationRepository.get=async id=>{const value=await get(id);if(phase==='admission-host'&&f.row?.fleetResourceAdmission)delay();return value};
  resourceReservationRepository.recorderClaims=async id=>{const value=await recorder!(id);if(phase==='admission-recorder'&&f.row?.fleetResourceAdmission)delay();return value};
  TestHostStateModel.collection.findOneAndUpdate=mock(async(...args:any[])=>{const value=await hostWrite.apply(TestHostStateModel.collection,args as never);if(phase==='recorder-cas'&&value&&f.row?.fleetResourceAdmission)delay();return value}) as never;
  try{
   const selected=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'mini','android',new Date(at));expect(delayed).toBe(true);
   if(boundary==='baseline-exact'){expect(selected?.fleetResourceReservation?.hostId).toBe('mini');expect(f.row!.fleetResourceReservation).toEqual(h.resourceReservations[0])}
   else{expect(selected).toBeNull();expect(f.row!.fleetResourceReservation).toBeUndefined();if(laneKind==='serialized-android'||phase==='recorder-cas')expect(h.resourceReservations).toHaveLength(1);else expect(h.resourceReservations).toEqual([])}
   expect(f.row!.fleetResourceAdmission?.intent.hostId).toBe('mini');expect(f.row!.fleetSelection).toEqual(original.fleetSelection);expect(f.row!.fleetPreparation).toEqual(original.fleetPreparation);expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{TestRequestModel.collection.findOne=read;TestHostStateModel.collection.findOneAndUpdate=hostWrite;resourceReservationRepository.get=get;resourceReservationRepository.recorderClaims=recorder;fleetClock.mockRestore();clock.mockRestore()}
 });
});


for(const laneKind of ['mac','android','serialized-android'] as const)for(const phase of ['stage-cas','receipt-cas'] as const)for(const boundary of ['baseline-exact','baseline-expired','deadline'] as const)test(`ordinary offline ${laneKind} delayed ${phase} ${boundary} preserves its actual committed original`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepare();
  for(const[id,h]of hosts)h.snapshot=structuredClone(snapshots.get(id));const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!),platform=laneKind==='mac'?'ios-on-mac':'android';
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);h.snapshot.lanes[0].platform=platform;
  if(laneKind==='serialized-android')h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='phone').capabilities=['backend-connectivity'];
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),write=TestRequestModel.collection.findOneAndUpdate,originalReserveFleet=ResourceReservationsService.prototype.reserveFleet,
   clock=spyOn(Date,'now').mockReturnValue(at),fleetClock=spyOn(ResourceReservationsService.prototype,'reserveFleet').mockImplementation(function(...args){return originalReserveFleet.apply(new ResourceReservationsService(resourceReservationRepository,()=>Date.now()),args)});
  let delayed=false;
  TestRequestModel.collection.findOneAndUpdate=mock(async(...args:any[])=>{const value=await write.apply(TestRequestModel.collection,args as never),update=args[1];
   if(value&&!delayed&&(phase==='stage-cas'?update.$set.fleetResourceAdmission:update.$set.fleetResourceReservation)){delayed=true;clock.mockReturnValue(boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2))}return value}) as never;
  try{
   const result=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'mini','android',new Date(at));expect(delayed).toBe(true);
   expect(f.row!.fleetResourceAdmission?.intent.hostId).toBe('mini');expect(counters.request).toBe(phase==='receipt-cas'||boundary==='baseline-exact'?2:1);
   if(boundary==='baseline-exact')expect(result?.fleetResourceReservation?.hostId).toBe('mini');else expect(result).toBeNull();
   if(phase==='receipt-cas'||boundary==='baseline-exact'){expect(f.row!.fleetResourceReservation).toEqual(h.resourceReservations[0]);expect(h.resourceReservations).toHaveLength(1)}
   else{expect(f.row!.fleetResourceReservation).toBeUndefined();expect(h.resourceReservations).toHaveLength(laneKind==='serialized-android'?1:0)}
   expect(f.row!.fleetSelection).toEqual(original.fleetSelection);expect(f.row!.fleetPreparation).toEqual(original.fleetPreparation);expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{TestRequestModel.collection.findOneAndUpdate=write;fleetClock.mockRestore();clock.mockRestore()}
 });
});
