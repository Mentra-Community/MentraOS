/**
 * Diagnostics of old automated-testing incidents, read for as long as those reports exist.
 *
 * Nothing writes `nativeDiagnostics` for a user's report: their artifacts live in `report_assets`, and
 * this never runs for them. An old automated report keeps only a pointer to a snapshot in blob storage,
 * and that snapshot names files of its framework run, whose row stays in `test_runs` and whose envelope
 * stays under `testing-detail/`. Both must outlive these reports.
 */

import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ReportNativeRunModel} from '../models/report-native-run.model';
import {createStorageService, type StorageService} from './storage/storage.service';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const detailPointerSchema = z.object({key: z.string().min(1).max(1000), sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(32 * 1024 * 1024)}).strict();
const nativeReferenceSchema = z.object({runId: z.string(), payloadSha256: z.string(), count: z.number().int().nonnegative(),
  detail: detailPointerSchema}).strict();
const reportNativeSnapshotSchema = z.object({version: z.literal(1), reportId: z.string(), mentraUserId: z.string(),
  runId: z.string(), payloadSha256: z.string(), artifacts: z.array(z.object({artifactId: z.string(), assetId: z.string(),
    createdAt: z.string().datetime({offset: true}), type: z.enum(['screenshot', 'state_snapshot']),
    source: z.enum(['framework-screenshot', 'framework-diagnostic'])}).strict())}).strict();
type ReportNativeSnapshot = z.infer<typeof reportNativeSnapshotSchema>;

/** Only what a report reads of a stored run. The rest of the payload stays, unparsed, for its digest. */
const nativeRunEnvelopeSchema = z.object({version: z.literal(1), payloadSha256: sha256Schema,
  payload: z.object({result: z.object({runId: z.string()}).passthrough(),
    assets: z.array(z.object({id: z.string(), kind: z.string(), path: z.string(), sha256: sha256Schema,
      size: z.number().int().nonnegative(), mimeType: z.string()}).passthrough())}).passthrough(),
  acceptedAssets: z.array(z.object({runId: z.string(), assetId: z.string(), storageKey: z.string(),
    sizeBytes: z.number().int().nonnegative(), sha256: sha256Schema}).strict())}).strict();

interface NativeRunEnvelope {
  payloadSha256: string;
  payload: {result: {runId: string}; assets: Array<{id: string; kind: string; path: string; sha256: string; size: number; mimeType: string}>};
  acceptedAssets: Array<{assetId: string; storageKey: string; sizeBytes: number; sha256: string}>;
}

/** A stored diagnostic that cannot be trusted or reached right now. */
class NativeReportError extends Error {
  readonly status = 503 as const;
}

/** The digest stored details were written under: JSON with every object's keys sorted. */
function canonicalDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function readDetail<T>(storage: Pick<StorageService, 'getObject'>, input: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const pointer = detailPointerSchema.parse(input);
  let bytes: Uint8Array;
  try {bytes = await storage.getObject(pointer.key, AbortSignal.timeout(30_000));}
  catch {throw new NativeReportError('Immutable testing detail is unavailable');}
  if (bytes.byteLength !== pointer.sizeBytes) throw new NativeReportError('Immutable testing detail size differs');
  let value: unknown;
  try {value = JSON.parse(Buffer.from(bytes).toString('utf8'));}
  catch {throw new NativeReportError('Immutable testing detail JSON is invalid');}
  if (canonicalDigest(value) !== pointer.sha256) throw new NativeReportError('Immutable testing detail digest differs');
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NativeReportError('Immutable testing detail schema differs');
  return parsed.data;
}

