import {afterEach, expect, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {ReportNativeRunModel} from '../models/report-native-run.model';
import {readNativeReportAssets} from './report-native-detail.service';

const mocks: Array<{mockRestore(): void}> = [];
afterEach(() => mocks.splice(0).forEach(mock => mock.mockRestore()));

/** The stored digest, spelled out here so these fixtures stay what old reports actually hold. */
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
  : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

function stored() {
  const objects = new Map<string, Uint8Array>();
  const put = (key: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(sorted(value)));
    objects.set(key, bytes);
    return {key, sha256: digest(value), sizeBytes: bytes.byteLength};
  };
  return {objects, put, storage: {async getObject(key: string) {
    const bytes = objects.get(key);
    if (!bytes) throw new Error('missing');
    return bytes;
  }}};
}

/** One old automated report, its snapshot and framework run, as Core wrote them. */
function oldReport() {
  const blobs = stored();
  const fileHash = 'a'.repeat(64), shotHash = 'b'.repeat(64), runId = 'old-run';
  // Fields beyond those a report reads must stay in the digest without being parsed.
  const payload = {schemaVersion: 1, requestId: runId, routineId: 'notes', routineSource: {commit: 'c'.repeat(40)},
    result: {runId, finishedAt: '2026-10-08T10:01:00Z', steps: []},
    assets: [
      {id: 'diagnostic:0', kind: 'diagnostic', path: 'original/state.json', sha256: fileHash, size: 10, mimeType: 'application/json'},
      {id: 'screen:0', kind: 'screenshot', path: 'original/failure.png', sha256: shotHash, size: 20, mimeType: 'image/png'},
    ]};
  const payloadSha256 = digest(payload);
  const acceptedAssets = [
    {runId, assetId: 'diagnostic:0', storageKey: 'test-runs/old/state', sizeBytes: 10, sha256: fileHash},
    {runId, assetId: 'screen:0', storageKey: 'test-runs/old/failure', sizeBytes: 20, sha256: shotHash},
  ];
  const runDetail = blobs.put('testing-detail/dev/run/one.json', {version: 1, payload, payloadSha256, acceptedAssets});
  const createdAt = '2026-10-08T10:02:00.000Z';
  const snapshot = {version: 1, reportId: 'rep_OLD', mentraUserId: 'automation:test-run', runId, payloadSha256, artifacts: [
    {artifactId: 'art_STATE', assetId: 'diagnostic:0', createdAt, type: 'state_snapshot', source: 'framework-diagnostic'},
    {artifactId: 'art_SHOT', assetId: 'screen:0', createdAt, type: 'screenshot', source: 'framework-screenshot'},
  ]};
  const detail = blobs.put('testing-detail/dev/report-native/one.json', snapshot);
  const row = {reportId: 'rep_OLD', mentraUserId: 'automation:test-run', nativeDiagnostics: {runId, payloadSha256, count: 2, detail}};
  return {...blobs, row, runDetail, payloadSha256, runId, snapshot, createdAt};
}

function runRow(value: unknown) {
  const find = spyOn(ReportNativeRunModel, 'findOne').mockImplementation(() => ({
    read() {return this;}, readConcern() {return this;}, async lean() {return value;},
  }) as never);
  mocks.push(find);
  return find;
}

test('a report without native diagnostics, as every user report is, reads neither test_runs nor storage', async () => {
  const find = runRow(null), get = spyOn(stored().storage, 'getObject');
  mocks.push(get);
  expect(await readNativeReportAssets({reportId: 'rep_USER', mentraUserId: 'mu_user'})).toEqual({artifacts: [], assets: []});
  expect(find).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

test('an old automated report still resolves its attachments to the run blobs they name', async () => {
  const f = oldReport();
  const find = runRow({runId: f.runId, payloadSha256: f.payloadSha256, uploadsComplete: true, detail: f.runDetail});
  expect(await readNativeReportAssets(f.row, f.storage)).toEqual({
    artifacts: [
      {artifactId: 'art_STATE', type: 'state_snapshot', source: 'framework-diagnostic', filename: 'state.json', contentType: 'application/json', sizeBytes: 10, createdAt: f.createdAt},
      {artifactId: 'art_SHOT', type: 'screenshot', source: 'framework-screenshot', filename: 'failure.png', contentType: 'image/png', sizeBytes: 20, createdAt: f.createdAt},
    ],
    assets: [
      {artifactId: 'art_STATE', storageKey: 'test-runs/old/state', fileName: 'state.json', contentType: 'application/json', sizeBytes: 10, sha256: 'a'.repeat(64), createdAt: f.createdAt},
      {artifactId: 'art_SHOT', storageKey: 'test-runs/old/failure', fileName: 'failure.png', contentType: 'image/png', sizeBytes: 20, sha256: 'b'.repeat(64), createdAt: f.createdAt},
    ],
  });
  expect(find.mock.calls[0]?.[0]).toEqual({resultSchemaVersion: 1, runId: f.runId, payloadSha256: f.payloadSha256, uploadsComplete: true});
});

test('old diagnostics that cannot be trusted or reached stay unavailable, never partial', async () => {
  const unavailable = {status: 503};
  const missingRun = oldReport();
  runRow(null);
  await expect(readNativeReportAssets(missingRun.row, missingRun.storage)).rejects.toMatchObject(unavailable);

  const foreign = oldReport();
  await expect(readNativeReportAssets({...foreign.row, mentraUserId: 'mu_other'}, foreign.storage)).rejects.toMatchObject(unavailable);

  const tampered = oldReport();
  runRow({runId: tampered.runId, payloadSha256: tampered.payloadSha256, uploadsComplete: true, detail: tampered.runDetail});
  const bytes = tampered.objects.get(tampered.runDetail.key)!;
  tampered.objects.set(tampered.runDetail.key, Buffer.from(Buffer.from(bytes).toString().replace('state.json', 'other.json')));
  await expect(readNativeReportAssets(tampered.row, tampered.storage)).rejects.toMatchObject(unavailable);

  const gone = oldReport();
  gone.objects.clear();
  await expect(readNativeReportAssets(gone.row, gone.storage)).rejects.toMatchObject(unavailable);
});
