import {expect, spyOn, test} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {TestHostStateModel} from '../models/test-host-state.model';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import {TestHostStateService} from './test-host-state.service';
import {requestInputDigest, TestRequestService, type StoredRequest, type TestRequestRepository} from './test-request.service';
import {preparedRoutineRequestSchema} from './routine-dispatch.service';
import {preparationRejectionSchema, preparationStatusSchema} from '../types/routine-dispatch.types';

const now = Date.parse('2026-10-18T09:17:00Z'), current = {...testFrameworkBinding(), version: 1085};
const build = {repository: 'Mentra-Community/MentraOS' as const, headSha: 'c'.repeat(40), channel: 'dev' as const, kind: 'android-apk' as const,
  source: {channel: 'dev' as const, buildRunId: 1, publicationAttempt: 1},
  archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', size: 10, sha256: 'd'.repeat(64)},
  receipt: {url: 'https://artifactscdn.mentraglass.com/receipt', size: 2, sha256: 'e'.repeat(64)}};
const intent = {requestId: 'gallery-original', routineId: 'gallery-sync-android', platform: 'android' as const,
  routineRevision: 'a'.repeat(40), laneId: 'pro-android', source: build.source, build, minimumFrameworkVersion: 1085};
const input = {routineId: intent.routineId, platform: intent.platform, definitionRevision: intent.routineRevision,
  routineSource: testRoutineSource(), laneId: intent.laneId, build, resources: [{id: 'app', kind: 'app'}], minimumFrameworkVersion: 1085};
const observation = (version = 1085, time = now) => ({binding: {...current, version},
  receivedAt: new Date(time).toISOString(), observedAt: new Date(time).toISOString()});
