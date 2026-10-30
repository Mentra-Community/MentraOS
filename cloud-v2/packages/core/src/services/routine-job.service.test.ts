import {TestRunError} from './test-result-error';
import {Hono} from 'hono';
import type {AppEnv} from '../types/hono.types';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {expect, test, mock, spyOn} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {TestHostStateModel} from '../models/test-host-state.model';
import {resourceReservationRepository, ResourceReservationsService, replaceableMacRecorderQuota} from './resource-reservations.service';
import {hostStateSchema} from './test-host-state.service';
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types';
import {resourceAvailable, requiredResourceBlocker} from './resource-readiness';
import {createRoutineJobsApi, createRoutineJobBindingApi} from '../api/internal/routine-jobs.api';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import {requestInputDigest, TestRequestConflict, TestRequestService, type TestRequestRepository, type HostAcceptance} from './test-request.service';
import {RoutineJobService, isAutomaticPrRoutineJob, routineJobRepository, routineJobInputDigest, orderedRoutineCandidates, routineJobRouting, routineLaneDescriptorRevision, routineRequirementLabels, compatibleRoutineLane, type RoutineJobRepository} from './routine-job.service';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {ReceivedTestHostState, RoutingTestHostState} from './test-host-state.service';
import {isExclusiveHostReservation, type ExclusiveHostReservation} from '../types/resource-reservations.types';
import {RESOURCE_ADMISSION_WAIT, RECORDER_CAPACITY_WAIT, RECORDER_OBSERVATION_WAIT, sharedResourceWait} from './routine-resource-wait';
import {testingTarget, type TestingTarget} from '../types/testing-source.types';
import type {RoutineJobActions} from './routine-job-actions.service';
const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:2};
const selection = {requestId:'job-one',routineId:'new-routine',platform:'android' as const,source,routineRevision:'a'.repeat(40)};
const definition = {id:'new-routine',minimumRoutineApiVersion:1,title:'A check',purpose:'Verify independently',platforms:['android'],entry:'home',account:'lane',
  requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],
  execution:{resourceKinds:['phone','app','recorder','network'],policy:{estimatedOutputBytes:1024 ** 3}},resourceRequirements:[{kind:'phone',capabilities:[]},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']}],
  source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:selection.routineRevision,path:'routines/new-routine/routine.ts'}};
