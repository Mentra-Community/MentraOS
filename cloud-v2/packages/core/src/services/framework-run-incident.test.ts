import {createHash} from 'node:crypto';
import {expect, test} from 'bun:test';
import type {RecordedFrameworkRun} from '../types/framework-run.types';
import {readRunIncident, recordedRunIncident} from './framework-run-incident';

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

test('incident link requires a filed receipt bound to the original request and run', () => {
  expect(recordedRunIncident(runId, request, bytes)).toBe('rep_EXACT');
  for (const changed of [{status: 'failed'}, {test_run_id: 'other-run'}, {alert_id: 'other-alert'},
    {requestSha256: 'f'.repeat(64)}, {incident_id: 'rep_OTHER'}, {report_id: '../foreign'}, {schemaVersion: 2},
    {requestFile: 'other/request.json'}])
    expect(recordedRunIncident(runId, request, Buffer.from(JSON.stringify({...receipt, ...changed})))).toBeNull();
  expect(recordedRunIncident('other-run', request, bytes)).toBeNull();
  expect(recordedRunIncident(runId, Buffer.concat([request, Buffer.from(' ')]), bytes)).toBeNull();
  expect(recordedRunIncident(runId, request, Buffer.from('not json'))).toBeNull();
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
  expect((await service.detailByRun(runId, true)).incidentReportId).toBeNull();
});
