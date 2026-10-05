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
export async function readFrameworkRunSummary(row: StoredSummaryRow): Promise<FrameworkRunSummary> {
  let projection = row.summaryProjection;
  if (projection === undefined) {
    const stored = await TestRunModel.findOne({...nativeRunFilter, runId: row.runId, payloadSha256: row.payloadSha256})
      .select({payload: 1, payloadSha256: 1}).read("primary").readConcern("majority").lean();
    if (!stored) throw new TestRunError(503, "Frozen result summary is unavailable");
    projection = createFrameworkRunSummaryProjection(stored.payload, stored.payloadSha256);
  }
  const verified = verifiedFrameworkRunSummaryProjection({...row, summaryProjection: projection});
  return {...verified.summary, uploadsComplete: row.uploadsComplete === true};
}

/** Fill native rows once, using the unchanged full validator and a compare-and-set against the frozen digest. */
export async function backfillFrameworkRunSummaries() {
  const cursor = TestRunModel.find({...nativeRunFilter, summaryProjection: {$exists: false}})
    .select({runId: 1, payloadSha256: 1, payload: 1}).read("primary").readConcern("majority").maxTimeMS(10_000)
    .lean().cursor({batchSize: 10});
  for await (const row of cursor) {
    let projection;
    try {projection = createFrameworkRunSummaryProjection(row.payload, row.payloadSha256);}
    catch {logger.warn({runId: row.runId}, "Frozen result cannot be projected for history"); continue;}
    await TestRunModel.updateOne({runId: row.runId, payloadSha256: row.payloadSha256, summaryProjection: {$exists: false}},
      {$set: {summaryProjection: projection}}, {writeConcern: testWriteConcern});
  }
}
