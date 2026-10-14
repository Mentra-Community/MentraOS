import {expect, test} from 'bun:test';
import {testRoutineSource} from '../testing/framework-fixtures';
import {permissionObservationMatches, permissionObservationSchema, permissionContext, type PermissionObservation} from '../types/resource-permissions.types';
import {routineEnrollmentSchema, routineResourceRequirementSchema} from '../types/routine-definition.types';
import {frameworkRequestInputSchema} from '../types/framework-request.types';
import {selectedBuildInput, type TestBuild} from '../types/test-build.types';
import {portableRoutineSelectionSchema, type StoredRoutineJob} from '../types/routine-job.types';
import {routineAdmissionInput} from './routine-admission.service';
import {compatibleRoutineLane, routineJobInputDigest, routineJobRouting, routineLaneDescriptorRevision, routinePortableRequirements, routineRequirementLabels} from './routine-job.service';
import {hostStateSchema, type ReceivedTestHostState} from './test-host-state.service';
import {pendingQueueItem} from './test-pending-queue.service';
import {requestInputDigest} from './test-request.service';
const now = Date.parse('2026-10-13T18:00:00Z'), revision = 'a'.repeat(40), hash = 'b'.repeat(64);
const binding = {version: 938, revision, installationId: 'accepted-runtime', configurationSha256: hash,
  runtimeSha256: 'c'.repeat(64), routineApiVersion: 37, publicApiSha256: 'd'.repeat(64)};
const build: TestBuild = {source: {channel: 'dev', buildRunId: 10, publicationAttempt: 1}, platform: 'ios-on-mac', title: 'Exact app',
  availability: 'available', headSha: revision, buildUrl: 'https://github.com/Mentra-Community/MentraOS/actions/runs/10', createdAt: new Date(now).toISOString(),
  archive: {name: 'app.zip', sha256: hash, size: 100, url: 'https://artifactscdn.mentraglass.com/app.zip'},
  receipt: {sha256: hash, size: 100, url: 'https://artifactscdn.mentraglass.com/receipt.json'}};
const app = {headSha: revision, archiveSha256: hash, receiptSha256: hash};
const appRecipient = {kind: 'app' as const, uid: 501, pid: 50, processStartedAt: 'verified process lifetime', launchedAt: now - 1000,
  bundleId: 'com.mentra.mentra' as const, bundlePath: '/Applications/Mentra.app', executablePath: '/Applications/Mentra.app/Mentra', version: '3.3.0', build: '100',
  teamId: 'T5XXXL6N36', codeRequirement: 'verified signed requirement', selectedBuild: app};
const observed: PermissionObservation = {permission: 'camera', status: 'granted', rawStatus: 'authorized', observedAt: new Date(now).toISOString(), binding,
  recipient: appRecipient, evidence: {sha256: 'e'.repeat(64)}};
