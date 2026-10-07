import type {PipelineStage} from "mongoose";
import {z} from "zod";
import {createLogger} from "@mentra/cloud-shared";
import {TestRerunModel} from "../models/test-rerun.model";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunIdSchema} from "../types/framework-run.types";
import type {TestHistoryEntry, TestHistoryPage} from "../types/test-history.types";
import {nativeRunFilter, readFrameworkRunSummary, type StoredSummaryRow} from "./framework-run-summary.service";
import {TestRunError} from "./test-result-error";
import {TestSuiteService} from "./test-suite.service";
const logger = createLogger("core").child({component: "test-history"});

const cursorSchema = z.object({startedAt: z.string().datetime({offset: true}),
  kind: z.enum(["run", "suite"]), id: frameworkRunIdSchema}).strict();
type HistoryCursor = z.infer<typeof cursorSchema>;
const querySchema = z.object({cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  includeReruns: z.enum(["true", "false"]).default("false").transform(value => value === "true")}).strict();
export interface StoredHistoryRow {
  historyKind: "run" | "suite"; historyId: string; historyStartedAt: Date;
  requestId?: string; payloadSha256?: string; summaryProjection?: unknown; uploadsComplete?: boolean;
  historySuppressed?: boolean; rerunCount?: number; rerun?: {rerunId: string; parentSuiteId?: string};
}
export interface HistorySourceQueries {runs: PipelineStage[]; suites: PipelineStage[]; after: HistoryCursor | null; limit: number; includeReruns: boolean}
const RAW_HISTORY_BATCH_SIZE = 256;
interface StoredHistoryBatch {entries: StoredHistoryRow[]; scan: {count: number; last: StoredHistoryRow}[]}

function sourceCursor(after: HistoryCursor | null, kind: "run" | "suite", id: string) {
  if (!after) return {};
  const time = new Date(after.startedAt);
  return {startedAt: {$lte: time}, $or: [{startedAt: {$lt: time}}, ...(kind < after.kind ? [{startedAt: time}]
    : kind === after.kind ? [{startedAt: time, [id]: {$lt: after.id}}] : [])]};
}

