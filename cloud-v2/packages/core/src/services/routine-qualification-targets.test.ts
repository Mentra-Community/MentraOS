import {expect, mock, test} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {createTestRequestsApi} from '../api/internal/test-requests.api';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import {portableRequirementsSchema, portableRoutineSelectionSchema, routineQualificationTargetSchema, type StoredRoutineJob} from '../types/routine-job.types';
import type {PermissionObservation} from '../types/resource-permissions.types';
import {RoutineJobService, routineJobInputDigest, routineJobRepository, routineLaneDescriptorRevision, type RoutineJobRepository} from './routine-job.service';
import {requestInputDigest, TestRequestService} from './test-request.service';
import {routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {frameworkRequestInputSchema} from '../types/framework-request.types';
import type {ReceivedTestHostState} from './test-host-state.service';

const now = Date.parse('2026-10-14T02:00:00Z'), revision = 'a'.repeat(40), hash = 'b'.repeat(64);
const binding = {...testFrameworkBinding(), version: 1000, routineApiVersion: 38};
const requirements = portableRequirementsSchema.parse({platform: 'ios-on-mac', resources: [
  {kind: 'app', capabilities: ['relaunch'], permissions: [{permission: 'location', recipient: 'app'}]},
  {kind: 'recorder', capabilities: []}]});
function row(jobId = 'pending-ota'): StoredRoutineJob {
  const source = {channel: 'dev', buildRunId: 100, publicationAttempt: 1};
  const selection = portableRoutineSelectionSchema.parse({requestId: jobId, routineId: 'ota-test', platform: 'ios-on-mac',
    routineRevision: revision, source, build: {repository: 'Mentra-Community/MentraOS', headSha: revision, channel: 'dev',
      kind: 'mac-ci-package', source, archive: {name: 'Mentra.zip', url: 'https://artifactscdn.mentraglass.com/selected.zip', sha256: hash, size: 100},
      receipt: {url: 'https://artifactscdn.mentraglass.com/selected.json', sha256: hash, size: 100}}});
  const definition = {id: 'ota-test', minimumRoutineApiVersion: 38, title: 'OTA', purpose: 'Check the selected app',
    platforms: ['ios-on-mac'], entry: 'home', account: 'lane', requirements: [], fixtures: [],
    steps: [{id: 'check', instruction: 'Check updates', expected: 'Updates checked'}],
    execution: {resourceKinds: ['app', 'recorder']}, resourceRequirements: structuredClone(requirements.resources),
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision, path: 'routines/ota-test/routine.ts'}};
  const value = {requestId: jobId, state: 'awaiting-runner' as const, fleetSelection: selection,
    fleetSelectionSha256: requestInputDigest(selection), fleetDeadline: new Date(now + 60_000),
    fleetPreparation: {routineSource: {...testRoutineSource(revision), minimumRoutineApiVersion: 38},
      definitionSha256: requestInputDigest(definition), definition, requirements: structuredClone(requirements)}} as StoredRoutineJob;
  value.fleetInputSha256 = routineJobInputDigest(value);
  return value;
}
function host(): ReceivedTestHostState {
  return {hostId: 'pro1', incarnation: 'boot', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), frameworkBinding: binding,
    lanes: [{id: 'pro1-mac', platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic', resources: [
      {id: 'app', kind: 'app', capabilities: ['relaunch']}, {id: 'recorder', kind: 'recorder'}]}]};
}
function granted(): PermissionObservation {
  return {permission: 'location', status: 'granted', rawStatus: 'authorizedAlways', observedAt: new Date(now).toISOString(), binding,
    recipient: {kind: 'app', uid: 501, pid: 123, processStartedAt: 'observed-process', launchedAt: now - 1000,
      bundleId: 'com.mentra.mentra', bundlePath: '/Applications/Mentra.app', executablePath: '/Applications/Mentra.app/Mentra',
      version: '3.3.0', build: '100', teamId: 'TEAM', codeRequirement: 'verified requirement',
      selectedBuild: {headSha: revision, archiveSha256: hash, receiptSha256: hash}}, evidence: {sha256: hash}};
}
function queuedRow(jobId = 'queued-ota') {
  const value = row(jobId), observed = host();
  const input = frameworkRequestInputSchema.parse({routineId: value.fleetSelection.routineId, platform: value.fleetSelection.platform,
    definitionRevision: revision, routineSource: value.fleetPreparation!.routineSource, laneId: 'pro1-mac', build: value.fleetSelection.build,
    resources: observed.lanes[0]!.resources.map(({id, kind}) => ({id, kind, laneId: 'pro1-mac'}))});
  const intent = routineDispatchIntentSchema.parse({...value.fleetSelection, routineSource: value.fleetPreparation!.routineSource, laneId: 'pro1-mac'});
  return {...value, state: 'queued' as const, hostId: 'pro1', input, inputSha256: requestInputDigest(input),
    dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent),
    fleetBinding: {jobId, requestId: jobId, hostId: 'pro1', laneId: 'pro1-mac', descriptorRevision: routineLaneDescriptorRevision(observed.lanes[0]!),
      actionsRunId: '1', actionsJobId: '2', boundAt: new Date(now - 1000).toISOString()}};
}
function fixture(rows = [row()], observed = host()) {
  const reads: unknown[] = [];
  const forbidden = async (): Promise<never> => {throw new Error('Qualification must not mutate or resolve source/builds');};
  const repository: RoutineJobRepository = {async get(jobId,timeoutMS) {reads.push({jobId,timeoutMS});return structuredClone(rows.find(value=>value.requestId===jobId) ?? null);}, insert: forbidden, prepare: forbidden, bind: forbidden, cancel: forbidden,
    async *qualificationCandidates(hostId, laneId, limit, at, timeoutMS, includeQueued, includeAccepted) {reads.push({hostId, laneId, limit, at, timeoutMS, includeQueued, includeAccepted});
      yield* structuredClone(rows.filter(value => includeQueued || value.state === 'awaiting-runner'));}};
  const service = new RoutineJobService(repository, {resolve: forbidden, isPrSuperseded: forbidden},
    {resolve: forbidden, inventory: forbidden, blob: forbidden}, {getExact: forbidden},
    {async get(id) {expect(id).toBe('pro1'); return structuredClone(observed);}}, {cancel: forbidden}, {detail: forbidden}, () => now);
  return {service, reads, rows, observed};
}

