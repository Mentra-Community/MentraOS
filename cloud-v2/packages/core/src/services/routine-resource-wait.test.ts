import {expect, test} from 'bun:test';
import {dependencyWaitingReason, recorderWait, RECORDER_CAPACITY_WAIT, RECORDER_OBSERVATION_WAIT, RESOURCE_ADMISSION_WAIT,
  sharedResourceWait, sharedResourceWaitingReason} from './routine-resource-wait';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {RoutingTestHostState} from './test-host-state.service';

const now = Date.parse('2026-10-17T01:00:00Z'), gib = 1024 ** 3;
const dependency = {resourceId: 'private-account-id', authorityHostId: 'authority', capability: 'google-authentication'};
function fixture() {
  const row = {requestId: 'waiting', state: 'awaiting-runner', fleetInputSha256: 'a'.repeat(64), fleetResourceAdmission: {
    intent: {operationId: 'run:waiting', hostId: 'borrower', laneId: 'mac', controller: {incarnation: 'process', generation: 1, sequence: 1},
      owner: {id: 'waiting', kind: 'run'}, inputSha256: 'a'.repeat(64), resources: [{id: 'fixture', capabilities: ['google-authentication']}]},
    dependencies: [dependency]}} as StoredRoutineJob;
  const hosts = [{hostId: 'authority', receivedAt: new Date(now).toISOString(), lanes: [], authorityReservations: [{kind: 'exclusive',
    id: 'da63eacd-8c98-4a09-a459-405d362f9dcb', resourceId: dependency.resourceId, authorityHostId: 'authority', borrowerHostId: 'other-host',
    laneId: 'other-lane', owner: {id: 'private-owner-id', kind: 'run'}}]}] as RoutingTestHostState[];
  return {row, hosts};
}

test('shared waiting text uses the actual dependency capability without exposing private resource, account, owner or host identities', () => {
  const {row, hosts} = fixture(), reason = sharedResourceWaitingReason(row, hosts)!;
  expect(reason).toBe(sharedResourceWait('google-authentication'));
  for (const privateValue of ['private-account-id', 'private-owner-id', 'other-host', 'other-lane']) expect(reason).not.toContain(privateValue);
  row.fleetResourceAdmission!.dependencies[0]!.capability = 'glasses-ble';
  expect(sharedResourceWaitingReason(row, hosts)).toBe(sharedResourceWait());
  expect(dependencyWaitingReason([dependency], 'unknown-resource')).toBe(sharedResourceWait());
});

test('read-only projection distinguishes an actual authority holder from returned, unrelated or unchanged own claims', () => {
  const {row, hosts} = fixture(), claim = hosts[0]!.authorityReservations![0]! as any;
  claim.resourceId = 'another-resource'; expect(sharedResourceWaitingReason(row, hosts)).toBeUndefined();
  claim.resourceId = dependency.resourceId; claim.owner = {id: row.requestId, kind: 'run'};
  claim.origin = {kind: 'fleet', fleetInputSha256: row.fleetInputSha256}; claim.borrowerHostId = 'borrower'; claim.laneId = 'mac';
  expect(sharedResourceWaitingReason(row, hosts)).toBeUndefined();
  claim.origin.fleetInputSha256 = 'b'.repeat(64); expect(sharedResourceWaitingReason(row, hosts)).toBeUndefined();
  hosts[0]!.authorityReservations = []; expect(sharedResourceWaitingReason(row, hosts)).toBeUndefined();
});

test('cancelled, bound or changed source identities cannot publish a staged resource blocker', () => {
  const {row, hosts} = fixture();
  for (const changed of [{...row, state: 'terminal'}, {...row, fleetBinding: {}}, {...row, fleetCancellation: {}},
    {...row, fleetInputSha256: 'b'.repeat(64)}, {...row, fleetResourceAdmission: {}}])
    expect(sharedResourceWaitingReason(changed as StoredRoutineJob, hosts)).toBeUndefined();
});

test('fresh measured disk or staging shortage has capacity wording; absent, stale and future measurements remain observations', () => {
  const observation = {poolId: 'pool', observedAt: new Date(now).toISOString(), availableBytes: 20 * gib,
    stagingBudgetBytes: 10 * gib, pendingEvidenceBytes: 0, reservations: []};
  expect(recorderWait(observation, 7 * gib, now)).toBeUndefined();
  expect(recorderWait({...observation, availableBytes: 6 * gib}, 7 * gib, now)).toBe(RECORDER_CAPACITY_WAIT);
  expect(recorderWait({...observation, pendingEvidenceBytes: 6 * gib}, 7 * gib, now)).toBe(RECORDER_CAPACITY_WAIT);
  for (const value of [undefined, {...observation, observedAt: new Date(now - 120_001).toISOString()},
    {...observation, observedAt: new Date(now + 1).toISOString()}]) expect(recorderWait(value, 7 * gib, now)).toBe(RECORDER_OBSERVATION_WAIT);
  expect(recorderWait(observation, 7 * gib, now, Number.POSITIVE_INFINITY)).toBe(RESOURCE_ADMISSION_WAIT);
});