function verifyStoredRun(envelope: z.infer<typeof nativeRunEnvelopeSchema>, row: {runId: string; payloadSha256: string}) {
  const run = envelope.payload;
  if (canonicalDigest(run) !== envelope.payloadSha256) throw new NativeReportError('Frozen result digest differs');
  const assets = new Map(envelope.acceptedAssets.map(asset => [asset.assetId, asset]));
  if (assets.size !== envelope.acceptedAssets.length || envelope.acceptedAssets.some(asset => asset.runId !== run.result.runId))
    throw new NativeReportError('Accepted result asset identity differs');
  if (assets.size !== run.assets.length || !run.assets.every(asset => {
    const accepted = assets.get(asset.id);
    return accepted?.sha256 === asset.sha256 && accepted.sizeBytes === asset.size;
  })) throw new NativeReportError('Accepted result manifest differs');
  if (run.result.runId !== row.runId || envelope.payloadSha256 !== row.payloadSha256)
    throw new NativeReportError('Stored result identity differs');
  return envelope;
}

/** Resolve shared native bytes through one accepted run authority; report-owned uploads stay independent. */
export async function readNativeReportAssets(row: {reportId: string; mentraUserId: string; nativeDiagnostics?: unknown},
  storage?: Pick<StorageService, 'getObject'>) {
  if (!row.nativeDiagnostics) return {artifacts: [], assets: []};
  const reference = nativeReferenceSchema.parse(row.nativeDiagnostics);
  const details = storage ?? createStorageService();
  const snapshot = await readDetail(details, reference.detail, reportNativeSnapshotSchema);
  if (snapshot.reportId !== row.reportId || snapshot.mentraUserId !== row.mentraUserId || snapshot.runId !== reference.runId ||
    snapshot.payloadSha256 !== reference.payloadSha256 || snapshot.artifacts.length !== reference.count)
    throw new NativeReportError('Native report source association differs');
  const runRow = await ReportNativeRunModel.findOne({resultSchemaVersion: 1, runId: reference.runId, payloadSha256: reference.payloadSha256,
    uploadsComplete: true}).read('primary').readConcern('majority').lean();
  if (!runRow) throw new NativeReportError('Native report result authority is unavailable');
  const envelope = await readDetail(details, runRow.detail, nativeRunEnvelopeSchema);
  return expandNativeReportSnapshot(snapshot, verifyStoredRun(envelope, reference));
}

function expandNativeReportSnapshot(snapshot: ReportNativeSnapshot, envelope: NativeRunEnvelope) {
  if (snapshot.runId !== envelope.payload.result.runId || snapshot.payloadSha256 !== envelope.payloadSha256)
    throw new NativeReportError('Native report result identity differs');
  const descriptors = new Map(envelope.payload.assets.map(asset => [asset.id, asset]));
  const accepted = new Map(envelope.acceptedAssets.map(asset => [asset.assetId, asset]));
  if (new Set(snapshot.artifacts.map(asset => asset.artifactId)).size !== snapshot.artifacts.length ||
    new Set(snapshot.artifacts.map(asset => asset.assetId)).size !== snapshot.artifacts.length)
    throw new NativeReportError('Native report attachment identities differ');
  const expanded = snapshot.artifacts.map(artifact => {
    const asset = descriptors.get(artifact.assetId), blob = accepted.get(artifact.assetId);
    if (!asset || !blob || !['diagnostic', 'report', 'screenshot'].includes(asset.kind) ||
      (asset.kind === 'screenshot') !== (artifact.type === 'screenshot'))
      throw new NativeReportError('Native report attachment is not declared');
    const fileName = asset.path.split('/').at(-1) ?? null;
    return {artifact: {artifactId: artifact.artifactId, type: artifact.type, source: artifact.source, filename: fileName,
      contentType: asset.mimeType, sizeBytes: asset.size, createdAt: artifact.createdAt},
      asset: {artifactId: artifact.artifactId, storageKey: blob.storageKey, fileName,
        contentType: asset.mimeType, sizeBytes: asset.size, sha256: asset.sha256, createdAt: artifact.createdAt}};
  });
  return {artifacts: expanded.map(value => value.artifact), assets: expanded.map(value => value.asset)};
}
