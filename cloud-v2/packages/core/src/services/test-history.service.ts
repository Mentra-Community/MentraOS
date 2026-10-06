import type {PipelineStage} from "mongoose";
import {z} from "zod";
import {createLogger} from "@mentra/cloud-shared";
import {TestRunModel} from "../models/test-run.model";
import {backfillTestSuiteStartedAt, TestSuiteModel} from "../models/test-suite.model";
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
  limit: z.coerce.number().int().min(1).max(100).default(25)}).strict();
export interface StoredHistoryRow {
  historyKind: "run" | "suite"; historyId: string; historyStartedAt: Date;
  requestId?: string; payloadSha256?: string; summaryProjection?: unknown; uploadsComplete?: boolean;
  historySuppressed?: boolean;
}
export interface HistorySourceQueries {runs: PipelineStage[]; suites: PipelineStage[]; after: HistoryCursor | null; limit: number}

function sourceCursor(after: HistoryCursor | null, kind: "run" | "suite", id: string) {
  if (!after) return {};
  const time = new Date(after.startedAt);
  return {$or: [{startedAt: {$lt: time}}, ...(kind < after.kind ? [{startedAt: time}]
    : kind === after.kind ? [{startedAt: time, [id]: {$lt: after.id}}] : [])]};
}

/** Paginate after exact membership exclusion, so large suites cannot consume the run page. */
export function testHistoryQueries(after: HistoryCursor | null, limit: number): HistorySourceQueries {
  const runs: PipelineStage[] = [
    {$match: {...nativeRunFilter, ...sourceCursor(after, "run", "runId")}},
    {$sort: {startedAt: -1, runId: -1}},
    {$limit: limit + 1},
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
    {$project: {_id: 0, historyKind: {$literal: "run"}, historyId: "$runId",
      historyStartedAt: "$startedAt", runId: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1, uploadsComplete: 1,
      historySuppressed: {$gt: [{$size: "$historySuites"}, 0]}}},
  ];
  const suites: PipelineStage[] = [
      {$match: {"payload.members.1": {$exists: true}, startedAt: {$type: "date"}, ...sourceCursor(after, "suite", "suiteId")}},
      {$sort: {startedAt: -1, suiteId: -1}},
      {$limit: limit + 1},
      {$project: {_id: 0, historyKind: {$literal: "suite"}, historyId: "$suiteId",
        historyStartedAt: "$startedAt"}},
  ];
  return {runs, suites, after, limit};
}

const HISTORY_QUERY_BUDGET_MS = 10_000;
function remainingQueryTime(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TestRunError(503, "Test history query timed out. Try again.");
  return remaining;
}

async function readStandaloneRuns(queries: HistorySourceQueries, deadline: number) {
  const eligible: StoredHistoryRow[] = [];
  let after = queries.after;
  // A batch is bounded, but there is no total raw-run cap: scan past any number of suite members.
  while (eligible.length < queries.limit + 1) {
    const pipeline = testHistoryQueries(after, queries.limit).runs;
    const batch = await TestRunModel.aggregate<StoredHistoryRow>(pipeline).collation({locale: "simple"})
      .read("primary").readConcern("majority").option({maxTimeMS: remainingQueryTime(deadline)}).exec();
    eligible.push(...batch.filter(row => !row.historySuppressed));
    const last = batch.at(-1);
    if (batch.length < queries.limit + 1 || !last) break;
    after = {startedAt: last.historyStartedAt.toISOString(), kind: "run", id: last.historyId};
  }
  return eligible.slice(0, queries.limit + 1);
}

export class TestHistoryService {
  constructor(private readonly suites: Pick<TestSuiteService, "detail"> = new TestSuiteService(),
    private readonly read: (queries: HistorySourceQueries) => Promise<StoredHistoryRow[][]> = async queries => {
      const deadline = Date.now() + HISTORY_QUERY_BUDGET_MS;
      await backfillTestSuiteStartedAt(TestSuiteModel.collection, () => ({maxTimeMS: remainingQueryTime(deadline)}));
      // Older writers racing this repair become eligible on the next refresh, with their real date.
      const [runs, suites] = await Promise.all([readStandaloneRuns(queries, deadline), TestSuiteModel.aggregate<StoredHistoryRow>(queries.suites)
        .collation({locale: "simple"}).read("primary").readConcern("majority").option({maxTimeMS: remainingQueryTime(deadline)}).exec()]);
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
    try {sources = await this.read(testHistoryQueries(after, query.data.limit));}
    catch (error) {
      if ((error as {code?: number}).code === 50) throw new TestRunError(503, "Test history query timed out. Try again.");
      throw error;
    }
    const rows = sources.flat().sort((a, b) => b.historyStartedAt.getTime() - a.historyStartedAt.getTime()
      || (a.historyKind < b.historyKind ? 1 : a.historyKind > b.historyKind ? -1 : 0)
      || (a.historyId < b.historyId ? 1 : a.historyId > b.historyId ? -1 : 0));
    const page = rows.slice(0, query.data.limit);
    const entries = await Promise.all(page.map(async (row): Promise<TestHistoryEntry> => {
      try {
        if (row.historyKind === "run") {
          return {kind: "run", ...await readFrameworkRunSummary({...row, runId: row.historyId} as StoredSummaryRow)};
        }
        // The existing reader preserves frozen completions and computes current waiting members.
        const suite = await this.suites.detail(row.historyId);
        return {kind: "suite", suiteId: suite.suiteId, channel: suite.channel, trigger: suite.trigger,
          startedAt: suite.startedAt, ...(suite.finishedAt ? {finishedAt: suite.finishedAt} : {}),
          outcome: suite.outcome, expectedCount: suite.members.length, passed: suite.passed, build: suite.build,
          skipped: suite.members.filter(member => member.status === "not-run").length,
          members: suite.members.map(({routineId, platform}) => ({routineId, platform}))};
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