/** Paginate after exact indexed membership exclusion in the database, without transferring suppressed raw rows. */
export function testHistoryQueries(after: HistoryCursor | null, limit: number, includeReruns = false): HistorySourceQueries {
  const runs: PipelineStage[] = [
    {$match: {...nativeRunFilter, ...sourceCursor(after, "run", "runId")}},
    {$sort: {startedAt: -1, runId: -1}},
    {$limit: RAW_HISTORY_BATCH_SIZE},
    {$lookup: {from: TestSuiteModel.collection.name, localField: "payload.requestId", foreignField: "payload.members.requestId",
      let: {requestId: "$payload.requestId", routineId: "$payload.routineId", platform: "$payload.platform",
        channel: "$payload.build.channel", headSha: "$payload.build.headSha", runId: "$runId"},
      pipeline: [{$match: {"payload.members.1": {$exists: true}, startedAt: {$type: "date"}, $expr: {$and: [
        {$eq: ["$payload.channel", "$$channel"]},
        {$anyElementTrue: [{$map: {input: "$payload.members", as: "member", in: {$and: [
          {$eq: ["$$member.requestId", "$$requestId"]}, {$eq: ["$$member.routineId", "$$routineId"]},
          {$eq: ["$$member.platform", "$$platform"]},
          {$eq: [{$ifNull: ["$$member.headSha", "$payload.build.headSha"]}, "$$headSha"]},
        ]}}}]},
        {$or: [{$eq: [{$ifNull: ["$nightlyResult", {$ifNull: ["$completedResult", null]}]}, null]},
          {$anyElementTrue: [{$map: {input: {$ifNull: ["$nightlyResult.members", {$ifNull: ["$completedResult.members", []]}]}, as: "member",
            in: {$and: [{$eq: ["$$member.requestId", "$$requestId"]}, {$eq: ["$$member.runId", "$$runId"]}]}}}]}]},
      ]}}}, {$limit: 1}], as: "historySuites"}},
    {$lookup: {from: TestRerunModel.collection.name, localField: "payload.requestId", foreignField: "plan.members.requestId",
      pipeline: [{$match: {state: "accepted"}}, {$limit: 1}, {$project: {_id: 0, rerunId: 1, parentSuiteId: "$plan.parent.suiteId"}}],
      as: "historyReruns"}},
    {$project: {_id: 0, historyKind: {$literal: "run"}, historyId: "$runId",
      historyStartedAt: "$startedAt", runId: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1, uploadsComplete: 1,
      rerun: {$arrayElemAt: ["$historyReruns", 0]},
      historySuppressed: {$or: [{$gt: [{$size: "$historySuites"}, 0]},
        ...(!includeReruns ? [{$gt: [{$size: "$historyReruns"}, 0]}] : [])]}}},
    {$facet: {entries: [{$match: {historySuppressed: false}}, {$limit: limit + 1}],
      scan: [{$group: {_id: null, count: {$sum: 1}, last: {$last: {historyKind: "$historyKind", historyId: "$historyId", historyStartedAt: "$historyStartedAt"}}}}]}},
  ];
  const suites: PipelineStage[] = [
      {$match: {"payload.members.1": {$exists: true}, startedAt: {$type: "date"}, ...sourceCursor(after, "suite", "suiteId")}},
      {$sort: {startedAt: -1, suiteId: -1}},
      {$limit: limit + 1},
      {$lookup: {from: TestRerunModel.collection.name, localField: "suiteId", foreignField: "plan.parent.suiteId",
        pipeline: [{$match: {state: "accepted"}}, {$count: "count"}], as: "historyReruns"}},
      {$project: {_id: 0, historyKind: {$literal: "suite"}, historyId: "$suiteId",
        historyStartedAt: "$startedAt", rerunCount: {$ifNull: [{$arrayElemAt: ["$historyReruns.count", 0]}, 0]}}},
  ];
  return {runs, suites, after, limit, includeReruns};
}

const HISTORY_QUERY_BUDGET_MS = 10_000;
function remainingQueryTime(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TestRunError(503, "Test history query timed out. Try again.");
  return remaining;
}

export class TestHistoryService {
  constructor(private readonly suites: Pick<TestSuiteService, "summaries"> = new TestSuiteService(),
    private readonly read: (queries: HistorySourceQueries, deadline: number) => Promise<StoredHistoryRow[][]> = async (queries, deadline) => {
      // Timestamp projection is installed at startup and written with every new suite.
      const suites = await TestSuiteModel.aggregate<StoredHistoryRow>(queries.suites)
        .collation({locale: "simple"}).read("primary").readConcern("majority").option({timeoutMS: remainingQueryTime(deadline), maxTimeMS: remainingQueryTime(deadline)}).exec();
      const runs: StoredHistoryRow[] = [];
      let after = queries.after;
      while (runs.length < queries.limit + 1) {
        const runsPipeline = testHistoryQueries(after, queries.limit, queries.includeReruns).runs;
        // A full suite candidate page proves a next page; older runs cannot enter this page.
        if (suites.length === queries.limit + 1) runsPipeline.splice(1, 0, {$match: {startedAt: {$gte: suites.at(-1)!.historyStartedAt}}});
        const [batch] = await TestRunModel.aggregate<StoredHistoryBatch>(runsPipeline)
          .collation({locale: "simple"}).read("primary").readConcern("majority").option({timeoutMS: remainingQueryTime(deadline), maxTimeMS: remainingQueryTime(deadline)}).exec();
        runs.push(...(batch?.entries ?? []));
        const scan = batch?.scan[0];
        if (!scan || scan.count < RAW_HISTORY_BATCH_SIZE) break;
        after = {startedAt: scan.last.historyStartedAt.toISOString(), kind: "run", id: scan.last.historyId};
      }
      return [runs, suites];
    }) {}

