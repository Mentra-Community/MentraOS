import {createHash} from 'node:crypto';
import {createServer, type AddressInfo, type Socket} from 'node:net';
import {expect, test, spyOn} from 'bun:test';
import {recordedFrameworkRunSchema, type RecordedFrameworkRun} from '../types/framework-run.types';
import {testRoutineSource} from '../testing/framework-fixtures';
import {FrameworkResultService} from './framework-result.service';
import {failureDiagnosticAssets, readFailureScreens, recordedFailureScreens} from './framework-failure-screen';
import {TestAssetService} from './test-asset.service';
import {StorageService} from './storage/storage.service';
import {S3StorageProvider} from './storage/providers/s3-storage.provider';
import {TestAssetModel} from '../models/test-run.model';
import producerTerminal from '../testing/android-crashed-app-terminal.fixture';
import {recordedFailureImageProvenance} from './framework-failure-image-provenance';

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

test('cleanup-only causes retain exact recorded image associations and diagnostics without flattened copies', () => {
  for (const phase of ['teardown', 'evidence'] as const) for (const location of ['teardown', 'outcome'] as const) {
    const base = fixture(), error = {...failure, phase};
    const run = {...base, result: {...base.result, failures: [], teardown: {...base.result.teardown,
      errors: location === 'teardown' ? [error] : [], outcomes: location === 'outcome'
        ? [{state: 'cleaned' as const, resourceId: 'recorder', evidence: [], errors: [error]}] : []}}};
    const before = JSON.stringify(run);
    expect(failureDiagnosticAssets(run)).toEqual([base.assets[1]!]);
    expect(recordedFailureScreens(run, [{...diagnostic[0], phase}])).toEqual([{phase, actionId: failure.actionId, assetId: screenshot.id}]);
    expect(recordedFailureScreens(run, [{...diagnostic[0], phase, screenshotAssetId: 'foreign'}])).toEqual([]);
    expect(JSON.stringify(run)).toBe(before);
  }
});

function crashWitnessFixture() {
  const run = fixture(), preceding = {...screenshot, id: 'preceding-app', path: 'screenshots/preceding.png'},
    system = {...screenshot, id: 'current-system', path: 'screenshots/system.png'},
    desktop = {...screenshot, id: 'failure-desktop', path: 'screenshots/desktop.png'};
  const original = {pid: 29776, startSeq: 7632, bootId: 'f37d778b-baa3-4c56-a4a8-bc88bd207464', apkSha256: '9'.repeat(64), build: '991'};
  const row = {command: 'failure', state: 'error', ...failure, error: {message: failure.message},
    failureObservedAt: '2026-10-03T19:00:10Z',
    phoneProcessWitness: {original, state: 'replaced' as const, observedAt: '2026-10-03T19:00:11Z', current: {pid: 30444, startSeq: 7635}},
    precedingAppImage: {assetId: preceding.id, boundary: 'before-password-input' as const, original,
      captureStartedAt: '2026-10-03T19:00:08Z', captureFinishedAt: '2026-10-03T19:00:09Z'},
    currentPhoneImage: {assetId: system.id, source: 'system' as const, captureStartedAt: '2026-10-03T19:00:12Z', captureFinishedAt: '2026-10-03T19:00:13Z'},
    desktopAssetIds: [desktop.id], desktopImages: [{assetId: desktop.id, displayId: 0,
      captureStartedAt: '2026-10-03T19:00:12Z', captureFinishedAt: '2026-10-03T19:00:14Z'}]};
  return {run: {...run, assets: [...run.assets, preceding, system, desktop]}, row, preceding, system, desktop};
}

test('a ceased or replaced original app preserves preceding and system images without claiming either is the failure app', () => {
  const {run, row, desktop} = crashWitnessFixture(), frozen = JSON.stringify(run);
  const {command: _command, state: _state, phase, actionId, message: _message, error: _error, desktopAssetIds: _ids, ...metadata} = row;
  expect(recordedFailureScreens(run, [row])).toEqual([{phase, actionId, desktopAssetId: desktop.id, ...metadata}]);
  expect(recordedFailureScreens(run, [row, structuredClone(row)])).toEqual(recordedFailureScreens(run, [row]));
  const ceased = {...row, phoneProcessWitness: {...row.phoneProcessWitness, state: 'ceased', current: undefined}};
  expect(recordedFailureScreens(run, [ceased])[0]?.phoneProcessWitness?.state).toBe('ceased');
  expect(recordedFailureScreens(run, [{...row, currentPhoneImage: undefined}])[0]?.precedingAppImage).toEqual(row.precedingAppImage);
  expect(JSON.stringify(run)).toBe(frozen);
});

