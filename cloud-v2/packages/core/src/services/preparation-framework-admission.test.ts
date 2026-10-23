import {expect, spyOn, test} from 'bun:test';
import {TestHostStateModel} from '../models/test-host-state.model';
import {TestRequestModel} from '../models/test-request.model';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import {TestHostStateService} from './test-host-state.service';
import {requestInputDigest, TestRequestService} from './test-request.service';

const now = Date.parse('2026-10-18T09:17:00Z'), time = new Date(now).toISOString(), binding = {...testFrameworkBinding(), version: 1085};
const build = {repository: 'Mentra-Community/MentraOS', headSha: 'c'.repeat(40), channel: 'dev', kind: 'android-apk',
  source: {channel: 'dev', buildRunId: 1, publicationAttempt: 1}, archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 10, sha256: 'd'.repeat(64)},
  receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 2, sha256: 'e'.repeat(64)}};
const intent = {requestId: 'original-gallery', routineId: 'gallery-sync-android', platform: 'android', routineRevision: 'a'.repeat(40),
  laneId: 'pro-android', source: build.source, build, minimumFrameworkVersion: 1085};
const input = {routineId: intent.routineId, platform: intent.platform, definitionRevision: intent.routineRevision, routineSource: testRoutineSource(),
  laneId: intent.laneId, build, resources: [{id: 'app', kind: 'app'}], minimumFrameworkVersion: 1085};
const digest = requestInputDigest(intent), rejection = {dispatchIntentSha256: digest, frameworkBinding: binding,
  code: 'source-invalid', reason: 'Actual incompatible source', rejectedAt: time, disposition: 'not-run'};
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (key === '$and') return value.every((part: any) => matches(row, part));
    const actual = row[key];
    if (value && typeof value === 'object' && '$exists' in value) return (actual !== undefined) === value.$exists;
    if (value && typeof value === 'object' && '$gt' in value) return actual > value.$gt;
    return JSON.stringify(actual ?? null) === JSON.stringify(value ?? null);
  });
}
function fixture() {
  let row: any = {requestId: intent.requestId, hostId: 'pro', state: 'preparing', dispatchIntent: structuredClone(intent), dispatchIntentSha256: digest};
  const process = {pid: 123, startedAt: 'original-lifetime'};
  const host: any = {hostId: 'pro', incarnation: 'original', incarnationGeneration: 1, sequence: 1, receivedAt: new Date(now),
    snapshot: {hostId: 'pro', incarnation: 'original', incarnationGeneration: 1, sequence: 1, observedAt: time, lanes: [],
      frameworkBinding: binding, frameworkAcceptedAt: time, frameworkProcess: process},
    frameworkHistory: [{binding, incarnation: 'original', incarnationGeneration: 1, process, effectiveAt: time, observedAt: time}],
    preparationFrameworkAdmissions: [], preparationFrameworkAdmissionVersion: 0};
  let beforeHost: (() => void) | undefined, afterHost: (() => void) | undefined, beforeRequest: (() => void) | undefined;
  let hostWrites = 0, effects = 0, lostHostReply = false, lostRequestReply = false, outage = false, settledRows: unknown[] = [];
  const query = (value: () => unknown) => {const q = {select() {return q}, read() {return q}, readConcern() {return q},
    setOptions() {return q}, limit() {return q}, async lean() {return structuredClone(value())}}; return q};
  const hostRead = spyOn(TestHostStateModel, 'findOne').mockImplementation((() => query(() => host)) as never);
  const requestRead = spyOn(TestRequestModel, 'findOne').mockImplementation((() => query(() => row)) as never);
  const settled = spyOn(TestRequestModel, 'find').mockImplementation((() => query(() => settledRows)) as never);
  const hostWrite = spyOn(TestHostStateModel, 'findOneAndUpdate').mockImplementation(((filter: any, update: any) => query(() => {
    if (outage) throw Error('Host authority unavailable');
    beforeHost?.(); beforeHost = undefined;
    if (!matches(host, filter)) return null;
    host.preparationFrameworkAdmissions = structuredClone(update.$set.preparationFrameworkAdmissions);
    host.preparationFrameworkAdmissionVersion++; hostWrites++;
    afterHost?.(); afterHost = undefined;
    if (lostHostReply) {lostHostReply = false; throw Error('Lost host reply')}
    return {hostId: host.hostId};
  })) as never);
  const apply = (filter: any, update: any) => {
    beforeRequest?.(); beforeRequest = undefined;
    if (!matches(row, filter)) return null;
    row = {...row, ...structuredClone(update.$set)};
    effects++;
    if (lostRequestReply) {lostRequestReply = false; throw Error('Lost request reply')}
    return structuredClone(row);
  };
  const completion = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation((async (filter: any, update: any) => apply(filter, update)) as never);
  const rejected = spyOn(TestRequestModel, 'findOneAndUpdate').mockImplementation(((filter: any, update: any) => query(() => apply(filter, update))) as never);
  const service = new TestRequestService(undefined, undefined, null, new TestHostStateService(() => now), () => now);
  const replace = (stop = false) => {
    host.sequence++; host.snapshot.sequence++;
    if (stop) host.frameworkHistory[0].endedAt = time;
    else {
      host.incarnation = host.snapshot.incarnation = 'successor'; host.incarnationGeneration = host.snapshot.incarnationGeneration = 2;
      host.snapshot.frameworkBinding = {...binding, version: 1086, installationId: 'replacement'};
      host.frameworkHistory[0].endedAt = time;
      host.frameworkHistory.push({...host.frameworkHistory[0], binding: host.snapshot.frameworkBinding, incarnation: 'successor', incarnationGeneration: 2, endedAt: undefined});
    }
  };
  return {service, host, get row() {return row}, set row(value) {row = value}, get hostWrites() {return hostWrites}, get effects() {return effects}, replace,
    set beforeHost(value: () => void) {beforeHost = value}, set afterHost(value: () => void) {afterHost = value}, set beforeRequest(value: () => void) {beforeRequest = value},
    set lostHostReply(value: boolean) {lostHostReply = value}, set lostRequestReply(value: boolean) {lostRequestReply = value}, set outage(value: boolean) {outage = value},
    set settledRows(value: unknown[]) {settledRows = value},
    restore() {for (const spy of [hostRead, requestRead, settled, hostWrite, completion, rejected]) spy.mockRestore()}};
}
const run = (f: ReturnType<typeof fixture>, reject: boolean) => reject ? f.service.rejectPreparation(intent.requestId, 'pro', rejection) :
  f.service.completePreparation(intent.requestId, 'pro', digest, input, binding);

