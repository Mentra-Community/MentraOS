import {testWriteConcern} from "../models/test-write-concern";
import {FailedFrameworkRunReportService} from './failed-framework-run-report.service';
import {TestAssetModel} from "../models/test-run.model";
import {TestRunModel} from "../models/test-run.model";
import {RoutineDefinitionModel} from "../models/routine-definition.model";
import type {FrameworkRunPage} from "../types/test-history.types";
import {z} from "zod";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {TestRequestModel} from "../models/test-request.model";
import {frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunSchema, recordedFrameworkRunSchema, type FrameworkRun, type RecordedFrameworkRun} from "../types/framework-run.types";
import {requestInputDigest, TestRequestConflict} from "./test-request.service";
import {frameworkBuildSchema} from "../types/framework-request.types";
import {TestRunError} from "./test-result-error";
import {TestAssetService, type TestAsset} from "./test-asset.service";
import type {CandidateVerification} from '../types/candidate-verification.types';
import type {RoutineSourceRef} from '../types/framework-version.types';
import {readFailureScreens} from './framework-failure-screen';

export class FrameworkResultConflict extends Error {}
const resultCursorSchema = z.object({startedAt: z.string().datetime({offset: true}), runId: z.string().min(1).max(240)}).strict();
export function frameworkResultCursorFilter(cursor?: string): Record<string, unknown> {
  if (!cursor) return {};
  try {
    if (cursor.length > 2000) throw new Error("Cursor too long");
    const after = resultCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    const startedAt = new Date(after.startedAt);
    return {$or: [{startedAt: {$lt: startedAt}}, {startedAt, runId: {$lt: after.runId}}]};
  } catch {throw new TestRunError(400, "Invalid routine results cursor");}
}
export interface FrameworkResultRepository {
  insert(run: FrameworkRun, payloadSha256: string, metadata?: {verification: CandidateVerification; catalogEligible: boolean}): Promise<void>;
  getByRequest(requestId: string): Promise<StoredFrameworkRun | null>;
  getByRun(runId: string): Promise<StoredFrameworkRun | null>;
  getAsset(identity: {requestId: string} | {runId: string}, assetId: string): Promise<StoredFrameworkAsset | null>;
}
export interface StoredFrameworkRun {payload: RecordedFrameworkRun; payloadSha256: string; uploadsComplete: boolean}
export interface StoredFrameworkAsset {runId: string; asset: FrameworkRun["assets"][number] | null}
export interface FrameworkUploadAcknowledgements {
  list(runId: string): Promise<Array<{assetId: string; sha256: string; sizeBytes: number}>>;
  complete(stored: StoredFrameworkRun): Promise<void>;
}
export {nativeRunFilter, summarizeFrameworkRun} from "./framework-run-summary.service";
import {createFrameworkRunSummaryProjection, nativeRunFilter, readFrameworkRunSummary, readFrameworkRunSummaryProjection, verifiedFrameworkRunSummaryProjection} from "./framework-run-summary.service";
import type {StoredSummaryRow} from "./framework-run-summary.service";
export const frameworkResultSummaryFields = {runId: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1,
  uploadsComplete: 1, "payload.build": 1} as const;

/** Single and batched readers verify the same frozen verdict and exact build. */
export function verifiedFrameworkResultSummary(row: StoredSummaryRow & {payload?: unknown}) {
  const projection = verifiedFrameworkRunSummaryProjection(row), summary = projection.summary;
  const build = frameworkBuildSchema.safeParse((row.payload as {build?: unknown} | undefined)?.build);
  if (!build.success || summary.requestId !== row.requestId || build.data.repository !== summary.build.repository
    || build.data.channel !== summary.build.channel || build.data.headSha !== summary.build.headSha
    || build.data.prNumber !== summary.build.prNumber)
    throw new TestRunError(503, "Frozen result summary build or identity is unavailable");
  return {...summary, definitionRevision: projection.definitionRevision, build: build.data, uploadsComplete: row.uploadsComplete === true};
}
/** A missing derived projection uses the original digest-checked native payload; corrupt projections never fall back. */
export async function readFrameworkResultSummary(row: StoredSummaryRow & {payload?: unknown}, deadline = Date.now() + 10_000) {
  const verified = row.summaryProjection === undefined ? {
    ...row, summaryProjection: await readFrameworkRunSummaryProjection(row, deadline),
  } : row;
  return verifiedFrameworkResultSummary(verified);
}
export interface ResultRequestBinding {hostId: string; catalogEligible?: boolean;
  input: {routineId: string; definitionRevision: string; routineSource: RoutineSourceRef; minimumFrameworkVersion?: number;
    platform: string; laneId: string; build: unknown; verification?: CandidateVerification}}
