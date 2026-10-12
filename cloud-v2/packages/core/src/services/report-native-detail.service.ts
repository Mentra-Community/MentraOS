import {z} from 'zod';
import {TestRunModel} from '../models/test-run.model';
import {readStoredRun, type FrameworkRunEnvelope} from './framework-run-detail.service';
import {TestingDetailStorage, testingDetailPointerSchema} from './testing-detail-storage.service';
import {TestRunError} from './test-result-error';

const nativeReferenceSchema = z.object({runId: z.string(), payloadSha256: z.string(), count: z.number().int().nonnegative(),
  detail: testingDetailPointerSchema}).strict();
export const reportNativeSnapshotSchema = z.object({version: z.literal(1), reportId: z.string(), mentraUserId: z.string(),
  runId: z.string(), payloadSha256: z.string(), artifacts: z.array(z.object({artifactId: z.string(), assetId: z.string(),
    createdAt: z.string().datetime({offset: true}), type: z.enum(['screenshot', 'state_snapshot']),
    source: z.enum(['framework-screenshot', 'framework-diagnostic'])}).strict())}).strict();
export type ReportNativeSnapshot = z.infer<typeof reportNativeSnapshotSchema>;

/** Resolve shared native bytes through one accepted run authority; report-owned uploads stay independent. */
export async function readNativeReportAssets(row: {reportId: string; mentraUserId: string; nativeDiagnostics?: unknown},
  storage = new TestingDetailStorage()) {
  if (!row.nativeDiagnostics) return {artifacts: [], assets: []};
  const reference = nativeReferenceSchema.parse(row.nativeDiagnostics);
  const snapshot = await storage.read(reference.detail, reportNativeSnapshotSchema);
  if (snapshot.reportId !== row.reportId || snapshot.mentraUserId !== row.mentraUserId || snapshot.runId !== reference.runId ||
    snapshot.payloadSha256 !== reference.payloadSha256 || snapshot.artifacts.length !== reference.count)
    throw new TestRunError(503, 'Native report source association differs');
  const runRow = await TestRunModel.findOne({resultSchemaVersion: 1, runId: reference.runId, payloadSha256: reference.payloadSha256,
    uploadsComplete: true}).read('primary').readConcern('majority').lean();
  if (!runRow) throw new TestRunError(503, 'Native report result authority is unavailable');
  const envelope = await readStoredRun(runRow, storage);
  return expandNativeReportSnapshot(snapshot, envelope);
}

export function expandNativeReportSnapshot(snapshot: ReportNativeSnapshot, envelope: FrameworkRunEnvelope) {
  if (snapshot.runId !== envelope.payload.result.runId || snapshot.payloadSha256 !== envelope.payloadSha256)
    throw new TestRunError(503, 'Native report result identity differs');
  const descriptors = new Map(envelope.payload.assets.map(asset => [asset.id, asset]));
  const accepted = new Map(envelope.acceptedAssets.map(asset => [asset.assetId, asset]));
  if (new Set(snapshot.artifacts.map(asset => asset.artifactId)).size !== snapshot.artifacts.length ||
    new Set(snapshot.artifacts.map(asset => asset.assetId)).size !== snapshot.artifacts.length)
    throw new TestRunError(503, 'Native report attachment identities differ');
  const expanded = snapshot.artifacts.map(artifact => {
    const asset = descriptors.get(artifact.assetId), blob = accepted.get(artifact.assetId);
    if (!asset || !blob || !['diagnostic', 'report', 'screenshot'].includes(asset.kind) ||
      (asset.kind === 'screenshot') !== (artifact.type === 'screenshot'))
      throw new TestRunError(503, 'Native report attachment is not declared');
    const fileName = asset.path.split('/').at(-1) ?? null;
    return {artifact: {artifactId: artifact.artifactId, type: artifact.type, source: artifact.source, filename: fileName,
      contentType: asset.mimeType, sizeBytes: asset.size, createdAt: artifact.createdAt},
      asset: {artifactId: artifact.artifactId, storageKey: blob.storageKey, fileName,
        contentType: asset.mimeType, sizeBytes: asset.size, sha256: asset.sha256, createdAt: artifact.createdAt}};
  });
  return {artifacts: expanded.map(value => value.artifact), assets: expanded.map(value => value.asset)};
}
