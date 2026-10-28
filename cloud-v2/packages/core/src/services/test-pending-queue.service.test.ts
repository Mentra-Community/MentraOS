import {expect, test} from 'bun:test';
import {pendingQueueItem} from './test-pending-queue.service';
import {compatibleRoutineLane, routineJobInputDigest, routinePortableRequirements} from './routine-job.service';
import {requestInputDigest} from './test-request.service';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {ReceivedTestHostState} from './test-host-state.service';
import {sharedResourceWait} from './routine-resource-wait';
import {backendConnectivityObservationSchema} from '../types/backend-connectivity.types';
import {permissionContext} from '../types/resource-permissions.types';
const now = Date.parse('2026-10-08T01:00:00Z');
const definition = {id:'check',minimumRoutineApiVersion:1,title:'Check',purpose:'Verify',platforms:['android'],entry:'home',account:'lane',
  requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],
  execution:{resourceKinds:['phone']},resourceRequirements:[{kind:'phone',capabilities:['bluetooth-observe']}],
  source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:'a'.repeat(40),path:'routines/check/routine.ts'}};
function fixture() {
  const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:1};
  const selection = {requestId:'request',routineId:'check',platform:'android' as const,routineRevision:'a'.repeat(40),source,
    build:{repository:'Mentra-Community/MentraOS',kind:'android-apk',headSha:'b'.repeat(40),channel:'pr',prNumber:12,source,
      archive:{url:'https://artifactscdn.mentraglass.com/app.apk',name:'app.apk',sha256:'c'.repeat(64),size:100},
      receipt:{url:'https://artifactscdn.mentraglass.com/receipt.json',sha256:'d'.repeat(64),size:100}}};
  const row: StoredRoutineJob = {requestId:'request',state:'awaiting-runner',fleetSelection:selection as any,
    fleetSelectionSha256:requestInputDigest(selection),fleetDeadline:new Date(now+3600_000),createdAt:new Date(now-1000),
    fleetPreparation:{routineSource:testRoutineSource('a'.repeat(40)),definition:definition as any,definitionSha256:requestInputDigest(definition),
      requirements:routinePortableRequirements({platform:'android',definition} as any)}};
  row.fleetInputSha256 = routineJobInputDigest(row);
  const host: ReceivedTestHostState = {hostId:'mini',frameworkBinding:testFrameworkBinding(),receivedAt:new Date(now).toISOString(),observedAt:new Date(now).toISOString(), lanes:[
    {id:'idle',platform:'android',state:'idle',dispatchMode:'automatic',resources:[{id:'phone',kind:'phone',capabilities:['bluetooth-observe']}]},
    {id:'busy',platform:'android',state:'running',dispatchMode:'automatic',resources:[{id:'phone',kind:'phone',capabilities:['bluetooth-observe']}]},
    {id:'paused',platform:'android',state:'idle',dispatchMode:'paused',resources:[{id:'phone',kind:'phone',capabilities:['bluetooth-observe']}]},
    {id:'incompatible',platform:'android',state:'idle',dispatchMode:'automatic',resources:[{id:'phone',kind:'phone',capabilities:[]}]},
  ]} as any;
  return {row,host};
}
function backendFixture() {
  const f = fixture(), prepared = f.row.fleetPreparation!;
  prepared.definition = structuredClone(prepared.definition);
  prepared.definition.resourceRequirements[0]!.capabilities = ['backend-connectivity'];
  prepared.definitionSha256 = requestInputDigest(prepared.definition);
  prepared.requirements = routinePortableRequirements({platform: 'android', definition: prepared.definition} as any);
  f.row.fleetInputSha256 = routineJobInputDigest(f.row);
  f.host.frameworkBinding = {...testFrameworkBinding(), routineApiVersion: 111};
  for (const lane of f.host.lanes.slice(0, 3)) lane.resources[0]!.capabilities = ['backend-connectivity'];
  const context = {...permissionContext(f.host.frameworkBinding, f.row.fleetSelection.build, now)!, backend: {
    hostId: f.host.hostId, incarnation: 'original-controller', generation: 1,
    resourceGenerations: [{resourceId: 'phone', generation: 2, current: true, unowned: true}]}};
  const health = backendConnectivityObservationSchema.parse({schemaVersion: 1, capability: 'backend-connectivity', outcome: 'qualified',
    observedAt: new Date(now).toISOString(), phoneResourceId: 'phone', binding: f.host.frameworkBinding,
    controller: {incarnation: 'original-controller', generation: 1}, app: context.app,
    target: {schemaVersion: 1, coreUrl: 'https://core.dev.mentraglass.com'}, targetSource: 'verified-apk-configuration',
    bootId: '06965353-509e-4b20-a6d9-746e553b5315', tool: {path: '/tools/adb', sha256: 'e'.repeat(64)},
    check: {operationId: 'original-check', resultSha256: 'e'.repeat(64), readersSha256: 'e'.repeat(64), closedAt: new Date(now).toISOString()},
    releasedGeneration: 2, appRouteVerified: false});
  return {...f, requirements: prepared.requirements, context, health};
}
test('pending backend-capable hardware stays visible before health while executable admission remains strict', () => {
  const f = backendFixture(), before = structuredClone(f);
  const projected = pendingQueueItem(f.row, [f.host], now);
  expect(projected.compatibilityKnown).toBe(true);
  expect(projected.compatibleLanes.map(lane => lane.laneId)).toEqual(['idle']);
  expect(projected.compatibleLanes.map(lane => [lane.state, lane.dispatchMode])).toEqual([
    ['idle', 'automatic']]);
  expect(compatibleRoutineLane(f.requirements, f.host.lanes[0]!, f.context)).toBe(true);
  expect(f).toEqual(before);
});
test('pending hardware compatibility accepts valid health without conflating withdrawn health with missing hardware', () => {
  const f = backendFixture(), phone = f.host.lanes[0]!.resources[0]!;
  phone.backendConnectivity = structuredClone(f.health);
  expect(compatibleRoutineLane(f.requirements, f.host.lanes[0]!, f.context)).toBe(true);
  expect(pendingQueueItem(f.row, [f.host], now).compatibleLanes.map(lane => lane.laneId)).toEqual(['idle']);
  for (const change of [
    () => {phone.backendConnectivity!.observedAt = new Date(now - 120_001).toISOString();},
    () => {phone.backendConnectivity!.app.archiveSha256 = '0'.repeat(64);},
    () => {phone.backendConnectivity!.outcome = 'unknown';},
  ]) {
    phone.backendConnectivity = structuredClone(f.health); change();
    expect(compatibleRoutineLane(f.requirements, f.host.lanes[0]!, f.context)).toBe(true);
    expect(pendingQueueItem(f.row, [f.host], now).compatibleLanes.map(lane => lane.laneId)).toEqual(['idle']);
  }
  f.host.frameworkBinding!.routineApiVersion = 60;
  expect(pendingQueueItem(f.row, [f.host], now).compatibleLanes).toEqual([]);
});
test('an assigned preparing job reports its unmet framework floor without changing selection or deadline', () => {
  const {row, host} = fixture();
  row.state = 'preparing'; row.fleetBinding = {requestId: row.requestId, hostId: host.hostId, laneId: 'idle', descriptorRevision: 'a'.repeat(64),
    actionsRunId: '1', jobId: 'original-job', actionsJobId: '1', boundAt: new Date(now).toISOString()};
  row.fleetSelection.minimumFrameworkVersion = 1085; row.fleetSelectionSha256 = requestInputDigest(row.fleetSelection);
  row.fleetInputSha256 = routineJobInputDigest(row);
  const original = structuredClone(row);
  host.frameworkBinding = {...testFrameworkBinding(), version: 1083};
  expect(pendingQueueItem(row, [host], now).reason).toContain('Waiting for framework 1085');
  host.frameworkBinding = {...testFrameworkBinding(), version: 1085};
  host.receivedAt = new Date(now - 120_001).toISOString();
  expect(pendingQueueItem(row, [host], now).reason).toContain('no fresh accepted framework observation');
  expect(row).toEqual(original);
});
test('pending projection labels every compatible lane and keeps availability separate', () => {
  const {row,host} = fixture(), item = pendingQueueItem(row,[host],now);
  expect(item.compatibilityKnown).toBe(true);
  expect(item.compatibleLanes.map(lane=>lane.laneId)).toEqual(['idle']);
  expect(item.compatibleLanes).toHaveLength(1);
  host.receivedAt = new Date(now-120_001).toISOString();
  expect(pendingQueueItem(row,[host],now).compatibleLanes).toEqual([]);
});
test('exact targets restrict compatibility and unknown source preparation has only candidates', () => {
  const {row,host} = fixture(); row.fleetTarget={hostId:'mini',laneId:'busy'}; row.fleetInputSha256=routineJobInputDigest(row);
  expect(pendingQueueItem(row,[host],now).compatibleLanes.map(lane=>lane.laneId)).toEqual([]);
  delete row.fleetPreparation; delete row.fleetInputSha256; row.state='awaiting-source';
  const unknown=pendingQueueItem(row,[host],now);
  expect(unknown.compatibilityKnown).toBe(false); expect(unknown.compatibleLanes).toEqual([]);
  expect(unknown.platformCandidates.map(lane=>lane.laneId)).toEqual(['busy']);
});
test('pending fixture requirements exclude generic fixtures and keep capable busy lanes visible', () => {
  const {row, host} = fixture(), prepared = row.fleetPreparation!;
  prepared.definition = structuredClone(prepared.definition);
  prepared.definition.fixtures = [{provider: 'miniapp-appearance', description: 'Owned reviewed references and decoder'}];
  prepared.definition.execution!.resourceKinds.push('fixture-data');
  prepared.definition.resourceRequirements.push({kind: 'fixture-data', capabilities: ['reviewed-miniapp-appearance', 'media-decode']});
  prepared.definitionSha256 = requestInputDigest(prepared.definition);
  prepared.requirements = routinePortableRequirements({platform: 'android', definition: prepared.definition} as any);
  row.fleetInputSha256 = routineJobInputDigest(row);
  host.lanes = host.lanes.slice(0, 2);
  host.lanes[0]!.resources.push({id: 'generic-fixture', kind: 'fixture-data', capabilities: []});
  host.lanes[1]!.resources.push({id: 'reviewed-fixture', kind: 'fixture-data', capabilities: ['reviewed-miniapp-appearance', 'media-decode']});
  const item = pendingQueueItem(row, [host], now);
  expect(item.compatibilityKnown).toBe(true);
  expect(item.compatibleLanes).toEqual([]);
  host.lanes[1]!.state='idle';
  expect(pendingQueueItem(row,[host],now).compatibleLanes.map(lane=>lane.laneId)).toEqual(['busy']);
  expect(row.fleetPreparation!.definition.fixtures[0]!.provider).toBe('miniapp-appearance');
});
test('corrupt exact requirements cannot produce compatible lane claims or hide neighboring rows', () => {
  const {row,host} = fixture(); row.fleetPreparation!.requirements.resources[0]!.capabilities=[];
  const item=pendingQueueItem(row,[host],now); expect(item.compatibleLanes).toEqual([]); expect(item.reason).toContain('unavailable');
  expect(pendingQueueItem(fixture().row,[host],now).compatibleLanes).toHaveLength(1);
});

