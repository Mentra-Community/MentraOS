import {createHash} from 'node:crypto';
import {createServer, type AddressInfo, type Socket} from 'node:net';
import {expect, test, spyOn} from 'bun:test';
import {recordedFrameworkRunSchema} from '../types/framework-run.types';
import {testRoutineSource} from '../testing/framework-fixtures';
import {FrameworkResultService} from './framework-result.service';
import {failureDiagnosticAsset, readFailureScreens, recordedFailureScreens} from './framework-failure-screen';
import {TestAssetService} from './test-asset.service';
import {StorageService} from './storage/storage.service';
import {S3StorageProvider} from './storage/providers/s3-storage.provider';
import {TestAssetModel} from '../models/test-run.model';

const failure = {phase: 'test' as const, actionId: 'update', message: 'Update Failed'};
const screenshot = {id: 'failure-screen', kind: 'screenshot' as const, path: 'screenshots/opaque.png',
  mimeType: 'image/png' as const, size: 10, sha256: 'a'.repeat(64)};
const diagnostic = [{command: 'failure', state: 'error', ...failure, error: {message: failure.message}, screenshotAssetId: screenshot.id}];
const bytes = Buffer.from(JSON.stringify(diagnostic));
function fixture(platform: 'android' | 'ios-on-mac' = 'android') {
  return recordedFrameworkRunSchema.parse({schemaVersion: 1, requestId: 'display-failure', hostId: 'mini', routineId: 'update',
    definitionRevision: 'c'.repeat(40), platform, laneId: 'phone',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-03T19:00:00Z', finishedAt: '2026-10-03T19:01:00Z',
    assets: [screenshot, {id: 'diagnostic', kind: 'diagnostic', mimeType: 'application/json',
      path: platform === 'android' ? 'setup-evidence/setup-diagnostics.json' : 'run.json',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}],
    result: {runId: 'display-failure', finishedAt: '2026-10-03T19:01:00Z', setup: {status: 'passed'}, test: 'failed',
      steps: [{id: failure.actionId, status: 'failed', durationMs: 1}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [failure], evidence: ['diagnostic'],
      timing: {startedAt: '2026-10-03T19:00:00Z', setupMs: 0, testMs: 1, teardownMs: 0}}});
}
const association = [{phase: failure.phase, actionId: failure.actionId, assetId: screenshot.id}];

test('Android failure image requires its exact recorded phase, action, message and declared image', () => {
  const run = fixture();
  expect(recordedFailureScreens(run, diagnostic)).toEqual(association);
  for (const changed of [{phase: 'setup'}, {actionId: 'other'}, {error: {message: 'Different failure'}},
    {screenshotAssetId: 'foreign'}, {command: 'failure-screenshot'}, {state: 'complete'}, {screenshotAssetId: undefined}])
    expect(recordedFailureScreens(run, [{...diagnostic[0], ...changed}])).toEqual([]);
  expect(recordedFailureScreens({...run, assets: run.assets.filter(asset => asset.id !== screenshot.id)}, diagnostic)).toEqual([]);
  expect(recordedFailureScreens({...run, assets: run.assets.map(asset => asset.id === screenshot.id ? {...asset, kind: 'diagnostic'} : asset)}, diagnostic)).toEqual([]);
  expect(recordedFailureScreens(run, [...diagnostic, {...diagnostic[0], screenshotAssetId: 'foreign'}])).toEqual([]);
  expect(recordedFailureScreens(run, [...diagnostic, ...diagnostic])).toEqual(association);
  const other = {...failure, message: 'A different update failure'};
  const conflicting = {...run, assets: [...run.assets, {...screenshot, id: 'other-screen', path: 'screenshots/other.png'}],
    result: {...run.result, failures: [failure, other]}};
  expect(recordedFailureScreens(conflicting, [...diagnostic,
    {...diagnostic[0], error: {message: other.message}, screenshotAssetId: 'other-screen'}])).toEqual([]);
});

test('Mac failed result uses its explicit public screenshot path without choosing a nearby image', () => {
  const run = fixture('ios-on-mac');
  const row = {id: failure.actionId, status: 'failed', error: failure.message, screenshot: screenshot.path};
  expect(recordedFailureScreens(run, {results: [row]})).toEqual(association);
  for (const changed of [{privateEvidence: true}, {status: 'passed'}, {error: 'Different failure'},
    {screenshot: 'screenshots/failure-update.png'}, {id: 'other'}])
    expect(recordedFailureScreens(run, {results: [{...row, ...changed}]})).toEqual([]);
  expect(recordedFailureScreens({...run, result: {...run.result, failures: [{...failure, phase: 'setup'}]}}, {results: [row]})).toEqual([]);
  expect(recordedFailureScreens({...run, assets: [...run.assets, {...screenshot, id: 'ambiguous'}]}, {results: [row]})).toEqual([]);
});

test('diagnostic display read validates frozen size and digest and refuses missing or oversized reports', async () => {
  const run = fixture();
  expect(await readFailureScreens(run, async () => new Response(bytes))).toEqual(association);
  expect(await readFailureScreens(run, async () => new Response(Buffer.concat([bytes, Buffer.from(' ')])))).toEqual([]);
  expect(await readFailureScreens(run, async () => new Response(bytes.subarray(1)))).toEqual([]);
  expect(await readFailureScreens(run, async () => new Response(Buffer.alloc(bytes.length, 32)))).toEqual([]);
  expect(await readFailureScreens(run, async () => new Response(null, {status: 404}))).toEqual([]);
  expect(await readFailureScreens(run, async () => {throw new Error('unavailable');})).toEqual([]);
  expect(failureDiagnosticAsset({...run, assets: [{...run.assets[1]!, size: 8 * 1024 ** 2 + 1}]})).toBeUndefined();
  expect(failureDiagnosticAsset({...run, result: {...run.result, failures: []}})).toBeUndefined();
});

test('a stalled diagnostic body is cancelled within the display deadline', async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const stream = new ReadableStream<Uint8Array>({pull() {return new Promise(() => {});}, cancel() {cancelled = true;}});
  const started = performance.now();
  expect(await readFailureScreens(fixture(), async (_, supplied) => {signal = supplied; return new Response(stream);})).toEqual([]);
  expect(performance.now() - started).toBeLessThan(4000);
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test('late diagnostic resolution and rejection are handled and a late body is cancelled', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => {unhandled.push(reason);};
  let cancelled = false;
  process.on('unhandledRejection', listener);
  try {
    expect(await Promise.all([
      readFailureScreens(fixture(), async () => {await Bun.sleep(3100); return new Response(new ReadableStream({cancel() {cancelled = true;}}));}),
      readFailureScreens(fixture(), async () => {await Bun.sleep(3100); throw new Error('late diagnostic failure');}),
    ])).toEqual([[], []]);
    await Bun.sleep(200);
    expect(cancelled).toBe(true);
    expect(unhandled).toEqual([]);
  } finally {process.off('unhandledRejection', listener);}
});

test('the real diagnostic media path aborts stalled S3 HEAD at the display deadline without starting GET', async () => {
  const sockets = new Set<Socket>(), methods: string[] = [];
  let closedAt: number | undefined;
  const started = performance.now();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => {sockets.delete(socket); closedAt = performance.now() - started;});
    socket.on('data', chunk => {const method = chunk.toString().split(' ')[0]; if (method === 'HEAD' || method === 'GET') methods.push(method);});
    // Deliberately never send metadata. The client must close this request at its own deadline.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = fixture(), declared = run.assets[1]!;
  const provider = new S3StorageProvider({endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bucket: 'private-test-bucket', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key', region: 'us-east-1'});
  const media = new TestAssetService(undefined, () => new StorageService(provider));
  try {
    expect(await readFailureScreens(run, async (_, signal) => media.mediaDeclaredAsset({assetId: declared.id, kind: 'metadata',
      contentType: declared.mimeType, filename: 'diagnostic.json', sizeBytes: declared.size, sha256: declared.sha256},
    {runId: run.result.runId, assetId: declared.id, storageKey: 'diagnostic', sizeBytes: declared.size, sha256: declared.sha256},
    new Request('http://localhost/diagnostic', {signal})))).toEqual([]);
    await Bun.sleep(100);
    expect(methods).toEqual(['HEAD']);
    expect(closedAt).toBeDefined();
    expect(closedAt!).toBeLessThan(4000);
  } finally {for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));}
});

