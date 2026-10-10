import {createHash} from 'node:crypto';
import {expect, test} from 'bun:test';
import type {RecordedFrameworkRun} from '../types/framework-run.types';
import {readRunIncident, readRunIncidentCorrelation, recordedRunIncident} from './framework-run-incident';

const runId = 'original-run';
const request = Buffer.from(JSON.stringify({schemaVersion: 1, request: {test_run_id: runId, alert_id: 'original-alert'}}));
const receipt = {schemaVersion: 1, test_run_id: runId, alert_id: 'original-alert', status: 'filed',
  requestFile: 'incident-report/request.json', requestSha256: createHash('sha256').update(request).digest('hex'),
  report_id: 'rep_EXACT', incident_id: 'rep_EXACT'};
const bytes = Buffer.from(JSON.stringify(receipt));
function fixture(): RecordedFrameworkRun {
  return {result: {runId}, assets: [request, bytes].map((body, index) => ({id: String(index), kind: 'report',
    path: `incident-report/${index ? 'result' : 'request'}.json`, mimeType: 'application/json',
    size: body.length, sha256: createHash('sha256').update(body).digest('hex')}))} as RecordedFrameworkRun;
}

test('receipt-loss recovery requires the exact unique hash-verified original automation request', async () => {
  const original = Buffer.from(JSON.stringify({schemaVersion: 1, request: {
    source: 'mentra_automated_testing', alert_id: 'original-alert', test_run_id: runId,
  }}));
  const asset = {...fixture().assets[0]!, size: original.length, sha256: createHash('sha256').update(original).digest('hex')};
  const run = {...fixture(), assets: [asset]};
  expect(await readRunIncidentCorrelation(run, async () => new Response(original))).toEqual({alertId: 'original-alert', testRunId: runId});
  expect(await readRunIncidentCorrelation({...run, assets: [asset, {...asset, id: 'duplicate'}]}, async () => new Response(original))).toBeNull();
  expect(await readRunIncidentCorrelation(run, async () => new Response(Buffer.concat([original, Buffer.from(' ')])))).toBeNull();
  for (const change of [{schemaVersion: 2}, {request: {source: 'external_trigger', alert_id: 'original-alert', test_run_id: runId}},
    {request: {source: 'mentra_automated_testing', alert_id: 'original-alert', test_run_id: 'unrelated-run'}},
    {request: {source: 'mentra_automated_testing', alert_id: '../private', test_run_id: runId}}]) {
    const body = Buffer.from(JSON.stringify({...JSON.parse(original.toString()), ...change}));
    expect(await readRunIncidentCorrelation({...run, assets: [{...asset, size: body.length,
      sha256: createHash('sha256').update(body).digest('hex')}]}, async () => new Response(body))).toBeNull();
  }
});

test('existing authenticated completion recovers a filed report link after transport receipt loss without changing failed verdict', async () => {
  const {FrameworkResultService} = await import('./framework-result.service');
  const {requestInputDigest} = await import('./test-request.service');
  const original = Buffer.from(JSON.stringify({schemaVersion: 1, request: {
    source: 'mentra_automated_testing', alert_id: 'original-alert', test_run_id: runId,
  }}));
  const run = {...fixture(), requestId: 'accepted-request', result: {runId, setup: {status: 'passed'}, test: 'failed',
    teardown: {ready: true}, failures: [{phase: 'test', actionId: 'original', message: 'Original failure'}]},
    assets: [{...fixture().assets[0]!, size: original.length, sha256: createHash('sha256').update(original).digest('hex')}]} as RecordedFrameworkRun;
  const before = JSON.stringify(run), hash = requestInputDigest(run);
  let lookup = 0, failLookup = false, unavailableLookup = false, uploadsComplete = true;
  const service = new FrameworkResultService({async insert() {}, async getByRequest() {
    return {payload: run, payloadSha256: hash, uploadsComplete};
  }, async getByRun() {return {payload: run, payloadSha256: hash, uploadsComplete};}, async getAsset() {return null;}},
  async () => ({hostId: 'owned-host', input: {} as never}), undefined, undefined, undefined,
  {async list() {return [];}, async complete() {throw new Error('Must not acknowledge missing uploads');}},
  {async complete() {return undefined;}}, undefined, async correlation => {
    lookup++; expect(correlation).toEqual({alertId: 'original-alert', testRunId: runId});
    if (unavailableLookup) throw new Error('Optional report lookup unavailable');
    return failLookup ? null : 'rep_ORIGINAL';
  });
  service.mediaByRun = async () => new Response(original);
  expect(await service.complete('accepted-request', 'owned-host')).toMatchObject({deviceIncident: {
    reportId: 'rep_ORIGINAL', correlation: {alertId: 'original-alert', testRunId: runId},
  }});
  expect(JSON.stringify(run)).toBe(before);
  expect(run.result.test).toBe('failed');
  failLookup = true;
  expect(await service.complete('accepted-request', 'owned-host')).not.toHaveProperty('deviceIncident');
  expect(lookup).toBe(2);
  unavailableLookup = true;
  expect(await service.complete('accepted-request', 'owned-host')).not.toHaveProperty('deviceIncident');
  expect(lookup).toBe(3);
  await expect(service.complete('accepted-request', 'foreign-host')).rejects.toThrow('not acknowledged');
  expect(lookup).toBe(3);
  uploadsComplete = false;
  await expect(service.complete('accepted-request', 'owned-host')).rejects.toThrow('not acknowledged');
  expect(lookup).toBe(3);
});

