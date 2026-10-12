import {afterEach, expect, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {ReportAssetModel} from '../models/report-asset.model';
import {ReportModel} from '../models/report.model';
import {TestAssetModel, TestRunModel} from '../models/test-run.model';
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures';
import {recordedFrameworkRunSchema} from '../types/framework-run.types';
import {referenceDeviceIncidentDiagnostics, referenceTestRunDiagnostics} from './report.service';
import {requestInputDigest} from './test-request.service';
import {writeRunEnvelope} from './framework-run-detail.service';
import {readNativeReportAssets} from './report-native-detail.service';

const mocks: Array<{mockRestore(): void}> = [];
afterEach(() => mocks.splice(0).forEach(mock => mock.mockRestore()));
const owner = {reportId: 'rep_DIAGNOSTIC', mentraUserId: 'automation:test-run'};
function frozenRun(count: number) {
  const hash = createHash('sha256').update('diagnostic bytes').digest('hex');
  const assets = Array.from({length: count}, (_, index) => ({id: `diagnostic:${index}`, kind: index % 2 ? 'screenshot' : 'diagnostic',
    path: `original/diagnostic-${index}.json`, sha256: hash, size: index + 1, mimeType: index % 2 ? 'image/png' : 'application/json'}));
  return recordedFrameworkRunSchema.parse({schemaVersion: 1, requestId: 'diagnostic-run', hostId: 'host', laneId: 'android',
    routineId: 'notes', routineSource: testRoutineSource(), frameworkBinding: testFrameworkBinding(), definitionRevision: 'a'.repeat(40),
    platform: 'android', build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:01:00Z', assets,
    result: {runId: 'diagnostic-run', finishedAt: '2026-10-08T10:01:00Z', setup: {status: 'failed'}, test: 'not-run',
      steps: [{id: 'required', status: 'not-run', durationMs: 0, causedBy: 'original'}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: 'setup', actionId: 'original', message: 'Original setup failure'}], evidence: [],
      timing: {startedAt: '2026-10-08T10:00:00Z', setupMs: 10, testMs: 0, teardownMs: 10}}});
}
async function models(count: number) {
  const run = frozenRun(count), payloadSha256 = requestInputDigest(run), accepted = run.assets.map(asset => ({runId: run.result.runId,
    assetId: asset.id, storageKey: `test-runs/original/${asset.id}`, sha256: asset.sha256, sizeBytes: asset.size}));
  const detail = await writeRunEnvelope(run, payloadSha256, accepted, true);
  const row: any = {...owner, createdAt: new Date('2026-10-08T10:02:00Z'), artifacts: []};
  const chain = (value: unknown) => ({read() {return this;}, readConcern() {return this;}, select() {return this;}, setOptions() {return this;}, async lean() {return value;}});
  mocks.push(spyOn(ReportModel, 'findOne').mockImplementation(() => chain(row) as never));
  mocks.push(spyOn(TestRunModel, 'findOne').mockImplementation(() => chain({runId: run.result.runId, payloadSha256, uploadsComplete: true, detail}) as never));
  const bulk = spyOn(ReportAssetModel, 'bulkWrite'), custody = spyOn(TestAssetModel, 'find');
  const write = spyOn(ReportModel, 'updateOne').mockImplementation(((_filter: unknown, change: any) => {
    row.nativeDiagnostics ??= change.$set.nativeDiagnostics; return Promise.resolve({matchedCount: 1});
  }) as never); mocks.push(bulk, custody, write);
  return {run, row, accepted, write, bulk, custody};
}
for (const count of [1389, 4096]) test(`${count} attachments share one immutable accepted result and keep Mongo inventory constant`, async () => {
  const f = await models(count), original = requestInputDigest(f.run);
  expect(await referenceTestRunDiagnostics(owner, f.run)).toBe(count);
  const pointer = structuredClone(f.row.nativeDiagnostics), first = await readNativeReportAssets(f.row);
  expect(first.assets.map(asset => asset.storageKey)).toEqual(f.accepted.map(asset => asset.storageKey));
  expect(first.artifacts.filter(asset => asset.type === 'screenshot')).toHaveLength(Math.floor(count / 2));
  expect(f.row.artifacts).toEqual([]); expect(JSON.stringify(pointer).length).toBeLessThan(600);
  expect(f.bulk).not.toHaveBeenCalled(); expect(f.custody).not.toHaveBeenCalled();
  expect(await referenceTestRunDiagnostics(owner, f.run)).toBe(count); expect(f.write).toHaveBeenCalledTimes(1);
  expect(await readNativeReportAssets(f.row)).toEqual(first); expect(requestInputDigest(f.run)).toBe(original);
});
test('a committed source pointer with lost acknowledgement reconciles on retry without rewriting timestamps', async () => {
  const f = await models(2), committed = Error('acknowledgement lost');
  const implementation = f.write.getMockImplementation()!;
  f.write.mockImplementationOnce(((...args: any[]) => {(implementation as (...args: any[]) => any)(...args); return Promise.reject(committed);}) as never);
  await expect(referenceTestRunDiagnostics(owner, f.run)).rejects.toBe(committed);
  const first = await readNativeReportAssets(f.row);
  expect(await referenceTestRunDiagnostics(owner, f.run)).toBe(2);
  expect(await readNativeReportAssets(f.row)).toEqual(first); expect(f.write).toHaveBeenCalledTimes(1);
});
test('foreign owner or run authority cannot be reused', async () => {
  const f = await models(2); await referenceTestRunDiagnostics(owner, f.run);
  await expect(readNativeReportAssets({...f.row, mentraUserId: 'foreign'})).rejects.toMatchObject({status: 503});
  f.row.nativeDiagnostics.runId = 'foreign';
  await expect(referenceTestRunDiagnostics(owner, f.run)).rejects.toMatchObject({status: 409});
});
test('device attachment authority requires the original alert and test-run association', async () => {
  const f = await models(2), find = spyOn(ReportModel, 'findOne'); mocks.push(find);
  find.mockImplementationOnce(() => ({read() {return this;}, readConcern() {return this;}, select() {return this;}, setOptions() {return this;},
    async lean() {return {...f.row, kind: 'automatic', trigger: {source: 'mentra_automated_testing', reason: 'incident_report_requested'}};}}) as never);
  expect(await referenceDeviceIncidentDiagnostics(owner.reportId, {alertId: 'original', testRunId: f.run.result.runId}, f.run)).toBe(2);
  expect(find.mock.calls[0]?.[0]).toMatchObject({'automationCorrelation.testRunId': f.run.result.runId, 'automationCorrelation.alertId': 'original'});
  await expect(referenceDeviceIncidentDiagnostics(owner.reportId, {alertId: 'original', testRunId: 'foreign'}, f.run)).rejects.toMatchObject({status: 409});
});
