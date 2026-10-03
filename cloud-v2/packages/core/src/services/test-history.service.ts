import type {PipelineStage} from "mongoose";
import {z} from "zod";
import {createLogger} from "@mentra/cloud-shared";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunIdSchema, frameworkRunSchema} from "../types/framework-run.types";
import type {TestSuite} from "../types/test-suite.types";
import {nativeRunFilter, summarizeFrameworkRun, type FrameworkRunSummary} from "./framework-result.service";
import {TestRunError} from "./test-result-error";
import {TestSuiteService} from "./test-suite.service";
const logger = createLogger("core").child({component: "test-history"});

export type TestHistoryEntry = ({kind: "run"} & FrameworkRunSummary) | {
  kind: "suite"; suiteId: string; channel: TestSuite["channel"]; trigger: TestSuite["trigger"];
  startedAt: string; finishedAt?: string; outcome: string; expectedCount: number; passed: number; build: TestSuite["build"];
} | {kind: "unavailable"; sourceKind: "run" | "suite"; id: string; startedAt: string; message: "Details unavailable."};
export interface TestHistoryPage {entries: TestHistoryEntry[]; nextCursor: string | null}
const cursorSchema = z.object({startedAt: z.string().datetime({offset: true}),
  kind: z.enum(["run", "suite"]), id: frameworkRunIdSchema}).strict();
type HistoryCursor = z.infer<typeof cursorSchema>;
const querySchema = z.object({cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)}).strict();
export interface StoredHistoryRow {
  historyKind: "run" | "suite"; historyId: string; historyStartedAt: Date;
  payload?: unknown; uploadsComplete?: boolean;
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
      pipeline: [{$match: {"payload.members.1": {$exists: true}, $expr: {$and: [
        {$eq: ["$payload.channel", "$$channel"]},
        {$anyElementTrue: [{$map: {input: "$payload.members", as: "member", in: {$and: [
          {$eq: ["$$member.requestId", "$$requestId"]}, {$eq: ["$$member.routineId", "$$routineId"]},
          {$eq: ["$$member.platform", "$$platform"]},
          {$eq: [{$ifNull: ["$$member.headSha", "$payload.build.headSha"]}, "$$headSha"]},
        ]}}}]},
        {$or: [{$eq: [{$ifNull: ["$completedResult", null]}, null]},
          {$anyElementTrue: [{$map: {input: {$ifNull: ["$completedResult.members", []]}, as: "member",
            in: {$and: [{$eq: ["$$member.requestId", "$$requestId"]}, {$eq: ["$$member.runId", "$$runId"]}]}}}]}]},
      ]}}}, {$limit: 1}], as: "historySuites"}},
    {$project: {_id: 0, historyKind: {$literal: "run"}, historyId: "$runId",
      historyStartedAt: "$startedAt", payload: 1, uploadsComplete: 1,
      historySuppressed: {$gt: [{$size: "$historySuites"}, 0]}}},
  ];
  const suites: PipelineStage[] = [
      {$match: {"payload.members.1": {$exists: true}, ...sourceCursor(after, "suite", "suiteId")}},
      {$sort: {startedAt: -1, suiteId: -1}},
      {$limit: limit + 1},
      {$project: {_id: 0, historyKind: {$literal: "suite"}, historyId: "$suiteId",
        historyStartedAt: "$startedAt"}},
  ];
  return {runs, suites, after, limit};
}

async function readStandaloneRuns(queries: HistorySourceQueries) {
  const eligible: StoredHistoryRow[] = [];
  let after = queries.after;
  // A batch is bounded, but there is no total raw-run cap: scan past any number of suite members.
  while (eligible.length < queries.limit + 1) {
    const pipeline = testHistoryQueries(after, queries.limit).runs;
    const batch = await TestRunModel.aggregate<StoredHistoryRow>(pipeline).collation({locale: "simple"})
      .read("primary").readConcern("majority").exec();
    eligible.push(...batch.filter(row => !row.historySuppressed));
    const last = batch.at(-1);
    if (batch.length < queries.limit + 1 || !last) break;
    after = {startedAt: last.historyStartedAt.toISOString(), kind: "run", id: last.historyId};
  }
  return eligible.slice(0, queries.limit + 1);
}

export class TestHistoryService {
  constructor(private readonly suites: Pick<TestSuiteService, "detail"> = new TestSuiteService(),
    private readonly read: (queries: HistorySourceQueries) => Promise<StoredHistoryRow[][]> = queries =>
      Promise.all([readStandaloneRuns(queries), TestSuiteModel.aggregate<StoredHistoryRow>(queries.suites)
        .collation({locale: "simple"}).read("primary").readConcern("majority").exec()])) {}

  async list(input: Record<string, string> = {}): Promise<TestHistoryPage> {
    const query = querySchema.safeParse(input);
    if (!query.success) throw new TestRunError(400, "invalid test history query");
    let after: HistoryCursor | null = null;
    if (query.data.cursor) {
      try {after = cursorSchema.parse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString("utf8")));}
      catch {throw new TestRunError(400, "invalid test history cursor");}
    }
    const sources = await this.read(testHistoryQueries(after, query.data.limit));
    const rows = sources.flat().sort((a, b) => b.historyStartedAt.getTime() - a.historyStartedAt.getTime()
      || (a.historyKind < b.historyKind ? 1 : a.historyKind > b.historyKind ? -1 : 0)
      || (a.historyId < b.historyId ? 1 : a.historyId > b.historyId ? -1 : 0));
    const page = rows.slice(0, query.data.limit);
    const entries = await Promise.all(page.map(async (row): Promise<TestHistoryEntry> => {
      try {
        if (row.historyKind === "run") {
          const parsed = frameworkRunSchema.safeParse(row.payload);
          if (!parsed.success) throw new TestRunError(503, "History run is not a valid framework result");
          return {kind: "run", ...summarizeFrameworkRun(parsed.data, row.uploadsComplete === true)};
        }
        // The existing reader preserves frozen completions and computes current waiting members.
        const suite = await this.suites.detail(row.historyId);
        return {kind: "suite", suiteId: suite.suiteId, channel: suite.channel, trigger: suite.trigger,
          startedAt: suite.startedAt, ...(suite.finishedAt ? {finishedAt: suite.finishedAt} : {}),
          outcome: suite.outcome, expectedCount: suite.members.length, passed: suite.passed, build: suite.build};
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