for (const reject of [false, true]) for (const stop of [false, true]) test(`${reject ? 'rejection' : 'completion'} admits at the host CAS, rejecting ${stop ? 'stop' : 'replacement'} before it and preserving proof after it`, async () => {
  let f = fixture();
  try {
    f.beforeHost = () => f.replace(stop);
    await expect(run(f, reject)).rejects.toMatchObject({status: 409}); expect(f.hostWrites).toBe(0); expect(f.effects).toBe(0);
  } finally {f.restore()}
  f = fixture();
  try {
    f.afterHost = () => f.replace(stop);
    const result = await run(f, reject); expect(result.state).toBe(reject ? 'terminal' : 'queued'); expect(f.hostWrites).toBe(1); expect(f.effects).toBe(1);
    expect(f.host.preparationFrameworkAdmissions[0]).toMatchObject({binding, admittedAt: time, incarnation: 'original', sequence: 1});
    expect(f.host.preparationFrameworkAdmissions[0]).not.toHaveProperty('snapshot');
  } finally {f.restore()}
});
for (const reject of [false, true]) test(`${reject ? 'rejection' : 'completion'} preserves cancellation, withdrawal, selection and deadline fences between the two CASes`, async () => {
  for (const change of ['cancel', 'withdraw', 'selection', 'deadline']) {
    const f = fixture();
    try {
      if (change === 'deadline') f.row = {...f.row, fleetDeadline: new Date(now + 1000)};
      f.afterHost = () => {
        if (change === 'cancel') f.row = {...f.row, preparationCancellation: {requestedAt: time, reason: 'Cancel'}, state: 'terminal', terminalStatus: 'cancelled'};
        if (change === 'withdraw') f.row = {...f.row, fleetCancellation: {reason: 'Withdraw'}};
        if (change === 'selection') f.row = {...f.row, fleetTarget: {hostId: 'other', laneId: 'other'}};
        if (change === 'deadline') f.row = {...f.row, fleetDeadline: new Date(now - 1)};
      };
      await run(f, reject); expect(f.hostWrites).toBe(1); expect(f.effects).toBe(0); expect(f.row.input).toBeUndefined(); expect(f.row.preparationRejection).toBeUndefined();
    } finally {f.restore()}
  }
});
for (const reject of [false, true]) test(`${reject ? 'rejection' : 'completion'} reconciles a lost host reply from its unchanged admission after replacement`, async () => {
  const f = fixture();
  try {
    f.lostHostReply = true;
    await expect(run(f, reject)).rejects.toThrow('Lost host reply'); expect(f.effects).toBe(0); f.replace();
    if (!reject) await f.service.assertPreparationFramework(f.row, binding, true);
    await run(f, reject); expect(f.effects).toBe(1); expect(f.hostWrites).toBe(1); expect(f.host.preparationFrameworkAdmissions[0].admittedAt).toBe(time);
    f.lostRequestReply = true; // Already committed replay returns exact effect without another write.
    await run(f, reject); expect(f.effects).toBe(1);
  } finally {f.restore()}
});
test('host admission refuses changed effects and binding, retains unknown publication, and propagates authority outage', async () => {
  const f = fixture();
  try {
    f.lostHostReply = true; await expect(run(f, false)).rejects.toThrow('Lost host reply');
    await expect(f.service.completePreparation(intent.requestId, 'pro', digest, {...input, resources: [{id: 'other', kind: 'app'}]}, binding)).rejects.toMatchObject({status: 409});
    await expect(f.service.completePreparation(intent.requestId, 'pro', digest, input, {...binding, installationId: 'different'})).rejects.toMatchObject({status: 409});
    await expect(run(f, true)).rejects.toMatchObject({status: 409}); expect(f.effects).toBe(0); expect(f.host.preparationFrameworkAdmissions).toHaveLength(1);
  } finally {f.restore()}
  const failed = fixture();
  try {failed.outage = true; await expect(run(failed, false)).rejects.toThrow('Host authority unavailable'); expect(failed.effects).toBe(0)} finally {failed.restore()}
});
test('unknown request reply is reconciled from the exact committed effect without re-admission', async () => {
  const f = fixture();
  try {
    f.lostRequestReply = true; await expect(run(f, false)).rejects.toThrow('Lost request reply'); f.replace();
    expect(await run(f, false)).toEqual(f.row); expect(f.effects).toBe(1); expect(f.hostWrites).toBe(1);
  } finally {f.restore()}
});
test('unfinished admissions fail visibly closed at the poll request bound and only exact authoritative settlement prunes them', async () => {
  const f = fixture();
  try {
    f.lostHostReply = true; await expect(run(f, false)).rejects.toThrow('Lost host reply');
    const admitted = f.host.preparationFrameworkAdmissions[0];
    f.host.preparationFrameworkAdmissions = Array.from({length: 100}, (_, index) => ({...admitted, requestId: `old-${index}`, admittedAt: '2020-01-01T00:00:00Z'}));
    await expect(run(f, false)).rejects.toMatchObject({status: 409, message: expect.stringContaining('100 original requests remain unresolved')});
    expect(f.host.preparationFrameworkAdmissions).toHaveLength(100); expect(f.effects).toBe(0);
    f.settledRows = [{requestId: 'old-0', hostId: 'other', dispatchIntentSha256: digest}];
    await expect(run(f, false)).rejects.toMatchObject({status: 409});
    f.settledRows = [{requestId: 'old-0', hostId: 'pro', dispatchIntentSha256: digest}];
    await run(f, false); expect(f.effects).toBe(1); expect(f.host.preparationFrameworkAdmissions).toHaveLength(100);
    expect(f.host.preparationFrameworkAdmissions.some((receipt: any) => receipt.requestId === 'old-0')).toBe(false);
    expect(f.host.preparationFrameworkAdmissions.some((receipt: any) => receipt.requestId === intent.requestId)).toBe(true);
  } finally {f.restore()}
});
test('concurrent identical completions share one admitted effect while competing effects cannot both commit', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([run(f, false), run(f, false)]);
    expect(results[0]).toEqual(results[1]); expect(f.hostWrites).toBe(1); expect(f.effects).toBe(1);
  } finally {f.restore()}
  const competing = fixture();
  try {
    const results = await Promise.allSettled([run(competing, false), run(competing, true)]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(competing.hostWrites).toBe(1); expect(competing.effects).toBe(1);
  } finally {competing.restore()}
});