const requestBinding = async (requestId: string): Promise<ResultRequestBinding | null> => {
  const row = await TestRequestModel.findOne({requestId, hostReceipt: {$exists: true}}).read("primary").readConcern("majority").lean();
  return row && typeof row.hostId === 'string' ? {hostId: row.hostId, input: row.input as ResultRequestBinding["input"],
    ...(typeof row.catalogEligible === 'boolean' ? {catalogEligible: row.catalogEligible} : {})} : null;
};
const buildDigest = (input: unknown): string | null => {
  if (!frameworkBuildSchema.safeParse(input).success) return null;
  try {return requestInputDigest(input);}
  catch (error) {if (error instanceof TestRequestConflict) return null; throw error;}
};
const definitionFor = async (run: RecordedFrameworkRun): Promise<RoutineEnrollment | null> =>
  await RoutineDefinitionModel.findOne({routineId: run.routineId, platform: run.platform,
    definitionRevision: run.definitionRevision}).read("primary").readConcern("majority").lean() as RoutineEnrollment | null;

const mongoRepository: FrameworkResultRepository = {
  async insert(run, payloadSha256, metadata) {
    await TestRunModel.create([{runId: run.result.runId, requestId: run.requestId, routineId: run.routineId,
      definitionRevision: run.definitionRevision, hostId: run.hostId, platform: run.platform, laneId: run.laneId,
      startedAt: new Date(run.startedAt), completedAt: new Date(run.finishedAt),
      outcome: frameworkRunOutcome(run), payloadSha256, payload: run, summaryProjection: createFrameworkRunSummaryProjection(run, payloadSha256),
      ...(metadata ?? {}), uploadsComplete: run.assets.length === 0}], {writeConcern: testWriteConcern});
  },
  async getByRequest(requestId) {
    const row = await TestRunModel.findOne({...nativeRunFilter, requestId}).read("primary").readConcern("majority").lean();
    return row ? {payload: row.payload as RecordedFrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
  async getByRun(runId) {
    const row = await TestRunModel.findOne({...nativeRunFilter, runId}).read("primary").readConcern("majority").lean();
    return row ? {payload: row.payload as RecordedFrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
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
    private readonly definition: (run: RecordedFrameworkRun) => Promise<RoutineEnrollment | null> = definitionFor,
    private readonly assets: TestAssetService = new TestAssetService(),
    private readonly acknowledgements: FrameworkUploadAcknowledgements = uploadAcknowledgements,
    private readonly incidents: Pick<FailedFrameworkRunReportService, 'complete'> = new FailedFrameworkRunReportService()) {}
  async ingest(input: unknown, authenticatedHostId: string) {
    const parsed = frameworkRunSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, `Invalid frozen framework result: ${parsed.error.issues.slice(0, 5)
      .map(issue => `${issue.code} at ${issue.path.join(".") || "root"}`).join("; ")}`);
    const run = parsed.data, payloadSha256 = requestInputDigest(run);
    const binding = await this.request(run.requestId);
    if (!binding || !buildDigest(binding.input?.build) || binding.hostId !== authenticatedHostId || run.hostId !== authenticatedHostId || binding.input.routineId !== run.routineId
      || binding.input.definitionRevision !== run.definitionRevision
      || requestInputDigest(binding.input.routineSource) !== requestInputDigest(run.routineSource)
      || run.frameworkBinding.routineApiVersion < run.routineSource.minimumRoutineApiVersion
      || binding.input.minimumFrameworkVersion !== undefined && run.frameworkBinding.version < Number(binding.input.minimumFrameworkVersion) || binding.input.platform !== run.platform
      || binding.input.laneId !== run.laneId || buildDigest(binding.input.build) !== requestInputDigest(run.build))
      throw new FrameworkResultConflict("Result does not match this host's accepted request");
    const definition = await this.definition(run);
    if (!definition || run.result.steps.length !== definition.definition.steps.length
      || run.result.steps.some((step, index) => step.id !== definition.definition.steps[index]?.id))
      throw new FrameworkResultConflict("Result must contain the complete ordered source step list");
    for (const phase of ["setup", "teardown"] as const) {
      const declared = definition.definition[phase], reported = run.result[phase].actions;
      // Fixture actions execute routine-owned code but are separate from explicit lifecycle hooks.
      // Bind them to declared providers; keep the existing exact hook-list validation below.
      const fixtureActions = reported?.filter(action => action.fixtureProvider !== undefined) ?? [];
      const providers = new Set(definition.definition.fixtures?.map(fixture => fixture.provider) ?? []);
      if (fixtureActions.some(action => action.scope !== "routine" || !providers.has(action.fixtureProvider!)
          || declared?.some(hook => hook.id === action.id))
        || new Set(fixtureActions.map(action => action.fixtureProvider)).size !== fixtureActions.length)
        throw new FrameworkResultConflict(`Result ${phase} fixture actions must belong to distinct declared routine fixtures`);
      const routineActions = reported?.filter(action => action.scope === "routine" && action.fixtureProvider === undefined) ?? [];
      if ((declared !== undefined && reported === undefined) || routineActions.length !== (declared?.length ?? 0)
        || routineActions.some((action, index) => action.id !== declared?.[index]?.id
          || action.instruction !== declared?.[index]?.instruction || action.expected !== declared?.[index]?.expected))
        throw new FrameworkResultConflict(`Result must contain the complete ordered source ${phase} action list and English descriptions`);
    }
    let created = true;
    try {await this.repository.insert(run, payloadSha256, binding.input.verification ?
      {verification: binding.input.verification, catalogEligible: binding.catalogEligible === true} : undefined);}
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
    // Assets/verdict are already durable. Report evidence is acknowledged before
    // disposal; Core reporting owns any pending Slack intent independently.
    const incident = await this.incidents.complete(stored.payload, stored.payloadSha256);
    return {entityId: stored.payload.result.runId, payloadSha256: stored.payloadSha256,
      manifestSha256: requestInputDigest(stored.payload.assets), ...(incident ? {incident} : {})};
  }

  async list(scope: Record<string, string> = {}): Promise<FrameworkRunPage> {
    const filter: Record<string, unknown> = {...nativeRunFilter, ...frameworkResultCursorFilter(scope.cursor)};
    for (const field of ["routineId", "platform", "hostId", "laneId"])
      if (scope[field]) filter[field] = scope[field];
    if (scope.archiveSha256) filter["payload.build.archive.sha256"] = scope.archiveSha256;
    for (const field of ["repository", "headSha", "channel", "prNumber"])
      if (scope[field]) filter[`payload.build.${field}`] = field === "prNumber" ? Number(scope[field]) : scope[field];
    const rows = await TestRunModel.find(filter)
      .sort({startedAt: -1, runId: -1}).limit(101).select({runId: 1, startedAt: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1, uploadsComplete: 1})
      .read("primary").readConcern("majority").lean();
    const page = rows.slice(0, 100), last = page.at(-1);
    const nextCursor = rows.length > 100 && last ? Buffer.from(JSON.stringify({startedAt: last.startedAt.toISOString(), runId: last.runId})).toString("base64url") : null;
    return {runs: await Promise.all(page.map(row => readFrameworkRunSummary(row))), nextCursor};
  }

  async detail(requestId: string, includeFailureScreens = false) {
    return this.describe(await this.repository.getByRequest(requestId), includeFailureScreens);
  }

  /** Occurrence polling reads the existing verified verdict without transferring its manifest or execution evidence. */
  async summary(requestId: string) {
    const row = await TestRunModel.findOne({...nativeRunFilter, requestId})
      .select(frameworkResultSummaryFields)
      .read("primary").readConcern("majority").setOptions({timeoutMS: 10_000}).lean();
    if (!row) throw new TestRunError(404, "Framework run was not found");
    // Missing and corrupt projections fail closed here; polling must never fall back to the full payload.
    return readFrameworkResultSummary(row);
  }

  /** An assigned supervisor reads its original publication without an admin browser session. */
  async detailForHost(requestId: string, hostId: string) {
    const binding = await this.request(requestId);
    if (!binding || binding.hostId !== hostId) throw new TestRunError(404, 'Framework run was not found for this host');
    return {...await this.detail(requestId), ...(binding.input.verification ? {verification: binding.input.verification} : {})};
  }

  async mediaForHost(requestId: string, assetId: string, hostId: string, request: Request) {
    const binding = await this.request(requestId);
    if (!binding || binding.hostId !== hostId) throw new TestRunError(404, 'Framework run was not found for this host');
    return this.media(requestId, assetId, request);
  }

  async detailByRun(runId: string, includeFailureScreens = false) {
    return this.describe(await this.repository.getByRun(runId), includeFailureScreens);
  }

  private async describe(stored: StoredFrameworkRun | null, includeFailureScreens: boolean) {
    if (!stored) throw new TestRunError(404, "Framework run was not found");
    const run = recordedFrameworkRunSchema.parse(stored.payload), definition = await this.definition(run);
    const displayEvidence = includeFailureScreens ? {failureScreens: stored.uploadsComplete
      ? await readFailureScreens(run, asset => this.mediaByRun(run.result.runId, asset.id,
        new Request('http://localhost/frozen-failure-diagnostic'))) : []} : {};
    return {run, definition: definition?.definition ?? null, outcome: frameworkRunOutcome(run), uploadsComplete: stored.uploadsComplete,
      evidenceStatus: frameworkEvidenceComplete(run) ? "complete" : "failed", ...displayEvidence};
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
