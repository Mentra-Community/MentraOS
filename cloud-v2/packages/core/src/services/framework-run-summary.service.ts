import {createLogger} from "@mentra/cloud-shared";
import {TestRunModel} from "../models/test-run.model";
import {testWriteConcern} from "../models/test-write-concern";
import {frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import {frameworkRunSummaryProjectionSchema, type FrameworkRunSummaryProjection} from "../types/framework-run-summary.types";
import type {FrameworkRunSummary} from "../types/test-history.types";
import {requestInputDigest} from "./test-request.service";
import {TestRunError} from "./test-result-error";

export const nativeRunFilter = {"payload.schemaVersion": 1};
const logger = createLogger("core").child({component: "framework-run-summary"});

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
    stepCounts: {passed: run.result.steps.filter(step => step.status === "passed").length,
      total: run.result.steps.length, skipped: run.result.steps.filter(step => step.status === "not-run").length},
    build: {repository: run.build.repository, channel: run.build.channel, headSha: run.build.headSha,
      ...(run.build.prNumber !== undefined ? {prNumber: run.build.prNumber} : {}),
      ...(release ? {release} : {}), ...(producerUrl ? {producerUrl} : {})}};
}

export function createFrameworkRunSummaryProjection(input: unknown, payloadSha256: string): FrameworkRunSummaryProjection {
  const run = frameworkRunSchema.parse(input);
  if (requestInputDigest(run) !== payloadSha256) throw new TestRunError(503, "Frozen result digest is unavailable");
  const {uploadsComplete: _uploads, ...summary} = summarizeFrameworkRun(run, false);
  return frameworkRunSummaryProjectionSchema.parse({version: 1, payloadSha256, definitionRevision: run.definitionRevision,
    summary, ...(run.recordingAssetId ? {recordingAssetId: run.recordingAssetId} : {}),
    summarySha256: requestInputDigest({summary, definitionRevision: run.definitionRevision, recordingAssetId: run.recordingAssetId ?? null})});
}

export interface StoredSummaryRow {
  runId: string; requestId?: string; payloadSha256: string; summaryProjection?: unknown; uploadsComplete?: boolean;
}

export function verifiedFrameworkRunSummaryProjection(row: StoredSummaryRow): FrameworkRunSummaryProjection {
  const parsed = frameworkRunSummaryProjectionSchema.safeParse(row.summaryProjection);
  if (!parsed.success || parsed.data.payloadSha256 !== row.payloadSha256 || parsed.data.summary.runId !== row.runId
    || (row.requestId !== undefined && parsed.data.summary.requestId !== row.requestId)
    || requestInputDigest({summary: parsed.data.summary, definitionRevision: parsed.data.definitionRevision, recordingAssetId: parsed.data.recordingAssetId ?? null}) !== parsed.data.summarySha256)
    throw new TestRunError(503, "Frozen result summary is unavailable");
  return parsed.data;
}

/** Missing projections during a rolling deployment read only that frozen result; corrupt projections fail closed. */
export async function readFrameworkRunSummaryProjection(row: StoredSummaryRow): Promise<FrameworkRunSummaryProjection> {
  let projection = row.summaryProjection;
  const previous = projection === undefined ? undefined : verifiedFrameworkRunSummaryProjection(row);
  if (projection === undefined || previous?.summary.stepCounts === undefined) {
    const stored = await TestRunModel.findOne({...nativeRunFilter, runId: row.runId, payloadSha256: row.payloadSha256})
      .select({payload: 1, payloadSha256: 1}).read("primary").readConcern("majority").setOptions({timeoutMS: 10_000}).lean();
    if (!stored) throw new TestRunError(503, "Frozen result summary is unavailable");
    projection = createFrameworkRunSummaryProjection(stored.payload, stored.payloadSha256);
    // A rolling old writer must not make every refresh transfer this evidence again.
    await TestRunModel.updateOne({...nativeRunFilter, runId: row.runId, payloadSha256: row.payloadSha256,
      ...(previous ? {"summaryProjection.summarySha256": previous.summarySha256} : {summaryProjection: {$exists: false}})},
      {$set: {summaryProjection: projection}}, {writeConcern: testWriteConcern, timeoutMS: 10_000}).catch(() => {
      logger.warn({runId: row.runId}, "Frozen result summary publication will retry on a later read");
    });
  }
  return verifiedFrameworkRunSummaryProjection({...row, summaryProjection: projection});
}

export async function readFrameworkRunSummary(row: StoredSummaryRow): Promise<FrameworkRunSummary> {
  const projection = await readFrameworkRunSummaryProjection(row);
  return {...projection.summary, uploadsComplete: row.uploadsComplete === true};
}

const BACKFILL_BUDGET_MS = 30_000;
/** Optional read acceleration: cap wall time and rows, and compare-and-set only the frozen digest. */
export async function backfillFrameworkRunSummaries(signal: AbortSignal = AbortSignal.timeout(BACKFILL_BUDGET_MS)) {
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  const cursor = TestRunModel.collection.find({...nativeRunFilter, summaryProjection: {$exists: false}},
    {projection: {runId: 1, payloadSha256: 1, payload: 1}, limit: 1000, batchSize: 10,
      readPreference: "primary", readConcern: {level: "majority"}, signal,
      timeoutMS: BACKFILL_BUDGET_MS, timeoutMode: "cursorLifetime"});
  try {
    for await (const row of cursor) {
      signal.throwIfAborted();
      const timeoutMS = deadline - Date.now();
      if (timeoutMS <= 0) break;
      let projection;
      try {projection = createFrameworkRunSummaryProjection(row.payload, row.payloadSha256);}
      catch {logger.warn({runId: row.runId}, "Frozen result cannot be projected for history"); continue;}
      await TestRunModel.collection.updateOne({...nativeRunFilter, runId: row.runId, payloadSha256: row.payloadSha256, summaryProjection: {$exists: false}},
        {$set: {summaryProjection: projection}}, {writeConcern: testWriteConcern, timeoutMS});
    }
  } finally {await cursor.close({timeoutMS: 1000}).catch(() => {});}
}

/** Start after HTTP is serving; failure never changes readiness, and shutdown cancels the cursor and drains bounded writes. */
export function startFrameworkRunSummaryBackfill() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKFILL_BUDGET_MS);
  timer.unref();
  const complete = backfillFrameworkRunSummaries(controller.signal).catch(() => {
    logger.warn("Frozen result summary backfill stopped; missing rows remain readable and retryable");
  }).finally(() => clearTimeout(timer));
  return async () => {
    controller.abort();
    await complete;
  }
}