test('an unseen selected build becomes a bounded read-only target while its original job remains unbound', async () => {
  const f = fixture(), before = structuredClone(f.rows), targets = await f.service.qualificationTargets('pro1');
  expect(targets).toHaveLength(1);
  const {inputSha256, ...target} = targets[0]!;
  expect(target).toEqual({jobId: 'pending-ota', hostId: 'pro1', laneId: 'pro1-mac', deadline: new Date(now + 60_000).toISOString(),
    selection: f.rows[0]!.fleetSelection, requirements});
  expect(inputSha256).toBe(requestInputDigest(target));
  expect(inputSha256).not.toBe(f.rows[0]!.fleetInputSha256);
  expect(f.reads).toEqual([{hostId: 'pro1', laneId: 'pro1-mac', limit: 100, at: new Date(now), timeoutMS: 5000, includeQueued: true, includeAccepted: false}]);
  expect(f.rows).toEqual(before);
  expect(f.rows[0]).not.toHaveProperty('fleetBinding');
  expect(f.rows[0]).not.toHaveProperty('hostReceipt');
  expect(f.rows[0]).not.toHaveProperty('dispatchIntent');
  expect(requestInputDigest({...target, selection: {...target.selection, build: {...target.selection.build, headSha: 'c'.repeat(40)}}})).not.toBe(inputSha256);
});

test('target constraints, cancellation, expiry, bound state and structural mismatches cannot produce a candidate', async () => {
  const invalid = [
    {...row('other-host'), fleetTarget: {hostId: 'other'}},
    {...row('other-lane'), fleetTarget: {hostId: 'pro1', laneId: 'other'}},
    {...row('cancelled'), fleetCancellation: {requestedAt: new Date(now).toISOString(), reason: 'Cancelled'}},
    {...row('expired'), fleetDeadline: new Date(now)},
    {...row('accepted'), state: 'accepted' as const, hostId: 'pro1'},
    {...row('unprepared'), state: 'awaiting-source' as const, fleetPreparation: undefined},
  ];
  expect(await fixture(invalid).service.qualificationTargets('pro1')).toEqual([]);
  const selected = row(); selected.fleetTarget = {hostId: 'pro1', laneId: 'pro1-mac'};
  selected.fleetInputSha256 = routineJobInputDigest(selected);
  expect((await fixture([selected]).service.qualificationTargets('pro1'))[0]?.target).toEqual(selected.fleetTarget);
  const wrongResources = host(); wrongResources.lanes[0]!.resources[0]!.capabilities = [];
  expect(await fixture([row()], wrongResources).service.qualificationTargets('pro1')).toEqual([]);
});

test('an unaccepted queued handoff refreshes only its exact assigned build and lane without replacing input or ownership', async () => {
  const original = queuedRow(), observed = host(); observed.lanes.push({...structuredClone(observed.lanes[0]!), id: 'other-mac'});
  const f = fixture([original], observed), before = structuredClone(original), targets = await f.service.qualificationTargets('pro1');
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({jobId: original.requestId, hostId: 'pro1', laneId: 'pro1-mac', deadline: original.fleetDeadline.toISOString(),
    selection: original.fleetSelection, target: {hostId: 'pro1', laneId: 'pro1-mac'}});
  expect(f.rows[0]).toEqual(before); expect(f.rows[0]!.inputSha256).toBe(original.inputSha256);
  const fresh = host(); fresh.lanes[0]!.resources[0]!.permissionObservations = [granted()];
  expect(await fixture([original], fresh).service.qualificationTargets('pro1')).toEqual([]);
});

