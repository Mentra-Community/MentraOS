import {testWriteConcern} from "../models/test-write-concern";
import {TestAssetModel} from "../models/test-run.model";
import {TestRunModel} from "../models/test-run.model";
import {RoutineDefinitionModel} from "../models/routine-definition.model";
import type {FrameworkRunSummary} from "../types/test-history.types";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {TestRequestModel} from "../models/test-request.model";
import {frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import {requestInputDigest, TestRequestConflict} from "./test-request.service";
import {frameworkBuildSchema} from "../types/framework-request.types";
import {TestRunError} from "./test-result-error";
import {TestAssetService, type TestAsset} from "./test-asset.service";

export class FrameworkResultConflict extends Error {}
export interface FrameworkResultRepository {
  insert(run: FrameworkRun, payloadSha256: string): Promise<void>;
  getByRequest(requestId: string): Promise<StoredFrameworkRun | null>;
  getByRun(runId: string): Promise<StoredFrameworkRun | null>;
  getAsset(identity: {requestId: string} | {runId: string}, assetId: string): Promise<StoredFrameworkAsset | null>;
}
export interface StoredFrameworkRun {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean}
export interface StoredFrameworkAsset {runId: string; asset: FrameworkRun["assets"][number] | null}
export interface FrameworkUploadAcknowledgements {
  list(runId: string): Promise<Array<{assetId: string; sha256: string; sizeBytes: number}>>;
  complete(stored: StoredFrameworkRun): Promise<void>;
}
export {nativeRunFilter, summarizeFrameworkRun} from "./framework-run-summary.service";
import {createFrameworkRunSummaryProjection, nativeRunFilter, readFrameworkRunSummary} from "./framework-run-summary.service";
export interface ResultRequestBinding {hostId: string; input: {routineId: string; definitionRevision: string; platform: string; laneId: string; build: unknown}}
const requestBinding = async (requestId: string): Promise<ResultRequestBinding | null> => {
  const row = await TestRequestModel.findOne({requestId, hostReceipt: {$exists: true}}).read("primary").readConcern("majority").lean();
  return row ? {hostId: row.hostId, input: row.input as ResultRequestBinding["input"]} : null;
};
const buildDigest = (input: unknown): string | null => {
  if (!frameworkBuildSchema.safeParse(input).success) return null;
  try {return requestInputDigest(input);}
  catch (error) {if (error instanceof TestRequestConflict) return null; throw error;}
};
const definitionFor = async (run: FrameworkRun): Promise<RoutineEnrollment | null> =>
  await RoutineDefinitionModel.findOne({routineId: run.routineId, platform: run.platform,
    definitionRevision: run.definitionRevision}).read("primary").readConcern("majority").lean() as RoutineEnrollment | null;

const mongoRepository: FrameworkResultRepository = {
  async insert(run, payloadSha256) {
    await TestRunModel.create([{runId: run.result.runId, requestId: run.requestId, routineId: run.routineId,
      definitionRevision: run.definitionRevision, hostId: run.hostId, platform: run.platform, laneId: run.laneId,
      startedAt: new Date(run.startedAt), completedAt: new Date(run.finishedAt),
      outcome: frameworkRunOutcome(run), payloadSha256, payload: run, summaryProjection: createFrameworkRunSummaryProjection(run, payloadSha256), uploadsComplete: run.assets.length === 0}], {writeConcern: testWriteConcern});
  },
  async getByRequest(requestId) {
    const row = await TestRunModel.findOne({...nativeRunFilter, requestId}).read("primary").readConcern("majority").lean();
    return row ? {payload: row.payload as FrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
  async getByRun(runId) {
    const row = await TestRunModel.findOne({...nativeRunFilter, runId}).read("primary").readConcern("majority").lean();
    return row ? {payload: row.payload as FrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
  async getAsset(identity, assetId) {
    // Read the declaration from the frozen payload without transferring the
    // entire manifest and execution evidence for every upload or media request.
    // Keep expressions in an aggregation projection for Cosmos MongoDB 4.2.
    const [row] = await TestRunModel.aggregate([
      {$match: {...nativeRunFilter, ...identity}}, {$limit: 1},
      {$project: {"payload.result.runId": 1, "payload.assets": {$filter: {input: "$payload.assets", as: "asset",
        cond: {$eq: ["$$asset.id", {$literal: assetId}]}}}, _id: 0}},
    ]).read("primary").readConcern("majority").exec();
    return row ? {runId: row.payload.result.runId, asset: row.payload.assets?.[0] ?? null} : null;
  },
};

const projectTerminal = async (run: FrameworkRun) => {
  const result = await TestRequestModel.updateOne({requestId: run.requestId, inputSha256: {$exists: true},
    hostReceipt: {$exists: true}, $or: [{runId: {$exists: false}}, {runId: run.result.runId}]},
    {$set: {state: "terminal", runId: run.result.runId, terminalStatus: frameworkRunOutcome(run)}}, {writeConcern: testWriteConcern});
  if (result.matchedCount !== 1) throw new FrameworkResultConflict("Accepted request terminal projection conflicts with its result");
};
const uploadAcknowledgements: FrameworkUploadAcknowledgements = {
  async list(runId) {
    return await TestAssetModel.find({runId}).select({assetId: 1, sha256: 1, sizeBytes: 1, _id: 0})
      .read("primary").readConcern("majority").lean();
  },
  async complete(stored) {
    const result = await TestRunModel.updateOne({runId: stored.payload.result.runId, payloadSha256: stored.payloadSha256},
      {$set: {uploadsComplete: true, outcome: frameworkRunOutcome(stored.payload)}}, {writeConcern: testWriteConcern});
    if (result.matchedCount !== 1) throw new FrameworkResultConflict("Frozen upload acknowledgement conflicts with its result");
  },
};

/** One frozen terminal result per controller request; publication never rewrites verdicts. */
export class FrameworkResultService {
  constructor(private readonly repository: FrameworkResultRepository = mongoRepository,
    private readonly request: (id: string) => Promise<ResultRequestBinding | null> = requestBinding,
    private readonly terminal: (run: FrameworkRun) => Promise<void> = projectTerminal,
    private readonly definition: (run: FrameworkRun) => Promise<RoutineEnrollment | null> = definitionFor,
    private readonly assets: TestAssetService = new TestAssetService(),
    private readonly acknowledgements: FrameworkUploadAcknowledgements = uploadAcknowledgements) {}
  async ingest(input: unknown, authenticatedHostId: string) {
    const parsed = frameworkRunSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, `Invalid frozen framework result: ${parsed.error.issues.slice(0, 5)
      .map(issue => `${issue.code} at ${issue.path.join(".") || "root"}`).join("; ")}`);
    const run = parsed.data, payloadSha256 = requestInputDigest(run);
    const binding = await this.request(run.requestId);
    if (!binding || !buildDigest(binding.input?.build) || binding.hostId !== authenticatedHostId || run.hostId !== authenticatedHostId || binding.input.routineId !== run.routineId
      || binding.input.definitionRevision !== run.definitionRevision || binding.input.platform !== run.platform
      || binding.input.laneId !== run.laneId || buildDigest(binding.input.build) !== requestInputDigest(run.build))
      throw new FrameworkResultConflict("Result does not match this host's accepted request");
    const definition = await this.definition(run);
    if (!definition || run.result.steps.length !== definition.definition.steps.length
      || run.result.steps.some((step, index) => step.id !== definition.definition.steps[index]?.id))
      throw new FrameworkResultConflict("Result must contain the complete ordered source step list");
    for (const phase of ["setup", "teardown"] as const) {
      const declared = definition.definition[phase], reported = run.result[phase].actions;
      const routineActions = reported?.filter(action => action.scope === "routine") ?? [];
      if ((declared !== undefined && reported === undefined) || routineActions.length !== (declared?.length ?? 0)
        || routineActions.some((action, index) => action.id !== declared?.[index]?.id
          || action.instruction !== declared?.[index]?.instruction || action.expected !== declared?.[index]?.expected))
        throw new FrameworkResultConflict(`Result must contain the complete ordered source ${phase} action list and English descriptions`);
    }
    let created = true;
    try {await this.repository.insert(run, payloadSha256);}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.getByRequest(run.requestId);
      if (!existing || existing.payloadSha256 !== payloadSha256)
        throw new FrameworkResultConflict("Request already has a different terminal result");
      created = false;
    }
    // A lost cross-store acknowledgement is repaired by repeating this same immutable result.
    await this.terminal(run);
    return {entityId: run.result.runId, payloadSha256, created};
  }

  async upload(requestId: string, assetId: string, hostId: string, body: ReadableStream<Uint8Array> | null, headers: Headers) {
    const stored = await this.repository.getAsset({requestId}, assetId), binding = await this.request(requestId);
    if (!stored || binding?.hostId !== hostId) throw new FrameworkResultConflict("Result is not owned by this host");
    const asset = stored.asset;
    if (!asset) throw new FrameworkResultConflict("Asset is not declared in the frozen result");
    const kind: TestAsset["kind"] = asset.mimeType.startsWith("video/") ? "video"
      : asset.mimeType.startsWith("image/") ? "screenshot" : asset.mimeType === "application/json" ? "metadata" : "log";
    const receipt = await this.assets.uploadDeclaredAsset(stored.runId,
      {assetId, kind, contentType: asset.mimeType, filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256},
      body, headers, async () => {});
    return {...receipt, entityId: requestId, assetId, sha256: asset.sha256, size: asset.size};
  }

  async complete(requestId: string, hostId: string) {
    const stored = await this.repository.getByRequest(requestId), binding = await this.request(requestId);
    if (!stored || binding?.hostId !== hostId)
      throw new FrameworkResultConflict("Required manifest uploads are not acknowledged for this host");
    if (!stored.uploadsComplete) {
      const uploaded = await this.acknowledgements.list(stored.payload.result.runId);
      const byId = new Map(uploaded.map(asset => [asset.assetId, asset]));
      if (uploaded.length !== stored.payload.assets.length || byId.size !== uploaded.length || !stored.payload.assets.every(expected => {
        const actual = byId.get(expected.id);
        return actual?.sha256 === expected.sha256 && actual.sizeBytes === expected.size;
      })) throw new FrameworkResultConflict("Required manifest uploads are not acknowledged for this host");
      await this.acknowledgements.complete(stored);
    }
    return {entityId: stored.payload.result.runId, payloadSha256: stored.payloadSha256,
      manifestSha256: requestInputDigest(stored.payload.assets)};
  }

  async list(scope: Record<string, string> = {}): Promise<{runs: FrameworkRunSummary[]}> {
    const filter: Record<string, unknown> = {...nativeRunFilter};
    for (const field of ["routineId", "platform", "hostId", "laneId"])
      if (scope[field]) filter[field] = scope[field];
    if (scope.archiveSha256) filter["payload.build.archive.sha256"] = scope.archiveSha256;
    for (const field of ["repository", "headSha", "channel", "prNumber"])
      if (scope[field]) filter[`payload.build.${field}`] = field === "prNumber" ? Number(scope[field]) : scope[field];
    const rows = await TestRunModel.find(filter)
      .sort({startedAt: -1, runId: -1}).limit(100).select({runId: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1, uploadsComplete: 1})
      .read("primary").readConcern("majority").lean();
    return {runs: await Promise.all(rows.map(row => readFrameworkRunSummary(row)))};
  }

  async detail(requestId: string) {
    return this.describe(await this.repository.getByRequest(requestId));
  }

  async detailByRun(runId: string) {
    return this.describe(await this.repository.getByRun(runId));
  }

  private async describe(stored: StoredFrameworkRun | null) {
    if (!stored) throw new TestRunError(404, "Framework run was not found");
    const definition = await this.definition(stored.payload);
    return {run: stored.payload, definition: definition?.definition ?? null, outcome: frameworkRunOutcome(stored.payload), uploadsComplete: stored.uploadsComplete, evidenceStatus: frameworkEvidenceComplete(stored.payload) ? "complete" : "failed"};
  }

  async media(requestId: string, assetId: string, request: Request) {
    return this.storedMedia(await this.repository.getAsset({requestId}, assetId), assetId, request);
  }

  async mediaByRun(runId: string, assetId: string, request: Request) {
    return this.storedMedia(await this.repository.getAsset({runId}, assetId), assetId, request);
  }

  private async storedMedia(stored: StoredFrameworkAsset | null, assetId: string, request: Request) {
    const asset = stored?.asset;
    if (!stored || !asset) throw new TestRunError(404, "Asset is not declared in this result");
    const uploaded = await TestAssetModel.findOne({runId: stored.runId, assetId}).read("primary").readConcern("majority").lean();
    if (!uploaded) throw new TestRunError(404, "Asset upload is not acknowledged");
    const kind: TestAsset["kind"] = asset.mimeType.startsWith("video/") ? "video"
      : asset.mimeType.startsWith("image/") ? "screenshot" : asset.mimeType === "application/json" ? "metadata" : "log";
    return new TestAssetService().mediaDeclaredAsset({assetId, kind, contentType: asset.mimeType,
      filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256}, uploaded, request);
  }
}