function fixture(initial = observation()) {
  let row: StoredRequest | null = null, observed: ReturnType<typeof observation> | null = initial, completions = 0, rejections = 0;
  const repository: TestRequestRepository = {
    async insert() {throw Error('unused')}, async get() {return structuredClone(row)}, async accept() {return null}, async reject() {return null},
    async cancel() {return null}, async acknowledgeCancellation() {return null}, async queued() {return []}, async cancellations() {return []},
    async insertPreparation(value) {row = structuredClone(value)}, async preparations() {return row?.state === 'preparing' ? [structuredClone(row)] : []},
    async completePreparation(id, host, digest, value, inputSha256) {
      if (row?.state !== 'preparing') return null;
      completions++; row = {...row, state: 'queued', input: value, inputSha256}; return structuredClone(row);
    },
    async rejectPreparation(id, host, digest, value) {
      if (row?.state !== 'preparing') return null;
      rejections++; row = {...row, state: 'terminal', terminalStatus: 'not-run', preparationRejection: value}; return structuredClone(row);
    },
    async updatePreparation(id, host, digest, value) {if (row?.state !== 'preparing') return null; row = {...row, preparation: value}; return structuredClone(row)},
    async cancelPreparation(id, digest, value) {if (row?.state !== 'preparing') return null; row = {...row, state: 'terminal', terminalStatus: 'cancelled', preparationCancellation: value}; return structuredClone(row)},
  };
  const service = new TestRequestService(repository, undefined, null, {async frameworkObservation() {return structuredClone(observed)}}, () => now);
  return {service, get observed() {return observed}, set observed(value) {observed = value}, get completions() {return completions}, get rejections() {return rejections}};
}
test('unknown, stale, future and below-floor observations withhold preparation without changing immutable identity', async () => {
  for (const observed of [null, observation(1083), observation(1085, now - 120_001), observation(1085, now + 1),
    {...observation(), observedAt: new Date(now + 1).toISOString()},
    {...observation(), observedAt: new Date(now - 120_001).toISOString()}]) {
    const f = fixture(); f.observed = observed;
    const original = await f.service.prepare('pro', intent);
    expect((await f.service.queued('pro', undefined, 1)).preparations).toEqual([]);
    expect(await f.service.get(intent.requestId)).toEqual(original);
    await expect(f.service.assertPreparationFramework(original, current, true)).rejects.toMatchObject({status: 409});
  }
  for (const version of [1085, 1086]) {
    const f = fixture(observation(version)); await f.service.prepare('pro', intent);
    expect((await f.service.queued('pro', undefined, 1)).preparations).toHaveLength(1);
  }
});
test('delayed old or binding-free rejection cannot borrow an upgraded framework, while cancellation still wins', async () => {
  const f = fixture(observation(1083)), original = await f.service.prepare('pro', intent), digest = original.dispatchIntentSha256!;
  f.observed = observation();
  const rejected = {dispatchIntentSha256: digest, code: 'source-invalid', reason: 'Frozen resources mismatch', rejectedAt: new Date(now).toISOString(), disposition: 'not-run'};
  for (const frameworkBinding of [undefined, {...current, version: 1083}, {...current, installationId: 'retired-installation'}]) {
    await expect(f.service.rejectPreparation(intent.requestId, 'pro', {...rejected, ...(frameworkBinding ? {frameworkBinding} : {})})).rejects.toMatchObject({status: 409});
    expect(await f.service.get(intent.requestId)).toEqual(original);
  }
  expect(f.rejections).toBe(0);
  f.observed = null;
  const cancelled = (await f.service.cancel(intent.requestId, new Date(now).toISOString(), 'Operator cancellation'))!;
  expect(await f.service.rejectPreparation(intent.requestId, 'pro', rejected)).toEqual(cancelled);
  expect(await f.service.completePreparation(intent.requestId, 'pro', digest, input)).toEqual(cancelled);
});
test('exact eligible response completes once and an older response cannot commit', async () => {
  const f = fixture(), original = await f.service.prepare('pro', intent), digest = original.dispatchIntentSha256!;
  await expect(f.service.completePreparation(intent.requestId, 'pro', digest, input, {...current, version: 1083})).rejects.toMatchObject({status: 409});
  expect(f.completions).toBe(0);
  const queued = await f.service.completePreparation(intent.requestId, 'pro', digest, input, current);
  expect(queued.inputSha256).toBe(requestInputDigest(input));
  expect(queued.dispatchIntent).toEqual(intent); expect(queued.dispatchIntentSha256).toBe(digest);
  expect(await f.service.completePreparation(intent.requestId, 'pro', digest, input, current)).toEqual(queued); expect(f.completions).toBe(1);
});
test('framework replacement during preparation validation is rechecked before the final input CAS', async () => {
  const f = fixture(), original = await f.service.prepare('pro', intent);
  await f.service.assertPreparationFramework(original, current, true);
  f.observed = {...observation(), binding: {...current, installationId: 'successor-installation'}};
  await expect(f.service.completePreparation(intent.requestId, 'pro', original.dispatchIntentSha256!, input, current)).rejects.toMatchObject({status: 409});
  expect(f.completions).toBe(0); expect(await f.service.get(intent.requestId)).toEqual(original);
  await expect(f.service.rejectPreparation(intent.requestId, 'pro', {dispatchIntentSha256: original.dispatchIntentSha256!, frameworkBinding: current,
    code: 'source-invalid', reason: 'Old validation', rejectedAt: new Date(now).toISOString(), disposition: 'not-run'})).rejects.toMatchObject({status: 409});
  expect(f.rejections).toBe(0);
});
test('waiting status retains the actual old binding after replacement without terminalizing the original', async () => {
  const f = fixture(), original = await f.service.prepare('pro', intent), old = {...current, version: 1083};
  const value = {dispatchIntentSha256: original.dispatchIntentSha256!, frameworkBinding: old, code: 'framework-minimum',
    reason: 'Waiting for framework 1085; installed 1083', observedAt: new Date(now - 1000).toISOString()};
  const updated = await f.service.preparationStatus(intent.requestId, 'pro', value);
  expect(updated).toMatchObject({state: 'preparing', dispatchIntent: intent, preparation: {frameworkBinding: old, reason: value.reason}});
  expect(updated).not.toHaveProperty('input'); expect(updated).not.toHaveProperty('preparationRejection');
  expect(preparationStatusSchema.parse(value).frameworkBinding).toEqual(old);
  const {observedAt, ...rejection} = value;
  expect(preparationRejectionSchema.parse({...rejection, rejectedAt: observedAt, disposition: 'not-run'}).frameworkBinding).toEqual(old);
  expect(preparedRoutineRequestSchema.shape.frameworkBinding.parse(current)).toEqual(current);
});
test('no-floor legacy rejection still accepts the original body without requiring a host framework', async () => {
  const f = fixture(); f.observed = null;
  const {minimumFrameworkVersion: _floor, ...legacy} = intent, original = await f.service.prepare('pro', legacy);
  expect((await f.service.queued('pro', undefined, 1)).preparations).toHaveLength(1);
  const rejected = await f.service.rejectPreparation(intent.requestId, 'pro', {dispatchIntentSha256: original.dispatchIntentSha256,
    code: 'source-invalid', reason: 'Actual invalid source', rejectedAt: new Date(now).toISOString(), disposition: 'not-run'});
  expect(rejected.state).toBe('terminal'); expect(f.rejections).toBe(1);
});
test('Mongo preparing filter applies the version floor before its page limit, preserving rotation and original digests', async () => {
  const rows = Array.from({length: 101}, (_, i) => ({requestId: `request-${i}`, hostId: 'pro', state: 'preparing',
    dispatchIntent: {...intent, requestId: `request-${i}`, minimumFrameworkVersion: i < 100 ? 1086 : 1085},
    dispatchIntentSha256: requestInputDigest({...intent, requestId: `request-${i}`, minimumFrameworkVersion: i < 100 ? 1086 : 1085})}));
  const calls: unknown[] = [];
  const find = spyOn(TestRequestModel, 'find').mockImplementation(((filter: any) => {
    calls.push(filter); let limit = 0;
    const query = {sort() {return query}, limit(value: number) {limit = value; return query}, read() {return query}, readConcern() {return query}, async lean() {
      if (filter.state !== 'preparing') return [];
      const version = filter.$or[1]['dispatchIntent.minimumFrameworkVersion'].$lte;
      return rows.filter(row => row.dispatchIntent.minimumFrameworkVersion <= version).slice(0, limit);
    }}; return query;
  }) as never);
  const update = spyOn(TestRequestModel, 'updateMany').mockResolvedValue({} as never);
  try {
    const service = new TestRequestService(undefined, undefined, null, {async frameworkObservation() {return observation()}}, () => now);
    const page = await service.queued('pro', undefined, 1);
    expect(page.preparations.map(row => row.requestId)).toEqual(['request-100']);
    expect(calls).toContainEqual({hostId: 'pro', state: 'preparing', $or: [
      {'dispatchIntent.minimumFrameworkVersion': {$exists: false}}, {'dispatchIntent.minimumFrameworkVersion': {$lte: 1085}},
    ]});
    expect(page.preparations[0]!.dispatchIntentSha256).toBe(rows[100]!.dispatchIntentSha256);
  } finally {find.mockRestore(); update.mockRestore()}
});
test('updater minimum includes withheld preparing requests in one primary-majority bounded host query and clears on withdrawal', async () => {
  let withdrawn = false; const calls: unknown[] = [];
  const find = spyOn(TestRequestModel, 'findOne').mockImplementation(((filter: unknown) => {
    calls.push(filter);
    const query = {select(value: unknown) {calls.push(value); return query}, sort(value: unknown) {calls.push(value); return query},
      read(value: unknown) {calls.push(value); return query}, readConcern(value: unknown) {calls.push(value); return query},
      setOptions(value: unknown) {calls.push(value); return query}, async lean() {
        return withdrawn ? null : {dispatchIntent: {minimumFrameworkVersion: 1086}};
      }}; return query;
  }) as never);
  try {
    const service = new TestRequestService(); expect(await service.preparationFrameworkMinimum('pro')).toBe(1086);
    withdrawn = true; expect(await service.preparationFrameworkMinimum('pro')).toBeNull();
    expect(calls).toContainEqual({hostId: 'pro', state: 'preparing', 'dispatchIntent.minimumFrameworkVersion': {$exists: true}});
    expect(calls).toContainEqual({'dispatchIntent.minimumFrameworkVersion': -1});
    expect(calls).toContain('primary'); expect(calls).toContain('majority'); expect(calls).toContainEqual({timeoutMS: 5000});
  } finally {find.mockRestore()}
});
test('framework read uses compact primary/majority accepted identity and refuses an observed stopped interval', async () => {
  let ended = false, malformed = false; const calls: unknown[] = [];
  const find = spyOn(TestHostStateModel, 'findOne').mockImplementation(((filter: unknown) => {
    calls.push(filter);
    const query = {select(value: unknown) {calls.push(value); return query}, read(value: unknown) {calls.push(value); return query},
      readConcern(value: unknown) {calls.push(value); return query}, setOptions(value: unknown) {calls.push(value); return query}, async lean() {
        const time = new Date(now).toISOString(), process = {pid: 123, startedAt: 'exact-process-lifetime'};
        return {hostId: 'pro', receivedAt: new Date(now), snapshot: {hostId: 'pro', incarnation: 'current', observedAt: time,
          frameworkBinding: malformed ? {...current, version: '1085'} : current, frameworkAcceptedAt: time, frameworkProcess: process}, frameworkHistory: [{binding: current, incarnation: 'current',
          incarnationGeneration: 1, process, effectiveAt: time, observedAt: time, ...(ended ? {endedAt: time, endReason: 'observed-stop'} : {})}]};
      }}; return query;
  }) as never);
  try {
    const service = new TestHostStateService(); expect((await service.frameworkObservation('pro'))?.binding).toEqual(current);
    ended = true; expect(await service.frameworkObservation('pro')).toBeNull();
    ended = false; malformed = true; expect(await service.frameworkObservation('pro')).toBeNull();
    expect(calls).toContain('primary'); expect(calls).toContain('majority'); expect(calls).toContainEqual({timeoutMS: 5000});
    expect(calls).not.toContainEqual(expect.objectContaining({'snapshot.lanes': 1}));
  } finally {find.mockRestore()}
});
