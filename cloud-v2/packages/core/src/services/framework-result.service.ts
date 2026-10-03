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
}
export interface StoredFrameworkRun {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean}
export function summarizeFrameworkRun(run: FrameworkRun, uploadsComplete: boolean): FrameworkRunSummary {
  const release = typeof run.build.releaseIdentity === "string" ? run.build.releaseIdentity
    : typeof run.build.release === "string" ? run.build.release : undefined;
  const source = run.build.source as {buildRunId?: unknown} | undefined;
  const producerUrl = typeof run.build.producerUrl === "string" ? run.build.producerUrl
    : Number.isSafeInteger(source?.buildRunId) && Number(source?.buildRunId) > 0
      ? `https://github.com/${run.build.repository}/actions/runs/${source!.buildRunId}` : undefined;
  return {runId: run.result.runId, requestId: run.requestId, hostId: run.hostId, routineId: run.routineId,
    platform: run.platform, laneId: run.laneId, startedAt: run.startedAt, finishedAt: run.finishedAt,
    outcome: frameworkRunOutcome(run), uploadsComplete, evidenceStatus: frameworkEvidenceComplete(run) ? "complete" : "failed",
    build: {repository: run.build.repository, channel: run.build.channel, headSha: run.build.headSha,
      ...(run.build.prNumber !== undefined ? {prNumber: run.build.prNumber} : {}),
      ...(release ? {release} : {}), ...(producerUrl ? {producerUrl} : {})}};
}
export const nativeRunFilter = {"payload.schemaVersion": 1};
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
      outcome: frameworkRunOutcome(run), payloadSha256, payload: run, uploadsComplete: run.assets.length === 0}], {writeConcern: testWriteConcern});
  },
  async getByRequest(requestId) {
    const row = await TestRunModel.findOne({...nativeRunFilter, requestId}).read("primary").readConcern("majority").lean();
    return row ? {payload: row.payload as FrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
  async getByRun(runId) {
    const row = await TestRunModel.findOne({...nativeRunFilter, runId}).read("primary").readConcern("majority").lean();
    return row ? {payload: row.payload as FrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
};

const projectTerminal = async (run: FrameworkRun) => {
  const result = await TestRequestModel.updateOne({requestId: run.requestId, inputSha256: {$exists: true},
    hostReceipt: {$exists: true}, $or: [{runId: {$exists: false}}, {runId: run.result.runId}]},
    {$set: {state: "terminal", runId: run.result.runId, terminalStatus: frameworkRunOutcome(run)}}, {writeConcern: testWriteConcern});
  if (result.matchedCount !== 1) throw new FrameworkResultConflict("Accepted request terminal projection conflicts with its result");
};

/** One frozen terminal result per controller request; publication never rewrites verdicts. */
export class FrameworkResultService {
  constructor(private readonly repository: FrameworkResultRepository = mongoRepository,
    private readonly request: (id: string) => Promise<ResultRequestBinding | null> = requestBinding,
    private readonly terminal: (run: FrameworkRun) => Promise<void> = projectTerminal,
    private readonly definition: (run: FrameworkRun) => Promise<RoutineEnrollment | null> = definitionFor) {}
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
    const stored = await this.repository.getByRequest(requestId), binding = await this.request(requestId);
    if (!stored || binding?.hostId !== hostId) throw new FrameworkResultConflict("Result is not owned by this host");
    const asset = stored.payload.assets.find(item => item.id === assetId);
    if (!asset) throw new FrameworkResultConflict("Asset is not declared in the frozen result");
    const kind: TestAsset["kind"] = asset.mimeType.startsWith("video/") ? "video"
      : asset.mimeType.startsWith("image/") ? "screenshot" : asset.mimeType === "application/json" ? "metadata" : "log";
    const receipt = await new TestAssetService().uploadDeclaredAsset(stored.payload.result.runId,
      {assetId, kind, contentType: asset.mimeType, filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256},
      body, headers, async () => {
        const uploaded = await TestAssetModel.find({runId: stored.payload.result.runId}).read("primary").readConcern("majority").lean();
        if (stored.payload.assets.every(expected => uploaded.some(actual => actual.assetId === expected.id
          && actual.sha256 === expected.sha256 && actual.sizeBytes === expected.size)))
          await TestRunModel.updateOne({runId: stored.payload.result.runId, payloadSha256: stored.payloadSha256}, {$set: {uploadsComplete: true, outcome: frameworkRunOutcome(stored.payload)}}, {writeConcern: testWriteConcern});
      });
    return {...receipt, entityId: requestId, assetId, sha256: asset.sha256, size: asset.size};
  }

  async complete(requestId: string, hostId: string) {
    const stored = await this.repository.getByRequest(requestId), binding = await this.request(requestId);
    if (!stored || binding?.hostId !== hostId || !stored.uploadsComplete)
      throw new FrameworkResultConflict("Required manifest uploads are not acknowledged for this host");
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
      .sort({startedAt: -1, runId: -1}).limit(100).read("primary").readConcern("majority").lean();
    return {runs: rows.map(row => {
      const run = frameworkRunSchema.parse(row.payload);
      return summarizeFrameworkRun(run, row.uploadsComplete);
    })};
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
    return this.storedMedia(await this.repository.getByRequest(requestId), assetId, request);
  }

  async mediaByRun(runId: string, assetId: string, request: Request) {
    return this.storedMedia(await this.repository.getByRun(runId), assetId, request);
  }

  private async storedMedia(stored: StoredFrameworkRun | null, assetId: string, request: Request) {
    const asset = stored?.payload.assets.find(item => item.id === assetId);
    if (!stored || !asset) throw new TestRunError(404, "Asset is not declared in this result");
    const uploaded = await TestAssetModel.findOne({runId: stored.payload.result.runId, assetId}).read("primary").readConcern("majority").lean();
    if (!uploaded) throw new TestRunError(404, "Asset upload is not acknowledged");
    const kind: TestAsset["kind"] = asset.mimeType.startsWith("video/") ? "video"
      : asset.mimeType.startsWith("image/") ? "screenshot" : asset.mimeType === "application/json" ? "metadata" : "log";
    return new TestAssetService().mediaDeclaredAsset({assetId, kind, contentType: asset.mimeType,
      filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256}, uploaded, request);
  }
}