test('contradictory phone provenance refuses its images while independent recorded desktop evidence survives', () => {
  const {run, row, desktop, preceding} = crashWitnessFixture();
  const desktopOnly = [{phase: failure.phase, actionId: failure.actionId, desktopAssetId: desktop.id}];
  for (const changed of [
    {failureObservedAt: '2026-10-03T19:02:00Z'},
    {phoneProcessWitness: {...row.phoneProcessWitness, observedAt: '2026-10-03T19:00:09Z'}},
    {phoneProcessWitness: {...row.phoneProcessWitness, state: 'same'}},
    {phoneProcessWitness: {...row.phoneProcessWitness, state: 'ceased'}},
    {phoneProcessWitness: {...row.phoneProcessWitness, state: 'unknown', original: undefined}},
    {precedingAppImage: {...row.precedingAppImage, captureFinishedAt: '2026-10-03T19:00:11Z'}},
    {precedingAppImage: {...row.precedingAppImage, original: {...row.precedingAppImage.original, pid: 30444}}},
    {precedingAppImage: {...row.precedingAppImage, assetId: 'foreign'}},
    {screenshotAssetId: preceding.id},
    {currentPhoneImage: {...row.currentPhoneImage, source: 'original-app'}, screenshotAssetId: row.currentPhoneImage.assetId},
    {desktopImages: [{...row.desktopImages[0]!, capturedAt: '2026-10-03T19:00:15Z'}]},
  ]) expect(recordedFailureScreens(run, [{...row, ...changed}])).toEqual(desktopOnly);
  const sibling = {...row, precedingAppImage: {...row.precedingAppImage, boundary: 'before-email-input'}};
  expect(recordedFailureScreens(run, [row, sibling])).toEqual(desktopOnly);
  const legacy = {command: row.command, state: row.state, phase: row.phase, actionId: row.actionId, error: row.error, desktopAssetIds: ['foreign']};
  expect(recordedFailureScreens(run, [row, legacy])[0]?.desktopImages).toBeUndefined();
  const earlier = {...failure, message: 'Earlier failure without recorded capture'};
  expect(recordedFailureScreens({...run, result: {...run.result, failures: [earlier, failure]}}, [row])).toEqual([]);
  expect(recordedFailureScreens({...run, build: {...run.build, archive: {sha256: '8'.repeat(64)}}}, [row])).toEqual(desktopOnly);
});

test('new current app evidence requires the original process and capture interval, not just a matching APK', () => {
  const {run, row} = crashWitnessFixture();
  const same = {...row, phoneProcessWitness: {...row.phoneProcessWitness, state: 'same', current: {pid: 29776, startSeq: 7632}},
    screenshotAssetId: screenshot.id, currentPhoneImage: {...row.currentPhoneImage, source: 'original-app', assetId: screenshot.id}};
  expect(recordedFailureScreens(run, [same])[0]?.assetId).toBe(screenshot.id);
  const changed = {...same, phoneProcessWitness: {...same.phoneProcessWitness, current: {pid: 30444, startSeq: 7635}}};
  expect(recordedFailureScreens(run, [changed])[0]?.assetId).toBeUndefined();
});

test('the actual Harness crash A to B terminal fixture preserves all images and its final postcapture process witness', () => {
  const original = {...failure, phase: producerTerminal.phase as 'setup', actionId: producerTerminal.actionId, message: producerTerminal.error.message};
  const ids = [producerTerminal.precedingAppImage.assetId, producerTerminal.currentPhoneImage.assetId, ...producerTerminal.desktopAssetIds];
  const base = fixture(), run = {...base, startedAt: '2026-10-19T03:26:00Z', finishedAt: '2026-10-19T03:26:03Z',
    build: {...base.build, kind: 'android-apk', archive: {sha256: producerTerminal.phoneProcessWitness.original.apkSha256}},
    assets: ids.map(id => ({...screenshot, id, path: id})), result: {...base.result, failures: [original]}};
  const [display] = recordedFailureScreens(run, [producerTerminal]);
  const expected = recordedFailureImageProvenance(run, producerTerminal);
  expect(expected).toBeDefined();
  expect(display?.precedingAppImage).toEqual(expected!.precedingAppImage);
  expect(display?.currentPhoneImage).toEqual(expected!.currentPhoneImage);
  expect(display?.phoneProcessWitness).toEqual(expected!.phoneProcessWitness);
  expect(display?.desktopImages).toEqual(expected!.desktopImages);
  expect(display?.assetId).toBeUndefined();
  expect(display?.desktopAssetId).toBeUndefined();
});

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