function fixture(selectedDefinition: Omit<typeof definition, 'resourceRequirements' | 'fixtures'> & {resourceRequirements: {kind: string; capabilities: string[]}[]; fixtures: {provider: string; description: string}[]; glasses?: {models: string[]}} = definition, actions: RoutineJobActions | null = null, jobSelection: typeof selection = selection) {
  let time = Date.parse('2026-10-08T00:00:00Z'), row:StoredRoutineJob|null=null, resolves=0, sources=0;
  let offeredHosts: (ReceivedTestHostState & Pick<RoutingTestHostState, 'authorityReservations'>)[] | undefined, resultFound = false;
  const copy = <T>(value:T):T => structuredClone(value);
  const rows:RoutineJobRepository={
    async get(id){return row?.requestId===id?copy(row):null},async insert(value){if(row)throw Object.assign(Error('duplicate'),{code:11000});row=copy(value)},
    async prepare(id,digest,prepared,inputSha256,now){if(!row||row.requestId!==id||row.state!=='awaiting-source'||row.fleetSelectionSha256!==digest||row.fleetCancellation||row.fleetDeadline<=now)return null;
      row={...row,fleetPreparation:copy(prepared),fleetInputSha256:inputSha256,state:'awaiting-runner'};return copy(row)},
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
  const host=(hostId:string):ReceivedTestHostState=>({hostId,incarnation:'one',incarnationGeneration:1,sequence:1,observedAt:new Date(time).toISOString(),receivedAt:new Date(time).toISOString(),frameworkBinding:testFrameworkBinding(),lanes:[{...copy(lane),resources:lane.resources.map(resource=>resource.storage?{...resource,storage:{...resource.storage,observedAt:new Date(time).toISOString()}}:resource)}]});
  const service=new RoutineJobService(rows,{async resolve(value,platform){resolves++;return {source:value,platform,availability:'available',title:'App',headSha:'c'.repeat(40),createdAt:new Date(time).toISOString(),buildUrl:'https://github.com/Mentra-Community/MentraOS/actions/runs/55',
    archive:{name:'app.apk',size:100,sha256:'d'.repeat(64),url:'https://artifactscdn.mentraglass.com/app.apk'},receipt:{size:10,sha256:'e'.repeat(64),url:'https://artifactscdn.mentraglass.com/receipt.json'}}}},
    {async resolve(revision){sources++;return revision??jobSelection.routineRevision},async inventory(commit){return {commit,files:[]}},async blob(){return new Uint8Array()}},
    {async getExact(){return null}}, {async get(hostId){return offeredHosts?.find(host => host.hostId === hostId) ?? host(hostId)}, async list(){return offeredHosts ?? [host('mini')]}}, {async cancel(){if(row && row.state!=='terminal')row={...row,state:'terminal',terminalStatus:'cancelled'};return null}},
    {async detail(){throw new TestRunError(404,'missing')}},()=>time,actions);
  // Result lookup intentionally uses the same 404 class as existing Core result APIs.
  const prepare=async()=>{const first=await service.submit(jobSelection);await service.prepared(jobSelection.requestId,{inputSha256:first.fleetSelectionSha256,
    routineSource:testRoutineSource(jobSelection.routineRevision),definitionSha256:requestInputDigest(selectedDefinition),definition:selectedDefinition});return service.preparation(jobSelection.requestId)};
  // Existing custody tests start from an already-created reserved request. New
  // portable preparation tests use prepare() and reach acquisition through bind.
  const reservePrepared = async (hostId?: string) => {
    const current = row!, prepared = {jobId: current.requestId, kind: 'run' as const,
      inputSha256: current.fleetInputSha256!, deadline: current.fleetDeadline.toISOString(), state: current.state,
      selection: current.fleetSelection, prepared: current.fleetPreparation,
      resourceTarget: undefined as {hostId: string; laneId: string} | undefined,
      ...routineJobRouting(current.fleetPreparation!.requirements, [], time)};
    if (hostId || !current.fleetResourceReservation && !current.fleetCandidatePreparation && !current.fleetTarget) {
      const hosts = await (service as any).hosts.list() as RoutingTestHostState[];
      const selected = await rows.selectedLanes?.(hosts.map(host => host.hostId)) ?? [];
      for (const {host, lane} of orderedRoutineCandidates(current.requestId, hosts, selected)) {
        if (hostId && host.hostId !== hostId) continue;
        const routing = routineJobRouting(current.fleetPreparation!.requirements,
          [{...host, lanes: [lane]}], time, undefined, current.fleetSelection.build, false,
          {requestId: current.requestId, inputSha256: current.fleetInputSha256!});
        if (routing.waitingReason) continue;
        const reserved = await rows.reserveResources?.(current.requestId, current.fleetInputSha256!, host.hostId, lane.id, new Date(time));
        if (reserved?.fleetResourceReservation || row!.fleetCandidatePreparation) break;
      }
    }
    const quota = row!.fleetResourceReservation;
    return quota ? {...prepared, waitingReason: undefined, chosenModel: quota.chosenModel,
      resourceTarget: {hostId: quota.hostId, laneId: quota.laneId},
      routingLabels: routineRequirementLabels(row!.fleetPreparation!.requirements, quota.chosenModel, quota)} : prepared;
  };
  const prepareReserved = async () => {await prepare(); return reservePrepared();};
  return {service,rows,lane,prepare,prepareReserved,reservePrepared,offer(hosts: (ReceivedTestHostState & Pick<RoutingTestHostState, 'authorityReservations'>)[]){offeredHosts=copy(hosts).map(host=>({...host,frameworkBinding:host.frameworkBinding??testFrameworkBinding()}))}, restore(value:StoredRoutineJob){row=copy(value)},settle(inputSha256:string){if(row)row={...row,state:'terminal',terminalStatus:'pass',inputSha256} as any},queued(inputSha256:string){if(row)row={...row,state:'queued',inputSha256,hostReceipt:undefined} as any},accepted(inputSha256:string){if(row)row={...row,state:'accepted',inputSha256,hostReceipt:{requestId:row.requestId,hostId:row.hostId!,inputSha256,acceptedAt:new Date(time).toISOString()}} as any},result(insertedOnly=false){resultFound=true;if(row&&!insertedOnly)row={...row,runId:jobSelection.requestId,state:'terminal',terminalStatus:'pass'}},get row(){return row},get resolves(){return resolves},get sources(){return sources},advance(ms:number){time+=ms}};
}
test('preparation POST freezes exact source and its GET leaves default work portable', async () => {
  const previousToken = process.env.TEST_RUN_INGEST_TOKEN;
  process.env.TEST_RUN_INGEST_TOKEN = 'preparation-observer-token-at-least-thirty-two-characters';
  try {
    const f = fixture(), first = await f.service.submit(selection);
    const input = {inputSha256: first.fleetSelectionSha256, routineSource: testRoutineSource(selection.routineRevision),
      definitionSha256: requestInputDigest(definition), definition};
    const app = createRoutineJobsApi(f.service), headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`,
      'content-type': 'application/json'}, path = `/${selection.requestId}/preparation`;
    const saved = await app.request(path, {method: 'POST', headers, body: JSON.stringify(input)});
    expect(saved.status).toBe(200);
    expect(f.row?.fleetPreparation?.definitionSha256).toBe(input.definitionSha256);
    expect(f.row?.fleetResourceReservation).toBeUndefined();
    expect(await saved.json()).toEqual({jobId: selection.requestId, inputSha256: f.row!.fleetInputSha256, state: 'awaiting-runner'});
    const routed = await app.request(path, {headers});
    expect(routed.status).toBe(200);
    expect(f.row?.fleetResourceReservation).toBeUndefined();
    const routing = await routed.json() as {jobId: string; resourceTarget?: {hostId: string; laneId: string}; routingLabels: string[]};
    expect(routing.jobId).toBe(selection.requestId);
    expect(routing.resourceTarget).toBeUndefined();
    expect(routing.routingLabels.some(label => label.startsWith('mentra-host-') || label.startsWith('mentra-lane-'))).toBe(false);
    expect(routing.routingLabels).toContain('mentra-platform-android');
  } finally {
    if (previousToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN;
    else process.env.TEST_RUN_INGEST_TOKEN = previousToken;
  }
});

test('unavailable matching cannot fail an already committed preparation acknowledgement', async () => {
  const previousToken = process.env.TEST_RUN_INGEST_TOKEN;
  process.env.TEST_RUN_INGEST_TOKEN = 'preparation-observer-token-at-least-thirty-two-characters';
  const f = fixture(), first = await f.service.submit(selection);
  const routing = spyOn(f.service, 'preparation').mockRejectedValue(new TestRunError(503, 'Matching is unavailable'));
  try {
    const input = {inputSha256: first.fleetSelectionSha256, routineSource: testRoutineSource(selection.routineRevision),
      definitionSha256: requestInputDigest(definition), definition};
    const app = createRoutineJobsApi(f.service), headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`,
      'content-type': 'application/json'}, path = `/${selection.requestId}/preparation`;
    const saved = await app.request(path, {method: 'POST', headers, body: JSON.stringify(input)});
    expect(saved.status).toBe(200);
    expect(f.row?.state).toBe('awaiting-runner');
    expect(routing).not.toHaveBeenCalled();
    expect((await app.request(path, {headers})).status).toBe(503);
    expect(routing).toHaveBeenCalledTimes(1);
  } finally {
    routing.mockRestore();
    if (previousToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN;
    else process.env.TEST_RUN_INGEST_TOKEN = previousToken;
  }
});

test('preparation acknowledgement retains frozen-input rejection before any matching', async () => {
  const previousToken = process.env.TEST_RUN_INGEST_TOKEN;
  process.env.TEST_RUN_INGEST_TOKEN = 'preparation-observer-token-at-least-thirty-two-characters';
  const f = fixture(); await f.service.submit(selection);
  const routing = spyOn(f.service, 'preparation');
  try {
    const app = createRoutineJobsApi(f.service), headers = {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`,
      'content-type': 'application/json'};
    const response = await app.request(`/${selection.requestId}/preparation`, {method: 'POST', headers,
      body: JSON.stringify({inputSha256: '0'.repeat(64), routineSource: testRoutineSource(selection.routineRevision),
        definitionSha256: requestInputDigest(definition), definition})});
    expect(response.status).toBe(409);
    expect(f.row?.state).toBe('awaiting-source');
    expect(f.row?.fleetPreparation).toBeUndefined();
    expect(routing).not.toHaveBeenCalled();
  } finally {
    routing.mockRestore();
    if (previousToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN;
    else process.env.TEST_RUN_INGEST_TOKEN = previousToken;
  }
});

test('preparation failures name the active database stage and retain request correlation without logging inputs', async () => {
  const previousToken = process.env.TEST_RUN_INGEST_TOKEN;
  process.env.TEST_RUN_INGEST_TOKEN = 'preparation-observer-token-at-least-thirty-two-characters';
  try {
    for (const stage of ['job-lookup', 'prepared-input-CAS', 'recorder-original-request-read'] as const) {
      const f = fixture(), first = await f.service.submit(selection);
      const input = {inputSha256: first.fleetSelectionSha256, routineSource: testRoutineSource(selection.routineRevision),
        definitionSha256: requestInputDigest(definition), definition};
      if (stage === 'recorder-original-request-read') await f.service.prepared(selection.requestId, input);
      let now = 0;
      const error = Object.assign(new Error('private database command and source body'), {name: 'MongoOperationTimeoutError'});
      const reject = async () => {now = 21; throw error;};
      const lookup = stage === 'job-lookup' ? spyOn(f.rows, 'get').mockImplementation(reject) : undefined;
      const save = stage === 'prepared-input-CAS' ? spyOn(f.rows, 'prepare').mockImplementation(reject) : undefined;
      if (stage === 'recorder-original-request-read') f.rows.reconcileRecorderHost = async (_hostId, _now, onPhase) => {
        onPhase?.(stage, {attempt: 0, claimCount: 2});
        return reject();
      };
      const records: {fields: Record<string, unknown>; message: string}[] = [];
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('reqId', 'original-preparation-request');
        c.set('logger', {info: (fields: Record<string, unknown>, message: string) => records.push({fields, message}),
          error: (fields: Record<string, unknown>, message: string) => records.push({fields, message})} as any);
        await next();
      });
      app.route('/', createRoutineJobsApi(f.service));
      try {
        const response = await app.request(`/${selection.requestId}/preparation`, {
          ...(stage === 'prepared-input-CAS' ? {method: 'POST', body: JSON.stringify(input)} : {}),
          headers: {authorization: `Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`, 'content-type': 'application/json'},
        });
        expect(response.status).toBe(503);
        const failed = records.filter(record => record.message === 'routine job preparation failed');
        expect(failed).toHaveLength(1);
        expect(failed[0]!.fields).toMatchObject({operation: stage === 'prepared-input-CAS' ? 'save' : 'lookup', phase: stage,
          jobId: selection.requestId, reqId: 'original-preparation-request', stageElapsedMs: 21, requestElapsedMs: 21,
          errorName: 'MongoOperationTimeoutError'});
        if (stage === 'recorder-original-request-read') expect(failed[0]!.fields).toMatchObject({hostCount: 1, hostIndex: 0, attempt: 0, claimCount: 2});
        expect(JSON.stringify(records)).not.toContain(error.message);
        expect(JSON.stringify(records)).not.toContain(input.inputSha256);
        expect(JSON.stringify(records)).not.toContain(input.routineSource.bundle.url);
        expect(JSON.stringify(records)).not.toContain(process.env.TEST_RUN_INGEST_TOKEN!);
        if (stage === 'prepared-input-CAS') expect(f.row?.fleetPreparation).toBeUndefined();
      } finally {
        lookup?.mockRestore(); save?.mockRestore(); clock.mockRestore();
      }
    }
  } finally {
    if (previousToken === undefined) delete process.env.TEST_RUN_INGEST_TOKEN;
    else process.env.TEST_RUN_INGEST_TOKEN = previousToken;
  }
});

test('dispatch persists its original target before I/O and legacy receipts remain on main after the selector changes', async () => {
  const previousSetting = process.env.TESTING_REPOSITORY;
  try {
    delete process.env.TESTING_REPOSITORY;
    const delivered: TestingTarget[] = [], observed: TestingTarget[] = [];
    const f = fixture(definition, {async dispatch(_id, target) {
      expect(f.row?.fleetDispatch?.target).toEqual(target);
      delivered.push(target!);
    }, async runs(_id, _since, target) {observed.push(target!); return [];}, async cancel() {}});
    const first = await f.service.submit(selection), frozenDigest = first.fleetSelectionSha256;
    // A pre-bridge receipt has no target. It retains the old identity even after a restart/switch.
    const {target: _target, ...legacyReceipt} = first.fleetDispatch!;
    f.restore({...first, fleetDispatch: legacyReceipt});
    process.env.TESTING_REPOSITORY = 'Mentra-Community/Mentra';
    expect(await f.service.freezeSelection({...selection, routineRepository: testingTarget().repository})).not.toHaveProperty('routineRepository');
    f.advance(130_000);
    const retried = await f.service.submit(selection);
    expect(retried.fleetSelectionSha256).toBe(frozenDigest);
    expect(retried.fleetSelection).not.toHaveProperty('routineRepository');
    expect(delivered).toEqual([testingTarget(), testingTarget()]);
    expect(observed).toEqual([testingTarget()]);
  } finally {if (previousSetting === undefined) delete process.env.TESTING_REPOSITORY; else process.env.TESTING_REPOSITORY = previousSetting;}
});

test('canonical source and workflow remain pinned when new work is retried after a switch back', async () => {
  const previousSetting = process.env.TESTING_REPOSITORY;
  try {
    process.env.TESTING_REPOSITORY = 'Mentra-Community/Mentra';
    const delivered: TestingTarget[] = [], f = fixture(definition, {async dispatch(_id, target) {
      expect(f.row?.fleetDispatch?.target).toEqual(target); delivered.push(target!);
    }, async runs(_id, _since, target) {expect(target).toEqual(testingTarget('Mentra-Community/Mentra')); return [];}, async cancel() {}});
    const first = await f.service.submit(selection), frozenDigest = first.fleetSelectionSha256;
    expect(first.fleetSelection.routineRepository).toBe('Mentra-Community/Mentra');
    delete process.env.TESTING_REPOSITORY;
    f.advance(130_000);
    const retried = await f.service.submit(selection);
    expect(retried.fleetSelectionSha256).toBe(frozenDigest);
    expect(retried.fleetSelection.routineRepository).toBe('Mentra-Community/Mentra');
    expect(delivered).toEqual([testingTarget('Mentra-Community/Mentra'), testingTarget('Mentra-Community/Mentra')]);
    await expect(f.service.submit({...selection, routineRepository: 'Mentra-Community/Mentra-Automated-Testing'})).rejects.toThrow('changed');
  } finally {if (previousSetting === undefined) delete process.env.TESTING_REPOSITORY; else process.env.TESTING_REPOSITORY = previousSetting;}
});

test('bound observation never substitutes prepared input before executable preparation', async () => {
  const f = fixture(), prepared = await f.prepareReserved();
  expect(await f.service.observation(selection.requestId)).not.toHaveProperty('boundInputSha256');
  const input = {inputSha256: prepared.inputSha256, laneId: f.lane.id, descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'};
  const bound = await f.service.bind(selection.requestId, 'mini', input);
  expect(bound.observation).toMatchObject({inputSha256: prepared.inputSha256, state: 'preparing', terminal: false});
  expect(bound.observation).not.toHaveProperty('boundInputSha256');
});
test('portable preparation preserves an actual resource blocker instead of inventing recorder shortage when admission returns no winner', async () => {
  const f = fixture(), original = f.rows.reserveResources!; await f.prepareReserved();
  const frozen = structuredClone(f.row);
  f.rows.reserveResources = async (_id, _digest, _host, _lane, _now, onWaiting) => {onWaiting?.(sharedResourceWait('google-authentication'), true); return null;};
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(sharedResourceWait('google-authentication'));
  expect(f.row).toEqual(frozen);
  f.rows.reserveResources = async () => null;
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT);
  f.rows.reserveResources = original;
});
test('existing observation reports a staged authority blocker without changing custody or manufacturing a recorder reason', async () => {
  const f = fixture(); await f.prepareReserved();
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
test('explicit routing distinguishes known capacity shortage, missing measurements and mixed unknowns before authority admission', async () => {
  const f = fixture(); await f.prepareReserved();
  const row = {...f.row!, fleetResourceReservation: undefined, fleetTarget: {hostId: 'mini'}}; row.fleetInputSha256 = routineJobInputDigest(row); f.restore(row);
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
  const f = fixture(); await f.prepareReserved();
  const row = {...f.row!, fleetResourceReservation: undefined, fleetTarget: {hostId: 'mini'}}; row.fleetInputSha256 = routineJobInputDigest(row); f.restore(row);
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

test('an acquired target disk shortage or absent observation is not hidden by another available lane', async () => {
  const f = fixture(); await f.prepareReserved();
  const row = structuredClone(f.row!);
  row.fleetResourceAdmission = {intent: {operationId: `run:${row.requestId}`, hostId: 'mini', laneId: f.lane.id,
    owner: {id: row.requestId, kind: 'run'}, inputSha256: row.fleetInputSha256!, controller: {incarnation: 'one', generation: 1, sequence: 1},
    resources: [{id: 'recorder', capabilities: []}]}, dependencies: []};
  f.restore(row);
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: '2026-10-08T00:00:00Z', receivedAt: '2026-10-08T00:00:00Z', lanes: [structuredClone(f.lane), {...structuredClone(f.lane), id: 'other'}]};
  let calls = 0; f.rows.reserveResources = async (_id, _digest, _host, _lane, _now, onWaiting) => {
    calls++; onWaiting?.(host.lanes[0]!.resources.find(resource => resource.kind === 'recorder')!.storage ? RECORDER_CAPACITY_WAIT : RECORDER_OBSERVATION_WAIT); return null;
  };
  host.lanes[0]!.resources.find(resource => resource.kind === 'recorder')!.storage!.availableBytes = 0; f.offer([host]);
  expect((await f.service.preparation(row.requestId)).waitingReason).toBe(RECORDER_CAPACITY_WAIT);
  delete host.lanes[0]!.resources.find(resource => resource.kind === 'recorder')!.storage; f.offer([host]);
  expect((await f.service.preparation(row.requestId)).waitingReason).toBe(RECORDER_OBSERVATION_WAIT);
  expect(calls).toBe(2); expect(f.row).toEqual(row);
});

test('mixed candidate refusal and skipped recorder observations use truthful general wording regardless of order', async () => {
  const f = fixture(); await f.prepareReserved(); const row = {...f.row!, fleetResourceReservation: undefined, fleetTarget: {hostId: 'mini'}}; row.fleetInputSha256 = routineJobInputDigest(row); f.restore(row);
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
  const f=fixture(),prepared=await f.prepareReserved(), phases:string[]=[];
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  const before=structuredClone(f.row),result=await f.service.observation(selection.requestId,value=>phases.push(value));
  expect(phases).toEqual(['request','delivery','result','projection']);expect(f.row).toEqual(before);
  expect(result).toMatchObject({state:'preparing',terminal:false});expect(result).not.toHaveProperty('result');
});

test('deadline cancellation propagates phase through its nested observation and subsequent outer reload',async()=>{
  const f=fixture(),prepared=await f.prepareReserved(),phases:string[]=[];
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  f.advance(3*3600000+1);
  const result=await f.service.observation(selection.requestId,value=>phases.push(value));
  expect(phases).toEqual(['request','delivery','cancellation','request','delivery','result','projection','request','result','projection']);
  expect(result).toMatchObject({state:'terminal',terminal:false});expect(f.row?.fleetCancellation?.reason).toContain('three-hour deadline');
  expect(result).not.toHaveProperty('dispatchCompletion');
});

for (const state of ['queued', 'accepted'] as const) {
  test(`${state} observation exposes the retained executable digest without changing prepared identity or custody`, async () => {
    const f = fixture(), prepared = await f.prepareReserved(), executableDigest = 'c'.repeat(64);
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
  const prepared = await f.prepareReserved(), digest = prepared.inputSha256, frozen = structuredClone(f.row!.fleetSelection);
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
  const f=fixture(),prepared=await f.prepareReserved();expect(prepared).toMatchObject({state:'awaiting-runner',prepared:{requirements:{platform:'android',resources:[{kind:'phone',capabilities:[]},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']}]}}});
  const calls=f.sources;await f.service.submit(selection);expect(f.sources).toBe(calls);expect(f.resolves).toBe(1);expect(f.row?.hostId).toBeUndefined();
  await expect(f.service.submit({...selection,source:{...source,buildRunId:56}})).rejects.toThrow('changed');
  await expect(f.service.prepared(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,routineSource:testRoutineSource(selection.routineRevision),definitionSha256:requestInputDigest({...definition,minimumRoutineApiVersion:2}),definition:{...definition,minimumRoutineApiVersion:2}})).rejects.toThrow();
});
test('a prepared request from before capacity admission retains its exact digest while the same policy gains a current claim', async () => {
  const f=fixture(); await f.prepareReserved();
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
  const f=fixture(), prepared=await f.prepareReserved(), time=Date.parse('2026-10-08T00:00:00Z');
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
  const f=fixture(),prepared=await f.prepareReserved(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  const attempts=await Promise.allSettled([f.service.bind(selection.requestId,'mini',input),f.service.bind(selection.requestId,'air',{...input,actionsRunId:'11',actionsJobId:'21'})]);
  const bindings=attempts.flatMap(value=>value.status==='fulfilled'?[value.value]:[]);
  expect(bindings.filter(value=>value.execute)).toHaveLength(1);expect(f.row?.hostId).toBe('mini');
  const winner=bindings.find(value=>value.execute)!;const repeated=await f.service.bind(selection.requestId,winner.binding.hostId,{...input,actionsRunId:winner.binding.actionsRunId,actionsJobId:'99'});expect(repeated.execute).toBe(false);
});
test('descriptor/capability and target fences reject incompatible assignments before binding',async()=>{
  const f=fixture(),prepared=await f.prepareReserved(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  await expect(f.service.bind(selection.requestId,'mini',{...input,descriptorRevision:'f'.repeat(64)})).rejects.toThrow('descriptor');
  f.lane.resources.find(resource => resource.kind === 'network')!.capabilities=[];f.lane.descriptorRevision=routineLaneDescriptorRevision(f.lane);
  await expect(f.service.bind(selection.requestId,'mini',{...input,descriptorRevision:f.lane.descriptorRevision})).rejects.toThrow('compatible');expect(f.row?.fleetBinding).toBeUndefined();
});
test('bind checklist names the pre-reservation refusal without evaluating later checks', async () => {
  const f = fixture(), prepared = await f.prepareReserved(), before = structuredClone(f.row);
  const reserve = spyOn(f.rows, 'reserveResources'), bind = spyOn(f.rows, 'bind');
  try {
    const error = await f.service.bind(selection.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: f.lane.id,
      descriptorRevision: 'f'.repeat(64), actionsRunId: '10', actionsJobId: '20'}).catch(error => error);
    expect(error.diagnostics).toMatchObject({stage: 'before-reservation', hostId: 'mini', laneId: 'android'});
    expect(error.diagnostics.conditions.filter((condition: {status: string}) => condition.status === 'failed'))
      .toEqual([{id: 'reported-descriptor', status: 'failed', expected: `Runner descriptor: ${'f'.repeat(64)}`, observed: f.lane.descriptorRevision}]);
    expect(error.diagnostics.conditions.slice(-3).map((condition: {status: string}) => condition.status)).toEqual(['not-evaluated', 'not-evaluated', 'not-evaluated']);
    expect(reserve).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled(); expect(f.row).toEqual(before);
  } finally {reserve.mockRestore(); bind.mockRestore();}
});
test('bind checklist separates a changed post-reservation lane while retaining original custody', async () => {
  const f = fixture(), prepared = await f.prepareReserved(), hosts = (f.service as any).hosts;
  const original = await hosts.get('mini'), changed = structuredClone(original); changed.lanes[0].dispatchMode = 'manual';
  const get = spyOn(hosts, 'get').mockResolvedValueOnce(original).mockResolvedValueOnce(changed),
    reserve = spyOn(f.rows, 'reserveResources'), bind = spyOn(f.rows, 'bind'), claim = structuredClone(f.row!.fleetResourceReservation);
  try {
    const error = await f.service.bind(selection.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: f.lane.id,
      descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'}).catch(error => error);
    expect(error.diagnostics).toMatchObject({stage: 'after-reservation'});
    expect(error.diagnostics.conditions.find((condition: {status: string}) => condition.status === 'failed'))
      .toMatchObject({id: 'lane-automatic', observed: 'manual'});
    expect(reserve).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(2); expect(bind).not.toHaveBeenCalled();
    expect(f.row!.fleetResourceReservation).toEqual(claim); expect(f.row!.fleetBinding).toBeUndefined();
  } finally {get.mockRestore(); reserve.mockRestore(); bind.mockRestore();}
});
test('bind checklist reuses the exact resource blocker rather than treating own claims as unavailable', async () => {
  for (const foreign of [false, true]) {
    const f = fixture(), prepared = await f.prepareReserved(), host = await (f.service as any).hosts.get('mini');
    host.authorityReservations = foreign ? [{kind:'exclusive',id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',resourceId:f.lane.resources[0]!.id,authorityHostId:'mini',borrowerHostId:'mini',laneId:'android',operationId:'run:foreign-original',intentSha256:'a'.repeat(64),inputSha256:'f'.repeat(64),owner:{kind:'run',id:'foreign-original'},controllerIncarnation:'mini-process',controllerGeneration:1,borrowerSequence:1,reservedAt:new Date().toISOString()}] : [{...f.row!.fleetResourceReservation!}];
    f.offer([host]);
    const result = await f.service.bind(selection.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: f.lane.id,
      descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'}).catch(error => error);
    if (foreign) {
      expect(result.diagnostics.conditions.find((condition: {status: string}) => condition.status === 'failed'))
        .toMatchObject({id: 'resource-state', observed: {code: 'resource-owned', resourceId: f.lane.resources[0]!.id}});
      expect(f.row!.fleetBinding).toBeUndefined(); expect(host.authorityReservations[0].owner.id).toBe('foreign-original');
    } else {expect(result.execute).toBe(true); expect(f.row!.fleetBinding?.hostId).toBe('mini');}
  }
});
test('phone backend readiness capability cannot be supplied by the host uplink or an older phone provider', async () => {
  const f = fixture({...definition, resourceRequirements: definition.resourceRequirements.map(resource =>
    resource.kind === 'phone' ? {...resource, capabilities: ['backend-connectivity']} : resource)});
  const waiting = await f.prepareReserved();
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
  const prepared = await f.prepareReserved(), frozen = structuredClone(f.row!.fleetPreparation);
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
  const f=fixture(),prepared=await f.prepareReserved();await f.service.cancel(selection.requestId,{reason:'Cancel before runner'});
  const input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
  await expect(f.service.bind(selection.requestId,'mini',input)).rejects.toThrow('Cancelled');expect(await f.service.observation(selection.requestId)).toMatchObject({terminal:true,terminalStatus:'not-run',waitingReason:'Cancel before runner'});
  const expired=fixture(),before=await expired.prepare();expired.advance(3*3600_000);
  await expect(expired.service.bind(selection.requestId,'mini',{...input,inputSha256:before.inputSha256})).rejects.toThrow('expired');expect(await expired.service.observation(selection.requestId)).toMatchObject({terminal:true,waitingReason:expect.stringContaining('deadline')});
});
test('Mongo bind predicate guards absent host/binding, uncancelled prepared identity and deadline in one write',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=f.row!,write=TestRequestModel.collection.findOneAndUpdate;
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
  const f=fixture(),prepared=await f.prepareReserved(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'};
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
  const f=fixture(),prepared=await f.prepareReserved(),input={inputSha256:prepared.inputSha256,laneId:f.lane.id,
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
  const f=fixture(),prepared=await f.prepareReserved();
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

test('frozen admission acknowledges its durable original before the existing tick delivers it', async () => {
  let discoveries = 0, dispatches = 0;
  const f = fixture(definition, {async runs() {discoveries++; return dispatches ? [{actionsRunId: '10', status: 'queued', conclusion: null}] : [];},
    async dispatch() {dispatches++;}, async cancel() {}});
  const frozen = await f.service.freezeSelection(selection), deadline = '2026-10-08T03:00:00.000Z', target = {hostId: 'mini', laneId: 'android'};
  const admitted = await f.service.submitFrozen(frozen, deadline, target);
  expect(admitted).toMatchObject({state: 'awaiting-source', fleetSelection: frozen, fleetSelectionSha256: requestInputDigest(frozen), fleetTarget: target});
  expect(admitted.fleetDeadline.toISOString()).toBe(deadline);
  expect(admitted.fleetDispatch).toBeUndefined(); expect(discoveries).toBe(0); expect(dispatches).toBe(0);
  f.rows.pending = async () => [structuredClone(f.row!)];
  await f.service.reconcilePending();
  expect(f.row?.fleetDispatch?.acknowledgedAt).toBeDefined(); expect(dispatches).toBe(1);
  await f.service.submitFrozen(frozen, deadline, target);
  expect(discoveries).toBe(0); expect(dispatches).toBe(1);
  f.advance(30_001); await f.service.reconcilePending();
  expect(discoveries).toBeGreaterThan(0); expect(dispatches).toBe(1); expect(f.row?.fleetBinding).toBeUndefined();
  expect(f.row?.fleetSelection).toEqual(frozen); expect(f.row?.fleetDeadline.toISOString()).toBe(deadline);
});


test('Actions registration after cancellation cancels the late workflow without creating a binding',async()=>{
  const f=fixture(),prepared=await f.prepareReserved(),cancelled:string[]=[];
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
 const f=fixture(),prepared=await f.prepareReserved(),cancelled:unknown[][]=[];let dispatches=0;
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
  const f=fixture(),prepared=await f.prepareReserved();
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
  const f=fixture(),prepared=await f.prepareReserved();
  const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
  (f.service as any).requests={async cancel(){return f.row}};
  await f.service.bind(selection.requestId,'mini',{inputSha256:prepared.inputSha256,laneId:f.lane.id,descriptorRevision:f.lane.descriptorRevision!,actionsRunId:'10',actionsJobId:'20'});
  f.accepted('c'.repeat(64));await f.service.complete(selection.requestId,'mini',{inputSha256:'c'.repeat(64),disposition:'repair',completedAt:'2026-10-08T00:01:00Z'});
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'accepted',terminal:false});
  await f.service.cancel(selection.requestId,{reason:'Cancel settled custody'});
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'terminal',terminal:true,terminalStatus:'cancelled'});
});


test('deadline cancels an Actions observer still awaiting cleanup after result publication',async()=>{
  const f=fixture(),prepared=await f.prepareReserved(),cancelled:string[]=[];
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
 const prepared=await f.prepareReserved();const {TestRunError}=await import('./test-result-error');(f.service as any).results={async detail(){throw new TestRunError(404,'missing')}};
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
async function publicationFixture(){const f=fixture(),p=await f.prepareReserved();await f.service.bind(selection.requestId,'mini',{
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
  expect(await f.service.observation(selection.requestId)).toMatchObject({state:'awaiting-source',waitingReason:'Routine files could not be downloaded. Tests did not start. Retrying the same request.'})
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
test('a prepared original job retries beyond twenty completed deliveries without replacing its inputs or custody', async () => {
 const f=fixture();await f.prepareReserved();const original=structuredClone(f.row!);
 const target={repository:'Mentra-Community/Mentra' as const,ref:'refs/heads/dev' as const,sourceRoot:'testing/' as const,workflow:'Mentra-Community/Mentra/.github/workflows/routine-device.yml@refs/heads/dev' as const};
 const receipt={attempts:20,firstAttemptAt:'2026-10-07T23:00:00.000Z',lastAttemptAt:'2026-10-07T23:59:00.000Z',acknowledgedAt:'2026-10-07T23:59:01.000Z',target};
 const history=Array.from({length:20},(_,n)=>({actionsRunId:String(n+1),recordedAt:'2026-10-07T23:59:01.000Z'}));f.restore({...original,fleetDispatch:receipt,fleetActions:history});
 let calls=0;let runs=history.map(v=>({...v,status:'completed',conclusion:'failure' as string|null}));
 (f.service as any).actionsTransport={async dispatch(id:string,value:unknown){expect(id).toBe(original.requestId);expect(value).toEqual(target);calls++},async runs(){return runs},async cancel(){}};
 await (f.service as any).deliver(f.row!);expect(calls).toBe(1);expect(f.row?.fleetDispatch).toMatchObject({attempts:21,firstAttemptAt:receipt.firstAttemptAt,target});
 for(const key of ['fleetSelection','fleetSelectionSha256','fleetInputSha256','fleetDeadline','fleetResourceReservation','fleetResourceAdmission','fleetCandidatePreparations'] as const)expect(f.row?.[key]).toEqual(original[key]);
 expect(typeof f.row?.fleetDispatch?.acknowledgedAt).toBe('string');expect(f.row?.fleetActions).toEqual(history);expect(f.row?.fleetBinding).toBeUndefined();
 f.advance(30_001);runs=[...runs,{actionsRunId:'21',recordedAt:'2026-10-08T00:00:00.000Z',status:'queued',conclusion:null}];await (f.service as any).deliver(f.row!);expect(calls).toBe(1);expect(f.row?.fleetActions).toHaveLength(21);
 f.restore({...f.row!,fleetCancellation:{requestedAt:'2026-10-08T00:00:00Z',reason:'original cancellation'}});f.advance(30_001);await (f.service as any).deliver(f.row!);expect(calls).toBe(1);
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

test('delivery history retains the twenty-first exact workflow and pending reconciliation has only temporal limits', async () => {
 const write=TestRequestModel.findOneAndUpdate,find=TestRequestModel.find;
 const cas=mock((_filter:any,_update:any,_options:any)=>({lean:async()=>null}));TestRequestModel.findOneAndUpdate=cas as any;
 const query=mock((_filter:any)=>{const chain:any={sort:()=>chain,limit:()=>chain,read:()=>chain,readConcern:()=>chain,lean:async()=>[]};return chain});TestRequestModel.find=query as any;
 try {
  await routineJobRepository.actions!('job-one','a'.repeat(64),{actionsRunId:'21',recordedAt:'2026-10-08T00:00:00Z'});
  expect(cas.mock.calls[0]![0]).toEqual({requestId:'job-one',$or:[{fleetInputSha256:'a'.repeat(64)},{fleetSelectionSha256:'a'.repeat(64)}],'fleetActions.actionsRunId':{$ne:'21'}});
  expect(cas.mock.calls[0]![1]).toEqual({$push:{fleetActions:{actionsRunId:'21',recordedAt:'2026-10-08T00:00:00Z'}}});
  await routineJobRepository.pending!(20,new Date('2026-10-08T00:00:00Z'));const filter=query.mock.calls[0]![0],text=JSON.stringify(filter);
  expect(text).not.toContain('fleetDispatch.attempts');expect(text).toContain('fleetDeadline');expect(text).toContain('fleetBinding');expect(text).toContain('2026-10-07T23:59:30.000Z');expect(text).toContain('fleetCancellation');
 }finally{TestRequestModel.findOneAndUpdate=write;TestRequestModel.find=find}
});

test('frozen Android admissions cannot bypass an exact iOS-only declaration', async () => {
 const f=fixture(),known=await f.service.freezeSelection(selection);
 (f.service as any).definitions={async getExact(_id:string,platform:string){return platform==='ios-on-mac'?{definition:{platforms:['ios-on-mac']}}:null}};
 await expect(f.service.submitFrozen(known,'2026-10-08T01:00:00Z')).rejects.toThrow('does not support android');expect(f.row).toBeNull();
});
test('unprepared repeated delivery remains deadline-bound rather than terminalizing from its counter', async () => {
 const f=fixture();await f.service.submit(selection);let calls=0;
 await f.rows.dispatch!(selection.requestId,undefined,{attempts:20,firstAttemptAt:'2026-10-07T23:00:00.000Z',lastAttemptAt:'2026-10-07T23:59:00.000Z',acknowledgedAt:'2026-10-07T23:59:01.000Z'});
 (f.service as any).actionsTransport={async dispatch(){calls++},async runs(){return []},async cancel(){}};
 f.advance(61_000);await (f.service as any).deliver(f.row!);expect(calls).toBe(1);expect(f.row).toMatchObject({state:'awaiting-source',fleetDispatch:{attempts:21}});expect(f.row?.fleetCancellation).toBeUndefined();
 f.advance(3*3600_000);await (f.service as any).deliver(f.row!);expect(calls).toBe(1);
});

test('permanent preparation reports use the settled fence consumed by rerun readers', async () => {
 const f=fixture();await f.service.submit(selection);await f.service.actions(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'100'});
 await f.service.preparationStatus(selection.requestId,{inputSha256:f.row!.fleetSelectionSha256,actionsRunId:'100',phase:'routine description',code:'not-applicable',retryable:false});
 const {TestRerunService}=await import('./test-rerun.service');
 const reruns=new TestRerunService(undefined,undefined,undefined,{async get(){return f.row as any},async prepare(){throw Error('No admission')}});
 const attempt=await (reruns as any).requestAttempt(selection.requestId,{parent:{kind:'request',requestId:selection.requestId},memberId:selection.requestId,attemptNumber:1,attemptId:'attempt'});
 expect(attempt).toMatchObject({status:'not-run',publicationComplete:false,reason:'Routine new-routine does not support android.'});
});


test('APP permission is checked after owned install rather than requiring an earlier job grant to bind', async () => {
  const selected = {...definition, resourceRequirements: definition.resourceRequirements.map(resource => resource.kind === 'app'
    ? {...resource, permissions: [{permission: 'camera', recipient: 'app'}]} : resource)};
  const f = fixture(selected), prepared = await f.prepareReserved(), frozen = structuredClone(f.row), time = Date.parse('2026-10-08T00:00:00Z');
  const binding = {version: 938, revision: 'a'.repeat(40), installationId: 'accepted', configurationSha256: 'b'.repeat(64),
    runtimeSha256: 'c'.repeat(64), routineApiVersion: 111, publicApiSha256: 'd'.repeat(64)};
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
  expect(f.row).toEqual(frozen);
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
  const prepared = await f.prepareReserved();
  expect(prepared).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}});
  const original = structuredClone(f.row);
  f.offer([{...free, authorityReservations: [routingClaim('mini', 'android', 'another-original')]}, {...busy, authorityReservations: []}]);
  expect(await f.service.preparation(selection.requestId)).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}});
  expect(f.row).toEqual(original);
});

test('an unclaimed admission interrupted before its byte receipt selects an available alternative', async () => {
  const f = fixture(), prepared = await f.prepareReserved(), original = structuredClone(f.row!);
  const {fleetResourceReservation: _, ...withoutByteReceipt} = original;
  const intent = {operationId: `run:${selection.requestId}`, hostId: 'mini', laneId: 'android', inputSha256: prepared.inputSha256,
    owner: {id: selection.requestId, kind: 'run' as const}, resources: [{id: 'app:android', capabilities: []}],
    controller: {incarnation: 'one', generation: 1, sequence: 1}};
  f.restore({...withoutByteReceipt, fleetResourceAdmission: {intent, dependencies: []}});
  const now = '2026-10-08T00:00:00.000Z', base = {incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: now, receivedAt: now, lanes: [f.lane]};
  f.offer([{...base, hostId: 'mini', authorityReservations: [routingClaim('mini', 'android', 'other-claim')]}, {...base, hostId: 'air1'}]);
  expect(await f.service.preparation(selection.requestId)).toMatchObject({resourceTarget:{hostId:'air1',laneId:'android'}});
  expect(f.row!.fleetInputSha256).toBe(prepared.inputSha256);
  expect(f.row!.fleetResourceReservation?.hostId).toBe('air1');
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
  expect(await f.prepareReserved()).toMatchObject({resourceTarget: {hostId: 'mini', laneId: 'android'}});
  expect(calls).toEqual([['air1', 'mini']]);
  const original = structuredClone(f.row!);
  const {fleetResourceReservation: _, ...withoutReceipt} = original;
  const targeted = {...withoutReceipt, fleetTarget: {hostId: 'air1', laneId: 'android'}};
  f.restore({...targeted, fleetInputSha256: routineJobInputDigest(targeted)});
  expect(await f.service.preparation(selection.requestId)).toMatchObject({resourceTarget: {hostId: 'air1', laneId: 'android'}});
});

test('offline lost-claim response and restart route only the original provisional phone lane', async () => {
  for (const repositoryProof of [true, false]) {
    const f = fixture(); await f.prepareReserved()
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
    const f = fixture(); await f.prepareReserved(); const original = structuredClone(f.row!), claim = original.fleetResourceReservation!
    delete original.fleetResourceReservation; f.restore(original)
    f.rows.recorderClaims = async () => duplicate ? [claim, {...claim, hostId: 'air1'}] : [{...claim, fleetInputSha256: 'f'.repeat(64)}]
    let attempted = 0; f.rows.reserveResources = async () => {attempted++; throw Error('Ambiguous custody cannot reserve')}
    expect((await f.service.preparation(original.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT)
    expect(attempted).toBe(0); expect(f.row).toEqual(original)
  }
})

/** Real selection/reservation/binding with only the Mongo collection boundary replaced. */
async function withLocalResources(body: (f: ReturnType<typeof fixture>, hosts: Map<string, any>, counters: {host: number; request: number}, pastRows: Map<string, StoredRoutineJob>) => Promise<void>, extraKinds: ('audio'|'browser'|'fixture-data')[] = [], backendConnectivity = false, models = ['mentra-live'], jobSelection: typeof selection = selection) {
 const now=Date.now(),at=new Date(now).toISOString(),f=fixture({...definition,
   resourceRequirements:[...definition.resourceRequirements.map(resource=>backendConnectivity&&resource.kind==='phone'?{...resource,capabilities:['backend-connectivity']}:resource),{kind:'glasses',capabilities:['connection']},...extraKinds.map(kind=>({kind,capabilities:[]}))],glasses:{models},
   fixtures:extraKinds.includes('fixture-data')?[{provider:'synthetic',description:'Independent synthetic fixture'}]:[],
   execution:{resourceKinds:['phone','app','recorder','network','glasses',...extraKinds],policy:{estimatedOutputBytes:1024**3}}}, null, jobSelection);
 f.advance(now-Date.parse('2026-10-08T00:00:00Z'));
 const hosts=new Map<string,any>();
 for(const hostId of ['mini','air1']) {
  const lane:ReceivedTestHostState['lanes'][number]={...structuredClone(f.lane),resources:[...structuredClone(f.lane.resources),{id:'live-local',kind:'glasses' as const,capabilities:['connection']},...extraKinds.map(kind=>({id:`local-${kind}`,kind,capabilities:[]}))],
   glasses:[{resourceId:'live-local',deviceId:`synthetic-live-${hostId}`,model:'mentra-live',capabilities:['connection']}]};
  lane.resources=lane.resources.map(resource=>({...resource,id:`${hostId}:${resource.id}`,
   ...(backendConnectivity&&resource.kind==='phone'?{capabilities:['backend-connectivity']}:{}),
   ...(resource.storage?{storage:{...resource.storage,poolId:`${hostId}:disk:1`,observedAt:at}}:{}),
   idleContract:{version:'synthetic-baseline',maximumAgeMs:120000,qualifiedScope:{kind:'same-controller' as const,controllerId:hostId},conditions:['synthetic-condition'],repairConfigured:true}}));
  lane.glasses![0]!.resourceId=`${hostId}:live-local`;lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  const subjects=lane.resources.map(resource=>resourceLifecycleSubjectSchema.parse({subject:{kind:'resource',id:resource.id,authorityHostId:hostId},generation:7,status:'idle',observedAt:at,receivedAt:null,current:true,reason:null,owner:null,
   idle:{contractVersion:'synthetic-baseline',outcome:'passed',checkedAt:at,acceptedCheck:{operationId:`check:${resource.id}`,subjectGeneration:7,resultSha256:'a'.repeat(64),acceptedAt:at},qualifiedScope:resource.idleContract!.qualifiedScope,evidenceRefs:[]},
   repair:{configured:true,state:'none'},supportedActions:['reserve','check','mark-out-of-service'],resource:{kind:resource.kind,capabilities:resource.capabilities??[],memberships:[{hostId,laneId:lane.id}],dependencies:[],placement:'installed'}}));
  const snapshot=hostStateSchema.parse({hostId,incarnation:`${hostId}:original`,incarnationGeneration:1,sequence:1,observedAt:at,frameworkBinding:testFrameworkBinding(),frameworkAcceptedAt:at,frameworkProcess:{pid:100,startedAt:'software-current-controller'},
   laneControls:{schemaVersion:1,receipts:[],resourceControls:true},resourceLifecycle:{schemaVersion:1,subjects,history:[]},lanes:[lane]});
  hosts.set(hostId,{hostId,incarnation:snapshot.incarnation,incarnationGeneration:1,sequence:1,receivedAt:new Date(now),resourceReservationVersion:0,resourceReservations:[],laneControlVersion:0,laneControls:[],snapshot});
 }
 const project=()=>[...hosts.values()].map(h=>({...structuredClone(h.snapshot),receivedAt:h.receivedAt.toISOString(),authorityReservations:structuredClone(h.resourceReservations),resourceControlRecords:structuredClone(h.laneControls),resourceLifecycleCursor:structuredClone(h.resourceLifecycleCursor)}));
 (f.service as any).hosts={async get(id:string){return project().find(h=>h.hostId===id)??null},async list(){return project()}};
 const originals={find:TestRequestModel.collection.find,read:TestRequestModel.collection.findOne,write:TestRequestModel.collection.findOneAndUpdate,
  hostRead:TestHostStateModel.collection.findOne,hostWrite:TestHostStateModel.collection.findOneAndUpdate,get:resourceReservationRepository.get,request:resourceReservationRepository.request,claimed:resourceReservationRepository.claimedHosts,recorderClaims:resourceReservationRepository.recorderClaims,replace:resourceReservationRepository.replace};
 const counters={host:0,request:0},pastRows=new Map<string,StoredRoutineJob>();
 const matches=(row:any,filter:any)=>Boolean(row)&&Object.entries(filter).every(([key,guard])=>{
  const value=key.split('.').reduce((value:any,key)=>value?.[key],row);
  if(guard&&typeof guard==='object'&&'$exists' in guard)return (value!==undefined)===(guard as any).$exists;
  if(guard&&typeof guard==='object'&&'$gt' in guard)return value>(guard as any).$gt;
  return isDeepStrictEqual(value,guard);
 });
 type Session={base:StoredRoutineJob|null;row:StoredRoutineJob|null;hosts:Map<string,any>;baseHosts:Map<string,any>;writes:{host:number;request:number};writtenHosts:Set<string>;withTransaction(callback:()=>Promise<void>):Promise<void>;endSession():Promise<void>};
 const sessions=spyOn(TestHostStateModel.db,'startSession').mockImplementation((async()=>{
  const session:Session={base:null,row:null,hosts:new Map(),baseHosts:new Map(),writes:{host:0,request:0},writtenHosts:new Set(),
   async withTransaction(callback){
    for(let attempt=0;attempt<10;attempt++){
     session.base=structuredClone(f.row);session.row=structuredClone(f.row);
     session.baseHosts=new Map([...hosts].map(([id,host])=>[id,structuredClone(host)]));
     session.hosts=new Map([...hosts].map(([id,host])=>[id,structuredClone(host)]));session.writes={host:0,request:0};session.writtenHosts=new Set();
     await callback();
     if(!isDeepStrictEqual(f.row,session.base)||[...session.writtenHosts].some(id=>!isDeepStrictEqual(hosts.get(id),session.baseHosts.get(id))))continue;
     if(session.writes.request&&session.row)f.restore(session.row);
     for(const id of session.writtenHosts)Object.assign(hosts.get(id),structuredClone(session.hosts.get(id)));
     counters.host+=session.writes.host;counters.request+=session.writes.request;return;
    }
    throw Error('Test transaction exceeded write-conflict retries');
   },async endSession(){}};
  return session;
 }) as any);
 TestRequestModel.collection.find=((filter:any)=>({limit(n:number){expect(n).toBe(1001);expect(filter.requestId.$in.length).toBeLessThanOrEqual(1000);return {async toArray(){return filter.requestId.$in.flatMap((id:string)=>{const row=id===jobSelection.requestId?f.row:pastRows.get(id);return row?[structuredClone(row)]:[]})}}}})) as any;
 TestRequestModel.collection.findOne=(async(filter:any)=>{expect(filter.requestId).toBe(jobSelection.requestId);return structuredClone(f.row)}) as any;
 TestRequestModel.collection.findOneAndUpdate=(async(filter:any,update:any,options:any={})=>{const session=options.session as Session|undefined,row=session?session.row:f.row;
  if(!matches(row,filter))return null;
  const next={...row,...structuredClone(update.$set)};for(const key of Object.keys(update.$unset??{}))delete (next as any)[key];
  if(session){session.writes.request++;session.row=next as StoredRoutineJob;}else{counters.request++;f.restore(next as StoredRoutineJob);}
  return structuredClone(next)}) as any;
 TestHostStateModel.collection.findOne=(async(filter:any)=>structuredClone(hosts.get(filter.hostId))) as any;
 TestHostStateModel.collection.findOneAndUpdate=(async(filter:any,update:any,options:any={})=>{const session=options.session as Session|undefined,h=(session?session.hosts:hosts).get(filter.hostId);
  if(!matches(h,filter))return null;
  if(session){session.writes.host++;session.writtenHosts.add(filter.hostId);}else counters.host++;
  Object.assign(h,structuredClone(update.$set));h.resourceReservationVersion++;return structuredClone(h)}) as any;
 resourceReservationRepository.get=async id=>structuredClone(hosts.get(id)??null);
 resourceReservationRepository.replace=async(previous,claims)=>{const h=hosts.get(previous.hostId);if(previous.sequence!==h.sequence||previous.laneControlVersion!==h.laneControlVersion||previous.resourceReservationVersion!==h.resourceReservationVersion)return false;
  expect(claims.every(claim=>h.resourceReservations.some((original:any)=>requestInputDigest(original)===requestInputDigest(claim)))).toBe(true);h.resourceReservations=structuredClone(claims);h.resourceReservationVersion++;return true;};
 resourceReservationRepository.request=async()=>structuredClone(f.row);
 resourceReservationRepository.claimedHosts=async()=>[...hosts.values()].filter(h=>h.resourceReservations?.some((claim:any)=>claim.kind==='exclusive'&&claim.owner.kind==='run'&&claim.owner.id===jobSelection.requestId&&claim.origin?.kind==='fleet')).map(h=>structuredClone(h));
 resourceReservationRepository.recorderClaims=async()=>[...hosts.values()].flatMap(h=>structuredClone(h.resourceReservations)).filter((claim:any)=>claim.requestId===jobSelection.requestId);
 f.rows.reconcileRecorderHost=(...args)=>routineJobRepository.reconcileRecorderHost!.apply(routineJobRepository,args);
 f.rows.releaseUnusedPreparation=(...args)=>routineJobRepository.releaseUnusedPreparation!.apply(routineJobRepository,args);
 f.rows.reserveResources=(...args)=>routineJobRepository.reserveResources!.apply(routineJobRepository,args);
 f.rows.bind=(...args)=>routineJobRepository.bind.apply(routineJobRepository,args);
 f.rows.recorderClaims=(...args)=>resourceReservationRepository.recorderClaims!.apply(resourceReservationRepository,args);
 f.rows.claimedHosts=(...args)=>resourceReservationRepository.claimedHosts!.apply(resourceReservationRepository,args);
 const clock=spyOn(Date,'now').mockReturnValue(now);
 try {await body(f,hosts,counters,pastRows)} finally {clock.mockRestore();sessions.mockRestore();TestRequestModel.collection.find=originals.find;TestRequestModel.collection.findOne=originals.read;TestRequestModel.collection.findOneAndUpdate=originals.write;
  TestHostStateModel.collection.findOne=originals.hostRead;TestHostStateModel.collection.findOneAndUpdate=originals.hostWrite;resourceReservationRepository.get=originals.get;resourceReservationRepository.request=originals.request;resourceReservationRepository.claimedHosts=originals.claimed;resourceReservationRepository.recorderClaims=originals.recorderClaims;resourceReservationRepository.replace=originals.replace;}
}
function unavailableLocal(host:any,status:'unknown'|'out-of-service'|'reserved'|'in-repair'|'offline',kind='glasses') {
 const subject=host.snapshot.resourceLifecycle.subjects.find((value:any)=>value.resource.kind===kind);subject.status=status;
 subject.idle.outcome='not-checked';subject.idle.acceptedCheck=null;
 if(status==='reserved')subject.owner={id:'manual-original',kind:'authoring',generation:7,hostId:host.hostId};
 if(status==='in-repair')subject.repair.state='queued';
 return subject;
}
for(const failure of ['before-commit','lost-committed-reply'] as const)test(`current Android admission recovers its same original after ${failure} without candidate history`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const hostWrite=TestHostStateModel.collection.findOneAndUpdate,start=TestHostStateModel.db.startSession;let failed=false;
  if(failure==='before-commit')TestHostStateModel.collection.findOneAndUpdate=(async(...args:any[])=>{const value=await hostWrite.apply(TestHostStateModel.collection,args as never);if(!failed){failed=true;throw Error('Original transaction host reply failed')}return value}) as any;
  else TestHostStateModel.db.startSession=(async()=>{const session=await start.call(TestHostStateModel.db),end=session.endSession.bind(session);session.endSession=async()=>{await end();if(!failed){failed=true;throw Error('Original committed transaction reply lost')}};return session}) as any;
  try {await expect(f.prepareReserved()).rejects.toThrow('Original')}finally{TestHostStateModel.collection.findOneAndUpdate=hostWrite;TestHostStateModel.db.startSession=start;}
  const original=structuredClone(f.row!),claimed=[...hosts.values()].find(h=>h.resourceReservations.length),before={...counters};
  if(failure==='before-commit'){expect(claimed).toBeUndefined();expect(original.fleetResourceReservation).toBeUndefined();expect(original.fleetResourceAdmission).toBeUndefined();expect(counters).toEqual({host:0,request:0})}
  else{expect(claimed.resourceReservations).toEqual([original.fleetResourceReservation]);expect(original.fleetResourceAdmission!.intent.hostId).toBe(claimed.hostId);expect(counters).toEqual({host:1,request:1})}
  const resumed=await f.reservePrepared(),target=(resumed as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget;
  expect(resumed.waitingReason).toBeUndefined();expect(target).toBeDefined();expect(f.row!.fleetResourceReservation!.hostId).toBe(target.hostId);
  if(failure==='lost-committed-reply'){expect(target.hostId).toBe(claimed.hostId);expect(counters).toEqual(before)}
  for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);
  const h=hosts.get(target.hostId),lane=h.snapshot.lanes[0],bound=await f.service.bind(selection.requestId,h.hostId,{inputSha256:resumed.inputSha256,laneId:lane.id,descriptorRevision:lane.descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
  expect(bound.binding.hostId).toBe(h.hostId);expect(f.row!.state).toBe('preparing');expect([...hosts.values()].filter(other=>other!==h).every(other=>other.resourceReservations.length===0)).toBe(true);
 },[],true);
});
test('a current phone repair refuses an acquired Android admission without changing its original custody',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string}}).resourceTarget,claimed=hosts.get(target.hostId),original=structuredClone(f.row!),claims=structuredClone(claimed.resourceReservations),before={...counters};
  unavailableLocal(claimed,'in-repair','phone');
  expect((await f.service.preparation(selection.requestId)).waitingReason).toBeDefined();expect(f.row).toEqual(original);expect(claimed.resourceReservations).toEqual(claims);expect(counters).toEqual(before);
  expect([...hosts.values()].filter(h=>h!==claimed).every(h=>h.resourceReservations.length===0)).toBe(true);
 },[],true);
});
for(const status of ['unknown','out-of-service','reserved','in-repair','offline'] as const)test(`local ${status} glasses are excluded before real assignment and the SAME job uses a ready alternate`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  unavailableLocal(hosts.get('mini'),status);const prepared=await f.prepareReserved(),original=structuredClone(f.row!);
  expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toEqual({hostId:'air1',laneId:'android'});expect(f.row!.fleetResourceReservation!.hostId).toBe('air1');
  expect(hosts.get('mini').resourceReservations).toEqual([]);expect(counters.host).toBe(1);
  const lane=hosts.get('air1').snapshot.lanes[0],result=await f.service.bind(selection.requestId,'air1',{inputSha256:prepared.inputSha256,laneId:lane.id,descriptorRevision:lane.descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
  expect(result.binding.hostId).toBe('air1');expect(f.row!.state).toBe('preparing');
  for(const key of ['requestId','fleetSelection','fleetInputSha256','fleetPreparation','fleetDeadline'] as const)expect(f.row![key]).toEqual(original[key]);
 });
});
test('offline phone with no ready alternate remains unassigned without a claim or native execution',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  for(const h of hosts.values())unavailableLocal(h,'offline','phone');const prepared=await f.prepareReserved();
  expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toBeUndefined();expect(prepared.waitingReason).toBeDefined();expect(f.row!.state).toBe('awaiting-runner');
  expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(f.row!.fleetBinding).toBeUndefined();expect(counters).toEqual({host:0,request:0});
 });
});
test('a manual withdrawal after recorder claim fences binding and retains the original claim without fallback',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const prepared=await f.prepareReserved(),target=(prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget!,h=hosts.get(target.hostId),original=structuredClone(f.row!),lane=h.snapshot.lanes[0];
  h.laneControlVersion++;const subject=unavailableLocal(h,'out-of-service');h.resourceLifecycleCursor=structuredClone(h.snapshot.resourceLifecycle);
  h.laneControls=[{command:{operationId:'84e9ad37-18e0-4dba-b0f8-f10b624b1282',hostId:h.hostId,operatorId:'a'.repeat(64),expiresAt:h.receivedAt.getTime()+60000,
   action:'mark-out-of-service',reason:'Synthetic withdrawal during assignment',subject:{resourceId:subject.subject.id,subjectGeneration:7}}}];
  await expect(f.service.bind(selection.requestId,h.hostId,{inputSha256:prepared.inputSha256,laneId:lane.id,descriptorRevision:lane.descriptorRevision,actionsRunId:'10',actionsJobId:'20'})).rejects.toThrow('accepting');
  await f.service.preparation(selection.requestId);expect(f.row!.fleetResourceReservation).toEqual(original.fleetResourceReservation);expect(f.row!.fleetResourceAdmission).toEqual(original.fleetResourceAdmission);
  expect(f.row!.fleetBinding).toBeUndefined();expect([...hosts.values()].filter(host=>host.hostId!==h.hostId)[0].resourceReservations).toEqual([]);expect(counters.host).toBe(1);
 });
});
function changedCurrentCheck(host: any, observedAt: number) {
 unavailableLocal(host,'unknown');host.sequence++;host.snapshot.sequence=host.sequence;
 host.snapshot.observedAt=new Date(observedAt).toISOString();host.receivedAt=new Date(observedAt);
}
async function changedCheckRefusesBinding(host: any, row: StoredRoutineJob) {
 const resource=host.snapshot.lanes[0].resources.find((ref: any)=>ref.kind==='glasses');
 expect(resourceAvailable({...host,resourceControlRecords:host.laneControls},resource.id,Date.now())).toBe(false);
 const binding={jobId:row.requestId,requestId:row.requestId,hostId:host.hostId,laneId:'android',
  descriptorRevision:host.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:new Date(Date.now()).toISOString()};
 expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,binding,{},new Date(Date.now()))).toBeNull();
}
test('current cursor and manual controls remain authoritative when a valid returned check ages',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const h=hosts.get('mini'),subject=h.snapshot.resourceLifecycle.subjects.find((s:any)=>s.resource.kind==='glasses'),at=h.receivedAt.getTime();
  const available=()=>resourceAvailable({...h,resourceControlRecords:h.laneControls},subject.subject.id,at);
  expect(available()).toBe(true);h.resourceLifecycleCursor=structuredClone(h.snapshot.resourceLifecycle);subject.generation=6;subject.idle.acceptedCheck.subjectGeneration=6;expect(available()).toBe(false);
  subject.generation=7;subject.idle.acceptedCheck.subjectGeneration=7;subject.idle.checkedAt=new Date(at-120001).toISOString();expect(available()).toBe(true);
  subject.idle.checkedAt=new Date(at).toISOString();subject.idle.qualifiedScope={kind:'same-controller',controllerId:'foreign'};expect(available()).toBe(false);
  subject.idle.qualifiedScope={kind:'same-controller',controllerId:h.hostId};subject.idle.acceptedCheck.acceptedAt=new Date(at+1).toISOString();expect(available()).toBe(false);
  subject.idle.acceptedCheck.acceptedAt=new Date(at).toISOString();h.snapshot.resourceLifecycle.subjects=[];expect(resourceAvailable({...h,resourceControlRecords:[]},subject.subject.id,at)).toBe(false);
  expect(f.row).toBeNull();
 });
});
for(const kind of ['phone','app','glasses','recorder','fixture-data','audio','browser'] as const)test(`required local ${kind} failure prevents real Core reservation while independent ready resources cannot cover it`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  for(const h of hosts.values())unavailableLocal(h,'in-repair',kind);const prepared=await f.prepareReserved();
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
  const prepared=await f.prepareReserved();expect((prepared as {resourceTarget?:unknown}).resourceTarget).toBeUndefined();expect(counters).toEqual({host:0,request:0});
 });
});
test('newly discovered original recorder custody prevents fallback after an unavailable snapshot',async()=>{
 await withLocalResources(async(f,hosts)=>{
  for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();const row=structuredClone(f.row!),at=hosts.get('mini').receivedAt.toISOString(),claim={id:'97b4d2e9-6a03-461e-a4a6-fd314a873619',requestId:row.requestId,fleetInputSha256:row.fleetInputSha256!,hostId:'mini',laneId:'android',poolId:'mini:disk:1',minimumAvailableBytes:1024,reservedAt:at};
  hosts.get('mini').resourceReservations=[claim];const blockers:unknown[]=[];
  expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'air1','android',new Date(at),(...args)=>blockers.push(args))).toBeNull();
  expect(blockers).toEqual([[RESOURCE_ADMISSION_WAIT,true]]);expect(hosts.get('mini').resourceReservations).toEqual([claim]);expect(hosts.get('air1').resourceReservations).toEqual([]);
  expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(f.row!.fleetBinding).toBeUndefined();
 });
});
test('ordinary Mac repository binding reads local readiness and refuses unavailable glasses',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';f.restore(row);h.snapshot.lanes[0].platform='ios-on-mac';
  unavailableLocal(h,'out-of-service');const before=structuredClone(h.resourceReservations);
  expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeNull();
  expect(f.row!.fleetBinding).toBeUndefined();expect(h.resourceReservations).toEqual(before);
 });
});
for(const timing of ['before-cas','after-cas','cancel-after-cas','lost-request-reply','aged-check','expired-deadline'] as const)test(`final admission ${timing} preserves the original target and exact claims`,async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),original=structuredClone(f.row!),claims=structuredClone(h.resourceReservations),at=h.receivedAt.getTime(),binding={jobId:original.requestId,requestId:original.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()};
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
  if(timing==='aged-check'||timing==='expired-deadline') {
   if(timing==='aged-check')for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
   TestRequestModel.collection.findOne=(async(filter:any,options:any)=>{const answer=await requestRead.call(TestRequestModel.collection,filter,options);if(++reads===2)spyOn(Date,'now').mockReturnValue(timing==='aged-check'?at+2:original.fleetDeadline.getTime()+1);return answer}) as any;
  }
  try {
   if(timing==='lost-request-reply') {
    await expect(routineJobRepository.bind(original.requestId,original.fleetInputSha256!,binding,{},h.receivedAt)).rejects.toThrow('reply lost');
    expect(f.row!.fleetBinding).toEqual(binding);const after=await f.service.bind(original.requestId,h.hostId,{inputSha256:original.fleetInputSha256!,laneId:'android',descriptorRevision:binding.descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
    expect(after.binding).toEqual(binding);expect(casAccepted).toBe(1);
   }else{
    const answer=await routineJobRepository.bind(original.requestId,original.fleetInputSha256!,binding,{},h.receivedAt);
    if(timing==='after-cas'||timing==='aged-check'){expect(answer?.fleetBinding).toEqual(binding);expect(casAccepted).toBe(1)}else{expect(answer).toBeNull();expect(f.row!.fleetBinding).toBeUndefined();expect(casAccepted).toBe(timing==='cancel-after-cas'?1:0)}
   }
   expect(h.resourceReservations).toEqual(claims);expect(f.row!.fleetResourceReservation).toEqual(original.fleetResourceReservation);expect(f.row!.fleetResourceAdmission).toEqual(original.fleetResourceAdmission);
   expect(hosts.get(h.hostId==='mini'?'air1':'mini').resourceReservations).toEqual([]);
   if(timing==='aged-check'||timing==='expired-deadline')expect(casAttempts).toBe(timing==='aged-check'?1:0);
  }finally{resourceReservationRepository.replace=replace;TestRequestModel.collection.findOneAndUpdate=requestWrite;TestRequestModel.collection.findOne=requestRead;mock.restore()}
 });
});
test('a failed final host CAS retries only the same original claim without allocating an alternate',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),binding={jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()},replace=resourceReservationRepository.replace;
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
  h.resourceReservations=[claim];await f.prepareReserved();const original=structuredClone(f.row!);f.restore({...original,fleetResourceReservation:undefined,fleetResourceAdmission:undefined});
  const waiting:unknown[]=[];expect(await routineJobRepository.reserveResources!(original.requestId,original.fleetInputSha256!,'mini','android',new Date(at),(...args)=>waiting.push(args))).toBeNull();
  expect(waiting).toEqual([[RESOURCE_ADMISSION_WAIT,true]]);expect(h.resourceReservations).toEqual([claim]);expect(h.snapshot.resourceLifecycle.subjects.find((s:any)=>s.subject.id===phone.id).status).toBe('idle');
  expect(f.row!.fleetResourceReservation).toBeUndefined();expect(counters.host).toBe(1); // the healthy alternate's prior preparation is separate
 });
});
test('service recovers the SAME own exclusive claim after a lost reply without excluding or relocating its retained target',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),phone=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone'),at=h.receivedAt.toISOString();
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
test('an aged unchanged baseline during the final CAS response preserves custody and allows binding',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),replace=resourceReservationRepository.replace,at=h.receivedAt.getTime();
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  resourceReservationRepository.replace=async(...args)=>{const result=await replace(...args);spyOn(Date,'now').mockReturnValue(at+2);return result};
  try {expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).not.toBeNull();
   expect(f.row!.fleetBinding).toBeDefined();expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);expect(h.resourceReservations).toHaveLength(1);
  }finally{resourceReservationRepository.replace=replace;mock.restore()}
 });
});
test('ordinary Mac assignment preserves a foreign same-lane byte claim without making it a lane mutex',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),own=structuredClone(h.resourceReservations[0]);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';f.restore(row);h.snapshot.lanes[0].platform='ios-on-mac';
  h.resourceReservations.push({...own,id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'foreign-mac-original',fleetInputSha256:'c'.repeat(64)});const claims=structuredClone(h.resourceReservations);
  expect(h.snapshot.lanes[0].state).toBe('idle');expect(h.snapshot.resourceLifecycle.subjects.every((subject:any)=>subject.status==='idle')).toBe(true);
  expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:own.laneId,descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeDefined();
  expect(f.row!.fleetBinding).toBeDefined();expect(h.resourceReservations).toEqual(claims);
 });
});
test('an ordinary claim on another Mac lane sharing the disk does not prevent this lane assignment',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),own=structuredClone(h.resourceReservations[0]);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';f.restore(row);h.snapshot.lanes[0].platform='ios-on-mac';
  h.resourceReservations.push({...own,id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'foreign-mac-original',fleetInputSha256:'c'.repeat(64),laneId:'other-lane'});const claims=structuredClone(h.resourceReservations);
  expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:own.laneId,descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeDefined();
  expect(h.resourceReservations).toEqual(claims);
 });
});
async function withSelectedMacReservation(body: (f: ReturnType<typeof fixture>, host: any, counters: {host: number; request: number}, hosts: Map<string, any>) => Promise<void>) {
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));
  for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();
  for(const[id,h]of hosts)h.snapshot=structuredClone(snapshots.get(id));
  const h=hosts.get('mini'),row=structuredClone(f.row!);h.snapshot.lanes[0].platform='ios-on-mac';
  h.snapshot.lanes[0].descriptorRevision=routineLaneDescriptorRevision(h.snapshot.lanes[0]);
  row.fleetSelection.platform='ios-on-mac';row.fleetPreparation!.requirements.platform='ios-on-mac';
  row.fleetSelection.build={...row.fleetSelection.build,kind:'mac-ci-package',archive:{...row.fleetSelection.build.archive,name:'app.zip',url:'https://artifactscdn.mentraglass.com/app.zip'}};
  row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  const selected=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,h.hostId,'android',h.receivedAt);
  expect(selected?.fleetResourceReservation).toEqual(h.resourceReservations[0]);expect(counters.host).toBe(1);
   expect(f.row!.fleetResourceAdmission!.dependencies).toEqual([]);await body(f,h,counters,hosts);
 });
}
for(const condition of ['one-byte','insufficient-pool','exclusive-recorder','active-recorder'] as const)test(`Mac admission treats ${condition} as current capacity or actual custody`,async()=>{
 await withSelectedMacReservation(async(f,h)=>{
  const row=structuredClone(f.row!),own=structuredClone(h.resourceReservations[0]),recorder=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='recorder');
  if(condition==='exclusive-recorder')h.resourceReservations.push({kind:'exclusive',id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',resourceId:recorder.id,
   authorityHostId:h.hostId,borrowerHostId:h.hostId,laneId:own.laneId,operationId:'run:foreign',intentSha256:'c'.repeat(64),inputSha256:'d'.repeat(64),
   owner:{id:'foreign',kind:'run'},controllerIncarnation:h.incarnation,controllerGeneration:h.incarnationGeneration,borrowerSequence:h.sequence,reservedAt:h.receivedAt.toISOString()});
  else h.resourceReservations.push({...own,id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'foreign',fleetInputSha256:'c'.repeat(64),
   minimumAvailableBytes:condition==='insufficient-pool'?64*1024**3:1});
  if(condition==='active-recorder'){
   const subject=h.snapshot.resourceLifecycle.subjects.find((s:any)=>s.subject.id===recorder.id);
   subject.status='active';subject.owner={id:'foreign-writer',kind:'run',generation:subject.generation,hostId:h.hostId,laneId:own.laneId};
  }
  const claims=structuredClone(h.resourceReservations),selected=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,h.hostId,own.laneId,h.receivedAt);
  expect(Boolean(selected)).toBe(condition==='one-byte');expect(h.resourceReservations).toEqual(claims);
  if(selected){
   const binding={jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:own.laneId,descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()};
   expect((await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,binding,{},h.receivedAt))?.fleetBinding).toEqual(binding);
   expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);expect(f.row!.fleetResourceAdmission).toEqual(row.fleetResourceAdmission);
   expect(h.resourceReservations).toEqual(claims);
  }else expect(f.row!.fleetBinding).toBeUndefined();
 });
});
for(const replacement of [false,true])test(`selected Mac byte claim ${replacement?'after controller replacement ':''}bypasses re-planning and a redundant host CAS but still atomically binds`,async()=>{
 await withSelectedMacReservation(async(f,h,counters)=>{
  if(replacement){h.incarnation=h.snapshot.incarnation='replacement-controller';h.incarnationGeneration=h.snapshot.incarnationGeneration=2;h.sequence=h.snapshot.sequence=2;}
  const row=structuredClone(f.row!),before={...counters},claims=structuredClone(h.resourceReservations);
  const replan=spyOn(ResourceReservationsService.prototype,'reserveFleet'),extraCas=spyOn(TestHostStateModel.collection,'findOneAndUpdate').mockResolvedValue(null as never),bindCas=spyOn(resourceReservationRepository,'replace');
  try {
   const selected=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,h.hostId,'android',h.receivedAt);
   expect({planningCalls:replan.mock.calls.length,extraClaimCasCalls:extraCas.mock.calls.length}).toEqual({planningCalls:0,extraClaimCasCalls:0});
   expect(selected).toEqual(row);expect(counters).toEqual(before);
   const binding={jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()};
   expect((await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,binding,{},h.receivedAt))?.fleetBinding).toEqual(binding);
   expect(bindCas).toHaveBeenCalledTimes(1);expect(h.resourceReservations).toEqual(claims);
   expect(bindCas.mock.calls[0]![0].incarnation).toBe(h.incarnation);expect(bindCas.mock.calls[0]![0].incarnationGeneration).toBe(h.incarnationGeneration);
   expect(f.row!.fleetResourceAdmission).toEqual(row.fleetResourceAdmission);
   expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);expect(f.row!.fleetDeadline).toEqual(row.fleetDeadline);
  } finally {replan.mockRestore();extraCas.mockRestore();bindCas.mockRestore()}
 });
});
for(const changed of ['stale-host','claim-id','claim-input','claim-pool','claim-bytes','missing-claim','unknown-pool','physical-failure','disk-shortage','staging-shortage','active-writer','admission-owner','admission-resources','exclusive-custody'] as const)test(`selected Mac claim ${changed} refuses without reallocation`,async()=>{
 await withSelectedMacReservation(async(f,h,counters)=>{
  const original=structuredClone(f.row!),at=h.receivedAt.getTime(),claim=h.resourceReservations[0],storage=h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='recorder').storage;
  if(changed==='stale-host')h.receivedAt=new Date(at-120001);
  if(changed==='claim-id')claim.id='ef303cad-e9b5-4d3c-b9ea-91c1846a8dab';
  if(changed==='claim-input')claim.fleetInputSha256='f'.repeat(64);
  if(changed==='claim-pool')claim.poolId='changed:disk:2';
  if(changed==='claim-bytes')claim.minimumAvailableBytes++;
  if(changed==='missing-claim')h.resourceReservations=[];
  if(changed==='unknown-pool')h.resourceReservations.push({...structuredClone(claim),id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:'unknown-foreign-original',fleetInputSha256:'f'.repeat(64),laneId:'other-lane',poolId:'unknown:disk:2'});
  if(changed==='physical-failure')unavailableLocal(h,'out-of-service','app');
  if(changed==='disk-shortage')storage.availableBytes=claim.minimumAvailableBytes-1;
  if(changed==='staging-shortage')storage.stagingBudgetBytes=1024**3-1;
  if(changed==='active-writer'){h.snapshot.lanes[0].state='running';h.snapshot.lanes[0].activity={generation:7,owner:{id:'active-original',kind:'run',requestId:'active-original'}};}
  if(changed==='admission-owner'){const row=structuredClone(f.row!);row.fleetResourceAdmission!.intent.owner.id='foreign-original';f.restore(row)}
  if(changed==='admission-resources'){const row=structuredClone(f.row!);row.fleetResourceAdmission!.intent.resources.pop();f.restore(row)}
  const before={...counters},claims=structuredClone(h.resourceReservations),claimed=resourceReservationRepository.claimedHosts;
  if(changed==='exclusive-custody')resourceReservationRepository.claimedHosts=async()=>[structuredClone(h)];
  try {
   expect(await routineJobRepository.reserveResources!(original.requestId,original.fleetInputSha256!,h.hostId,'android',new Date(at))).toBeNull();
   expect(counters).toEqual(before);expect(h.resourceReservations).toEqual(changed==='claim-id'?[]:claims);expect(f.row!.fleetBinding).toBeUndefined();
   expect(f.row!.fleetResourceReservation).toEqual(original.fleetResourceReservation);expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);
  } finally {resourceReservationRepository.claimedHosts=claimed}
 });
});
test('selected Mac admission retains dependency validation when an installed exclusive dependency changes',async()=>{
 await withSelectedMacReservation(async(f,h,counters)=>{
  const row=structuredClone(f.row!),before={...counters};h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='glasses').exclusiveDependencies=[{resourceId:'remote-glasses',authorityHostId:'remote-host',capability:'connection'}];
  const replan=spyOn(ResourceReservationsService.prototype,'reserveFleet');
  try {expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,h.hostId,'android',h.receivedAt)).toBeNull();expect(replan).toHaveBeenCalledTimes(1);expect(counters).toEqual(before);expect(f.row!.fleetBinding).toBeUndefined()}
  finally{replan.mockRestore()}
 });
});
test('selected Mac claim remains held after the actual binding authority CAS loses its race',async()=>{
 await withSelectedMacReservation(async(f,h,counters)=>{
  const row=structuredClone(f.row!),before={...counters},claims=structuredClone(h.resourceReservations),bindCas=spyOn(resourceReservationRepository,'replace').mockResolvedValue(false);
  try {
   expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,h.hostId,'android',h.receivedAt)).toEqual(row);
   expect(await routineJobRepository.bind(row.requestId,row.fleetInputSha256!,{jobId:row.requestId,requestId:row.requestId,hostId:h.hostId,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20',boundAt:h.receivedAt.toISOString()}, {},h.receivedAt)).toBeNull();
   expect(bindCas).toHaveBeenCalledTimes(1);expect(counters).toEqual(before);expect(h.resourceReservations).toEqual(claims);expect(f.row!.fleetBinding).toBeUndefined();expect(f.row!.fleetResourceReservation).toEqual(row.fleetResourceReservation);
  } finally {bindCas.mockRestore()}
 });
});
for(const platform of ['android','ios-on-mac'] as const)for(const expiry of ['changed-check','deadline'] as const)test(`preclaim ${platform} ${expiry} refuses before the first recorder claim or stage`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const originals=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();
  for(const[id,h]of hosts)h.snapshot=structuredClone(originals.get(id));const row=structuredClone(f.row!),h=hosts.get('mini'),at=h.receivedAt.getTime();
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;f.restore(row);h.snapshot.lanes[0].platform=platform;
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const claimRead=resourceReservationRepository.recorderClaims;resourceReservationRepository.recorderClaims=async id=>{const claims=await claimRead!(id);spyOn(Date,'now').mockReturnValue(expiry==='changed-check'?at+2:row.fleetDeadline.getTime()+1);if(expiry==='changed-check')unavailableLocal(h,'unknown');return claims};
  try {expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'mini','android',h.receivedAt)).toBeNull();expect(counters).toEqual({host:0,request:0});
   expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetResourceReservation).toBeUndefined();expect(h.resourceReservations).toEqual([]);
  }finally{resourceReservationRepository.recorderClaims=claimRead;mock.restore()}
 });
});
test('serialized stage rejects a changed current check after its recorder authority read settles',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),row=structuredClone(f.row!),at=h.receivedAt.getTime(),claim=structuredClone(h.resourceReservations[0]);
  const phone=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone');phone.capabilities=['backend-connectivity'];delete row.fleetResourceAdmission;f.restore(row);
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;let now=at,stages=0;
  const reservations=new ResourceReservationsService({async request(){return structuredClone(row)},async get(){return structuredClone(h)},async recorderClaims(){now=at+2;changedCurrentCheck(h,now);return[claim]},
   async stageBackend(...args){stages++;return resourceReservationRepository.stageBackend!(...args)},async claimedHosts(){return[]},async replace(){throw Error('No exclusive claim may start')}},()=>now);
  expect(await reservations.reserveFleet(row.requestId,row.fleetInputSha256!,h.hostId,'android')).toBeNull();expect(stages).toBe(0);expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(h.resourceReservations).toEqual([claim]);
 });
});

test('routing skips known-empty recorder returns and reuses its unchanged host read, while selected admission still reconciles',async()=>{
 await withLocalResources(async(f,_hosts,counters)=>{
  const serviceHosts=(f.service as unknown as {hosts:{list:()=>Promise<ReceivedTestHostState[]>}}).hosts;
  const list=spyOn(serviceHosts,'list'),reconcile=spyOn(routineJobRepository,'reconcileRecorderHost');
  try {
   const prepared=await f.prepare();
   expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toBeUndefined();
   expect({hostLists:list.mock.calls.length,recorderReconciliations:reconcile.mock.calls.length}).toEqual({hostLists:1,recorderReconciliations:0});
   expect(counters.host).toBe(0);expect(counters.request).toBe(0);
   expect(f.row!.fleetResourceReservation).toBeUndefined();
   expect(f.row!.fleetBinding).toBeUndefined();
  }finally{list.mockRestore();reconcile.mockRestore()}
 });
});

test('actual current recorder work keeps custody without a second full host read',async()=>{
 await withLocalResources(async(f,hosts,_counters,pastRows)=>{
  for(const h of hosts.values()) {
   const at=h.receivedAt.toISOString(),claim={id:'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',requestId:`active-${h.hostId}`,fleetInputSha256:'c'.repeat(64),hostId:h.hostId,laneId:'android',poolId:`${h.hostId}:disk:1`,minimumAvailableBytes:3*1024**3,reservedAt:at};
   h.resourceReservations=[claim];h.snapshot.lanes[0].state='running';h.snapshot.lanes[0].activity={generation:7,owner:{id:claim.requestId,kind:'run',requestId:claim.requestId}};pastRows.set(claim.requestId,{requestId:claim.requestId,fleetInputSha256:claim.fleetInputSha256,state:'running'} as StoredRoutineJob);
  }
  const originalClaims=[...hosts.values()].map(h=>structuredClone(h.resourceReservations));
  const serviceHosts=(f.service as unknown as {hosts:{list:()=>Promise<ReceivedTestHostState[]>}}).hosts;
  const list=spyOn(serviceHosts,'list'),reconcile=spyOn(routineJobRepository,'reconcileRecorderHost');
  try {
   expect((await f.prepare()).waitingReason).toBeUndefined();
   expect({hostLists:list.mock.calls.length,recorderReconciliations:reconcile.mock.calls.length}).toEqual({hostLists:1,recorderReconciliations:2});
   expect([...hosts.values()].map(h=>h.resourceReservations)).toEqual(originalClaims);
   expect(f.row!.fleetResourceReservation).toBeUndefined();expect(f.row!.fleetBinding).toBeUndefined();
  }finally{list.mockRestore();reconcile.mockRestore()}
 });
});

test('missing authority inventory still receives ordinary recorder return reconciliation',async()=>{
 await withLocalResources(async(f)=>{
  const serviceHosts=(f.service as unknown as {hosts:{list:()=>Promise<ReceivedTestHostState[]>}}).hosts,originalList=serviceHosts.list;
  const list=spyOn(serviceHosts,'list').mockImplementation(async()=>
   (await originalList()).map(({authorityReservations:_,...host})=>host));
  const reconcile=spyOn(routineJobRepository,'reconcileRecorderHost');
  try {await f.prepare();expect(list).toHaveBeenCalledTimes(1);expect(reconcile).toHaveBeenCalledTimes(2)}
  finally{list.mockRestore();reconcile.mockRestore()}
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
  const serviceHosts=(f.service as unknown as {hosts:{list:()=>Promise<ReceivedTestHostState[]>}}).hosts;
  const list=spyOn(serviceHosts,'list');let prepared:Awaited<ReturnType<RoutineJobService['preparation']>>;
  try {prepared=await f.service.preparation(selection.requestId);expect(list).toHaveBeenCalledTimes(2)} finally {list.mockRestore()}
  expect((prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget).toBeUndefined();
  expect([...hosts.values()].flatMap(h=>h.resourceReservations).some(claim=>claim.requestId.startsWith('prior-'))).toBe(false);
  expect(f.row!.requestId).toBe(selection.requestId);expect(f.row!.fleetSelection.build).toEqual(row.fleetSelection.build);expect(f.row!.fleetDeadline).toEqual(row.fleetDeadline);expect(f.row!.fleetBinding).toBeUndefined();
  const reserved=await f.reservePrepared(), target=reserved.resourceTarget!,h=hosts.get(target.hostId),current=f.row!,
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
  let returned=0;
  try {
   if(refusal==='lost-cas')await expect(routineJobRepository.reconcileRecorderHost!('mini',h.receivedAt,undefined,()=>{returned++})).rejects.toThrow('Original CAS reply lost');
   else await routineJobRepository.reconcileRecorderHost!('mini',h.receivedAt,undefined,()=>{returned++});
   expect(returned).toBe(0);
   expect(h.resourceReservations).toEqual([claim]);expect(f.row).toBeNull();
  }finally{resourceReservationRepository.replace=replace}
 });
});


for(const platform of ['android','ios-on-mac'] as const)for(const phase of ['request','host'] as const)for(const boundary of ['baseline-exact','baseline-aged','changed-check','deadline'] as const)test(`offline ${platform} repository stage after ${phase} ${boundary} preserves the unclaimed SAME job for a ready alternate`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();
  for(const[id,h]of hosts)h.snapshot=structuredClone(snapshots.get(id));const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!);
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  for(const host of hosts.values())host.snapshot.lanes[0].platform=platform;
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),request=resourceReservationRepository.request,get=resourceReservationRepository.get,clock=spyOn(Date,'now').mockReturnValue(at);
  let delayed=false;
  const delay=()=>{if(delayed)return;delayed=true;const after=boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2);clock.mockReturnValue(after);if(boundary==='changed-check')changedCurrentCheck(h,Date.now())};
  resourceReservationRepository.request=async id=>{const value=await request!(id);if(phase==='request')delay();return value};
  resourceReservationRepository.get=async id=>{if(boundary==='changed-check'&&phase==='host')delay();const value=await get(id);if(phase==='host')delay();return value};
  const admission={intent:{operationId:`run:${row.requestId}`,hostId:h.hostId,laneId:'android',inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run' as const},
    controller:{incarnation:h.incarnation,generation:h.incarnationGeneration,sequence:h.sequence},resources:h.snapshot.lanes[0].resources.map((resource:any)=>({id:resource.id,capabilities:resource.capabilities??[]}))},dependencies:[]};
  try {
   const staged=await resourceReservationRepository.stage!(row.requestId,row.fleetInputSha256!,admission,h.receivedAt);
   if((boundary==='baseline-exact'||boundary==='baseline-aged')){expect(staged?.fleetResourceAdmission).toEqual(admission);expect(counters.request).toBe(1)}
   else{expect(staged).toBeNull();expect(counters).toEqual({host:0,request:0});expect(f.row).toEqual(original);expect(h.resourceReservations).toEqual([]);
    if(boundary==='changed-check'){
     const alternate=hosts.get('air1'),now=Date.now();alternate.receivedAt=new Date(now);alternate.snapshot.observedAt=new Date(now).toISOString();
     for(const subject of alternate.snapshot.resourceLifecycle.subjects){subject.observedAt=alternate.snapshot.observedAt;subject.idle.checkedAt=alternate.snapshot.observedAt;subject.idle.acceptedCheck.acceptedAt=alternate.snapshot.observedAt}
     resourceReservationRepository.request=request;resourceReservationRepository.get=get;
     expect(await new ResourceReservationsService(resourceReservationRepository,()=>Date.now()).reserveFleet(row.requestId,row.fleetInputSha256!,'air1','android')).toBeUndefined();
     expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(f.row!.fleetSelection).toEqual(original.fleetSelection);expect(f.row!.fleetPreparation).toEqual(original.fleetPreparation);
    }
   }
   expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{resourceReservationRepository.request=request;resourceReservationRepository.get=get;clock.mockRestore()}
 });
});
function legacyLocalResources(host: any) {
 delete host.snapshot.resourceLifecycle;delete host.snapshot.laneControls;delete host.resourceLifecycleCursor;
 for(const resource of host.snapshot.lanes[0].resources)delete resource.idleContract;
}
for(const platform of ['android','ios-on-mac'] as const)for(const phase of ['request','host'] as const)for(const elapsed of [120000,120001])test(`legacy offline ${platform} stage after ${phase} at ${elapsed}ms keeps fresh compatibility and excludes an expired host`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();
  for(const[id,h]of hosts){h.snapshot=structuredClone(snapshots.get(id));legacyLocalResources(h);h.snapshot.lanes[0].platform=platform;}
  const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!);
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  const original=structuredClone(f.row!),request=resourceReservationRepository.request,get=resourceReservationRepository.get,clock=spyOn(Date,'now').mockReturnValue(at);
  const delay=()=>clock.mockReturnValue(at+elapsed);
  resourceReservationRepository.request=async id=>{const value=await request!(id);if(phase==='request')delay();return value};
  resourceReservationRepository.get=async id=>{const value=await get(id);if(phase==='host')delay();return value};
  const admission={intent:{operationId:`run:${row.requestId}`,hostId:h.hostId,laneId:'android',inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run' as const},
   controller:{incarnation:h.incarnation,generation:h.incarnationGeneration,sequence:h.sequence},resources:h.snapshot.lanes[0].resources.map((resource:any)=>({id:resource.id,capabilities:resource.capabilities??[]}))},dependencies:[]};
  try {
   const staged=await resourceReservationRepository.stage!(row.requestId,row.fleetInputSha256!,admission,new Date(at));
   if(elapsed===120000){expect(staged?.fleetResourceAdmission).toEqual(admission);expect(counters).toEqual({host:0,request:1})}
   else{
    expect(staged).toBeNull();expect(counters).toEqual({host:0,request:0});expect(f.row).toEqual(original);expect(h.resourceReservations).toEqual([]);
    resourceReservationRepository.request=request;resourceReservationRepository.get=get;
    expect(await new ResourceReservationsService(resourceReservationRepository,()=>Date.now()).reserveFleet(row.requestId,row.fleetInputSha256!,'mini','android')).toBeNull();
    expect(await new ResourceReservationsService(resourceReservationRepository,()=>Date.now()).reserveFleet(row.requestId,row.fleetInputSha256!,'air1','android')).toBeNull();
    expect(f.row).toEqual(original);expect(counters).toEqual({host:0,request:0});
    const alternate=hosts.get('air1'),now=Date.now();alternate.receivedAt=new Date(now);alternate.snapshot.observedAt=new Date(now).toISOString();
    alternate.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='recorder').storage.observedAt=alternate.snapshot.observedAt;
    expect(await new ResourceReservationsService(resourceReservationRepository,()=>Date.now()).reserveFleet(row.requestId,row.fleetInputSha256!,'air1','android')).toBeUndefined();
    expect(f.row!.fleetResourceAdmission).toBeUndefined();expect(h.resourceReservations).toEqual([]);
   }
   for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{resourceReservationRepository.request=request;resourceReservationRepository.get=get;clock.mockRestore()}
 });
});
for(const envelope of ['missing-observed','invalid-observed','invalid-received','future-observed','future-received','observed-after-received'] as const)test(`legacy host ${envelope} never becomes ready through baseline or candidate exceptions`,async()=>{
 await withLocalResources(async(_f,hosts)=>{
  const h=hosts.get('mini'),now=h.receivedAt.getTime();legacyLocalResources(h);
  if(envelope==='missing-observed')delete h.snapshot.observedAt;
  if(envelope==='invalid-observed')h.snapshot.observedAt='invalid';
  if(envelope==='invalid-received')h.receivedAt=new Date(NaN);
  if(envelope==='future-observed')h.snapshot.observedAt=new Date(now+1).toISOString();
  if(envelope==='future-received')h.receivedAt=new Date(now+1);
  if(envelope==='observed-after-received')h.receivedAt=new Date(now-1);
  const host={...h,resourceControlRecords:h.laneControls},lane=h.snapshot.lanes[0],phone=lane.resources.find((resource:any)=>resource.kind==='phone');
  expect(resourceAvailable(host,phone.id,now)).toBe(false);expect(resourceAvailable(host,phone.id,now,true)).toBe(false);
  expect(requiredResourceBlocker(host,lane,[],now,()=>true)).toEqual({code:'host-report-unavailable'});
 });
});
for(const platform of ['android','ios-on-mac'] as const)test(`legacy offline ${platform} delayed stage commit retains its original admission without claiming a ready alternate`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();
  for(const[id,h]of hosts){h.snapshot=structuredClone(snapshots.get(id));legacyLocalResources(h);h.snapshot.lanes[0].platform=platform;}
  const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!);
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  const original=structuredClone(f.row!),write=TestRequestModel.collection.findOneAndUpdate,clock=spyOn(Date,'now').mockReturnValue(at),fleetClock=spyOn(f.service as any,'now').mockImplementation(()=>Date.now());
  let delayed=false;TestRequestModel.collection.findOneAndUpdate=mock(async(...args:any[])=>{const result=await write.apply(TestRequestModel.collection,args as never);
   if(result&&!delayed&&args[1].$set.fleetResourceAdmission){delayed=true;clock.mockReturnValue(at+120001)}return result}) as never;
  try{
   expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'mini','android',new Date(at))).toBeNull();
   expect(delayed).toBe(true);expect(f.row!.fleetResourceAdmission?.intent.hostId).toBe('mini');expect(f.row!.fleetResourceReservation).toEqual(h.resourceReservations[0]);expect(counters).toEqual({host:1,request:1});
   const alternate=hosts.get('air1'),now=Date.now();alternate.receivedAt=new Date(now);alternate.snapshot.observedAt=new Date(now).toISOString();
   alternate.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='recorder').storage.observedAt=alternate.snapshot.observedAt;
   await f.service.preparation(row.requestId);expect(f.row!.fleetResourceAdmission?.intent.hostId).toBe('mini');expect(alternate.resourceReservations).toEqual([]);
   for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{TestRequestModel.collection.findOneAndUpdate=write;fleetClock.mockRestore();clock.mockRestore()}
 });
});
for(const phase of ['request','recorder','host','final-request','final-host'] as const)for(const boundary of ['baseline-exact','baseline-aged','changed-check','deadline'] as const)test(`offline serialized Android repository stage after ${phase} ${boundary} retains its original provisional claim`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const prepared=await f.prepareReserved(),target=(prepared as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,h=hosts.get(target.hostId),at=h.receivedAt.getTime(),row=structuredClone(f.row!),claim=structuredClone(h.resourceReservations[0]);
  delete row.fleetResourceAdmission;delete row.fleetResourceReservation;f.restore(row);h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='phone').capabilities=['backend-connectivity'];
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),request=resourceReservationRepository.request,get=resourceReservationRepository.get,recorder=resourceReservationRepository.recorderClaims,clock=spyOn(Date,'now').mockReturnValue(at),initialWrites={...counters};
  let requestReads=0,hostReads=0,delayed=false;
  const delay=()=>{if(delayed)return;delayed=true;clock.mockReturnValue(boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2));if(boundary==='changed-check')changedCurrentCheck(h,Date.now())};
  resourceReservationRepository.request=async id=>{const value=await request!(id);if(phase===(++requestReads===1?'request':'final-request'))delay();return value};
  resourceReservationRepository.get=async id=>{const currentPhase=++hostReads===1?'host':'final-host';if(boundary==='changed-check'&&phase===currentPhase)delay();const value=await get(id);if(phase===currentPhase)delay();return value};
  resourceReservationRepository.recorderClaims=async id=>{const value=await recorder!(id);if(phase==='recorder')delay();return value};
  const admission={intent:{operationId:`run:${row.requestId}`,hostId:h.hostId,laneId:'android',inputSha256:row.fleetInputSha256!,owner:{id:row.requestId,kind:'run' as const},
   controller:{incarnation:h.incarnation,generation:h.incarnationGeneration,sequence:h.sequence},resources:h.snapshot.lanes[0].resources.map((resource:any)=>({id:resource.id,capabilities:resource.capabilities??[]}))},dependencies:[]};
  try {
   const staged=await resourceReservationRepository.stageBackend!(row.requestId,row.fleetInputSha256!,admission,structuredClone(h),h.receivedAt);
   if((boundary==='baseline-exact'||boundary==='baseline-aged')){expect(staged?.fleetResourceAdmission).toEqual(admission);expect(counters.request).toBe(initialWrites.request+1)}
   else{expect(staged).toBeNull();expect(counters).toEqual(initialWrites);expect(f.row).toEqual(original)}
   expect(h.resourceReservations).toEqual([claim]);expect(f.row!.fleetDeadline).toEqual(original.fleetDeadline);expect(f.row!.fleetInputSha256).toBe(original.fleetInputSha256);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{resourceReservationRepository.request=request;resourceReservationRepository.get=get;resourceReservationRepository.recorderClaims=recorder;clock.mockRestore()}
 });
});


for(const laneKind of ['mac','android','serialized-android'] as const)for(const phase of ['before-request','before-host','after-commit'] as const)for(const boundary of ['baseline-exact','baseline-aged','changed-check','deadline'] as const)test(`ordinary ${laneKind} atomic claim at ${phase} ${boundary} preserves real current custody and original dispatch bounds`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots=new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));for(const h of hosts.values())unavailableLocal(h,'out-of-service');await f.prepareReserved();
  for(const[id,h]of hosts)h.snapshot=structuredClone(snapshots.get(id));const h=hosts.get('mini'),at=h.receivedAt.getTime(),row=structuredClone(f.row!),platform=laneKind==='mac'?'ios-on-mac':'android';
  row.fleetSelection.platform=platform;row.fleetPreparation!.requirements.platform=platform;row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);h.snapshot.lanes[0].platform=platform;
  if(laneKind==='serialized-android')h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='phone').capabilities=['backend-connectivity'];
  for(const resource of h.snapshot.lanes[0].resources)resource.idleContract.maximumAgeMs=1;
  const original=structuredClone(f.row!),requestWrite=TestRequestModel.collection.findOneAndUpdate,hostWrite=TestHostStateModel.collection.findOneAndUpdate,start=TestHostStateModel.db.startSession,clock=spyOn(Date,'now').mockReturnValue(at);let delayed=false;
  const delay=()=>{if(delayed)return;delayed=true;clock.mockReturnValue(boundary==='deadline'?row.fleetDeadline.getTime():at+(boundary==='baseline-exact'?1:2));if(boundary==='changed-check')changedCurrentCheck(h,Date.now())};
  if(phase==='before-request')TestRequestModel.collection.findOneAndUpdate=(async(...args:any[])=>{if(args[2]?.session)delay();return requestWrite.apply(TestRequestModel.collection,args as never)}) as any;
  if(phase==='before-host')TestHostStateModel.collection.findOneAndUpdate=(async(...args:any[])=>{if(args[2]?.session)delay();return hostWrite.apply(TestHostStateModel.collection,args as never)}) as any;
  if(phase==='after-commit')TestHostStateModel.db.startSession=(async()=>{const session=await start.call(TestHostStateModel.db),commit=session.withTransaction.bind(session);session.withTransaction=async<T=any>(callback:(nativeSession:typeof session)=>Promise<T>,options?:Parameters<typeof session.withTransaction>[1])=>{const value=await commit(callback,options);delay();return value};return session}) as any;
  try{
   const selected=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,'mini','android',new Date(at));expect(delayed).toBe(true);
   if(boundary==='changed-check'&&phase!=='after-commit'){expect(selected).toBeNull();expect(f.row).toEqual(original);expect(h.resourceReservations).toEqual([]);expect(counters).toEqual({host:0,request:0})}
   else{expect(f.row!.fleetResourceAdmission!.intent.hostId).toBe('mini');expect(f.row!.fleetResourceReservation).toEqual(h.resourceReservations[0]);expect(h.resourceReservations).toHaveLength(1);expect(counters).toEqual({host:1,request:1});
    if(boundary==='deadline'){expect(selected).toBeNull();await expect(f.service.bind(row.requestId,'mini',{inputSha256:row.fleetInputSha256,laneId:'android',descriptorRevision:h.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20'})).rejects.toThrow();}
    else if(boundary==='changed-check')await changedCheckRefusesBinding(h,f.row!);
    else expect(selected?.fleetResourceReservation?.hostId).toBe('mini');
   }
   for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{TestRequestModel.collection.findOneAndUpdate=requestWrite;TestHostStateModel.collection.findOneAndUpdate=hostWrite;TestHostStateModel.db.startSession=start;clock.mockRestore()}
 });
});

test('verified clean completion schedules only its original recorder cleanup without delaying the immutable ACK', async () => {
  const f = fixture(), prepared = await f.prepareReserved(), input = {inputSha256: prepared.inputSha256, laneId: f.lane.id,
    descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'};
  await f.service.bind(selection.requestId, 'mini', input); f.accepted('c'.repeat(64));
  const calls: unknown[][] = [], completion = {inputSha256: 'c'.repeat(64), disposition: 'clean' as const, completedAt: '2026-10-08T00:01:00Z'};
  f.rows.reconcileRecorderHost = async (...args) => {calls.push(args); throw Error('cleanup unavailable')};
  await expect(f.service.complete(selection.requestId, 'foreign', completion)).rejects.toThrow('host');
  expect(calls).toHaveLength(0);
  expect(await f.service.complete(selection.requestId, 'mini', completion)).toEqual(completion);
  await Promise.resolve(); expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe('mini'); expect(calls[0]?.[5]).toBe(selection.requestId);
  expect(f.row!.dispatchCompletion).toEqual(completion);
  expect(await f.service.complete(selection.requestId, 'mini', completion)).toEqual(completion);
  await Promise.resolve(); expect(calls).toHaveLength(2);
  await expect(f.service.complete(selection.requestId, 'mini', {...completion, inputSha256: 'e'.repeat(64)})).rejects.toThrow('exact executable input');
  expect(calls).toHaveLength(2);
});

test('accepted current recorder snapshot returns only the completed original and keeps foreign byte custody', async () => {
  await withLocalResources(async (_f, hosts, counters, pastRows) => {
    const h = hosts.get('mini'), at = h.receivedAt.toISOString(), claim = {id: 'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',
      requestId: 'original', fleetInputSha256: 'c'.repeat(64), hostId: 'mini', laneId: 'android', poolId: 'mini:disk:1', minimumAvailableBytes: 3 * 1024 ** 3, reservedAt: at},
      foreign = {...claim, id: '8b224b98-f1f6-4e91-8fc8-2d6fb2f3638b', requestId: 'foreign'};
    h.resourceReservations = [claim, foreign];
    pastRows.set(claim.requestId, {requestId: claim.requestId, fleetInputSha256: claim.fleetInputSha256, inputSha256: 'd'.repeat(64),
      dispatchCompletion: {inputSha256: 'd'.repeat(64), disposition: 'clean', completedAt: at}} as StoredRoutineJob);
    const get = spyOn(resourceReservationRepository, 'get');
    try {
      await routineJobRepository.reconcileRecorderHost!('mini', h.receivedAt, undefined, undefined, structuredClone(h), claim.requestId);
      expect(get).toHaveBeenCalledTimes(0); expect(h.resourceReservations).toEqual([foreign]);
    } finally {get.mockRestore()}
  });
});

for (const unrelated of ['out-of-service', 'activity'] as const) test(`completed recorder return does not depend on unrelated lane ${unrelated}`, async () => {
  await withLocalResources(async (_f, hosts, counters, pastRows) => {
    const h = hosts.get('mini'), at = h.receivedAt.toISOString(), lane = h.snapshot.lanes[0], claim = {id: 'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab',
      requestId: 'original', fleetInputSha256: 'c'.repeat(64), hostId: 'mini', laneId: 'android', poolId: 'mini:disk:1', minimumAvailableBytes: 3 * 1024 ** 3, reservedAt: at},
      foreign = {...claim, id: '8b224b98-f1f6-4e91-8fc8-2d6fb2f3638b', requestId: 'foreign'};
    h.resourceReservations = [claim, foreign];
    pastRows.set(claim.requestId, {requestId: claim.requestId, fleetInputSha256: claim.fleetInputSha256, inputSha256: 'd'.repeat(64),
      dispatchCompletion: {inputSha256: 'd'.repeat(64), disposition: 'clean', completedAt: at}} as StoredRoutineJob);
    unavailableLocal(h, 'out-of-service', 'glasses');
    if (unrelated === 'out-of-service') lane.state = 'out-of-service';
    else lane.activity = {requestId: 'unrelated-phone-repair'};
    const originalLane = structuredClone(lane); let returned = 0;
    expect(await routineJobRepository.reconcileRecorderHost!('mini', h.receivedAt, undefined, () => {returned++}, structuredClone(h), claim.requestId)).toBe(true);
    expect(returned).toBe(1); expect(h.resourceReservations).toEqual([foreign]);
    expect(h.snapshot.lanes[0]).toEqual(originalLane); expect(counters).toEqual({host: 0, request: 0});
  });
});

test('recorder return reconciliation reads the narrow recorder-return host view', async () => {
  const get = spyOn(resourceReservationRepository, 'get').mockImplementation(async () => null);
  try {
    expect(await routineJobRepository.reconcileRecorderHost!('mini', new Date())).toBe(false);
    expect(get.mock.calls).toEqual([['mini', {recorderReturn: true}]]);
  } finally {get.mockRestore()}
});

test('recorder-only recovery selects current authority without check journals or history', async () => {
  const projections: any[] = [], reads: any[] = [];
  const find = spyOn(TestHostStateModel, 'findOne').mockImplementation(((filter: unknown) => {
    const query = {select(value: unknown) {projections.push(value); return query}, read(value: unknown) {reads.push(value); return query},
      readConcern(value: unknown) {reads.push(value); return query}, setOptions(value: unknown) {reads.push(value); return query}, async lean() {return null}};
    return query;
  }) as never);
  try {
    expect(await resourceReservationRepository.get('mini', {recorderReturn: true})).toBeNull();
    // Claims, recorder offers and every field of the replace() CAS fence.
    for (const key of ['hostId', 'incarnation', 'incarnationGeneration', 'sequence', 'receivedAt', 'laneControlVersion', 'resourceReservationVersion',
      'resourceReservations', 'snapshot.observedAt', 'snapshot.lanes.id', 'snapshot.lanes.state', 'snapshot.lanes.activity', 'snapshot.lanes.resources'])
      expect(projections[0]).toHaveProperty([key], 1);
    // Check journals, lifecycle history and repair diagnostics are hundreds of KB per host.
    for (const key of ['snapshot', 'frameworkHistory', 'frameworkStopReceipts', 'snapshot.frameworkHistory', 'snapshot.resourceReservations',
      'snapshot.resourceLifecycle', 'snapshot.restoration', 'resourceLifecycleCursor', 'laneControls', 'snapshot.laneControls'])
      expect(projections[0]).not.toHaveProperty([key]);
    expect(reads).toEqual(['primary', 'majority', {timeoutMS: 5000}]);
  } finally {find.mockRestore()}
});

test.each(['idle', 'out-of-service', 'in-repair'] as const)('current phone baseline reaches the real serialized recorder, admission and bind CAS with %s lane', async laneState => {
 await withLocalResources(async(f,hosts,counters)=>{
  const snapshots = new Map([...hosts].map(([id,h])=>[id,structuredClone(h.snapshot)]));
  for(const h of hosts.values())unavailableLocal(h,'out-of-service','phone');
  await f.prepareReserved();
  for(const [id,h] of hosts){h.snapshot=structuredClone(snapshots.get(id));
   h.snapshot.lanes[0].state=laneState;
   h.snapshot.frameworkBinding={version:1535,revision:'a'.repeat(40),installationId:'current',configurationSha256:'b'.repeat(64),runtimeSha256:'c'.repeat(64),routineApiVersion:111,publicApiSha256:'d'.repeat(64)};
   h.snapshot.frameworkAcceptedAt=h.snapshot.observedAt;h.snapshot.frameworkProcess={pid:100,startedAt:'original-current-worker'};
   h.snapshot.resourceReservations={claims:[],returns:[],resourceReadiness:true};
   h.snapshot.lanes[0].resources.find((ref:any)=>ref.kind==='phone').capabilities=['backend-connectivity'];
   h.snapshot.lanes[0].descriptorRevision=routineLaneDescriptorRevision(h.snapshot.lanes[0]);
  }
  const row=structuredClone(f.row!);row.fleetPreparation!.definition.resourceRequirements.find(ref=>ref.kind==='phone')!.capabilities=['backend-connectivity'];
  row.fleetPreparation!.requirements.resources.find(ref=>ref.kind==='phone')!.capabilities=['backend-connectivity'];
  row.fleetPreparation!.definitionSha256=requestInputDigest(row.fleetPreparation!.definition);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  const original=structuredClone(f.row!),prepared=await f.reservePrepared(),target=(prepared as {resourceTarget?:{hostId:string;laneId:string}}).resourceTarget;
  expect(target).toBeDefined();expect(f.row!.fleetResourceAdmission?.intent.operationId).toBe(`run:${row.requestId}`);
  expect(f.row!.fleetCandidatePreparation).toBeUndefined();expect(f.row!.fleetCandidatePreparations).toBeUndefined();
  expect(f.row!.fleetResourceReservation?.requestId).toBe(row.requestId);expect(counters.host).toBeGreaterThan(0);expect(counters.request).toBeGreaterThan(0);
  const host=hosts.get(target!.hostId);
  const bound=await f.service.bind(row.requestId,target!.hostId,{inputSha256:row.fleetInputSha256,laneId:target!.laneId,descriptorRevision:host.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
  expect(bound.execute).toBe(true);expect(f.row!.fleetBinding?.hostId).toBe(target!.hostId);
  for(const key of ['fleetSelection','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);
 });
});


for(const legacy of ['same-controller', 'replaced-controller', 'dependency-bearing', 'missing-old-host'] as const)test(`an unclaimed ${legacy} admission uses a current matching alternative without changing the original`,async()=>{
 await withLocalResources(async(f,hosts)=>{
  const first=await f.prepareReserved(),target=(first as unknown as {resourceTarget:{hostId:string}}).resourceTarget.hostId,old=hosts.get(target),alternate=[...hosts.keys()].find(id=>id!==target)!;
  const row=structuredClone(f.row!);delete row.fleetResourceReservation;delete row.fleetExclusiveReservation;
  for(const host of hosts.values())host.resourceReservations=[];
  if(legacy==='dependency-bearing')row.fleetResourceAdmission!.dependencies=[{capability:'google-authentication',resourceId:'legacy-account',authorityHostId:target}];
  if(legacy==='replaced-controller'){old.incarnation=old.snapshot.incarnation='replacement-controller';old.incarnationGeneration=old.snapshot.incarnationGeneration=478;}
  if(legacy==='missing-old-host')hosts.delete(target);else unavailableLocal(old,'out-of-service');
  f.restore(row);const before={selection:row.fleetSelection,prepared:row.fleetPreparation,digest:row.fleetInputSha256,deadline:row.fleetDeadline};
  expect(await f.service.preparation(row.requestId)).toMatchObject({resourceTarget:{hostId:alternate,laneId:'android'}});
  expect(f.row!.fleetResourceAdmission!.intent.hostId).toBe(alternate);expect(f.row!.fleetResourceReservation!.hostId).toBe(alternate);
  expect({selection:f.row!.fleetSelection,prepared:f.row!.fleetPreparation,digest:f.row!.fleetInputSha256,deadline:f.row!.fleetDeadline}).toEqual(before);
  expect(f.row!.fleetBinding).toBeUndefined();if(legacy!=='missing-old-host')expect(old.resourceReservations).toEqual([]);
 });
});

/** Freeze one unassigned input and its installed fixture dependency without admitting a candidate. */
async function unassignedLocalInput(f:ReturnType<typeof fixture>,hosts:Map<string,any>,dependencies=false){
 const reserve=f.rows.reserveResources;f.rows.reserveResources=async()=>null;
 try{await f.prepareReserved()}finally{f.rows.reserveResources=reserve}
 if(dependencies){
  const row=structuredClone(f.row!);
  row.fleetPreparation!.definition.resourceRequirements.find(resource=>resource.kind==='fixture-data')!.capabilities=['google-authentication'];
  row.fleetPreparation!.requirements.resources.find(resource=>resource.kind==='fixture-data')!.capabilities=['google-authentication'];
  row.fleetPreparation!.definitionSha256=requestInputDigest(row.fleetPreparation!.definition);row.fleetInputSha256=routineJobInputDigest(row);f.restore(row);
  for(const h of hosts.values()){
   const fixture=h.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='fixture-data');fixture.capabilities=['google-authentication'];
   fixture.exclusiveDependencies=[{resourceId:fixture.id,authorityHostId:h.hostId,capability:'google-authentication'}];
   h.snapshot.resourceLifecycle.subjects.find((subject:any)=>subject.subject.id===fixture.id).resource.capabilities=['google-authentication'];
   h.snapshot.lanes[0].descriptorRevision=routineLaneDescriptorRevision(h.snapshot.lanes[0]);
  }
 }
 return structuredClone(f.row!);
}
for(const dependencies of [false,true])test(`concurrent same-original ${dependencies?'different-authority dependency':'recorder-only'} candidates commit one real request winner and only that host can bind`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const original=await unassignedLocalInput(f,hosts,dependencies),write=TestRequestModel.collection.findOneAndUpdate,
   gates=new Map<string,{promise:Promise<void>;release():void}>(),entered=new Set<string>();
  for(const hostId of hosts.keys()){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve});gates.set(hostId,{promise,release})}
  let arrived!:()=>void;const both=new Promise<void>(resolve=>{arrived=resolve});
  TestRequestModel.collection.findOneAndUpdate=(async(...args:any[])=>{
   if(args[2]?.session){const hostId=args[1].$set.fleetResourceAdmission.intent.hostId;entered.add(hostId);if(entered.size===2)arrived();await gates.get(hostId)!.promise}
   return write.apply(TestRequestModel.collection,args as never);
  }) as any;
  const attempts=new Map([...hosts].map(([id,h])=>[id,routineJobRepository.reserveResources!(original.requestId,original.fleetInputSha256!,id,'android',h.receivedAt)]));
  try{
   await both;expect(f.row).toEqual(original);expect([...hosts.values()].every(h=>h.resourceReservations.length===0)).toBe(true);
   gates.get('air1')!.release();const winner=await attempts.get('air1')!;expect(winner?.fleetResourceReservation?.hostId).toBe('air1');
   gates.get('mini')!.release();expect(await attempts.get('mini')!).toBeNull();
   const won=hosts.get('air1'),lost=hosts.get('mini'),claim=structuredClone(winner!.fleetResourceReservation!);
   expect(lost.resourceReservations).toEqual([]);expect(won.resourceReservations.filter((value:any)=>value.requestId===original.requestId)).toEqual([claim]);
   if(dependencies){expect(winner!.fleetExclusiveReservation!.claims).toHaveLength(1);expect(won.resourceReservations).toHaveLength(2);expect(won.resourceReservations).toContainEqual(winner!.fleetExclusiveReservation!.claims[0]);}
   else expect(won.resourceReservations).toEqual([claim]);
   for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);
   const bind={inputSha256:original.fleetInputSha256!,laneId:'android',descriptorRevision:lost.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20'};
   await expect(f.service.bind(original.requestId,lost.hostId,bind)).rejects.toThrow();expect(f.row!.fleetBinding).toBeUndefined();expect(lost.resourceReservations).toEqual([]);
   const bound=await f.service.bind(original.requestId,won.hostId,{...bind,descriptorRevision:won.snapshot.lanes[0].descriptorRevision});
   expect(bound.execute).toBe(true);expect(bound.binding.hostId).toBe(won.hostId);expect(f.row!.state).toBe('preparing');
   expect(f.row!.fleetResourceReservation).toEqual(claim);expect(lost.resourceReservations).toEqual([]);
   for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);
  }finally{for(const gate of gates.values())gate.release();TestRequestModel.collection.findOneAndUpdate=write;}
 },dependencies?['fixture-data']:[]);
});
for(const retainedRecorder of [false,true])test(`a legacy acquired exclusive claim recovers its missing request receipt with ${retainedRecorder?'retained':'unclaimed'} recorder custody and binds the same original host`,async()=>{
 await withLocalResources(async(f,hosts)=>{
  await unassignedLocalInput(f,hosts,true);
  const first=await f.reservePrepared(),target=(first as unknown as {resourceTarget:{hostId:string;laneId:string}}).resourceTarget,
   owned=hosts.get(target.hostId),row=structuredClone(f.row!),exclusive=structuredClone(row.fleetExclusiveReservation!),alternate=[...hosts.keys()].find(id=>id!==target.hostId)!;
  delete row.fleetExclusiveReservation;
  if(!retainedRecorder){delete row.fleetResourceReservation;owned.resourceReservations=owned.resourceReservations.filter((claim:any)=>claim.kind==='exclusive');}
  f.restore(row);const original=structuredClone(f.row!),originalClaimIds=exclusive.claims.map(claim=>claim.id);
  expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,alternate,target.laneId,hosts.get(alternate).receivedAt)).toBeNull();
  expect(f.row).toEqual(original);expect(hosts.get(alternate).resourceReservations).toEqual([]);
  const resumed=await f.service.preparation(row.requestId);
  expect(resumed.waitingReason).toBeUndefined();expect((resumed as unknown as {resourceTarget:unknown}).resourceTarget).toEqual(target);
  expect(f.row!.fleetExclusiveReservation).toEqual(exclusive);
  expect(owned.resourceReservations.filter((claim:any)=>claim.kind==='exclusive').map((claim:any)=>claim.id)).toEqual(originalClaimIds);
  expect(f.row!.fleetResourceReservation).toBeDefined();
  const bound=await f.service.bind(row.requestId,target.hostId,{inputSha256:resumed.inputSha256,laneId:target.laneId,descriptorRevision:owned.snapshot.lanes[0].descriptorRevision,actionsRunId:'10',actionsJobId:'20'});
  expect(bound.execute).toBe(true);expect(bound.binding.hostId).toBe(target.hostId);expect(hosts.get(alternate).resourceReservations).toEqual([]);
  expect(owned.resourceReservations.filter((claim:any)=>claim.kind==='exclusive').map((claim:any)=>claim.id)).toEqual(originalClaimIds);
  for(const key of ['requestId','fleetSelection','fleetPreparation','fleetDeadline','fleetInputSha256'] as const)expect(f.row![key]).toEqual(original[key]);
 },['fixture-data']);
});

test('a remote exclusive claim rolls back when the original borrower operator control changes before commit',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const original=await unassignedLocalInput(f,hosts,true),authority=hosts.get('mini'),borrower=hosts.get('air1'),
   dependency=authority.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='fixture-data');
  borrower.snapshot.lanes[0].resources.find((resource:any)=>resource.kind==='fixture-data').exclusiveDependencies=[{resourceId:dependency.id,authorityHostId:authority.hostId,capability:'google-authentication'}];
  const write=TestHostStateModel.collection.findOneAndUpdate;let withdrawn=false;
  TestHostStateModel.collection.findOneAndUpdate=(async(...args:any[])=>{
   if(args[2]?.session&&args[0].hostId===authority.hostId&&!withdrawn){withdrawn=true;borrower.laneControlVersion++;unavailableLocal(borrower,'out-of-service');}
   return write.apply(TestHostStateModel.collection,args as never);
  }) as any;
  try{
   expect(await new ResourceReservationsService(resourceReservationRepository,()=>Date.now()).reserveFleet(original.requestId,original.fleetInputSha256!,borrower.hostId,'android')).toBeNull();
   expect(withdrawn).toBe(true);expect(f.row).toEqual(original);expect(authority.resourceReservations).toEqual([]);expect(borrower.resourceReservations).toEqual([]);expect(counters).toEqual({host:0,request:0});
   expect(borrower.laneControlVersion).toBe(1);expect(f.row!.fleetBinding).toBeUndefined();
  }finally{TestHostStateModel.collection.findOneAndUpdate=write;}
 },['fixture-data']);
});

test('a current acquired recorder keeps the same original lane when its physical check fails',async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const first=await f.prepareReserved(),target=(first as unknown as {resourceTarget:{hostId:string}}).resourceTarget.hostId,h=hosts.get(target),original=structuredClone(f.row!),claims=structuredClone(h.resourceReservations),writes={...counters};
  unavailableLocal(h,'out-of-service');
  expect((await f.service.preparation(original.requestId)).waitingReason).toBeDefined();
  expect(f.row).toEqual(original);expect(h.resourceReservations).toEqual(claims);expect(counters).toEqual(writes);
  expect([...hosts.values()].filter(host=>host!==h).every(host=>host.resourceReservations.length===0)).toBe(true);
 });
});

for(const serialized of [false,true])test(`a captured controller loses its ${serialized?'serialized':'ordinary'} claim CAS and fresh current authority can complete the original`,async()=>{
 await withLocalResources(async(f,hosts,counters)=>{
  const first=await f.prepareReserved(),target=(first as unknown as {resourceTarget:{hostId:string}}).resourceTarget.hostId,h=hosts.get(target),row=structuredClone(f.row!);
  delete row.fleetResourceReservation;delete row.fleetExclusiveReservation;for(const host of hosts.values())host.resourceReservations=[];
  if(serialized)h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone').capabilities=['backend-connectivity'];f.restore(row);
  const write=TestHostStateModel.collection.findOneAndUpdate;let attempts=0,lostOld=false;
  TestHostStateModel.collection.findOneAndUpdate=mock(async(...args:any[])=>{attempts++;h.incarnation=h.snapshot.incarnation='replacement-controller';h.incarnationGeneration=h.snapshot.incarnationGeneration=478;const value=await write.apply(TestHostStateModel.collection,args as never);if(args[0].incarnation!==h.incarnation)lostOld=value===null;return value}) as never;
  try{const selected=await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,target,'android',h.receivedAt);expect(lostOld).toBe(true);expect(attempts).toBeGreaterThan(1);expect(selected!.fleetResourceAdmission!.intent.controller.incarnation).toBe('replacement-controller');expect(selected!.fleetResourceAdmission!.intent.controller.generation).toBe(478);expect(h.resourceReservations).toEqual([selected!.fleetResourceReservation]);expect(f.row!.fleetInputSha256).toBe(row.fleetInputSha256)}
  finally{TestHostStateModel.collection.findOneAndUpdate=write}
 });
});

test('a current acquired winner observed in the final serialized read prevents another lane byte effect',async()=>{
 await withLocalResources(async(f,hosts)=>{
  const first=await f.prepareReserved(),target=(first as unknown as {resourceTarget:{hostId:string}}).resourceTarget.hostId,h=hosts.get(target),row=structuredClone(f.row!),admission=structuredClone(row.fleetResourceAdmission!),byte=structuredClone(row.fleetResourceReservation!);
  delete row.fleetResourceReservation;delete row.fleetExclusiveReservation;delete row.fleetResourceAdmission;for(const host of hosts.values())host.resourceReservations=[];
  const phone=h.snapshot.lanes[0].resources.find((r:any)=>r.kind==='phone');phone.capabilities=[...phone.capabilities??[],'backend-connectivity'];f.restore(row);
  const alternate=[...hosts.keys()].find(id=>id!==target)!,other=hosts.get(alternate);admission.intent.hostId=alternate;admission.intent.controller={incarnation:other.incarnation,generation:other.incarnationGeneration,sequence:other.sequence};
  const claim={...byte,hostId:alternate,laneId:'android',poolId:`${alternate}:disk:1`};
  const get=spyOn(routineJobRepository,'get').mockImplementation(async()=>{other.resourceReservations=[claim];f.restore({...row,fleetResourceAdmission:admission,fleetResourceReservation:claim});return structuredClone(f.row)});
  try{expect(await routineJobRepository.reserveResources!(row.requestId,row.fleetInputSha256!,target,'android',h.receivedAt)).toBeNull();expect(h.resourceReservations).toEqual([]);expect(f.row!.fleetResourceAdmission).toEqual(admission);expect(f.row!.fleetResourceReservation).toEqual(claim);expect(other.resourceReservations).toEqual([claim])}
  finally{get.mockRestore()}
 });
});

for (const stateName of ['terminal', 'accepted', 'running']) test(`bound cancellation acknowledgement preserves ${stateName} observer state`, async () => {
  const f = fixture(), prepared = await f.prepareReserved();
  await f.service.bind(selection.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: f.lane.id,
    descriptorRevision: f.lane.descriptorRevision!, actionsRunId: '10', actionsJobId: '20'});
  (f.service as any).results = {async detail() {throw new TestRunError(404, 'missing')}};
  const current = f.row!, boundInputSha256 = current.inputSha256 ?? 'c'.repeat(64);
  const cancellation = {requestId: current.requestId, hostId: current.hostId!, inputSha256: boundInputSha256,
    requestedAt: '2026-10-08T00:01:00.000Z', reason: 'Cancelled before routine execution'};
  f.restore({...current, inputSha256: boundInputSha256, state: stateName as StoredRoutineJob['state'], terminalStatus: 'cancelled',
    cancellationAcknowledged: true, hostCancellation: cancellation});
  expect(await f.service.observation(selection.requestId)).toMatchObject({terminal: stateName === 'terminal'});
});

function readyMacAlternate(hosts: Map<string, any>) {
 const alternate=hosts.get('air1'),lane=alternate.snapshot.lanes[0];
 lane.platform='ios-on-mac';lane.descriptorRevision=routineLaneDescriptorRevision(lane);return alternate;
}
test('portable preparation lets the ready worker acquire after the earlier candidate becomes busy', async () => {
  await withLocalResources(async (f, hosts) => {
    const prepared = await f.prepare(), original = structuredClone(f.row!);
    const target = (prepared as {resourceTarget?: {hostId: string}}).resourceTarget?.hostId ?? 'mini';
    const busy = hosts.get(target), ready = [...hosts.values()].find(host => host.hostId !== target)!;
    busy.snapshot.lanes[0].state = 'running';
    busy.snapshot.lanes[0].activity = {generation: 8, owner: {id: 'another-original', kind: 'run', requestId: 'another-original'}};
    const bound = await f.service.bind(original.requestId, ready.hostId, {
      inputSha256: prepared.inputSha256, laneId: ready.snapshot.lanes[0].id,
      descriptorRevision: ready.snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20',
    });
    expect(bound.binding.hostId).toBe(ready.hostId);
    expect(prepared.routingLabels?.some(label => label.startsWith('mentra-host-') || label.startsWith('mentra-lane-'))).toBe(false);
    expect(original.fleetResourceReservation).toBeUndefined();
    expect(busy.resourceReservations).toEqual([]);
    expect(ready.resourceReservations).toHaveLength(1);
    for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
      expect(f.row![key]).toEqual(original[key]);
  });
});
test('portable preparation refreshes a fallback model until an accepted alternate can take the original', async () => {
  await withLocalResources(async (f, hosts) => {
    for (const host of hosts.values()) {
      host.snapshot.lanes[0].state = 'running';
      host.snapshot.lanes[0].activity = {generation: 8, owner: {id: 'another-original', kind: 'run', requestId: 'another-original'}};
    }
    const prepared = await f.prepare(), original = structuredClone(f.row!), reserve = spyOn(f.rows, 'reserveResources');
    const {DispatchCore} = await import(new URL('../../../../../../../testing/host/dispatch/core.ts', import.meta.url).pathname);
    const {awaitRouting} = await import(new URL('../../../../../../../testing/ci/dispatch/prepare.ts', import.meta.url).pathname);
    let refreshes = 0;
    const core = new DispatchCore({url: 'https://core.example', credential: 'software-workflow-token', fetch: async () => {
      refreshes++; return Response.json(await f.service.preparation(original.requestId));
    }});
    try {
      expect(prepared.chosenModel).toBe('g1');
      expect(prepared.waitingReason).toBeDefined();
      const routed = await awaitRouting(prepared, {core, now: () => hosts.get('air1').receivedAt.getTime(), wait: async () => {
        const ready = hosts.get('air1').snapshot.lanes[0]; ready.state = 'idle'; delete ready.activity;
      }});
      expect(refreshes).toBe(1);
      expect(routed.chosenModel).toBe('mentra-live');
      expect(routed.waitingReason).toBeUndefined();
      expect(routed.routingLabels).toEqual(routineRequirementLabels(routed.prepared.requirements, 'mentra-live'));
      expect(reserve).not.toHaveBeenCalled();
      expect(f.row).toEqual(original);
    } finally {reserve.mockRestore();}
  }, [], false, ['g1', 'mentra-live']);
});
test('authenticated portable workers race for one original and duplicate binding preserves its winner', async () => {
  await withLocalResources(async (f, hosts) => {
    const prepared = await f.prepare(), original = structuredClone(f.row!);
    const credentials = {mini: 'software-mini-host-token-at-least-thirty-two', air1: 'software-air-host-token-at-least-thirty-two'};
    const app = new Hono().route('/api/internal/test-requests', createRoutineJobBindingApi(f.service, () => JSON.stringify(credentials)));
    const body = (hostId: 'mini' | 'air1') => ({inputSha256: prepared.inputSha256, laneId: 'android',
      descriptorRevision: hosts.get(hostId).snapshot.lanes[0].descriptorRevision,
      actionsRunId: hostId === 'mini' ? '10' : '11', actionsJobId: hostId === 'mini' ? '20' : '21'});
    const path = `/api/internal/test-requests/${original.requestId}/bind`;
    expect((await app.request(path, {method: 'POST', body: JSON.stringify(body('mini'))})).status).toBe(401);
    const responses = await Promise.all((['mini', 'air1'] as const).map(hostId => app.request(path, {
      method: 'POST', headers: {Authorization: `Bearer ${credentials[hostId]}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body(hostId)),
    })));
    const values = await Promise.all(responses.map(async response => await response.json() as {execute?: boolean}));
    expect(values.filter(value => value.execute === true)).toHaveLength(1);
    const winner = f.row!.fleetBinding!, other = winner.hostId === 'mini' ? 'air1' : 'mini';
    expect(hosts.get(winner.hostId).resourceReservations).toHaveLength(1);
    expect(hosts.get(other).resourceReservations).toEqual([]);
    const claims = structuredClone([...hosts.values()].map(host => host.resourceReservations));
    const retry = await app.request(path, {method: 'POST', headers: {Authorization: `Bearer ${credentials[winner.hostId as keyof typeof credentials]}`,
      'Content-Type': 'application/json'}, body: JSON.stringify(body(winner.hostId as 'mini' | 'air1'))});
    expect((await retry.json() as {binding?: unknown}).binding).toEqual(winner);
    expect(f.row!.fleetBinding).toEqual(winner);
    expect([...hosts.values()].map(host => host.resourceReservations)).toEqual(claims);
    for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
      expect(f.row![key]).toEqual(original[key]);
  });
});
test('a lost authenticated bind response retries the same committed original through DispatchCore', async () => {
  await withLocalResources(async (f, hosts) => {
    const prepared = await f.prepare(), original = structuredClone(f.row!);
    const credential = 'software-mini-host-token-at-least-thirty-two';
    const app = new Hono().route('/api/internal/test-requests', createRoutineJobBindingApi(f.service, () => JSON.stringify({mini: credential})));
    const {DispatchCore} = await import(new URL('../../../../../../../testing/host/dispatch/core.ts', import.meta.url).pathname);
    let loseReply = true, calls = 0;
    const core = new DispatchCore({url: 'https://core.example', credential, fetch: async (url: URL, init: RequestInit) => {
      const response = await app.request(url.pathname, init); calls++;
      if (response.ok && loseReply) {loseReply = false; throw Error('Authenticated bind reply lost after commit');}
      return response;
    }});
    const input = {inputSha256: prepared.inputSha256, laneId: 'android',
      descriptorRevision: hosts.get('mini').snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'};
    await expect(core.bind(original.requestId, input)).rejects.toThrow();
    const winner = structuredClone(f.row!.fleetBinding), claims = structuredClone(hosts.get('mini').resourceReservations);
    expect(winner).toBeDefined();
    expect((await core.bind(original.requestId, input)).binding).toEqual(winner);
    expect(calls).toBe(2);
    expect(hosts.get('mini').resourceReservations).toEqual(claims);
    expect(hosts.get('air1').resourceReservations).toEqual([]);
    for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
      expect(f.row![key]).toEqual(original[key]);
  });
});
test('an original exclusive claim on a withdrawn authority prevents a generic offer or another worker acquisition', async () => {
  await withLocalResources(async (f, hosts) => {
    const prepared = await f.prepare(), original = structuredClone(f.row!);
    const authority = structuredClone(hosts.get('mini'));
    authority.hostId = 'withdrawn-authority';
    authority.resourceReservations = [{kind: 'exclusive', id: 'ef303cad-e9b5-4d3c-b9ea-91c1846a8dab', resourceId: 'private-original-resource',
      authorityHostId: authority.hostId, borrowerHostId: 'mini', laneId: 'android', operationId: `run:${original.requestId}`,
      intentSha256: 'c'.repeat(64), inputSha256: prepared.inputSha256, origin: {kind: 'fleet', fleetInputSha256: prepared.inputSha256},
      owner: {id: original.requestId, kind: 'run'}, controllerIncarnation: 'mini:original', controllerGeneration: 1,
      borrowerSequence: 1, reservedAt: authority.receivedAt.toISOString()}];
    hosts.set(authority.hostId, authority);
    const source = (f.service as any).hosts, list = source.list;
    source.list = async () => (await list()).filter((host: RoutingTestHostState) => host.hostId !== authority.hostId);
    const claim = structuredClone(authority.resourceReservations), reserve = spyOn(f.rows, 'reserveResources');
    try {
      expect((await f.service.preparation(original.requestId)).waitingReason).toBe(RESOURCE_ADMISSION_WAIT);
      expect(reserve).not.toHaveBeenCalled();
      await expect(f.service.bind(original.requestId, 'air1', {inputSha256: prepared.inputSha256, laneId: 'android',
        descriptorRevision: hosts.get('air1').snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'})).rejects.toThrow();
      expect(f.row).toEqual(original);
      expect(authority.resourceReservations).toEqual(claim);
      expect(hosts.get('air1').resourceReservations).toEqual([]);
    } finally {source.list = list; reserve.mockRestore();}
  });
});
for (const cancelledAt of ['before-acquisition', 'after-acquisition'] as const)
test(`portable worker cancellation ${cancelledAt} cannot bind or start another original`, async () => {
  await withLocalResources(async (f, hosts) => {
    const prepared = await f.prepare(), reserve = f.rows.reserveResources!;
    if (cancelledAt === 'before-acquisition') await f.service.cancel(selection.requestId, {reason: 'Original cancelled before worker acquisition'});
    else f.rows.reserveResources = async (...args) => {
      const saved = await reserve(...args);
      await f.service.cancel(selection.requestId, {reason: 'Original cancelled after worker acquisition'});
      return saved;
    };
    await expect(f.service.bind(selection.requestId, 'air1', {inputSha256: prepared.inputSha256, laneId: 'android',
      descriptorRevision: hosts.get('air1').snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'})).rejects.toThrow();
    expect(f.row!.fleetCancellation).toBeDefined();
    expect(f.row!.fleetBinding).toBeUndefined();
    expect(f.row!.hostId).toBeUndefined();
    expect((f.row as StoredRoutineJob & {input?: unknown}).input).toBeUndefined();
    if (cancelledAt === 'before-acquisition') expect(hosts.get('air1').resourceReservations).toEqual([]);
  });
});
for (const loseClaimReply of [false, true])
test(`an already-created unused Mac quota is acquired by the ready authenticated worker without changing frozen inputs (lost claim reply: ${loseClaimReply})`, async () => {
  await withSelectedMacReservation(async (f, mini, _counters, hosts) => {
    const original = structuredClone(f.row!), alternate = readyMacAlternate(hosts);
    mini.snapshot.lanes[0].state = 'running';
    mini.snapshot.lanes[0].activity = {generation: 8, owner: {id: 'another-original', kind: 'run', requestId: 'another-original'}};
    const prepared = await f.service.preparation(original.requestId);
    expect(prepared.routingLabels?.some(label => label.startsWith('mentra-host-') || label.startsWith('mentra-lane-'))).toBe(false);
    const input = {inputSha256: prepared.inputSha256, laneId: alternate.snapshot.lanes[0].id,
      descriptorRevision: alternate.snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'};
    if (loseClaimReply) {
      const reserve = f.rows.reserveResources!;
      f.rows.reserveResources = async (...args) => {const saved = await reserve(...args); throw Error('Replacement claim reply lost after commit');};
      await expect(f.service.bind(original.requestId, alternate.hostId, input)).rejects.toThrow('reply lost');
      expect(f.row!.fleetResourceReservation!.hostId).toBe(alternate.hostId);
      expect(f.row!.fleetBinding).toBeUndefined();
      f.rows.reserveResources = reserve;
    }
    const result = await f.service.bind(original.requestId, alternate.hostId, input);
    expect(result.binding.hostId).toBe(alternate.hostId);
    expect(f.row!.fleetResourceReservation!.hostId).toBe(alternate.hostId);
    expect(mini.resourceReservations).toEqual([]);
    expect(mini.snapshot.lanes[0].activity.owner.id).toBe('another-original');
    for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
      expect(f.row![key]).toEqual(original[key]);
  });
});
test('unused Mac quota does not pin an unbound job to busy Mini; the ready alternate wins the existing request CAS',async()=>{
 await withSelectedMacReservation(async(f,mini,_counters,hosts)=>{
  const original=structuredClone(f.row!),oldQuota=structuredClone(mini.resourceReservations[0]),alternate=readyMacAlternate(hosts);
  mini.snapshot.lanes[0].state='running';mini.snapshot.lanes[0].activity={generation:8,owner:{id:'another-original',kind:'run',requestId:'another-original'}};
  const routed=await f.reservePrepared('air1');
  expect((routed as unknown as {resourceTarget?: {hostId: string; laneId: string}}).resourceTarget).toEqual({hostId:alternate.hostId,laneId:'android'});
  expect(f.row!.fleetResourceReservation!.hostId).toBe(alternate.hostId);expect(f.row!.fleetResourceReservation!.id).not.toBe(oldQuota.id);
  for(const key of ['requestId','fleetSelection','fleetInputSha256','fleetPreparation','fleetDeadline'] as const)expect(f.row![key]).toEqual(original[key]);
  expect(mini.resourceReservations).toEqual([oldQuota]);
  await f.service.preparation(original.requestId);
  expect(mini.resourceReservations).toEqual([]);expect(alternate.resourceReservations).toHaveLength(1);expect(f.row!.fleetBinding).toBeUndefined();
 });
});
for(const custody of ['bound','input','exclusive','local-bytes','current-owner','changed-claim','stale-offer'] as const)test(`unused Mac quota replacement refuses ${custody} custody`,async()=>{
 await withSelectedMacReservation(async(f,mini,_counters,hosts)=>{
  readyMacAlternate(hosts);const row=structuredClone(f.row!),quota=row.fleetResourceReservation!,storage=mini.snapshot.lanes[0].resources.find((r:any)=>r.kind==='recorder').storage;
  if(custody==='bound')row.fleetBinding={hostId:mini.hostId,laneId:quota.laneId} as never;
  if(custody==='input')(row as StoredRoutineJob & {input?:unknown}).input={requestId:row.requestId};
  if(custody==='exclusive')row.fleetExclusiveReservation={} as never;
  if(custody==='local-bytes')storage.reservations=[{requestId:row.requestId,inputSha256:'b'.repeat(64)}];
  if(custody==='current-owner')mini.snapshot.resourceLifecycle.subjects[0].owner={id:row.requestId,kind:'run',generation:7};
  if(custody==='changed-claim')mini.resourceReservations[0].minimumAvailableBytes++;
  if(custody==='stale-offer')storage.observedAt=new Date(mini.receivedAt.getTime()-120001).toISOString();
  expect(replaceableMacRecorderQuota(row,mini,mini.resourceReservations,mini.receivedAt.getTime())).toBe(false);
 });
});
test('Mini binding winning the request CAS prevents alternate quota acquisition',async()=>{
 await withSelectedMacReservation(async(f,mini,counters,hosts)=>{
  const original=structuredClone(f.row!),claims=structuredClone(mini.resourceReservations),before={...counters},alternate=readyMacAlternate(hosts);
  mini.snapshot.lanes[0].state='running';mini.snapshot.lanes[0].activity={generation:8,owner:{id:'other',kind:'run',requestId:'other'}};
  const write=TestRequestModel.collection.findOneAndUpdate;let raced=false;
  TestRequestModel.collection.findOneAndUpdate=(async(...args:any[])=>{
   if(!raced&&args[1]?.$set?.fleetResourceReservation?.hostId===alternate.hostId){raced=true;f.restore({...original,state:'preparing',fleetBinding:{hostId:mini.hostId,laneId:'android'} as never});}
   return (write as any)(...args);
  }) as never;
  try {await f.reservePrepared('air1');expect(raced).toBe(true);expect(f.row!.fleetBinding!.hostId).toBe(mini.hostId);
   expect(mini.resourceReservations).toEqual(claims);expect(alternate.resourceReservations).toEqual([]);expect(counters).toEqual(before);
  }finally{TestRequestModel.collection.findOneAndUpdate=write}
 });
});

test('exclusive acquisition between quota validation and the reread cannot be overwritten by the older candidate',async()=>{
 await withSelectedMacReservation(async(f,mini,counters,hosts)=>{
  const original=structuredClone(f.row!),alternate=readyMacAlternate(hosts),before={...counters};
  mini.snapshot.lanes[0].state='running';mini.snapshot.lanes[0].activity={generation:8,owner:{id:'other',kind:'run',requestId:'other'}};
  const admission=structuredClone(original.fleetResourceAdmission!),resourceId=mini.snapshot.lanes[0].resources.find((r:any)=>r.kind==='recorder').id;
  admission.dependencies=[{resourceId,authorityHostId:mini.hostId,capability:'recording'}];
  const origin={kind:'fleet' as const,fleetInputSha256:original.fleetInputSha256!},intent=admission.intent,
   intentSha256=requestInputDigest({...intent,controller:{incarnation:intent.controller.incarnation,generation:intent.controller.generation},origin,dependencies:admission.dependencies});
  const claim:ExclusiveHostReservation={kind:'exclusive',id:'1f3c2122-d572-40e3-81b6-028e3b186f94',resourceId,
   authorityHostId:mini.hostId,borrowerHostId:mini.hostId,laneId:'android',operationId:intent.operationId,intentSha256,
   inputSha256:original.fleetInputSha256!,owner:intent.owner,origin,controllerIncarnation:intent.controller.incarnation,
   controllerGeneration:intent.controller.generation,borrowerSequence:intent.controller.sequence,reservedAt:mini.receivedAt.toISOString()};
  const acquired={...original,fleetResourceAdmission:admission,fleetExclusiveReservation:{origin,intent,intentSha256,claims:[claim]}};
  const reserve=ResourceReservationsService.prototype.reserveFleet;let raced=false;
  const injection=spyOn(ResourceReservationsService.prototype,'reserveFleet').mockImplementation(async function(this:ResourceReservationsService,...args){
   const result=await reserve.apply(this,args);
   if(!raced&&args[2]===alternate.hostId&&result===undefined){raced=true;mini.resourceReservations.push(claim);mini.resourceReservationVersion++;f.restore(acquired);}
   return result;
  });
  try {await f.reservePrepared('air1');expect(raced).toBe(true);expect(f.row).toEqual(acquired);
   expect(mini.resourceReservations).toEqual([original.fleetResourceReservation,claim]);expect(alternate.resourceReservations).toEqual([]);expect(counters).toEqual(before);
  }finally{injection.mockRestore()}
 });
});

for(const authority of ['borrower','other-host'] as const)test(`unused Mac quota replacement atomically acquires recorder bytes and ${authority} dependency`,async()=>{
 await withSelectedMacReservation(async(f,mini,counters,hosts)=>{
  const original=structuredClone(f.row!),oldQuota=structuredClone(mini.resourceReservations[0]),alternate=readyMacAlternate(hosts),lane=alternate.snapshot.lanes[0],
   authorityHost=authority==='borrower'?alternate:JSON.parse(JSON.stringify(alternate).replaceAll('air1','quota-authority')),
   glasses=authorityHost.snapshot.lanes[0].resources.find((r:any)=>r.kind==='glasses');
  if(authority==='other-host'){
   authorityHost.receivedAt=new Date(alternate.receivedAt);hosts.set(authorityHost.hostId,authorityHost);
   authorityHost.snapshot.lanes[0].platform='android';
   glasses.exclusiveDependencies=[{resourceId:glasses.id,authorityHostId:authorityHost.hostId,capability:'connection'}];
   authorityHost.snapshot.lanes[0].descriptorRevision=routineLaneDescriptorRevision(authorityHost.snapshot.lanes[0]);
  }
  lane.resources.find((r:any)=>r.kind==='glasses').exclusiveDependencies=[{resourceId:glasses.id,authorityHostId:authorityHost.hostId,capability:'connection'}];
  lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  mini.snapshot.lanes[0].state='running';mini.snapshot.lanes[0].activity={generation:8,owner:{id:'other',kind:'run',requestId:'other'}};
  const before={...counters},routed=await f.reservePrepared('air1'),winner=f.row!.fleetResourceReservation!;
  expect((routed as unknown as {resourceTarget?:unknown}).resourceTarget).toEqual({hostId:alternate.hostId,laneId:lane.id});
  expect(winner.hostId).toBe(alternate.hostId);expect(f.row!.fleetExclusiveReservation!.claims).toHaveLength(1);
  expect(f.row!.fleetExclusiveReservation!.intent.hostId).toBe(alternate.hostId);
  expect(alternate.resourceReservations.filter((c:any)=>!isExclusiveHostReservation(c))).toEqual([winner]);
  expect(authorityHost.resourceReservations.filter(isExclusiveHostReservation)).toEqual(f.row!.fleetExclusiveReservation!.claims);
  expect(mini.resourceReservations).toContainEqual(oldQuota);
  // A single existing transaction commits both authorities and the request winner.
  expect(counters.request-before.request).toBe(1);expect(counters.host-before.host).toBe(authority==='borrower'?1:2);
  for(const key of ['requestId','fleetSelection','fleetInputSha256','fleetPreparation','fleetDeadline'] as const)expect(f.row![key]).toEqual(original[key]);
  await f.service.preparation(original.requestId);
  expect(mini.resourceReservations).not.toContainEqual(oldQuota);expect(f.row!.fleetResourceReservation).toEqual(winner);
  expect(f.row!.fleetBinding).toBeUndefined();expect((f.row as any).input).toBeUndefined();
 });
});
test('failed alternate byte CAS leaves neither a dependency-only winner nor a fabricated old quota return',async()=>{
 await withSelectedMacReservation(async(f,mini,counters,hosts)=>{
  const original=structuredClone(f.row!),oldClaims=structuredClone(mini.resourceReservations),alternate=readyMacAlternate(hosts),lane=alternate.snapshot.lanes[0],
   glasses=lane.resources.find((r:any)=>r.kind==='glasses'),before={...counters};
  glasses.exclusiveDependencies=[{resourceId:glasses.id,authorityHostId:alternate.hostId,capability:'connection'}];lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  mini.snapshot.lanes[0].state='running';mini.snapshot.lanes[0].activity={generation:8,owner:{id:'other',kind:'run',requestId:'other'}};
  const write=TestHostStateModel.collection.findOneAndUpdate;let refused=0;
  TestHostStateModel.collection.findOneAndUpdate=(async(filter:any,...args:any[])=>{
   if(filter.hostId===alternate.hostId){refused++;return null;}return (write as any)(filter,...args);
  }) as never;
  try {await f.reservePrepared('air1');expect(refused).toBeGreaterThan(0);expect(f.row).toEqual(original);
   expect(mini.resourceReservations).toEqual(oldClaims);expect(alternate.resourceReservations).toEqual([]);expect(counters).toEqual(before);
  }finally{TestHostStateModel.collection.findOneAndUpdate=write}
 });
});

for(const authority of ['borrower','other-host'] as const)for(const count of [998,999])test(`unused Mac quota replacement respects the combined ${authority} claim limit at ${count}`,async()=>{
 await withSelectedMacReservation(async(f,mini,counters,hosts)=>{
  const original=structuredClone(f.row!),alternate=readyMacAlternate(hosts),lane=alternate.snapshot.lanes[0],
   authorityHost=authority==='borrower'?alternate:JSON.parse(JSON.stringify(alternate).replaceAll('air1','quota-authority')),
   glasses=authorityHost.snapshot.lanes[0].resources.find((r:any)=>r.kind==='glasses');
  if(authority==='other-host'){
   authorityHost.receivedAt=new Date(alternate.receivedAt);hosts.set(authorityHost.hostId,authorityHost);
   authorityHost.snapshot.lanes[0].platform='android';
   glasses.exclusiveDependencies=[{resourceId:glasses.id,authorityHostId:authorityHost.hostId,capability:'connection'}];
   authorityHost.snapshot.lanes[0].descriptorRevision=routineLaneDescriptorRevision(authorityHost.snapshot.lanes[0]);
  }
  lane.resources.find((r:any)=>r.kind==='glasses').exclusiveDependencies=[{resourceId:glasses.id,authorityHostId:authorityHost.hostId,capability:'connection'}];
  lane.descriptorRevision=routineLaneDescriptorRevision(lane);
  authorityHost.resourceReservations=Array.from({length:count},(_,index)=>({kind:'exclusive',id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,
   resourceId:`unrelated-resource:${index}`,authorityHostId:authorityHost.hostId,borrowerHostId:authorityHost.hostId,laneId:'unrelated-lane',
   operationId:`run:foreign-${index}`,intentSha256:'c'.repeat(64),inputSha256:'d'.repeat(64),owner:{id:`foreign-${index}`,kind:'run'},
   controllerIncarnation:authorityHost.incarnation,controllerGeneration:authorityHost.incarnationGeneration,borrowerSequence:authorityHost.sequence,
   reservedAt:authorityHost.receivedAt.toISOString()}));
  mini.snapshot.lanes[0].state='running';mini.snapshot.lanes[0].activity={generation:8,owner:{id:'other',kind:'run',requestId:'other'}};
  const before={...counters},oldClaims=structuredClone(mini.resourceReservations),authorityClaims=structuredClone(authorityHost.resourceReservations),
   routed=await f.reservePrepared('air1');
  if(authority==='borrower'&&count===999){
   expect(f.row).toEqual(original);expect(mini.resourceReservations).toEqual(oldClaims);
   expect(authorityHost.resourceReservations).toEqual(authorityClaims);expect(counters).toEqual(before);
   expect((routed as {resourceTarget?:unknown}).resourceTarget).toEqual({hostId: mini.hostId, laneId: original.fleetResourceReservation!.laneId});
  }else{
   expect((routed as unknown as {resourceTarget?:unknown}).resourceTarget).toEqual({hostId:alternate.hostId,laneId:lane.id});
   expect(authorityHost.resourceReservations).toHaveLength(count+(authority==='borrower'?2:1));
   expect(authorityHost.resourceReservations.length).toBeLessThanOrEqual(1000);
   expect(f.row!.fleetResourceReservation!.hostId).toBe(alternate.hostId);
   expect(f.row!.fleetExclusiveReservation!.claims).toHaveLength(1);
   if(authority==='other-host')expect(alternate.resourceReservations).toHaveLength(1);
  }
  for(const key of ['requestId','fleetSelection','fleetInputSha256','fleetPreparation','fleetDeadline'] as const)expect(f.row![key]).toEqual(original[key]);
  expect(f.row!.fleetBinding).toBeUndefined();expect((f.row as any).input).toBeUndefined();
 });
});

for (const phase of ['admission', 'binding'] as const) for (const reportKind of ['current', 'future'] as const)
  test(`a ${reportKind} host report received during ${phase} ${reportKind === 'current' ? 'binds the same original' : 'cannot bind'}`, async () => {
  await withLocalResources(async (f, hosts) => {
    const prepared = await f.prepare(), original = structuredClone(f.row!), host = hosts.get('mini');
    let current = Date.now(), entered = false, reported = false;
    const clock = spyOn(Date, 'now').mockImplementation(() => current);
    const serviceClock = spyOn(f.service as any, 'now').mockImplementation(() => Date.now());
    const read = TestHostStateModel.collection.findOne, get = resourceReservationRepository.get;
    const reserve = f.rows.reserveResources!, bind = f.rows.bind;
    const report = async () => {
      if (!entered || reported) return;
      reported = true; await Bun.sleep(25); current = new Date().getTime();
      host.receivedAt = new Date(current + (reportKind === 'current' ? -10 : 1000));
      host.snapshot.observedAt = host.receivedAt.toISOString();
      host.sequence++; host.snapshot.sequence++;
    };
    f.rows.reserveResources = async (...args) => {if (phase === 'admission') entered = true; return reserve(...args);};
    f.rows.bind = async (...args) => {if (phase === 'binding') entered = true; return bind(...args);};
    TestHostStateModel.collection.findOne = (async (...args: any[]) => {if (phase === 'admission') await report(); return read.apply(TestHostStateModel.collection, args as never);}) as any;
    resourceReservationRepository.get = async id => {if (phase === 'binding') await report(); return get(id);};
    try {
      const binding = f.service.bind(original.requestId, 'mini', {inputSha256: prepared.inputSha256, laneId: 'android',
        descriptorRevision: host.snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'});
      if (reportKind === 'current') {
        const bound = await binding;
        expect(bound.execute).toBe(true); expect(bound.binding.hostId).toBe('mini');
        expect(host.resourceReservations).toHaveLength(1);
      } else {
        await expect(binding).rejects.toBeInstanceOf(TestRequestConflict);
        await expect(binding).rejects.toThrow('Routine resource admission');
        expect(f.row!.fleetBinding).toBeUndefined();
        expect(host.resourceReservations).toHaveLength(phase === 'admission' ? 0 : 1);
      }
      expect(reported).toBe(true); expect(hosts.get('air1').resourceReservations).toEqual([]);
      for (const key of ['requestId', 'fleetSelection', 'fleetPreparation', 'fleetInputSha256', 'fleetDeadline'] as const)
        expect(f.row![key]).toEqual(original[key]);
    } finally {
      f.rows.reserveResources = reserve; f.rows.bind = bind;
      TestHostStateModel.collection.findOne = read; resourceReservationRepository.get = get;
      serviceClock.mockRestore(); clock.mockRestore();
    }
  });
});


test('a deterministic failed Android bind returns its unused preparation so the next original can acquire the idle lane', async () => {
  const firstSelection = {...selection, requestId: 'battery-original'};
  let first: StoredRoutineJob, retained: unknown[];
  await withLocalResources(async (f, hosts) => {
    const host = hosts.get('mini');
    host.snapshot.lanes[0].resources.find((resource: any) => resource.kind === 'phone').capabilities = ['backend-connectivity'];
    host.snapshot.lanes[0].descriptorRevision = routineLaneDescriptorRevision(host.snapshot.lanes[0]);
    const prepared = await f.prepare(), original = structuredClone(f.row!), replace = resourceReservationRepository.replace;
    resourceReservationRepository.replace = async (captured, claims) => {host.sequence++; host.snapshot.sequence++; return replace(captured, claims);};
    try {
      await expect(f.service.bind(firstSelection.requestId, host.hostId, {inputSha256: prepared.inputSha256,
        laneId: 'android', descriptorRevision: host.snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'}))
        .rejects.toThrow('Routine resource admission did not commit worker binding');
      expect(f.row!.fleetBinding).toBeUndefined();
      expect(f.row!.hostId).toBeUndefined();
      expect(f.row!.dispatchIntent).toBeUndefined();
      for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
        expect(f.row![key]).toEqual(original[key]);
      first = structuredClone(f.row!);
      retained = structuredClone(host.resourceReservations);
    } finally {resourceReservationRepository.replace = replace;}
  }, [], false, ['mentra-live'], firstSelection);
  await withLocalResources(async (f, hosts, _counters, pastRows) => {
    const host = hosts.get('mini');
    host.snapshot.lanes[0].resources.find((resource: any) => resource.kind === 'phone').capabilities = ['backend-connectivity'];
    host.snapshot.lanes[0].descriptorRevision = routineLaneDescriptorRevision(host.snapshot.lanes[0]);
    host.resourceReservations = retained!;
    pastRows.set(first!.requestId, first!);
    const prepared = await f.prepare();
    const result = await f.service.bind(selection.requestId, host.hostId, {inputSha256: prepared.inputSha256,
      laneId: 'android', descriptorRevision: host.snapshot.lanes[0].descriptorRevision, actionsRunId: '11', actionsJobId: '21'});
    expect(result.binding.requestId).toBe(selection.requestId);
    expect(result.binding.hostId).toBe(host.hostId);
    expect(host.resourceReservations.map((claim: any) => claim.requestId)).toEqual([selection.requestId]);
    expect(first!.fleetResourceReservation).toBeUndefined();
    expect(first!.fleetResourceAdmission).toBeUndefined();
  });
});


for (const custody of ['bound', 'input', 'dispatch', 'receipt', 'candidate', 'exclusive', 'local-bytes', 'current-owner', 'changed-claim', 'stale-offer', 'unknown-authority'] as const)
test(`unused preparation return retains ${custody} authority`, async () => {
  await withLocalResources(async (f, hosts) => {
    await f.prepareReserved();
    const row = structuredClone(f.row!), host = hosts.get(row.fleetResourceReservation!.hostId),
      storage = host.snapshot.lanes[0].resources.find((resource: any) => resource.kind === 'recorder').storage;
    if (custody === 'bound') row.fleetBinding = {hostId: host.hostId, laneId: 'android'} as never;
    if (custody === 'input') (row as StoredRoutineJob & {input?: unknown}).input = {requestId: row.requestId};
    if (custody === 'dispatch') row.dispatchIntent = {requestId: row.requestId} as never;
    if (custody === 'receipt') row.hostReceipt = {requestId: row.requestId} as never;
    if (custody === 'candidate') row.fleetCandidatePreparation = {} as never;
    if (custody === 'exclusive') row.fleetExclusiveReservation = {} as never;
    if (custody === 'local-bytes') storage.reservations = [{requestId: row.requestId, inputSha256: 'b'.repeat(64)}];
    if (custody === 'current-owner') host.snapshot.resourceLifecycle.subjects[0].owner = {id: row.requestId, kind: 'run', generation: 7};
    if (custody === 'changed-claim') host.resourceReservations[0].minimumAvailableBytes++;
    if (custody === 'stale-offer') storage.observedAt = new Date(host.receivedAt.getTime() - 120001).toISOString();
    f.restore(row);
    const before = structuredClone(host.resourceReservations), authorities = routineJobRepository.claimedHosts;
    if (custody === 'unknown-authority') routineJobRepository.claimedHosts = async () => [host];
    try {
      expect(await routineJobRepository.releaseUnusedPreparation!(row)).toBe(false);
      expect(f.row).toEqual(row);
      expect(host.resourceReservations).toEqual(before);
    } finally {routineJobRepository.claimedHosts = authorities;}
  });
});

for (const race of ['binding', 'cancellation', 'report', 'controls', 'claims'] as const)
test(`unused preparation return loses ${race} CAS without returning current authority`, async () => {
  await withLocalResources(async (f, hosts, counters) => {
    await f.prepareReserved();
    const original = structuredClone(f.row!), host = hosts.get(original.fleetResourceReservation!.hostId), before = {...counters},
      write = TestRequestModel.collection.findOneAndUpdate, hostWrite = TestHostStateModel.collection.findOneAndUpdate;
    let raced = false;
    TestRequestModel.collection.findOneAndUpdate = (async (...args: any[]) => {
      if (!raced && args[1]?.$unset?.fleetResourceReservation !== undefined && (race === 'binding' || race === 'cancellation')) {
        raced = true;
        f.restore(race === 'binding' ? {...original, state: 'preparing', hostId: host.hostId,
          fleetBinding: {hostId: host.hostId, laneId: 'android'} as never} :
          {...original, fleetCancellation: {requestedAt: host.receivedAt.toISOString(), reason: 'Original cancellation won'}});
      }
      return (write as any)(...args);
    }) as never;
    TestHostStateModel.collection.findOneAndUpdate = (async (...args: any[]) => {
      if (!raced && args[2]?.session && args[1]?.$set?.resourceReservations && !['binding', 'cancellation'].includes(race)) {
        raced = true;
        if (race === 'report') {host.sequence++; host.snapshot.sequence++;}
        if (race === 'controls') host.laneControlVersion++;
        if (race === 'claims') {host.resourceReservationVersion++; host.resourceReservations.push({...original.fleetResourceReservation!, id: 'foreign-byte-claim', requestId: 'another-original'});}
      }
      return (hostWrite as any)(...args);
    }) as never;
    try {
      expect(await routineJobRepository.releaseUnusedPreparation!(original)).toBe(false);
      expect(raced).toBe(true);
      expect(f.row!.fleetResourceReservation).toEqual(original.fleetResourceReservation);
      expect(f.row!.fleetResourceAdmission).toEqual(original.fleetResourceAdmission);
      expect(host.resourceReservations).toContainEqual(original.fleetResourceReservation);
      if (race === 'binding') expect(f.row!.fleetBinding).toBeDefined();
      if (race === 'cancellation') expect(f.row!.fleetCancellation).toBeDefined();
      if (race === 'claims') expect(host.resourceReservations).toHaveLength(2);
      expect(counters).toEqual(before);
    } finally {TestRequestModel.collection.findOneAndUpdate = write; TestHostStateModel.collection.findOneAndUpdate = hostWrite;}
  });
});

for (const committed of [false, true])
test(`a lost Android binding reply retains its exact preparation (binding committed: ${committed})`, async () => {
  await withLocalResources(async (f, hosts) => {
    const host = hosts.get('mini');
    host.snapshot.lanes[0].resources.find((resource: any) => resource.kind === 'phone').capabilities = ['backend-connectivity'];
    host.snapshot.lanes[0].descriptorRevision = routineLaneDescriptorRevision(host.snapshot.lanes[0]);
    const prepared = await f.prepare(), bind = f.rows.bind;
    f.rows.bind = async (...args) => {if (committed) await bind(...args); throw Error('Binding reply lost');};
    const release = spyOn(routineJobRepository, 'releaseUnusedPreparation');
    try {
      await expect(f.service.bind(selection.requestId, host.hostId, {inputSha256: prepared.inputSha256,
        laneId: 'android', descriptorRevision: host.snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'}))
        .rejects.toThrow('Binding reply lost');
      expect(release).not.toHaveBeenCalled();
      expect(Boolean(f.row!.fleetBinding)).toBe(committed);
      expect(f.row!.fleetResourceReservation).toBeDefined();
      expect(f.row!.fleetResourceAdmission).toBeDefined();
      expect(host.resourceReservations).toEqual([f.row!.fleetResourceReservation]);
    } finally {f.rows.bind = bind; release.mockRestore();}
  });
});


test('DispatchCore receives the original 409, then the same original reoffer and duplicate bind preserve one winner', async () => {
  await withLocalResources(async (f, hosts) => {
    const host = hosts.get('mini');
    host.snapshot.lanes[0].resources.find((resource: any) => resource.kind === 'phone').capabilities = ['backend-connectivity'];
    host.snapshot.lanes[0].descriptorRevision = routineLaneDescriptorRevision(host.snapshot.lanes[0]);
    const prepared = await f.prepare(), original = structuredClone(f.row!), credential = 'software-mini-host-token-at-least-thirty-two';
    const app = new Hono().route('/api/internal/test-requests', createRoutineJobBindingApi(f.service, () => JSON.stringify({mini: credential})));
    const {DispatchCore, dispatchCoreFailureDiagnostic} = await import(new URL('../../../../../../../testing/host/dispatch/core.ts', import.meta.url).pathname);
    const statuses: number[] = [], core = new DispatchCore({url: 'https://core.example', credential,
      fetch: async (url: URL, init: RequestInit) => {const response = await app.request(url.pathname, init); statuses.push(response.status); return response;}});
    const input = {inputSha256: prepared.inputSha256, laneId: 'android',
      descriptorRevision: host.snapshot.lanes[0].descriptorRevision, actionsRunId: '10', actionsJobId: '20'}, replace = resourceReservationRepository.replace;
    let raced = false;
    resourceReservationRepository.replace = async (captured, claims) => {
      if (!raced) {raced = true; host.sequence++; host.snapshot.sequence++;}
      return replace(captured, claims);
    };
    try {
      let error: unknown;
      try {await core.bind(original.requestId, input);} catch (failure) {error = failure;}
      expect(dispatchCoreFailureDiagnostic(error)?.status).toBe(409);
      expect(dispatchCoreFailureDiagnostic(error)?.coreError?.message).toBe('Routine resource admission did not commit worker binding');
      expect(f.row!.fleetBinding).toBeUndefined();
      expect(f.row!.fleetResourceReservation).toBeUndefined();
      expect(host.resourceReservations).toEqual([]);
      const reoffered = await f.service.preparation(original.requestId);
      expect(reoffered.routingLabels?.some(label => label.startsWith('mentra-host-') || label.startsWith('mentra-lane-'))).toBe(false);
      const winner = (await core.bind(original.requestId, {...input, actionsRunId: '11', actionsJobId: '21'})).binding,
        claims = structuredClone(host.resourceReservations);
      expect((await core.bind(original.requestId, {...input, actionsRunId: '11', actionsJobId: '21'})).binding).toEqual(winner);
      expect(f.row!.fleetBinding).toEqual(winner);
      expect(host.resourceReservations).toEqual(claims);
      expect(host.resourceReservations).toHaveLength(1);
      expect(statuses).toEqual([409, 200, 200]);
      for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
        expect(f.row![key]).toEqual(original[key]);
    } finally {resourceReservationRepository.replace = replace;}
  });
});