test('staged resource admission qualifies only its original host and lane without choosing another compatible target', async () => {
  const original = row(), observed = host();
  original.fleetResourceAdmission = {intent: {operationId: `run:${original.requestId}`, hostId: 'pro1', laneId: 'pro1-mac',
    controller: {incarnation: observed.incarnation, generation: observed.incarnationGeneration, sequence: observed.sequence},
    owner: {id: original.requestId, kind: 'run'}, inputSha256: original.fleetInputSha256!,
    resources: [{id: 'app', capabilities: ['relaunch']}, {id: 'recorder', capabilities: []}]}, dependencies: []};
  observed.lanes.push({...structuredClone(observed.lanes[0]!), id: 'other-mac'});
  const f = fixture([original], observed), before = structuredClone(original);
  expect((await f.service.qualificationTargets('pro1')).map(target => target.target)).toEqual([{hostId: 'pro1', laneId: 'pro1-mac'}]);
  expect(f.rows[0]).toEqual(before);
  const changedInventory = host(); changedInventory.lanes[0]!.resources[0]!.id = 'replacement-app';
  expect(await fixture([original], changedInventory).service.qualificationTargets('pro1')).toEqual([]);
  for (const change of [
    (value: typeof original) => {value.fleetResourceAdmission!.intent.hostId = 'other';},
    (value: typeof original) => {value.fleetResourceAdmission!.intent.laneId = 'other';},
    (value: typeof original) => {value.fleetResourceAdmission!.intent.owner.id = 'other';},
    (value: typeof original) => {value.fleetResourceAdmission!.intent.inputSha256 = 'c'.repeat(64);},
    (value: typeof original) => {value.fleetResourceAdmission!.intent.resources.pop();},
    (value: typeof original) => {value.fleetResourceAdmission!.intent.resources[0]!.capabilities = [];},
  ]) {
    const value = structuredClone(original); change(value);
    expect(await fixture([value]).service.qualificationTargets('pro1')).toEqual([]);
  }
});

test('only the compatible canonical framework source receives queued targets; older workers retain unbound discovery', async () => {
  for (const routineApiVersion of [38, 43]) {
    const old = host(); old.frameworkBinding = {...binding, version: 998, routineApiVersion};
    expect(await fixture([queuedRow()], old).service.qualificationTargets('pro1')).toEqual([]);
    expect((await fixture([row()], old).service.qualificationTargets('pro1'))[0]?.jobId).toBe('pending-ota');
    const many = fixture([...Array.from({length: 101}, (_, index) => queuedRow(`queued-${index}`)), row()], old);
    expect((await many.service.qualificationTargets('pro1'))[0]?.jobId).toBe('pending-ota');
    expect(many.reads[0]).toMatchObject({includeQueued: false, limit: 100});
  }
  for (const version of [999, 1000]) {
    const current = host(); current.frameworkBinding = {...binding, version, routineApiVersion: 43};
    expect((await fixture([queuedRow()], current).service.qualificationTargets('pro1'))[0]?.target).toEqual({hostId: 'pro1', laneId: 'pro1-mac'});
  }
});

test('queued handoff proof refuses changed process selection, immutable input, source, resources or original binding', async () => {
  const changes: Array<(value: ReturnType<typeof queuedRow>) => void> = [
    value => {value.hostId = 'other';}, value => {value.fleetBinding.hostId = 'other';}, value => {value.fleetBinding.laneId = 'other';},
    value => {value.fleetBinding.jobId = 'other';}, value => {value.fleetBinding.requestId = 'other';},
    value => {value.fleetBinding.descriptorRevision = 'c'.repeat(64);},
    value => {value.inputSha256 = 'c'.repeat(64);}, value => {value.dispatchIntentSha256 = 'c'.repeat(64);},
    value => {value.input.laneId = 'other'; value.inputSha256 = requestInputDigest(value.input);},
    value => {value.input.routineId = 'other'; value.inputSha256 = requestInputDigest(value.input);},
    value => {value.input.build.headSha = 'c'.repeat(40); value.inputSha256 = requestInputDigest(value.input);},
    value => {value.input.routineSource.bundle.sha256 = 'c'.repeat(64); value.inputSha256 = requestInputDigest(value.input);},
    value => {value.input.resources[0]!.id = 'other-app'; value.inputSha256 = requestInputDigest(value.input);},
    value => {value.input.resources.push(structuredClone(value.input.resources[0]!)); value.inputSha256 = requestInputDigest(value.input);},
    value => {value.input.policy = {estimatedOutputBytes: 1}; value.inputSha256 = requestInputDigest(value.input);},
    value => {value.dispatchIntent = {...value.dispatchIntent, laneId: 'other'}; value.dispatchIntentSha256 = requestInputDigest(value.dispatchIntent);},
  ];
  for (const change of changes) {const value = queuedRow(); change(value); expect(await fixture([value]).service.qualificationTargets('pro1')).toEqual([]);}
  const changed = host(); changed.lanes[0]!.resources[0]!.capabilities!.push('launch');
  expect(await fixture([queuedRow()], changed).service.qualificationTargets('pro1')).toEqual([]);
});