test.each(['setup', 'test', 'teardown'] as const)('Android %s terminal row projects app and desktop captures independently', phase => {
  const original = {...failure, phase}, app = {...screenshot, id: 'screenshots/phone-opaque.png', path: 'screenshots/phone-opaque.png'},
    desktop = {...screenshot, id: 'screenshots/desktop-opaque.png', path: 'screenshots/desktop-opaque.png'};
  const run = {...fixture(), assets: [app, desktop], result: {...fixture().result, failures: [original]}};
  // This is the producer's terminal diagnostic shape, not nearby capture rows.
  const row = {at: '2026-10-03T19:01:00Z', command: 'failure', state: 'error', phase, actionId: original.actionId,
    screenshotAssetId: app.id, desktopAssetIds: [desktop.id], error: {message: original.message}};
  const both = [{phase, actionId: original.actionId, assetId: app.id, desktopAssetId: desktop.id}];
  const desktopOnly = [{phase, actionId: original.actionId, desktopAssetId: desktop.id}];
  expect(recordedFailureScreens(run, {records: [row]})).toEqual(both);
  expect(recordedFailureScreens(run, [row, row])).toEqual(both);
  expect(recordedFailureScreens(run, [{...row, screenshotAssetId: undefined}])).toEqual(desktopOnly);
  expect(recordedFailureScreens({...run, assets: [desktop]}, [row])).toEqual(desktopOnly);
  expect(recordedFailureScreens(run, [{...row, screenshotAssetId: 'foreign'}])).toEqual(desktopOnly);
  for (const changed of [{phase: phase === 'setup' ? 'test' : 'setup'}, {actionId: 'foreign'},
    {error: {message: 'Other failure'}}, {state: 'complete'}, {command: 'failure-desktop'}])
    expect(recordedFailureScreens(run, [{...row, ...changed}])).toEqual([]);
  for (const ids of [['foreign'], [desktop.id, 'foreign'], [], Array(5).fill(desktop.id), [desktop.id, 1], desktop.id])
    expect(recordedFailureScreens(run, [{...row, desktopAssetIds: ids}]))
      .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
  for (const changed of [{kind: 'diagnostic' as const}, {mimeType: 'application/json' as const}])
    expect(recordedFailureScreens({...run, assets: [app, {...desktop, ...changed}]}, [row]))
      .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
  expect(recordedFailureScreens({...run, assets: [app, desktop, {...desktop, path: 'screenshots/duplicate.png'}]}, [row]))
    .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
  const second = {...desktop, id: 'second-display', path: 'screenshots/second-display.png'};
  expect(recordedFailureScreens({...run, assets: [...run.assets, second]}, [{...row, desktopAssetIds: [desktop.id, second.id]}]))
    .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
  expect(recordedFailureScreens(run, [row, {...row, desktopAssetIds: ['foreign']}]))
    .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
  const sibling = {...original, message: 'Different terminal failure'};
  expect(recordedFailureScreens({...run, result: {...run.result, failures: [original, sibling]}},
    [row, {...row, error: {message: sibling.message}, desktopAssetIds: ['foreign']}]))
    .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
});

test('Android desktop-only producer evidence passes the existing frozen diagnostic read and preserves the result', async () => {
  const run = fixture(), desktop = {...screenshot, id: 'desktop-original', path: 'screenshots/desktop.png'};
  const row = {at: run.finishedAt, command: 'failure', state: 'error', phase: failure.phase, actionId: failure.actionId,
    desktopAssetIds: [desktop.id], error: {message: failure.message}};
  const json = jsonAsset('desktop-diagnostic', 'setup-evidence/setup-diagnostics.json', {records: [row]});
  const selected = {...run, assets: [desktop, json.asset]}, frozen = JSON.stringify(selected);
  expect(await readFailureScreens(selected, async () => new Response(json.body)))
    .toEqual([{phase: failure.phase, actionId: failure.actionId, desktopAssetId: desktop.id}]);
  expect(JSON.stringify(selected)).toBe(frozen);
  const nearby = jsonAsset('desktop-diagnostic', 'setup-evidence/setup-diagnostics.json', {records: [
    {command: 'failure-desktop', state: 'complete', phase: failure.phase, actionId: failure.actionId,
      assetId: desktop.id, path: desktop.path, displayId: 1, redacted: true},
  ]});
  expect(await readFailureScreens({...run, assets: [desktop, nearby.asset]}, async () => new Response(nearby.body))).toEqual([]);
});

