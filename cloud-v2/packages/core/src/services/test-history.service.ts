import type {PipelineStage} from "mongoose";
import {z} from "zod";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunIdSchema, frameworkRunSchema} from "../types/framework-run.types";
import type {TestSuite} from "../types/test-suite.types";
import {nativeRunFilter, summarizeFrameworkRun, type FrameworkRunSummary} from "./framework-result.service";
import {TestRunError} from "./test-result-error";
import {TestSuiteService} from "./test-suite.service";

export type TestHistoryEntry = ({kind: "run"} & FrameworkRunSummary) | {
  kind: "suite"; suiteId: string; channel: TestSuite["channel"]; trigger: TestSuite["trigger"];
  startedAt: string; finishedAt?: string; outcome: string; expectedCount: number; passed: number; build: TestSuite["build"];
};
export interface TestHistoryPage {entries: TestHistoryEntry[]; nextCursor: string | null}
const cursorSchema = z.object({startedAt: z.string().datetime({offset: true}),
  kind: z.enum(["run", "suite"]), id: frameworkRunIdSchema}).strict();
type HistoryCursor = z.infer<typeof cursorSchema>;
const querySchema = z.object({cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)}).strict();
export interface StoredHistoryRow {
  historyKind: "run" | "suite"; historyId: string; historyStartedAt: Date;
  payload?: unknown; uploadsComplete?: boolean;
}

/** Paginate after exact membership exclusion, so large suites cannot consume the run page. */
export function testHistoryPipeline(after: HistoryCursor | null, limit: number): PipelineStage[] {
  return [
    {$match: nativeRunFilter},
    {$lookup: {from: TestSuiteModel.collection.name, localField: "payload.requestId", foreignField: "payload.members.requestId",
      let: {requestId: "$payload.requestId", routineId: "$payload.routineId", platform: "$payload.platform",
        channel: "$payload.build.channel", headSha: "$payload.build.headSha"},
      pipeline: [{$match: {"payload.members.1": {$exists: true}, $expr: {$and: [
        {$eq: ["$payload.channel", "$$channel"]},
        {$anyElementTrue: [{$map: {input: "$payload.members", as: "member", in: {$and: [
          {$eq: ["$$member.requestId", "$$requestId"]}, {$eq: ["$$member.routineId", "$$routineId"]},
          {$eq: ["$$member.platform", "$$platform"]},
          {$eq: [{$ifNull: ["$$member.headSha", "$payload.build.headSha"]}, "$$headSha"]},
        ]}}}]},
      ]}}}, {$limit: 1}], as: "historySuites"}},
    {$match: {"historySuites.0": {$exists: false}}},
    {$project: {_id: 0, historyKind: {$literal: "run"}, historyId: "$runId",
      historyStartedAt: "$startedAt", payload: 1, uploadsComplete: 1}},
    {$unionWith: {coll: TestSuiteModel.collection.name, pipeline: [
      {$match: {"payload.members.1": {$exists: true}}},
      {$project: {_id: 0, historyKind: {$literal: "suite"}, historyId: "$suiteId",
        historyStartedAt: {$toDate: "$payload.startedAt"}}},
    ]}},
    ...(after ? [{$match: {$or: [
      {historyStartedAt: {$lt: new Date(after.startedAt)}},
      {historyStartedAt: new Date(after.startedAt), historyKind: {$lt: after.kind}},
      {historyStartedAt: new Date(after.startedAt), historyKind: after.kind, historyId: {$lt: after.id}},
    ]}}] : []),
    {$sort: {historyStartedAt: -1, historyKind: -1, historyId: -1}},
    {$limit: limit + 1},
  ] as PipelineStage[];
}

export class TestHistoryService {
  constructor(private readonly suites: Pick<TestSuiteService, "detail"> = new TestSuiteService(),
    private readonly read: (pipeline: PipelineStage[]) => Promise<StoredHistoryRow[]> = pipeline =>
      TestRunModel.aggregate<StoredHistoryRow>(pipeline).collation({locale: "simple"})
        .read("primary").readConcern("majority").exec()) {}

  async list(input: Record<string, string> = {}): Promise<TestHistoryPage> {
    const query = querySchema.safeParse(input);
    if (!query.success) throw new TestRunError(400, "invalid test history query");
    let after: HistoryCursor | null = null;
    if (query.data.cursor) {
      try {after = cursorSchema.parse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString("utf8")));}
      catch {throw new TestRunError(400, "invalid test history cursor");}
    }
    const rows = await this.read(testHistoryPipeline(after, query.data.limit));
    const page = rows.slice(0, query.data.limit);
    const entries = await Promise.all(page.map(async (row): Promise<TestHistoryEntry> => {
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
    }));
    const last = page.at(-1);
    // Ordinary keyset pagination: late publication or member binding can change later pages.
    const nextCursor = rows.length > query.data.limit && last ? Buffer.from(JSON.stringify({
      startedAt: last.historyStartedAt.toISOString(), kind: last.historyKind, id: last.historyId,
    } satisfies HistoryCursor)).toString("base64url") : null;
    return {entries, nextCursor};
  }
}
