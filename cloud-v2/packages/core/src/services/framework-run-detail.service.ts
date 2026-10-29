import {z} from 'zod';
import {TestAssetModel, TestRunModel} from '../models/test-run.model';
import {testWriteConcern} from '../models/test-write-concern';
import {recordedFrameworkRunSchema, type RecordedFrameworkRun} from '../types/framework-run.types';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {requestInputDigest} from './test-request.service';
import {TestRunError} from './test-result-error';
import type {StoredTestAsset} from './test-asset.service';

export const acceptedTestAssetSchema = z.object({runId: z.string(), assetId: z.string(), storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const frameworkRunEnvelopeSchema = z.object({version: z.literal(1), payload: recordedFrameworkRunSchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/), acceptedAssets: z.array(acceptedTestAssetSchema)}).strict();
export type FrameworkRunEnvelope = z.infer<typeof frameworkRunEnvelopeSchema>;

export function verifyRunEnvelope(input: unknown, complete: boolean): FrameworkRunEnvelope {
  const envelope = frameworkRunEnvelopeSchema.parse(input), run = envelope.payload;
  if (requestInputDigest(run) !== envelope.payloadSha256) throw new TestRunError(503, 'Frozen result digest differs');
  const assets = new Map(envelope.acceptedAssets.map(asset => [asset.assetId, asset]));
  if (assets.size !== envelope.acceptedAssets.length || envelope.acceptedAssets.some(asset => asset.runId !== run.result.runId))
    throw new TestRunError(503, 'Accepted result asset identity differs');
  if (complete && (assets.size !== run.assets.length || !run.assets.every(asset => {
    const accepted = assets.get(asset.id);
    return accepted?.sha256 === asset.sha256 && accepted.sizeBytes === asset.size;
  }))) throw new TestRunError(503, 'Accepted result manifest differs');
  return envelope;
}

export async function readStoredRun(row: {runId: string; payloadSha256: string; detail: unknown; uploadsComplete: boolean},
  details = new TestingDetailStorage()) {
  const envelope = verifyRunEnvelope(await details.read(row.detail, frameworkRunEnvelopeSchema), row.uploadsComplete);
  if (envelope.payload.result.runId !== row.runId || envelope.payloadSha256 !== row.payloadSha256)
    throw new TestRunError(503, 'Stored result identity differs');
  return envelope;
}

export async function writeRunEnvelope(payload: RecordedFrameworkRun, payloadSha256: string, acceptedAssets: StoredTestAsset[],
  complete: boolean, details = new TestingDetailStorage()) {
  const envelope = verifyRunEnvelope({version: 1, payload, payloadSha256, acceptedAssets}, complete);
  return details.write('run', payload.result.runId, envelope);
}

/** Completed results own their accepted mapping; pending upload receipts remain ordinary custody. */
export async function readAcceptedTestAsset(row: {runId: string; payloadSha256: string; detail: unknown; uploadsComplete: boolean},
  assetId: string, envelope?: FrameworkRunEnvelope): Promise<StoredTestAsset | null> {
  if (row.uploadsComplete) return (envelope ?? await readStoredRun(row)).acceptedAssets.find(asset => asset.assetId === assetId) ?? null;
  const receipt = await TestAssetModel.findOne({runId: row.runId, assetId}).read('primary').readConcern('majority').lean();
  if (receipt) return receipt;
  // Completion may have moved this same accepted mapping while the pending read was in flight.
  const completed = await TestRunModel.findOne({resultSchemaVersion: 1, runId: row.runId, payloadSha256: row.payloadSha256, uploadsComplete: true})
    .select({runId: 1, detail: 1, payloadSha256: 1, uploadsComplete: 1}).read('primary').readConcern('majority').lean();
  return completed ? (await readStoredRun(completed)).acceptedAssets.find(asset => asset.assetId === assetId) ?? null : null;
}

export async function findAcceptedTestAsset(runId: string, assetId: string): Promise<StoredTestAsset | null> {
  const row = await TestRunModel.findOne({resultSchemaVersion: 1, runId})
    .select({runId: 1, detail: 1, payloadSha256: 1, uploadsComplete: 1}).read('primary').readConcern('majority').lean();
  if (row) return readAcceptedTestAsset(row, assetId);
  return TestAssetModel.findOne({runId, assetId}).read('primary').readConcern('majority').lean();
}

export async function completeStoredRun(payload: RecordedFrameworkRun, payloadSha256: string) {
  const runId = payload.result.runId;
  const read = () => TestRunModel.findOne({runId, resultSchemaVersion: 1, payloadSha256})
    .read('primary').readConcern('majority').lean();
  const completed = async () => {
    const row = await read();
    if (!row?.uploadsComplete) return false;
    await readStoredRun(row);
    return true;
  };
  const current = await read();
  if (!current) throw new TestRunError(409, 'Result publication identity is unavailable');
  if (current.uploadsComplete) await readStoredRun(current);
  else {
    try {
      const acceptedAssets = await TestAssetModel.find({runId}).select({runId: 1, assetId: 1, storageKey: 1, sizeBytes: 1, sha256: 1, _id: 0})
        .read('primary').readConcern('majority').lean();
      try {verifyRunEnvelope({version: 1, payload, payloadSha256, acceptedAssets}, true);}
      catch {throw new TestRunError(409, 'Required manifest uploads are not acknowledged');}
      const detail = await writeRunEnvelope(payload, payloadSha256, acceptedAssets, true);
      const result = await TestRunModel.updateOne({runId, resultSchemaVersion: 1, payloadSha256, uploadsComplete: false},
        {$set: {detail, uploadsComplete: true}}, {writeConcern: testWriteConcern});
      if (result.matchedCount !== 1 && !await completed()) throw new TestRunError(409, 'Completed result publication conflicts');
    } catch (error) {
      // A concurrent winner may have deleted receipts; a timed-out update may have committed.
      if (!await completed()) throw error;
    }
  }
  // A failed/partial cleanup rejects completion. The next host retry settles this same authority.
  await TestAssetModel.deleteMany({runId}, {writeConcern: testWriteConcern});
}
