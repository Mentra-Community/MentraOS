import {expect, test} from 'bun:test';
import {ResourceLifecycleService, projectResourceLifecycle} from './resource-lifecycle.service';
import {TestHostStateService, hostStateSchema} from './test-host-state.service';
import {createTestHostStateApi} from '../api/internal/test-host-state.api';
import {resourceCheckReportSchema, type ResourceCheckReport} from '../types/resource-check-report.types';
import {resourceLifecycleSubjectSchema} from '../types/resource-lifecycle.types';

const at = '2026-10-25T23:00:00Z', hash = 'a'.repeat(64);
const report: ResourceCheckReport = {resourceId: 'phone', authorityHostId: 'air', contractVersion: 'v1', operationId: 'check-original',
  checkedAt: at, resultSha256: hash, outcome: 'passed', reportedOutcome: 'passed', evidenceRefs: ['proof'],
  conditions: ['present', 'wifi'].map(id => ({id, label: id, status: 'passed', reportedStatus: 'passed',
    observed: null, expected: null, explanation: null, repairAction: null, evidenceRefs: [], source: null}))};
const subject = {subject: {kind: 'resource', id: 'phone', authorityHostId: 'air'}, generation: 2, status: 'idle',
  current: true, observedAt: at, receivedAt: null, owner: null, reason: null,
  idle: {contractVersion: 'v1', outcome: 'passed', checkedAt: at,
    acceptedCheck: {operationId: 'check-original', subjectGeneration: 2, resultSha256: hash, acceptedAt: at},
    qualifiedScope: {kind: 'fleet'}, evidenceRefs: ['proof'], report},
  repair: {configured: true, state: 'none'}, supportedActions: ['check'],
  resource: {kind: 'phone', capabilities: [], memberships: [{hostId: 'air', laneId: 'android'}], dependencies: [], placement: 'installed'}};
const snapshot = {hostId: 'air', incarnation: 'boot', incarnationGeneration: 1, sequence: 3, observedAt: at,
  lanes: [{id: 'android', platform: 'android', dispatchMode: 'automatic', state: 'idle', resources: [{id: 'phone', kind: 'phone'}]}],
  resourceLifecycle: {schemaVersion: 1, subjects: [subject], history: []}};

test('actual legacy strict Core subject accepts only the report-free shape; current Core accepts the optional report', () => {
  const current = resourceLifecycleSubjectSchema.innerType();
  const legacySubject = current.extend({idle: current.shape.idle.omit({report: true}).strict()}).strict();
  expect(legacySubject.safeParse(subject).success).toBe(false);
  const legacy = current.parse(subject); delete legacy.idle.report;
  expect(legacySubject.parse(legacy)).toEqual(legacy);
  expect(resourceLifecycleSubjectSchema.safeParse(subject).success).toBe(true);
  expect(hostStateSchema.safeParse(snapshot).success).toBe(true);
});

test('current Core accepts separate not-checked contract coverage without relabeling the original green report', () => {
  const changed: ResourceCheckReport = {...report, currentContract: {contractVersion: 'v2', outcome: 'not-checked',
    conditions: [{...report.conditions[0]!, id: 'new-condition', status: 'not-checked', reportedStatus: null}]}};
  expect(resourceCheckReportSchema.parse(changed)).toEqual(changed);
  expect(changed).toMatchObject({contractVersion: 'v1', resultSha256: hash, checkedAt: at, outcome: 'passed'});
  expect(resourceCheckReportSchema.safeParse({...changed, currentContract: {...changed.currentContract,
    conditions: [{...changed.currentContract!.conditions[0]!, status: 'passed', reportedStatus: 'passed'}]}}).success).toBe(false);
  expect(resourceCheckReportSchema.safeParse({...report, conditions: [{...report.conditions[0]!, explanation: 'x'.repeat(257)}]}).success).toBe(false);
});

test('existing Core lifecycle/detail retains every optional report row/hash/time without changing readiness or owner', async () => {
  const original = structuredClone(snapshot);
  const rows = [{hostId: 'air', receivedAt: new Date(at), snapshot}];
  const result = projectResourceLifecycle(rows, Date.parse(at));
  const service = new ResourceLifecycleService(); service.list = async () => result;
  const detail = await service.detail('phone');
  expect(detail.subject.idle.report).toEqual(report);
  expect(detail.subject).toMatchObject({status: 'idle', owner: null, supportedActions: ['check']});
  expect(snapshot).toEqual(original);
  const legacy = structuredClone(snapshot); delete (legacy.resourceLifecycle.subjects[0]!.idle as {report?: unknown}).report;
  expect(hostStateSchema.safeParse(legacy).success).toBe(true);
  expect(hostStateSchema.safeParse(snapshot).success).toBe(true);
  expect(projectResourceLifecycle(rows, Date.parse(at) + 180001).subjects[0]!.idle.report).toEqual(report);
});

test('existing authenticated host-state ACK opts in only after successful parse; old host body is unchanged', async () => {
  const token = 'synthetic-report-test-' + 'x'.repeat(32), observed: unknown[] = [];
  class Service extends TestHostStateService {
    override async report(input: unknown, host: string) {
      const value = hostStateSchema.parse(input); expect(value.hostId).toBe(host); observed.push(value);
      return {hostId: host, incarnation: value.incarnation, incarnationGeneration: value.incarnationGeneration, sequence: value.sequence};
    }
  }
  const api = createTestHostStateApi(new Service(), () => JSON.stringify({air: token}));
  const headers = {'authorization': `Bearer ${token}`, 'content-type': 'application/json'};
  const legacy = {...snapshot, resourceLifecycle: undefined};
  const reply = await api.request('/', {method: 'POST', headers, body: JSON.stringify(legacy)});
  expect(reply.status).toBe(200); expect(await reply.json()).toMatchObject({resourceCheckReports: true, sequence: 3});
  expect(observed[0]).toEqual(JSON.parse(JSON.stringify(legacy)));
  expect((await api.request('/', {method: 'POST', headers: {...headers, authorization: 'Bearer wrong'}, body: JSON.stringify(snapshot)})).status).toBe(401);
  expect(observed).toHaveLength(1);
});