test('a queued state cannot obscure accepted, canceled, rejected, completed or active custody', async () => {
  const original = queuedRow();
  for (const evidence of [{hostReceipt: {requestId: original.requestId, hostId: 'pro1', inputSha256: original.inputSha256, acceptedAt: new Date(now).toISOString()}},
    {runId: original.requestId}, {dispatchCompletion: {inputSha256: original.inputSha256, disposition: 'clean' as const, completedAt: new Date(now).toISOString()}},
    {hostCancellation: {requestedAt: new Date(now).toISOString(), reason: 'Canceled'}}, {hostRejection: {code: 'invalid-source', reason: 'Rejected'}},
    {fleetCancellation: {requestedAt: new Date(now).toISOString(), reason: 'Canceled'}},
    {preparationCancellation: {requestedAt: new Date(now).toISOString(), reason: 'Canceled'}}, {preparationRejection: {code: 'invalid-source', reason: 'Rejected'}}])
    expect(await fixture([{...original, ...evidence}]).service.qualificationTargets('pro1')).toEqual([]);
  for (const state of ['accepted', 'running', 'terminal'] as const)
    expect(await fixture([{...original, state}]).service.qualificationTargets('pro1')).toEqual([]);
  const busy = host(); busy.lanes[0]!.state = 'reserved';
  expect(await fixture([original], busy).service.qualificationTargets('pro1')).toEqual([]);
});

test('active custody, paused/offline lanes, stale reports and older worker API never start target discovery', async () => {
  for (const state of ['running', 'reserved', 'in-repair', 'out-of-service', 'offline'] as const) {
    const observed = host(); observed.lanes[0]!.state = state;
    const f = fixture([row()], observed);
    expect(await f.service.qualificationTargets('pro1')).toEqual([]); expect(f.reads).toEqual([]);
  }
  for (const change of [
    (observed: ReceivedTestHostState) => {observed.lanes[0]!.dispatchMode = 'paused';},
    (observed: ReceivedTestHostState) => {observed.receivedAt = new Date(now - 120_001).toISOString();},
    (observed: ReceivedTestHostState) => {observed.receivedAt = new Date(now + 1).toISOString();},
    (observed: ReceivedTestHostState) => {observed.frameworkBinding = {...binding, routineApiVersion: 37};},
  ]) {const observed = host(); change(observed); const f = fixture([row()], observed);
    expect(await f.service.qualificationTargets('pro1')).toEqual([]); expect(f.reads).toEqual([]);}
});

test('an exact fresh app grant skips preparation; stale or different selected-build evidence still needs qualification', async () => {
  for (const qualificationNeeded of [false, true]) {
    const observed = host(), observation = granted();
    if (qualificationNeeded) observation.recipient = {...observation.recipient, selectedBuild: {headSha: 'c'.repeat(40), archiveSha256: hash, receiptSha256: hash}} as PermissionObservation['recipient'];
    observed.lanes[0]!.resources[0]!.permissionObservations = [observation];
    expect(await fixture([row()], observed).service.qualificationTargets('pro1')).toHaveLength(qualificationNeeded ? 1 : 0);
  }
  const observed = host(); observed.lanes[0]!.resources[0]!.permissionObservations = [{...granted(), observedAt: new Date(now - 120_001).toISOString()}];
  expect(await fixture([row()], observed).service.qualificationTargets('pro1')).toHaveLength(1);
});

test('one candidate per lane does not replace permissionless jobs or expose inconsistent exact inputs', async () => {
  const observed = host(); observed.lanes.push({...structuredClone(observed.lanes[0]!), id: 'second-mac'});
  const f = fixture([row(), row('later')], observed), targets = await f.service.qualificationTargets('pro1');
  expect(targets.map(value => [value.jobId, value.laneId])).toEqual([['pending-ota', 'pro1-mac'], ['pending-ota', 'second-mac']]);
  expect(targets[0]!.inputSha256).not.toBe(targets[1]!.inputSha256);
  const plain = row(); delete plain.fleetPreparation!.requirements.resources[0]!.permissions;
  plain.fleetInputSha256 = routineJobInputDigest(plain);
  expect(await fixture([plain]).service.qualificationTargets('pro1')).toEqual([]);
  const corrupted = row(); corrupted.fleetSelection.build.headSha = 'c'.repeat(40);
  await expect(fixture([corrupted]).service.qualificationTargets('pro1')).rejects.toThrow('Stored routine job exact inputs are unavailable');
  expect(routineQualificationTargetSchema.safeParse({...targets[0], jobId: 'other'}).success).toBe(false);
});

