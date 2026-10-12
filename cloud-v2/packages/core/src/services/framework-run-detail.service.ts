import {z} from 'zod';
import {TestAssetModel, TestRunModel} from '../models/test-run.model';
import {testWriteConcern} from '../models/test-write-concern';
import {recordedFrameworkRunSchema, type RecordedFrameworkRun} from '../types/framework-run.types';
import {TestingDetailStorage, testingDetailPointerSchema} from './testing-detail-storage.service';
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
export async function findAcceptedTestAsset(runId: string, assetId: string): Promise<StoredTestAsset | null> {
  const row = await TestRunModel.findOne({resultSchemaVersion: 1, runId})
    .select({runId: 1, detail: 1, payloadSha256: 1, uploadsComplete: 1}).read('primary').readConcern('majority').lean();
  if (row?.uploadsComplete) return (await readStoredRun(row)).acceptedAssets.find(asset => asset.assetId === assetId) ?? null;
  return TestAssetModel.findOne({runId, assetId}).read('primary').readConcern('majority').lean();
}

export async function completeStoredRun(payload: RecordedFrameworkRun, payloadSha256: string) {
  const runId = payload.result.runId;
  const acceptedAssets = await TestAssetModel.find({runId}).select({runId: 1, assetId: 1, storageKey: 1, sizeBytes: 1, sha256: 1, _id: 0})
    .read('primary').readConcern('majority').lean();
  const detail = await writeRunEnvelope(payload, payloadSha256, acceptedAssets, true);
  const result = await TestRunModel.updateOne({runId, resultSchemaVersion: 1, payloadSha256, uploadsComplete: false},
    {$set: {detail, uploadsComplete: true}}, {writeConcern: testWriteConcern});
  if (result.matchedCount !== 1) {
    const winner = await TestRunModel.findOne({runId, resultSchemaVersion: 1, payloadSha256, uploadsComplete: true})
      .read('primary').readConcern('majority').lean();
    if (!winner || requestInputDigest(testingDetailPointerSchema.parse(winner.detail)) !== requestInputDigest(detail))
      throw new TestRunError(409, 'Completed result publication conflicts');
  }
  // This deletes only the new writer's pending custody after exact accepted authority is durable.
  await TestAssetModel.deleteMany({runId}, {writeConcern: testWriteConcern});
}