  async list(input: Record<string, string> = {}): Promise<TestHistoryPage> {
    const query = querySchema.safeParse(input);
    if (!query.success) throw new TestRunError(400, "invalid test history query");
    let after: HistoryCursor | null = null;
    if (query.data.cursor) {
      try {after = cursorSchema.parse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString("utf8")));}
      catch {throw new TestRunError(400, "invalid test history cursor");}
    }
    let sources: StoredHistoryRow[][];
    const deadline = Date.now() + HISTORY_QUERY_BUDGET_MS;
    try {sources = await this.read(testHistoryQueries(after, query.data.limit, query.data.includeReruns), deadline);}
    catch (error) {
      if ((error as {code?: number}).code === 50) throw new TestRunError(503, "Test history query timed out. Try again.");
      throw error;
    }
    const rows = sources.flat().sort((a, b) => b.historyStartedAt.getTime() - a.historyStartedAt.getTime()
      || (a.historyKind < b.historyKind ? 1 : a.historyKind > b.historyKind ? -1 : 0)
      || (a.historyId < b.historyId ? 1 : a.historyId > b.historyId ? -1 : 0));
    const page = rows.slice(0, query.data.limit);
    const suiteSummaries = await this.suites.summaries(page.filter(row => row.historyKind === "suite").map(row => row.historyId), deadline);
    const entries = await Promise.all(page.map(async (row): Promise<TestHistoryEntry> => {
      try {
        if (row.historyKind === "run") {
          return {kind: "run", ...await readFrameworkRunSummary({...row, runId: row.historyId} as StoredSummaryRow, deadline),
            ...(row.rerun ? {rerun: row.rerun} : {})};
        }
        // The existing reader preserves frozen completions and computes current waiting members.
        const suite = suiteSummaries.get(row.historyId);
        if (!suite) throw new TestRunError(404, "test suite not found");
        if (suite instanceof Error) throw suite;
        const members = suite.members.map(member => {
          const source = member as typeof member & {laneId?: string; hostId?: string; dispatchIntent?: {laneId?: string}; input?: {laneId?: string}};
          const laneId = source.laneId ?? source.dispatchIntent?.laneId ?? source.input?.laneId;
          return {routineId: member.routineId, platform: member.platform,
            ...(laneId ? {laneId} : {}), ...(source.hostId ? {hostId: source.hostId} : {})};
        });
        return {kind: "suite", suiteId: suite.suiteId, channel: suite.channel, trigger: suite.trigger,
          startedAt: suite.startedAt, ...(suite.finishedAt ? {finishedAt: suite.finishedAt} : {}),
          outcome: suite.outcome, expectedCount: suite.members.length, passed: suite.passed, build: suite.build,
          skipped: suite.members.filter(member => member.status === "not-run").length,
          rerunCount: row.rerunCount ?? 0,
          failedCount: suite.members.filter(member => ["failed", "setup-failed", "teardown-failed"].includes(member.status)).length,
          lanes: [...new Map(members.flatMap(member => member.hostId && member.laneId
            ? [[JSON.stringify([member.hostId, member.laneId]), {hostId: member.hostId, laneId: member.laneId}] as const] : [])).values()]
            .sort((a, b) => a.hostId.localeCompare(b.hostId) || a.laneId.localeCompare(b.laneId)), members};
      } catch (error) {
        logger.warn({err: error, sourceKind: row.historyKind, id: row.historyId}, "History entry details unavailable");
        return {kind: "unavailable", sourceKind: row.historyKind, id: row.historyId,
          startedAt: row.historyStartedAt.toISOString(), message: "Details unavailable."};
      }
    }));
    const last = page.at(-1);
    // Ordinary keyset pagination: late publication or member binding can change later pages.
    const nextCursor = rows.length > query.data.limit && last ? Buffer.from(JSON.stringify({
      startedAt: last.historyStartedAt.toISOString(), kind: last.historyKind, id: last.historyId,
    } satisfies HistoryCursor)).toString("base64url") : null;
    return {entries, nextCursor};
  }
}