test('ordered streaming skips incompatible and already qualified rows without a separate query-language matcher', async () => {
  const first = row('already-qualified'), later = row('unseen-build');
  later.fleetSelection.build.headSha = 'c'.repeat(40);
  later.fleetSelectionSha256 = requestInputDigest(later.fleetSelection);
  later.fleetInputSha256 = routineJobInputDigest(later);
  const observed = host(); observed.lanes[0]!.resources[0]!.permissionObservations = [granted()];
  expect((await fixture([...Array.from({length: 26}, () => structuredClone(first)), later], observed)
    .service.qualificationTargets('pro1'))[0]?.jobId).toBe('unseen-build');
  expect(await fixture([...Array.from({length: 100}, () => structuredClone(first)), later], observed)
    .service.qualificationTargets('pro1')).toEqual([]);
});

test('all candidate streams share the query deadline and stop before a target is returned after it expires', async () => {
  const f = fixture(), service = f.service as unknown as {now: () => number};
  const times = [now, now + 1, now + 2, now + 5_000];
  service.now = () => times.shift() ?? now + 5_000;
  expect(await f.service.qualificationTargets('pro1')).toEqual([]);
  expect(f.reads).toEqual([{hostId: 'pro1', laneId: 'pro1-mac', limit: 100, at: new Date(now), timeoutMS: 4998, includeQueued: true, includeAccepted: false}]);
});

test('the authenticated poll only includes explicitly requested targets and does not bind or acknowledge a product', async () => {
  const f = fixture();
  class Requests extends TestRequestService {override async queued() {return {requests: [], preparations: [], dispatchCompletions: [], nextCursor: null};}}
  const token = 'controller-qualification-test-' + 'x'.repeat(32), headers = {authorization: `Bearer ${token}`};
  const api = createTestRequestsApi(new Requests(), () => JSON.stringify({pro1: token}), undefined, undefined, f.service);
  expect(await (await api.request('/?hostId=other', {headers})).json()).toEqual({requests: [], preparations: [], dispatchCompletions: [], nextCursor: null});
  expect(f.reads).toEqual([]);
  const response = await api.request('/?qualificationTargets=1&hostId=other', {headers});
  expect(response.status).toBe(200);
  const page = await response.json() as {qualificationTargets: unknown[]};
  expect(routineQualificationTargetSchema.parse(page.qualificationTargets[0])).toMatchObject({hostId: 'pro1', laneId: 'pro1-mac'});
  expect((await api.request('/?qualificationTargets=0', {headers})).status).toBe(400);
  expect((await api.request('/?qualificationTargets=1')).status).toBe(401);
  expect(f.rows[0]!.state).toBe('awaiting-runner');
});

test('candidate database stream is bounded, closed and includes only unbound or exact unaccepted queued handoffs without writes', async () => {
  for (const [includeQueued, includeAccepted] of [[false,false],[true,false],[true,true]]) {
  let filter: unknown, limit: number | undefined, closed = false;
  const cursor = {async *[Symbol.asyncIterator]() {yield row();}, async close() {closed = true;}};
  const query = {sort(value: unknown) {expect(value).toEqual(includeAccepted ? {'hostReceipt.acceptedAt': -1, state: -1, createdAt: 1, requestId: 1} :
    includeQueued ? {state: -1, createdAt: 1, requestId: 1} : {createdAt: 1, requestId: 1}); return this;},
    limit(value: number) {limit = value; return this;}, read(value: string) {expect(value).toBe('primary'); return this;},
    readConcern(value: string) {expect(value).toBe('majority'); return this;},
    setOptions(value: unknown) {expect(value).toEqual({timeoutMS: 123, maxTimeMS: 123}); return this;},
    lean() {return this;}, cursor(value: unknown) {expect(value).toEqual({batchSize: 20}); return cursor;}};
  const original = TestRequestModel.find;
  try {
    TestRequestModel.find = mock((value: unknown) => {filter = value; return query;}) as unknown as typeof TestRequestModel.find;
    for await (const candidate of routineJobRepository.qualificationCandidates!('pro1', 'pro1-mac', 100, new Date(now), 123, includeQueued, includeAccepted)) {
      expect(candidate.requestId).toBe('pending-ota'); break;
    }
    expect(limit).toBe(100); expect(closed).toBe(true);
    expect(filter).toMatchObject({...includeQueued ? {$or: [{state: 'awaiting-runner', hostId: {$exists: false}, fleetBinding: {$exists: false}, hostReceipt: {$exists: false}},
      {state: 'queued', hostId: 'pro1', 'fleetBinding.hostId': 'pro1', 'fleetBinding.laneId': 'pro1-mac', 'input.laneId': 'pro1-mac', inputSha256: {$exists: true}, hostReceipt: {$exists: false}},
      ...includeAccepted ? [{state:'accepted',hostId:'pro1','fleetBinding.hostId':'pro1','fleetBinding.laneId':'pro1-mac','input.laneId':'pro1-mac',inputSha256:{$exists:true},'hostReceipt.hostId':'pro1'}] : []]} :
      {state: 'awaiting-runner', hostId: {$exists: false}, fleetBinding: {$exists: false}, hostReceipt: {$exists: false}},
      runId: {$exists: false}, dispatchCompletion: {$exists: false},
      hostCancellation: {$exists: false}, hostRejection: {$exists: false}, preparationCancellation: {$exists: false}, preparationRejection: {$exists: false},
      fleetCancellation: {$exists: false}, fleetDeadline: {$gt: new Date(now)}, 'fleetSelection.platform': 'ios-on-mac', fleetPreparation: {$exists: true},
      $and: [{$or: [{'fleetTarget.hostId': {$exists: false}}, {'fleetTarget.hostId': 'pro1'}]},
        {$or: [{'fleetTarget.laneId': {$exists: false}}, {'fleetTarget.laneId': 'pro1-mac'}]},
        {$or: [{fleetResourceAdmission: {$exists: false}},
          {'fleetResourceAdmission.intent.hostId': 'pro1', 'fleetResourceAdmission.intent.laneId': 'pro1-mac'}]}]});
    if (!includeQueued) expect(filter).not.toHaveProperty('$or');
  } finally {TestRequestModel.find = original;}
  }
});