test('malformed persisted dates remain visible without hiding valid neighbors', () => {
  const {row,host}=fixture(), deadline={...row,fleetDeadline:new Date('invalid')}, created={...row,createdAt:new Date('invalid')};
  const page=[deadline,created,row].map(value=>pendingQueueItem(value,[host],now));
  expect(page).toHaveLength(3); expect(page[0]!.reason).toContain('unavailable'); expect(page[1]!.reason).toContain('unavailable');
  expect(page[2]!.compatibleLanes).toHaveLength(1);
});
test('pending queue shows an existing staged exclusive blocker without taking or returning custody', () => {
  const {row, host} = fixture();
  row.fleetResourceAdmission = {intent: {operationId: 'run:request', hostId: 'mini', laneId: 'idle', inputSha256: row.fleetInputSha256!,
    owner: {id: 'request', kind: 'run'}, controller: {incarnation: 'one', generation: 1, sequence: 1}, resources: [{id: 'phone', capabilities: ['bluetooth-observe']}]},
    dependencies: [{resourceId: 'private-account', authorityHostId: 'mini', capability: 'google-authentication'}]};
  const observed = {...host, authorityReservations: [{kind: 'exclusive', id:'10000000-0000-4000-8000-000000000001',resourceId: 'private-account', authorityHostId: 'mini',
    owner: {id: 'private-owner', kind: 'run'}, borrowerHostId: 'elsewhere', laneId: 'private-lane',operationId:'run:private-owner',intentSha256:'f'.repeat(64),inputSha256:'e'.repeat(64),controllerIncarnation:'foreign-controller',controllerGeneration:1,borrowerSequence:1,reservedAt:new Date(now).toISOString()}]} as any;
  const before = structuredClone(row), snapshot = structuredClone(observed);
  const item = pendingQueueItem(row, [observed], now);
  expect(item.reason).toBe(sharedResourceWait('google-authentication')); expect(item.reason).not.toContain('private-account');
  const blocker = item.diagnosis?.conditions.find(value => value.resourceId === 'private-account');
  expect(blocker?.owner).toBe('run:private-owner');
  expect(blocker?.hostId).toBe('elsewhere'); expect(blocker?.laneId).toBe('private-lane');
  expect(row).toEqual(before); expect(observed).toEqual(snapshot);
  observed.authorityReservations = [];
  expect(pendingQueueItem(row, [observed], now).reason).toContain('admission has not reached a bound worker');
});

