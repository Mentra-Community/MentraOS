import {TestAssetModel, TestRunModel} from "../models/test-run.model";
import {TestRequestModel} from "../models/test-request.model";
import {frameworkRunOutcome, frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import {requestInputDigest} from "./test-request.service";
import {TestRunError, TestRunService} from "./test-run.service";
import type {TestAsset} from "../types/test-run.types";

export class FrameworkResultConflict extends Error {}
export interface FrameworkResultRepository {
  insert(run: FrameworkRun, payloadSha256: string): Promise<void>;
  getByRequest(requestId: string): Promise<{payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null>;
}
export interface ResultRequestBinding {hostId: string; input: {routineId: string; definitionRevision: string; platform: string; laneId: string; build: unknown}}
const requestBinding = async (requestId: string): Promise<ResultRequestBinding | null> => {
  const row = await TestRequestModel.findOne({requestId, hostReceipt: {$exists: true}}).lean();
  return row ? {hostId: row.hostId, input: row.input as ResultRequestBinding["input"]} : null;
};
const mongoRepository: FrameworkResultRepository = {
  async insert(run, payloadSha256) {
    await TestRunModel.create({runId: run.result.runId, requestId: run.requestId, routineId: run.routineId,
      definitionRevision: run.definitionRevision, platform: run.platform, laneId: run.laneId,
      startedAt: new Date(run.startedAt), completedAt: new Date(run.finishedAt), completionProjectionVersion: 1,
      outcome: frameworkRunOutcome(run), payloadSha256, payload: run, uploadsComplete: run.assets.length === 0});
  },
  async getByRequest(requestId) {
    const row = await TestRunModel.findOne({requestId, definitionRevision: {$exists: true}}).lean();
    return row ? {payload: row.payload as FrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
};

/** One frozen terminal result per controller request; publication never rewrites verdicts. */
export class FrameworkResultService {
  constructor(private readonly repository: FrameworkResultRepository = mongoRepository,
    private readonly request: (id: string) => Promise<ResultRequestBinding | null> = requestBinding) {}
  async ingest(input: unknown, authenticatedHostId: string) {
    const parsed = frameworkRunSchema.safeParse(input);
    if (!parsed.success) throw new FrameworkResultConflict("Invalid frozen framework result");
    const run = parsed.data, payloadSha256 = requestInputDigest(run);
    const binding = await this.request(run.requestId);
    if (!binding || binding.hostId !== authenticatedHostId || binding.input.routineId !== run.routineId
      || binding.input.definitionRevision !== run.definitionRevision || binding.input.platform !== run.platform
      || binding.input.laneId !== run.laneId || requestInputDigest(binding.input.build) !== requestInputDigest(run.build))
      throw new FrameworkResultConflict("Result does not match this host's accepted request");
    let created = true;
    try {await this.repository.insert(run, payloadSha256);}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.getByRequest(run.requestId);
      if (!existing || existing.payloadSha256 !== payloadSha256)
        throw new FrameworkResultConflict("Request already has a different terminal result");
      created = false;
    }
    return {entityId: run.result.runId, payloadSha256, created};
  }

  async upload(requestId: string, assetId: string, hostId: string, body: ReadableStream<Uint8Array> | null, headers: Headers) {
    const stored = await this.repository.getByRequest(requestId), binding = await this.request(requestId);
    if (!stored || binding?.hostId !== hostId) throw new FrameworkResultConflict("Result is not owned by this host");
    const asset = stored.payload.assets.find(item => item.id === assetId);
    if (!asset) throw new FrameworkResultConflict("Asset is not declared in the frozen result");
    const kind: TestAsset["kind"] = asset.mimeType.startsWith("video/") ? "video"
      : asset.mimeType.startsWith("image/") ? "screenshot" : asset.mimeType === "application/json" ? "metadata" : "log";
    return new TestRunService().uploadDeclaredAsset(stored.payload.result.runId,
      {assetId, kind, contentType: asset.mimeType, filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256},
      body, headers, async () => {
        const uploaded = await TestAssetModel.find({runId: stored.payload.result.runId}).lean();
        if (stored.payload.assets.every(expected => uploaded.some(actual => actual.assetId === expected.id
          && actual.sha256 === expected.sha256 && actual.sizeBytes === expected.size)))
          await TestRunModel.updateOne({runId: stored.payload.result.runId, payloadSha256: stored.payloadSha256}, {$set: {uploadsComplete: true}});
      });
  }

  async complete(requestId: string, hostId: string) {
    const stored = await this.repository.getByRequest(requestId), binding = await this.request(requestId);
    if (!stored || binding?.hostId !== hostId || !stored.uploadsComplete)
      throw new FrameworkResultConflict("Required manifest uploads are not acknowledged for this host");
    return {entityId: stored.payload.result.runId, payloadSha256: stored.payloadSha256,
      manifestSha256: requestInputDigest(stored.payload.assets)};
  }

  async detail(requestId: string) {
    const stored = await this.repository.getByRequest(requestId);
    if (!stored) throw new TestRunError(404, "Framework run was not found");
    return {run: stored.payload, outcome: frameworkRunOutcome(stored.payload), uploadsComplete: stored.uploadsComplete};
  }

  async media(requestId: string, assetId: string, request: Request) {
    const stored = await this.repository.getByRequest(requestId);
    const asset = stored?.payload.assets.find(item => item.id === assetId);
    if (!stored || !asset) throw new TestRunError(404, "Asset is not declared in this result");
    const uploaded = await TestAssetModel.findOne({runId: stored.payload.result.runId, assetId}).lean();
    if (!uploaded) throw new TestRunError(404, "Asset upload is not acknowledged");
    const kind: TestAsset["kind"] = asset.mimeType.startsWith("video/") ? "video"
      : asset.mimeType.startsWith("image/") ? "screenshot" : asset.mimeType === "application/json" ? "metadata" : "log";
    return new TestRunService().mediaDeclaredAsset({assetId, kind, contentType: asset.mimeType,
      filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256}, uploaded, request);
  }
}