function acceptedHost() {
 const current=host();current.frameworkBinding={...binding,version:1053,routineApiVersion:51};
 (current.lanes[0]!.resources.find(value=>value.kind==='recorder') as any).storage={poolId:'pro1-pool',observedAt:new Date(now).toISOString(),availableBytes:20*1024**3,stagingBudgetBytes:20*1024**3,pendingEvidenceBytes:0,reservations:[]};
 return current;
}
function acceptedRow() {
 const value=queuedRow('accepted-original');
 (value.fleetPreparation!.definition as any).execution.policy={estimatedOutputBytes:0};
 value.input.policy={estimatedOutputBytes:0};value.inputSha256=requestInputDigest(value.input);
 value.fleetPreparation!.definitionSha256=requestInputDigest(value.fleetPreparation!.definition);value.fleetInputSha256=routineJobInputDigest(value);
 return{...value,state:'accepted' as const,hostReceipt:{requestId:value.requestId,hostId:'pro1',inputSha256:value.inputSha256,
  acceptedAt:new Date(now-500).toISOString()}}
}
test('an accepted original remains reachable before the finite cap of earlier incompatible candidates', async () => {
 const original=acceptedRow(), rows=[...Array.from({length:100},(_,index)=>{
  const value=row(`earlier-${index}`);value.fleetPreparation!.requirements.resources[0]!.capabilities=['unoffered'];
  value.fleetInputSha256=routineJobInputDigest(value);return value;
 }),original];
 let order:Record<string,number>={},limit=0,scanned=0,closed=false;
 const query={sort(value:Record<string,number>){order=value;return this},limit(value:number){limit=value;return this},
  read(){return this},readConcern(){return this},setOptions(){return this},lean(){return this},cursor(){return{
   async *[Symbol.asyncIterator](){
    const ordered=[...rows].sort((left,right)=>{for(const[field,direction]of Object.entries(order)){
     const read=(row:unknown)=>field.split('.').reduce<unknown>((value,key)=>value&&typeof value==='object'?(value as Record<string,unknown>)[key]:undefined,row);
     const a=read(left),b=read(right);if(a===b)continue;if(a===undefined)return-direction;if(b===undefined)return direction;
     return(String(a)<String(b)?-1:1)*direction;
    }return 0});
    for(const value of ordered.slice(0,limit)){scanned++;yield value}
   },async close(){closed=true},
  }}};
 const find=TestRequestModel.find,f=fixture([],acceptedHost());
 (f.service as unknown as {rows:RoutineJobRepository}).rows.qualificationCandidates=routineJobRepository.qualificationCandidates;
 try{TestRequestModel.find=mock(()=>query) as unknown as typeof find;
  expect((await f.service.qualificationTargets('pro1')).map(value=>value.jobId)).toEqual([original.requestId]);
  expect(limit).toBe(100);expect(scanned).toBe(1);expect(closed).toBe(true);
 }finally{TestRequestModel.find=find}
});
test('exact accepted unstarted request gets a current-binding target with a separate immutable executable digest',async()=>{
 const original=acceptedRow(),current=acceptedHost()
 const f=fixture([original],current),before=structuredClone(original),targets=await f.service.qualificationTargets('pro1')
 expect(targets).toHaveLength(1)
 expect(targets[0]).toMatchObject({jobId:original.requestId,hostId:'pro1',laneId:'pro1-mac',deadline:original.fleetDeadline.toISOString(),
  accepted:{...original.hostReceipt,binding:current.frameworkBinding,controller:{incarnation:current.incarnation,generation:current.incarnationGeneration}},
  selection:{...original.fleetSelection,routineSource:original.fleetPreparation!.routineSource},target:{hostId:'pro1',laneId:'pro1-mac'}})
 const{inputSha256,...body}=targets[0]!;expect(inputSha256).toBe(requestInputDigest(body));expect(inputSha256).not.toBe(original.inputSha256)
 expect(f.rows[0]).toEqual(before);expect(f.reads[0]).toMatchObject({includeAccepted:true})
 const old=host();old.frameworkBinding={...binding,version:1053,routineApiVersion:50};expect(await fixture([original],old).service.qualificationTargets('pro1')).toEqual([])
})
test('accepted target rejects wrong receipt, original source and canceled/running/completed identities',async()=>{
 const current=acceptedHost()
 for(const change of [
  (v:ReturnType<typeof acceptedRow>)=>{v.hostReceipt.requestId='other'},
  (v:ReturnType<typeof acceptedRow>)=>{v.hostReceipt.inputSha256='f'.repeat(64)},
  (v:ReturnType<typeof acceptedRow>)=>{v.hostReceipt.hostId='other'},
  (v:ReturnType<typeof acceptedRow>)=>{v.hostReceipt.acceptedAt=new Date(now+1).toISOString()},
  (v:ReturnType<typeof acceptedRow>)=>{v.input.resources[0]!.id='other';v.inputSha256=requestInputDigest(v.input);v.hostReceipt.inputSha256=v.inputSha256},
 ]){const value=acceptedRow();change(value);expect(await fixture([value],current).service.qualificationTargets('pro1')).toEqual([])}
 for(const extra of [{runId:'original'},{dispatchCompletion:{inputSha256:acceptedRow().inputSha256,disposition:'clean' as const,completedAt:new Date(now).toISOString()}},
  {fleetCancellation:{requestedAt:new Date(now).toISOString(),reason:'Original canceled'}},
  {hostCancellation:{requestedAt:new Date(now).toISOString(),reason:'Original canceled'}},
  {state:'running' as const},{state:'terminal' as const}]){
  expect(await fixture([{...acceptedRow(),...extra}],current).service.qualificationTargets('pro1')).toEqual([])
 }
})