test('a delayed frozen declaration cannot start an upload lookup or storage read after its deadline', async () => {
  const run = fixture();
  let finishDeclaration!: (value: {runId: string; asset: typeof run.assets[number]}) => void;
  const service = new FrameworkResultService({async insert() {}, async getByRequest() {return null;}, async getByRun() {return null;},
    getAsset() {return new Promise(resolve => {finishDeclaration = resolve;});}});
  const upload = spyOn(TestAssetModel, 'findOne');
  try {
    const reading = readFailureScreens(run, (asset, signal) => service.mediaByRun(run.result.runId, asset.id,
      new Request('http://localhost/diagnostic', {signal})));
    expect(await reading).toEqual([]);
    finishDeclaration({runId: run.result.runId, asset: run.assets[1]!});
    await Bun.sleep(20);
    expect(upload).not.toHaveBeenCalled();
  } finally {upload.mockRestore();}
});

test('Admin projects optional failure images without changing frozen results or adding host completion work', async () => {
  const run = fixture(), stored = {payload: run, payloadSha256: 'd'.repeat(64), uploadsComplete: true};
  const original = JSON.stringify(run);
  const service = new FrameworkResultService({async insert() {}, async getByRequest() {return stored;},
    async getByRun() {return stored;}, async getAsset() {return null;}},
    async () => ({hostId: run.hostId, input: {routineId: run.routineId, definitionRevision: run.definitionRevision,
      routineSource: testRoutineSource(), platform: run.platform, laneId: run.laneId, build: run.build}}), async () => {}, async () => null);
  const media = spyOn(service, 'mediaByRun').mockImplementation(async () => new Response(bytes));
  try {
    const detail = await service.detailByRun(run.result.runId, true);
    expect(detail.failureScreens).toEqual(association);
    expect(detail.outcome).toBe('failed');
    expect(JSON.stringify(run)).toBe(original);
    media.mockClear();
    expect(await service.detail(run.requestId)).not.toHaveProperty('failureScreens');
    expect(await service.detailByRun(run.result.runId)).not.toHaveProperty('failureScreens');
    expect(await service.detailForHost(run.requestId, run.hostId)).not.toHaveProperty('failureScreens');
    expect(media).not.toHaveBeenCalled();
    stored.uploadsComplete = false;
    expect((await service.detail(run.requestId, true)).failureScreens).toEqual([]);
    expect(media).not.toHaveBeenCalled();
    stored.uploadsComplete = true;
    media.mockImplementation(async () => {throw new Error('missing diagnostic');});
    const missing = await service.detail(run.requestId, true);
    expect(missing.failureScreens).toEqual([]);
    expect(missing.outcome).toBe('failed');
    expect(missing.run).toEqual(run);
  } finally {media.mockRestore();}
});
