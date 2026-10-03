import {z} from "zod";
import {frameworkEvidenceComplete, frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import {frameworkRunIdSchema} from "../types/framework-run.types";
import {TestRunModel} from "../models/test-run.model";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {RoutineDefinitionService} from "./routine-definition.service";
import {nativeRunFilter} from "./framework-result.service";

export interface CatalogExample {
  runId: string;
  startedAt: string;
  finishedAt: string;
  recordingAssetId: string;
  definitionRevision: string;
  build: FrameworkRun["build"];
}
export interface CatalogRunRepository {
  latestPassing(definition: RoutineEnrollment): Promise<CatalogExample | null>;
  history(routineId: string, platform: string, after: {startedAt: Date; runId: string} | null, limit: number): Promise<CatalogHistoryRun[]>;
}
export interface CatalogHistoryRun {runId: string; startedAt: string; outcome: string; uploadsComplete: boolean; evidenceStatus: "complete" | "failed"; definitionRevision: string}
export class RoutineCatalogError extends Error {
  constructor(readonly status: 400 | 404, message: string) {super(message);}
}
const mongoRuns: CatalogRunRepository = {
  async latestPassing(definition) {
    // A definition change does not erase earlier passing coverage. The example
    // carries its real revision and build; it is not proof of the current code.
    const row = await TestRunModel.findOne({...nativeRunFilter, routineId: definition.routineId, platform: definition.platform,
      outcome: "pass", uploadsComplete: true, "payload.result.setup.status": "passed",
      "payload.result.test": "passed", "payload.result.failures.phase": {$ne: "evidence"}, "payload.result.teardown.ready": true,
      "payload.recordingAssetId": {$type: "string"},
    }).sort({startedAt: -1, runId: -1}).read("primary").readConcern("majority").lean();
    if (!row) return null;
    const run = frameworkRunSchema.parse(row.payload);
    return {runId: run.result.runId, startedAt: run.startedAt, finishedAt: run.finishedAt,
      recordingAssetId: run.recordingAssetId!, definitionRevision: run.definitionRevision, build: run.build};
  },
  async history(routineId, platform, after, limit) {
    const filter = {...nativeRunFilter, routineId, platform, ...(after ? {$or: [
      {startedAt: {$lt: after.startedAt}}, {startedAt: after.startedAt, runId: {$lt: after.runId}},
    ]} : {})};
    const rows = await TestRunModel.find(filter).sort({startedAt: -1, runId: -1}).limit(limit)
      .select({runId: 1, startedAt: 1, outcome: 1, uploadsComplete: 1, definitionRevision: 1, payload: 1})
      .read("primary").readConcern("majority").lean();
    return rows.map(row => {
      const run = frameworkRunSchema.parse(row.payload);
      return {runId: row.runId, startedAt: run.startedAt, outcome: row.outcome,
        uploadsComplete: row.uploadsComplete, definitionRevision: run.definitionRevision,
        evidenceStatus: frameworkEvidenceComplete(run) ? "complete" as const : "failed" as const};
    });
  },
};
const cursorSchema = z.object({routineId: z.string(), platform: z.string(),
  startedAt: z.string().datetime({offset: true}), runId: frameworkRunIdSchema}).strict();

export class RoutineCatalogService {
  constructor(private readonly definitions: Pick<RoutineDefinitionService, "current" | "getCurrent"> = new RoutineDefinitionService(),
    private readonly runs: CatalogRunRepository = mongoRuns) {}
  async list() {
    const definitions = await this.definitions.current();
    const entries = await Promise.all(definitions.map(async definition => {
      const [example, history] = await Promise.all([this.runs.latestPassing(definition), this.runs.history(definition.routineId, definition.platform, null, 1)]);
      return {...definition, example, latestAttempt: history[0] ?? null};
    }));
    // Discovered definitions without a published example remain authoring work.
    return entries.filter(entry => entry.example !== null);
  }
  async detail(routineId: string, platform: string, cursor?: string, limit = 25) {
    if (!["ios-on-mac", "android"].includes(platform) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RoutineCatalogError(400, "Invalid routine history query");
    const definition = await this.definitions.getCurrent(routineId, platform);
    if (!definition) throw new RoutineCatalogError(404, "Routine is not enrolled on this platform");
    let after: {startedAt: Date; runId: string} | null = null;
    if (cursor) {
      try {
        const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        if (parsed.routineId !== routineId || parsed.platform !== platform) throw new Error("invalid");
        after = {startedAt: new Date(parsed.startedAt), runId: parsed.runId};
      } catch {throw new RoutineCatalogError(400, "Invalid routine history cursor");}
    }
    const [example, rows] = await Promise.all([this.runs.latestPassing(definition),
      this.runs.history(routineId, platform, after, limit + 1)]);
    const history = rows.slice(0, limit), last = history.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({routineId, platform,
      startedAt: last.startedAt, runId: last.runId})).toString("base64url") : null;
    return {...definition, example, history, nextCursor};
  }
}