test('accepted target preserves exact dependency authority and counts its own retained recorder reservation only once',async()=>{
 const gib=1024**3,original=acceptedRow(),current=acceptedHost();
 const dependency={resourceId:'account',authorityHostId:'mini',capability:'google-sign-in'};
 // The execution and current offer must retain the same dependency identity.
 const fixtureResource={id:'fixture',kind:'fixture-data' as const,capabilities:['google-sign-in'],exclusiveDependencies:[dependency]};
 current.lanes[0]!.resources.push(fixtureResource as never);
 original.fleetPreparation!.requirements.resources.push({kind:'fixture-data',capabilities:[]} as never);
 (original.fleetPreparation!.definition as any).resourceRequirements.push({kind:'fixture-data',capabilities:[]});
 original.fleetPreparation!.definitionSha256=requestInputDigest(original.fleetPreparation!.definition);
 original.input.resources.push({id:'fixture',kind:'fixture-data',laneId:'pro1-mac',exclusiveDependencies:[dependency]} as never);
 const estimate=3*gib;(original.fleetPreparation!.definition as any).execution.policy={estimatedOutputBytes:estimate};
 original.input.policy={estimatedOutputBytes:estimate};
 original.fleetPreparation!.definitionSha256=requestInputDigest(original.fleetPreparation!.definition);
 original.inputSha256=requestInputDigest(original.input);original.hostReceipt.inputSha256=original.inputSha256;
 const recorder=current.lanes[0]!.resources.find(value=>value.kind==='recorder')!;
 (recorder as any).storage={poolId:'pro1-pool',observedAt:new Date(now).toISOString(),availableBytes:6*gib,stagingBudgetBytes:4*gib,pendingEvidenceBytes:0,
  reservations:[{requestId:original.requestId,inputSha256:original.inputSha256,remainingOutputBytes:estimate},
   {requestId:'other',inputSha256:'d'.repeat(64),remainingOutputBytes:gib}]};
 // Routing descriptor excludes observation values, but includes dependency identities.
 original.fleetBinding.descriptorRevision=routineLaneDescriptorRevision(current.lanes[0]!);
 original.fleetInputSha256=routineJobInputDigest(original);
 const targets=await fixture([original],current).service.qualificationTargets('pro1');expect(targets).toHaveLength(1);
 expect(targets[0]!.requirements.resources.find(value=>value.kind==='recorder')!.storage!.minimumAvailableBytes).toBe(5*gib);
 const wrong=structuredClone(current);(wrong.lanes[0]!.resources.at(-1) as any).exclusiveDependencies[0].resourceId='different';
 original.fleetBinding.descriptorRevision=routineLaneDescriptorRevision(wrong.lanes[0]!);
 expect(await fixture([original],wrong).service.qualificationTargets('pro1')).toEqual([]);
});