test('a retained Mac reporter failure cannot establish a terminal screenshot association', () => {
  const run = fixture('ios-on-mac');
  const row = {id: failure.actionId, status: 'failed', error: failure.message, screenshot: screenshot.path};
  expect(recordedFailureScreens(run, {results: [row]})).toEqual([]);
  const terminal = {command: 'failure-screenshot', state: 'complete', phase: 'test', actionId: failure.actionId,
    message: failure.message, screenshotPath: screenshot.path, source: 'screenshot'};
  expect(recordedFailureScreens(run, [row, terminal])).toEqual(association);
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
  let oversizedRead = false;
  expect(await readFailureScreens({...run, assets: [{...run.assets[1]!, size: 8 * 1024 ** 2 + 1}]}, async () => {
    oversizedRead = true; return new Response(bytes);
  })).toEqual([]);
  expect(oversizedRead).toBe(false);
  expect(failureDiagnosticAssets({...run, result: {...run.result, failures: []}})).toEqual([]);
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
  let finishDeclaration!: (value: {runId: string; asset: typeof run.assets[number]; accepted: null}) => void;
  const service = new FrameworkResultService({async insert() {}, async getByRequest() {return null;}, async getByRun() {return null;},
    getAsset() {return new Promise(resolve => {finishDeclaration = resolve;});}});
  const upload = spyOn(TestAssetModel, 'findOne');
  try {
    const reading = readFailureScreens(run, (asset, signal) => service.mediaByRun(run.result.runId, asset.id,
      new Request('http://localhost/diagnostic', {signal})));
    expect(await reading).toEqual([]);
    finishDeclaration({runId: run.result.runId, asset: run.assets[1]!, accepted: null});
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
      routineSource: testRoutineSource(), platform: run.platform, laneId: run.laneId, build: run.build}}), async () => {}, async () => null,
    undefined, undefined, undefined, async () => null);
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

const journalPath = (id: string) => `setup-evidence/mac-commands-${id.repeat(8)}-${id.repeat(4)}-${id.repeat(4)}-${id.repeat(4)}-${id.repeat(12)}.json`;
function lifecycleFixture(phase: 'setup' | 'test' | 'teardown' = 'setup') {
  const run = fixture('ios-on-mac');
  const original = {...failure, phase};
  const app = {...screenshot, path: 'setup-evidence/screenshots/app-original.png'};
  const desktop = {...screenshot, id: 'desktop-original', path: 'setup-evidence/screenshots/display-original.png'};
  const rows = [
    {command: 'failure-screenshot', state: 'complete', ...original, source: 'screenshot', screenshotPath: app.path},
    {command: 'failure-screenshot', state: 'complete', ...original, source: 'desktop-screenshot', screenshotPath: desktop.path},
  ];
  return {run: {...run, assets: [app, desktop], result: {...run.result, failures: [original]}}, original, app, desktop, rows};
}
function jsonAsset(id: string, path: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  return {body, asset: {id, path, kind: 'diagnostic' as const, mimeType: 'application/json' as const,
    size: body.length, sha256: createHash('sha256').update(body).digest('hex')}};
}