function fixture() {
  const definition = routineEnrollmentSchema.parse({routineId: 'camera-check', platform: 'ios-on-mac', definitionRevision: revision,
    definitionSha256: hash, routineSource: testRoutineSource(revision), definition: {id: 'camera-check', minimumRoutineApiVersion: 1,
      title: 'Camera', purpose: 'Verify camera', platforms: ['ios-on-mac'], entry: 'sign-in', account: 'none', requirements: [], fixtures: [],
      resourceRequirements: [{kind: 'app', capabilities: [], permissions: [{permission: 'camera', recipient: 'app'}]}, {kind: 'recorder', capabilities: []}],
      execution: {resourceKinds: ['app', 'recorder']}, steps: [{id: 'camera', instruction: 'Open camera', expected: 'Camera visible'}],
      source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision, path: 'routines/camera-check/routine.ts'}}});
  const host: ReceivedTestHostState = {hostId: 'mini', incarnation: 'current', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), frameworkBinding: binding,
    lanes: [{id: 'mac', platform: 'ios-on-mac', dispatchMode: 'automatic', state: 'idle', resources: [
      {id: 'app', kind: 'app', permissionObservations: [structuredClone(observed)]}, {id: 'recorder', kind: 'recorder'}]}]};
  const selection = portableRoutineSelectionSchema.parse({requestId: 'camera-request', routineId: definition.routineId, platform: definition.platform,
    routineRevision: revision, source: build.source, build: selectedBuildInput(build, definition.platform)});
  const row: StoredRoutineJob = {requestId: selection.requestId, state: 'awaiting-runner', fleetSelection: selection,
    fleetSelectionSha256: requestInputDigest(selection), fleetDeadline: new Date(now + 3600_000), createdAt: new Date(now),
    fleetPreparation: {routineSource: definition.routineSource, definition: definition.definition,
      definitionSha256: requestInputDigest(definition.definition), requirements: routinePortableRequirements(definition)}};
  row.fleetInputSha256 = routineJobInputDigest(row);
  return {definition, host, lane: host.lanes[0]!, row};
}
test('strict wire schemas preserve named recipients and reject unknown or duplicate claims', () => {
  expect(routineResourceRequirementSchema.safeParse({kind: 'app', capabilities: [], permissions: [{permission: 'camera', recipient: 'app'}]}).success).toBe(true);
  for (const permissions of [[{permission: 'future', recipient: 'app'}], [{permission: 'camera', recipient: 'future'}],
    Array(2).fill({permission: 'camera', recipient: 'app'}), [{permission: 'camera', recipient: 'app', granted: true}]])
    expect(routineResourceRequirementSchema.safeParse({kind: 'app', capabilities: [], permissions}).success).toBe(false);
  expect(permissionObservationSchema.safeParse(observed).success).toBe(true);
  expect(permissionObservationSchema.safeParse({...observed, evidence: {sha256: 'unverified'}}).success).toBe(false);
  const f = fixture(), admitted = routineAdmissionInput(f.definition, build, {hostId: 'mini', laneId: 'mac'}, f.host, now);
  expect(frameworkRequestInputSchema.parse(admitted).resources[0]).toEqual({id: 'app', kind: 'app'});
  const {receivedAt: _, ...snapshot} = f.host;
  expect(hostStateSchema.safeParse({...snapshot, frameworkBinding: undefined}).success).toBe(true);
  f.lane.resources[0]!.permissionObservations = [observed, observed];
  expect(hostStateSchema.safeParse({...snapshot, frameworkBinding: undefined}).success).toBe(false);
});
test('current binding, explicit recipient and immutable selected app tuple are all required', () => {
  const context = {now, binding, app, recipient: 'app' as const};
  expect(permissionObservationMatches(observed, 'camera', context)).toBe(true);
  expect(permissionObservationMatches({...observed, observedAt: new Date(now - 120_000).toISOString()}, 'camera', context)).toBe(true);
  for (const age of [-1, 120_001]) expect(permissionObservationMatches({...observed,
    observedAt: new Date(now - age).toISOString()}, 'camera', context)).toBe(false);
  for (const status of ['denied', 'blocked', 'unavailable', 'unknown'] as const)
    expect(permissionObservationMatches({...observed, status}, 'camera', context)).toBe(false);
  expect(permissionObservationMatches(undefined, 'camera', context)).toBe(false);
  expect(permissionObservationMatches(observed, 'camera', {...context, app: undefined})).toBe(false);
  expect(permissionObservationMatches(observed, 'camera', {...context, recipient: 'worker'})).toBe(false);
  for (const key of ['headSha', 'archiveSha256', 'receiptSha256'] as const)
    expect(permissionObservationMatches(observed, 'camera', {...context, app: {...app, [key]: 'f'.repeat(key === 'headSha' ? 40 : 64)}})).toBe(false);
  for (const key of Object.keys(binding) as (keyof typeof binding)[])
    expect(permissionObservationMatches(observed, 'camera', {...context, binding: {...binding, [key]: typeof binding[key] === 'number' ? 1 : 'replacement'}})).toBe(false);
  const workerRecipient = {kind: 'worker' as const, uid: 501, runtime: {path: '/accepted/bun', sha256: binding.runtimeSha256}, helper: {path: '/accepted/driver', sha256: hash}};
  const worker: PermissionObservation = {...observed, permission: 'accessibility', recipient: workerRecipient};
  expect(permissionObservationMatches(worker, 'accessibility', {now, binding, recipient: 'worker'})).toBe(true);
  expect(permissionObservationMatches({...worker, recipient: {...workerRecipient, runtime: {path: '/other/bun', sha256: hash}}},
    'accessibility', {now, binding, recipient: 'worker'})).toBe(false);
});
test('routing, queue and final direct admission share the same exact observation predicate', () => {
  const f = fixture(), required = f.row.fleetPreparation!.requirements, frozen = structuredClone(f.row);
  expect(routineJobRouting(required, [f.host], now, undefined, build).waitingReason).toBeUndefined();
  expect(pendingQueueItem(f.row, [f.host], now).compatibleLanes.map(value => value.laneId)).toEqual(['mac']);
  expect(compatibleRoutineLane(required, f.lane, permissionContext(binding, build, now))).toBe(true);
  for (const value of [undefined, {...observed, status: 'unknown' as const}, {...observed, observedAt: new Date(now - 120_001).toISOString()},
    {...observed, recipient: {...appRecipient, selectedBuild: {...app, archiveSha256: 'f'.repeat(64)}}}]) {
    f.lane.resources[0]!.permissionObservations = value ? [value] : [];
    expect(routineJobRouting(required, [f.host], now, undefined, build).waitingReason).toBe('Awaiting a compatible enrolled runner');
    expect(pendingQueueItem(f.row, [f.host], now).compatibleLanes).toEqual([]);
    expect(() => routineAdmissionInput(f.definition, build, {hostId: 'mini', laneId: 'mac'}, f.host, now)).toThrow('camera permission for its app recipient');
  }
  expect(f.row).toEqual(frozen);
  f.definition.definition.resourceRequirements[0]!.permissions = undefined;
  const playback = routinePortableRequirements(f.definition);
  expect(compatibleRoutineLane(playback, f.lane)).toBe(true);
  expect(routineJobRouting(playback, [f.host], now).waitingReason).toBeUndefined();
  expect(routineAdmissionInput(f.definition, build, {hostId: 'mini', laneId: 'mac'}, f.host, now).routineId).toBe('camera-check');
});
test('permission report churn never changes inventory descriptor or stable requirement labels', () => {
  const f = fixture(), revision = routineLaneDescriptorRevision(f.lane), required = f.row.fleetPreparation!.requirements;
  const labels = routineRequirementLabels(required);
  expect(labels).toContain(`mentra-permission-${requestInputDigest('app:app:camera').slice(0, 24)}`);
  f.lane.resources[0]!.permissionObservations = [{...observed, observedAt: new Date(now + 10).toISOString(), evidence: {sha256: 'f'.repeat(64)}}];
  expect(routineLaneDescriptorRevision(f.lane)).toBe(revision);
  expect(routineRequirementLabels(required)).toEqual(labels);
  delete f.lane.resources[0]!.permissionObservations;
  expect(routineLaneDescriptorRevision(f.lane)).toBe(revision);
});

test('fresh permission evidence is checked without entering the immutable queued input', () => {
  const f = fixture(), select = () => routineAdmissionInput(f.definition, build, {hostId: 'mini', laneId: 'mac'}, f.host, now);
  const initial = select(), digest = requestInputDigest(initial);
  f.lane.resources[0]!.permissionObservations = [{...observed, observedAt: new Date(now - 10).toISOString(), evidence: {sha256: 'f'.repeat(64)}}];
  expect(select()).toEqual(initial); expect(requestInputDigest(select())).toBe(digest);
  f.lane.resources[0]!.permissionObservations = [{...observed, status: 'denied'}];
  expect(() => select()).toThrow('camera permission for its app recipient');
});