test('exact passive owner status preserves original target during busy-lane discovery omission without writes',async()=>{
 const f=fixture(),target=(await f.service.qualificationTargets('pro1'))[0]!,before=structuredClone(f.rows);
 f.observed.lanes[0]!.state='reserved';f.observed.lanes[0]!.activity={owner:{id:'passive-owner',kind:'authoring'},generation:44};
 const owned={jobId:target.jobId,laneId:target.laneId,inputSha256:target.inputSha256,ownerId:'passive-owner',generation:44,
  binding,controller:{incarnation:'boot',generation:1}};
 expect(await f.service.qualificationTargets('pro1')).toEqual([]);
 f.reads.splice(0);expect(await f.service.qualificationTargets('pro1',owned)).toEqual([target]);
 expect(f.reads).toEqual([{jobId:target.jobId,timeoutMS:5000}]);expect(f.rows).toEqual(before);
});
test('owned lookup rejects cancellation, expiry, terminal effects, changed frozen inputs and another borrower',async()=>{
 const baseline=fixture(),target=(await baseline.service.qualificationTargets('pro1'))[0]!;
 const owned={jobId:target.jobId,laneId:target.laneId,inputSha256:target.inputSha256,ownerId:'passive-owner',generation:44,
  binding,controller:{incarnation:'boot',generation:1}};
 const changes:Array<(value:StoredRoutineJob)=>void>=[
  value=>{value.fleetCancellation={requestedAt:new Date(now).toISOString(),reason:'withdrawn'};},
  value=>{value.fleetDeadline=new Date(now);},value=>{value.state='terminal';},value=>{value.runId='started';},
  value=>{value.preparationRejection={code:'source-invalid',rejectedAt:new Date(now).toISOString(),inputSha256:hash,reason:'withdrawn'}as any;},
  value=>{value.fleetTarget={hostId:'other'};},
  value=>{value.fleetResourceReservation={id:'00000000-0000-4000-8000-000000000001',requestId:value.requestId,
    fleetInputSha256:value.fleetInputSha256!,hostId:'other',laneId:'other-mac',poolId:'pool',minimumAvailableBytes:0,reservedAt:new Date(now).toISOString()};},
  value=>{value.fleetSelection.build.headSha='c'.repeat(40);value.fleetSelectionSha256=requestInputDigest(value.fleetSelection);value.fleetInputSha256=routineJobInputDigest(value);},
 ];
 for(const change of changes){const value=row();change(value);const observed=host();observed.lanes[0]!.state='reserved';
  observed.lanes[0]!.activity={owner:{id:'passive-owner',kind:'authoring'},generation:44};
  expect(await fixture([value],observed).service.qualificationTargets('pro1',owned)).toEqual([]);
 }
});
test('owned target refuses stale or replacement reporter, grant, binding and substituted executable digest',async()=>{
 const f=fixture(),target=(await f.service.qualificationTargets('pro1'))[0]!;
 f.observed.lanes[0]!.state='reserved';f.observed.lanes[0]!.activity={owner:{id:'passive-owner',kind:'authoring'},generation:44};
 const owned={jobId:target.jobId,laneId:target.laneId,inputSha256:target.inputSha256,ownerId:'passive-owner',generation:44,
  binding,controller:{incarnation:'boot',generation:1}};
 for(const changed of [{...owned,generation:45},{...owned,ownerId:'other'},{...owned,controller:{incarnation:'other',generation:1}},
   {...owned,binding:{...binding,installationId:'other'}},{...owned,inputSha256:f.rows[0]!.fleetInputSha256!}])
  expect(await f.service.qualificationTargets('pro1',changed)).toEqual([]);
});

test('exact owned primary-majority query applies its remaining client and database timeout',async()=>{
 const findOne=TestRequestModel.findOne,calls:unknown[]=[];
 const query={read(value:unknown){calls.push({read:value});return this;},readConcern(value:unknown){calls.push({readConcern:value});return this;},
  setOptions(value:unknown){calls.push({options:value});return this;},lean(){return Promise.resolve(null);}};
 try{TestRequestModel.findOne=mock((value)=>{calls.push({query:value});return query;})as any;
  expect(await routineJobRepository.get('original',123)).toBeNull();
  expect(calls).toEqual([{query:{requestId:'original',fleetSelection:{$exists:true}}},{read:'primary'},{readConcern:'majority'},{options:{timeoutMS:123,maxTimeMS:123}}]);
 }finally{TestRequestModel.findOne=findOne;}
});
test('late or failed owned database read cannot produce positive target authority',async()=>{
 for(const unavailable of [false,true]){
  const f=fixture(),target=(await f.service.qualificationTargets('pro1'))[0]!;f.observed.lanes[0]!.state='reserved';
  f.observed.lanes[0]!.activity={owner:{id:'passive-owner',kind:'authoring'},generation:44};
  const owned={jobId:target.jobId,laneId:target.laneId,inputSha256:target.inputSha256,ownerId:'passive-owner',generation:44,binding,controller:{incarnation:'boot',generation:1}};
  let elapsed=now;
  (f.service as any).now=()=>elapsed;
  (f.service as any).rows.get=async(_job:string,budget:number)=>{expect(budget).toBe(5000);elapsed+=5001;if(unavailable)throw Error('Mongo client timeout');return f.rows[0];};
  if(unavailable)await expect(f.service.qualificationTargets('pro1',owned)).rejects.toThrow('Mongo client timeout');
  else expect(await f.service.qualificationTargets('pro1',owned)).toEqual([]);
 }
});