test.each(['setup', 'test', 'teardown'] as const)('Mac %s journal associates each public source by exact original failure and declared relative path', phase => {
  const {run, original, app, desktop, rows} = lifecycleFixture(phase);
  const expected = [{phase, actionId: original.actionId, assetId: app.id, desktopAssetId: desktop.id}];
  expect(recordedFailureScreens(run, {records: rows})).toEqual(expected);
  for (const changed of [{phase: phase === 'setup' ? 'teardown' : 'setup'}, {actionId: 'other'}, {message: 'Other error'},
    {state: 'error'}, {state: 'suppressed'}, {privateEvidence: true}, {source: 'unknown'}, {screenshotPath: undefined, path: app.path}])
    expect(recordedFailureScreens(run, {records: rows.map(row => ({...row, ...changed}))})).toEqual([]);
  expect(recordedFailureScreens(run, {records: [{...rows[0], screenshotPath: '/absolute/' + app.path}]})).toEqual([]);
  expect(recordedFailureScreens(run, {records: [rows[1]]})).toEqual([{phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
  expect(recordedFailureScreens({...run, assets: [desktop]}, {records: rows})).toEqual([{phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
  const foreign = {...app, id: 'conflicting-app', path: 'setup-evidence/screenshots/unrelated.png'};
  expect(recordedFailureScreens({...run, assets: [...run.assets, foreign]}, {records: [...rows, {...rows[0], screenshotPath: foreign.path}]}))
    .toEqual([{phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
  expect(recordedFailureScreens({...run, assets: [...run.assets, {...app, id: 'duplicate-path'}]}, {records: rows}))
    .toEqual([{phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
  expect(recordedFailureScreens({...run, assets: [...run.assets, {...desktop, path: 'different-path.png'}]}, {records: rows}))
    .toEqual([{phase, actionId: original.actionId, assetId: app.id}]);
});

test.each(['passed', 'failed'] as const)('outer Mac test failure reads its terminal journal with historical %s nested rows', async status => {
  const {run, rows, original, app, desktop} = lifecycleFixture('test');
  const nested = jsonAsset('nested-report', 'run.json', {results: [
    {id: original.actionId, status, error: original.message, screenshot: 'screenshots/historical.png'},
  ]});
  const journal = jsonAsset('journal', journalPath('a'), {records: rows});
  const historical = {...app, id: 'historical-screen', path: 'screenshots/historical.png'};
  const recorded = {...run, assets: [...run.assets, historical, nested.asset, journal.asset]};
  const readIds: string[] = [], signals: AbortSignal[] = [];
  const expected = [{phase: original.phase, actionId: original.actionId, assetId: app.id, desktopAssetId: desktop.id}];
  expect(failureDiagnosticAssets(recorded)).toEqual([journal.asset]);
  expect(await readFailureScreens(recorded, async (asset, signal) => {
    readIds.push(asset.id); signals.push(signal);
    return new Response(asset.id === nested.asset.id ? nested.body : journal.body);
  })).toEqual(expected);
  expect(readIds).toEqual([journal.asset.id]);
  expect(signals).toHaveLength(1);
  expect(recorded.result.failures).toEqual([original]);
  expect(recorded.result.test).toBe('failed');
  expect(await readFailureScreens({...recorded, assets: [app, desktop, nested.asset]}, async () => new Response(nested.body)))
    .toEqual([]);

  const conflicting = jsonAsset('nested-report', 'run.json', {results: [
    {id: original.actionId, status: 'failed', error: original.message, screenshot: 'missing.png'},
  ]});
  expect(await readFailureScreens({...recorded, assets: [app, desktop, conflicting.asset, journal.asset]}, async asset =>
    new Response(asset.id === conflicting.asset.id ? conflicting.body : journal.body)))
    .toEqual(expected);
});

test('multiple declared Mac journals merge before association and share one total byte budget', async () => {
  const {run, rows, original, app, desktop} = lifecycleFixture();
  const first = jsonAsset('journal-a', journalPath('a'), {records: [rows[0]]});
  const second = jsonAsset('journal-b', journalPath('b'), {records: [rows[1]]});
  const reads: string[] = [], signals: AbortSignal[] = [];
  const read = async (asset: RecordedFrameworkRun['assets'][number], signal: AbortSignal) => {
    reads.push(asset.id); signals.push(signal); return new Response(asset.id === first.asset.id ? first.body : second.body);
  };
  expect(await readFailureScreens({...run, assets: [...run.assets, first.asset, second.asset]}, read))
    .toEqual([{phase: original.phase, actionId: original.actionId, assetId: app.id, desktopAssetId: desktop.id}]);
  expect(reads).toEqual([first.asset.id, second.asset.id]);
  expect(signals[0]).toBe(signals[1]);
  reads.length = 0;
  expect(await readFailureScreens({...run, assets: [...run.assets, {...first.asset, size: 5 * 1024 ** 2},
    {...second.asset, size: 5 * 1024 ** 2}]}, read)).toEqual([]);
  expect(reads).toEqual([]);
  const conflicting = jsonAsset('journal-c', journalPath('c'), {records: [{...rows[0], screenshotPath: 'unknown.png'}]});
  expect(await readFailureScreens({...run, assets: [...run.assets, first.asset, second.asset, conflicting.asset]}, async asset =>
    new Response(asset.id === first.asset.id ? first.body : asset.id === second.asset.id ? second.body : conflicting.body)))
    .toEqual([{phase: original.phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
});

test('all Mac journal reads share the original three-second deadline and refuse a partial association', async () => {
  const {run, rows} = lifecycleFixture();
  const first = jsonAsset('journal-a', journalPath('a'), {records: [rows[0]]});
  const second = jsonAsset('journal-b', journalPath('b'), {records: [rows[1]]});
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const started = performance.now();
  expect(await readFailureScreens({...run, assets: [...run.assets, first.asset, second.asset]}, async (asset, supplied) => {
    signal = supplied;
    if (asset.id === first.asset.id) {await Bun.sleep(1800); return new Response(first.body);}
    return new Response(new ReadableStream({pull() {return new Promise(() => {});}, cancel() {cancelled = true;}}));
  })).toEqual([]);
  expect(performance.now() - started).toBeLessThan(4000);
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test.each(['test', 'teardown'] as const)('bundled Mac %s journals retain their exact bytes and associations, with nested digest verification', async phase => {
  const {run, rows, original, app, desktop} = lifecycleFixture(phase);
  const originalJournal = jsonAsset('journal-a', journalPath('a'), {records: rows});
  const entry = {id: originalJournal.asset.id, path: originalJournal.asset.path, size: originalJournal.asset.size,
    sha256: originalJournal.asset.sha256, bytesBase64: originalJournal.body.toString('base64')};
  const makeBundle = (member: unknown) => jsonAsset('bundle', `setup-evidence-bundles/${'d'.repeat(64)}.json`,
    {schemaVersion: 1, kind: 'setup-diagnostic-bundle', encoding: 'base64', files: [member]});
  const good = makeBundle(entry);
  expect(await readFailureScreens({...run, assets: [...run.assets, good.asset]}, async () => new Response(good.body)))
    .toEqual([{phase: original.phase, actionId: original.actionId, assetId: app.id, desktopAssetId: desktop.id}]);
  for (const changed of [{sha256: 'e'.repeat(64)}, {size: entry.size + 1}, {bytesBase64: 'bad'}, {path: 'setup-evidence/unrelated.json'}]) {
    const bad = makeBundle({...entry, ...changed});
    expect(await readFailureScreens({...run, assets: [...run.assets, bad.asset]}, async () => new Response(bad.body))).toEqual([]);
  }
});


test('uncaptured sibling failures do not conflict with the displayed original, while real source ambiguity still refuses', () => {
  const {run, rows, original, app, desktop} = lifecycleFixture();
  const other = {...original, message: 'Another failure of this same action'};
  const expected = [{phase: original.phase, actionId: original.actionId, assetId: app.id, desktopAssetId: desktop.id}];
  const siblings = {...run, result: {...run.result, failures: [original, other]}};
  expect(recordedFailureScreens(siblings, {records: rows})).toEqual(expected);
  expect(recordedFailureScreens({...run, result: {...run.result, failures: [other, original]}}, {records: rows})).toEqual([]);
  expect(recordedFailureScreens({...run, result: {...run.result, failures: [original, {...original}]}}, {records: rows})).toEqual(expected);
  const otherApp = {...app, id: 'sibling-app', path: 'setup-evidence/screenshots/sibling-app.png'};
  const siblingAppRow = {...rows[0], message: other.message, screenshotPath: otherApp.path};
  const withOtherApp = {...siblings, assets: [...siblings.assets, otherApp]};
  expect(recordedFailureScreens(withOtherApp, {records: [...rows, siblingAppRow]}))
    .toEqual([{phase: original.phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
  expect(recordedFailureScreens(siblings, {records: [...rows, {...rows[0], message: other.message}]})).toEqual(expected);
  // A sibling with two conflicting paths is a recorded ambiguity, not an absent association.
  expect(recordedFailureScreens(withOtherApp, {records: [...rows, siblingAppRow, {...rows[0], message: other.message}]}))
    .toEqual([{phase: original.phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
  expect(recordedFailureScreens(siblings, {records: [...rows, {...rows[0], message: other.message, screenshotPath: 'missing.png'}]}))
    .toEqual([{phase: original.phase, actionId: original.actionId, desktopAssetId: desktop.id}]);
});