test('incident link requires a created report receipt bound to the original request and run', () => {
  expect(recordedRunIncident(runId, request, bytes)).toBe('rep_EXACT');
  expect(recordedRunIncident(runId, request, Buffer.from(JSON.stringify({...receipt, status: 'failed'})))).toBe('rep_EXACT');
  for (const changed of [{status: 'skipped'}, {status: 'failed', report_id: undefined}, {test_run_id: 'other-run'}, {alert_id: 'other-alert'},
    {requestSha256: 'f'.repeat(64)}, {incident_id: 'rep_OTHER'}, {report_id: '../foreign'}, {schemaVersion: 2},
    {requestFile: 'other/request.json'}])
    expect(recordedRunIncident(runId, request, Buffer.from(JSON.stringify({...receipt, ...changed})))).toBeNull();
  expect(recordedRunIncident('other-run', request, bytes)).toBeNull();
  expect(recordedRunIncident(runId, Buffer.concat([request, Buffer.from(' ')]), bytes)).toBeNull();
  expect(recordedRunIncident(runId, request, Buffer.from('not json'))).toBeNull();
});

test('partial log collection failure retains its verified incident link through the declared asset reader', async () => {
  const failed = Buffer.from(JSON.stringify({...receipt, status: 'failed',
    collection: {reportId: receipt.report_id, state: 'failed', logCollection: {}}}));
  const run = fixture();
  run.assets[1] = {...run.assets[1]!, size: failed.length, sha256: createHash('sha256').update(failed).digest('hex')};
  expect(await readRunIncident(run, async asset => new Response(asset.id === '0' ? request : failed))).toBe('rep_EXACT');
});

test('receipt lookup reads only unique declared blobs and verifies their exact bytes', async () => {
  const run = fixture();
  const read = async (asset: RecordedFrameworkRun['assets'][number]) => new Response(asset.id === '0' ? request : bytes);
  expect(await readRunIncident(run, read)).toBe('rep_EXACT');
  expect(await readRunIncident({...run, assets: []}, read)).toBeNull();
  expect(await readRunIncident({...run, assets: [...run.assets, {...run.assets[0]!, id: 'duplicate'}]}, read)).toBeNull();
  expect(await readRunIncident(run, async () => new Response(Buffer.alloc(bytes.length, 32)))).toBeNull();
  expect(await readRunIncident(run, async () => new Response(null, {status: 404}))).toBeNull();
  let readOversized = false;
  expect(await readRunIncident({...run, assets: [{...run.assets[0]!, size: 65 * 1024}, run.assets[1]!]}, async () => {
    readOversized = true; return new Response(request);
  })).toBeNull();
  expect(readOversized).toBe(false);
});

test('a stalled incident receipt is cancelled without preventing run display', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({cancel() {cancelled = true;}});
  expect(await readRunIncident(fixture(), async () => new Response(body))).toBeNull();
  expect(cancelled).toBe(true);
});

test('Admin detail prefers its filed device incident and uses an existing framework report when none filed', async () => {
  const {FrameworkResultService} = await import('./framework-result.service');
  const {recordedFrameworkRunSchema} = await import('../types/framework-run.types');
  const {requestInputDigest} = await import('./test-request.service');
  const run = recordedFrameworkRunSchema.parse({schemaVersion: 1, requestId: runId, hostId: 'mini', routineId: 'diagnose',
    definitionRevision: 'a'.repeat(40), platform: 'android', laneId: 'android',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-09T20:00:00Z', finishedAt: '2026-10-09T20:01:00Z', assets: fixture().assets,
    result: {runId, finishedAt: '2026-10-09T20:01:00Z', setup: {status: 'failed', actionId: 'pair'}, test: 'not-run',
      steps: [{id: 'inspect', status: 'not-run', durationMs: 0, causedBy: 'pair'}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: 'setup', actionId: 'pair', message: 'Pairing failed'}], evidence: [],
      timing: {startedAt: '2026-10-09T20:00:00Z', setupMs: 1, testMs: 0, teardownMs: 0}}});
  let uploaded = true, fallbackReads = 0, failLookup = false;
  const repository = {async insert() {}, async getByRequest() {return {payload: run, payloadSha256: requestInputDigest(run), uploadsComplete: uploaded};},
    async getByRun() {return this.getByRequest();}, async getAsset() {return null;}};
  const service = new FrameworkResultService(repository, undefined, undefined, async () => null, undefined, undefined,
    {async complete() {throw new Error('Display must never submit an incident');}}, async (id, hash) => {
      expect(id).toBe(runId); expect(hash).toBe(requestInputDigest(run)); fallbackReads++;
      if (failLookup) throw new Error('Report lookup unavailable');
      return 'rep_FRAMEWORK';
    });
  service.mediaByRun = async (_run, assetId) => new Response(assetId === '0' ? request : bytes);
  expect((await service.detailByRun(runId, true)).incidentReportId).toBe('rep_EXACT');
  expect(fallbackReads).toBe(0);
  expect(await service.detail(runId)).not.toHaveProperty('incidentReportId');
  uploaded = false;
  expect((await service.detailByRun(runId, true)).incidentReportId).toBe('rep_FRAMEWORK');
  failLookup = true;
  const pending = await service.detailByRun(runId, true);
  expect(pending.incidentReportId).toBeNull();
  expect(pending.incidentReportPending).toBe(true);
  failLookup = false;
  expect((await service.detailByRun(runId, true)).incidentReportPending).toBe(false);
});