test('every exact pending original explains its current stage without inventing a matching refusal', () => {
  const {row, host} = fixture(), before = structuredClone(row);
  const projected = pendingQueueItem(row, [host], now);
  expect(projected.reason).toContain('exact blocking condition is not recorded');
  expect(projected.diagnosis?.stage).toBe('Awaiting matching decision');
  expect(projected.diagnosis?.conditions[0]!.status).toBe('unknown');
  expect(projected.diagnosis?.nextAction).toContain('existing preparation stage logs');
  expect(row).toEqual(before);
});
test('historic candidate qualification does not become current reservation authority', () => {
  const {row, host} = fixture(); row.fleetCandidateSelection = {hostId: host.hostId, laneId: 'idle', targetInputSha256: 'e'.repeat(64)};
  const original = structuredClone(row), item = pendingQueueItem(row, [host], now);
  expect(item.diagnosis?.stage).toBe('Awaiting matching decision'); expect(item.reason).toContain('no atomic reservation');
  expect(item.compatibleLanes.map(lane=>lane.laneId)).toEqual(['idle']);
  expect(item.diagnosis?.conditions.at(-1)!.status).toBe('unknown'); expect(row).toEqual(original);
});
test('pending candidate identifies its exact original attempt and current foreign custody', () => {
  const {row, host} = fixture();
  row.fleetCandidatePreparation = {hostId: host.hostId, laneId: 'idle', candidate: {attemptId: 'original-attempt', requestedAt: new Date(now).toISOString()}} as any;
  const current = {...host, authorityReservations: [{id: '10000000-0000-4000-8000-000000000002', requestId: 'foreign-original', hostId: host.hostId,
    laneId: 'idle', poolId: 'original-disk', fleetInputSha256: 'f'.repeat(64), reservedAt: new Date(now).toISOString(), minimumAvailableBytes: 1}]};
  const before = structuredClone(row), snapshot = structuredClone(current), projected = pendingQueueItem(row, [current], now);
  expect(projected.diagnosis?.stage).toBe('Candidate check and return');
  expect(projected.reason).toContain('complete return');
  expect(projected.diagnosis?.conditions.some(value => value.owner === 'run:foreign-original' && value.resourceId === 'original-disk')).toBe(true);
  expect(projected.diagnosis?.conditions.at(-1)!.observed).toContain('original-attempt');
  expect(row).toEqual(before); expect(current).toEqual(snapshot);
});
test('bound execution reports missing original completion without calling a failed device a pass', () => {
  const {row, host} = fixture(); row.state = 'preparing';
  row.fleetBinding = {jobId: row.requestId, requestId: row.requestId, hostId: host.hostId, laneId: 'idle',
    descriptorRevision: 'f'.repeat(64), actionsRunId: '123', actionsJobId: '456', boundAt: new Date(now).toISOString()};
  const projected = pendingQueueItem(row, [host], now);
  expect(projected.diagnosis?.stage).toBe('Bound execution');
  expect(projected.diagnosis?.conditions.at(-1)!.status).toBe('waiting');
  expect(projected.diagnosis?.conditions.at(-1)!.observed).toContain('run 123, job 456');
  expect(projected.diagnosis?.nextAction).toContain('do not dispatch a duplicate');
});
test('missing current worker observation differs from a reported denial; app consent is owned setup', () => {
  const {row, host} = fixture(), prepared = row.fleetPreparation!;
  prepared.definition.execution!.resourceKinds = ['app'];
  prepared.definition.resourceRequirements = [{kind: 'app', capabilities: [], permissions: [{permission: 'accessibility', recipient: 'worker'}]}];
  prepared.definitionSha256 = requestInputDigest(prepared.definition);
  prepared.requirements = routinePortableRequirements({platform: 'android', definition: prepared.definition} as any);
  row.fleetInputSha256 = routineJobInputDigest(row); host.frameworkBinding = testFrameworkBinding();
  host.lanes = [{id: 'idle', platform: 'android', state: 'idle', dispatchMode: 'automatic', resources: [{id: 'exact-app', kind: 'app'}]}];
  const missing = pendingQueueItem(row, [host], now);
  expect(missing.compatibleLanes).toEqual([]);
  expect(missing.diagnosis?.conditions.some(condition=>condition.status==='unknown'&&condition.resourceId==='exact-app'&&condition.label.includes('accessibility'))).toBe(true);
  const observation = {permission: 'accessibility' as const, status: 'denied' as const, rawStatus: 'denied', binding: host.frameworkBinding!, observedAt: new Date(now).toISOString(),
    recipient: {kind: 'worker' as const, uid: 501, runtime:{path:'/worker',sha256:host.frameworkBinding.runtimeSha256},helper:{path:'/helper',sha256:'e'.repeat(64)}}, evidence:{sha256:'e'.repeat(64)}};
  host.lanes[0]!.resources[0]!.permissionObservations=[observation];
  expect(pendingQueueItem(row,[host],now).diagnosis?.conditions.some(condition=>condition.status==='failed'&&condition.observed.includes('denied'))).toBe(true);
  host.lanes[0]!.resources[0]!.permissionObservations=[{...observation,status:'granted'}];
  expect(pendingQueueItem(row,[host],now).compatibleLanes).toHaveLength(1);
  prepared.definition.resourceRequirements=[{kind:'app',capabilities:[],permissions:[{permission:'bluetooth',recipient:'app'}]}];
  prepared.definitionSha256=requestInputDigest(prepared.definition);prepared.requirements=routinePortableRequirements({platform:'android',definition:prepared.definition} as any);
  row.fleetInputSha256=routineJobInputDigest(row);host.lanes[0]!.resources[0]!.permissionObservations=[];
  expect(pendingQueueItem(row,[host],now).compatibleLanes).toHaveLength(1);
});
test('expired originals report deadline settlement while preserving outstanding custody', () => {
  const {row, host} = fixture(); row.fleetDeadline = new Date(now - 1); row.fleetInputSha256 = routineJobInputDigest(row); const original = structuredClone(row);
  const item = pendingQueueItem(row, [host], now);
  expect(item.diagnosis?.stage).toBe('Original deadline reached');
  expect(item.diagnosis?.nextAction).toContain('do not extend the deadline'); expect(row).toEqual(original);
});
test('terminal originals preserve their result instead of appearing as waiting cancellation', () => {
  const {row, host} = fixture(); row.state = 'terminal'; row.terminalStatus = 'not-run';
  row.fleetCancellation = {requestedAt: new Date(now).toISOString(), reason: 'deadline'} as any;
  const original = structuredClone(row), item = pendingQueueItem(row, [host], now);
  expect(item.diagnosis?.stage).toBe('Terminal original result');
  expect(item.reason).toContain('not pending delivery'); expect(row).toEqual(original);
});
