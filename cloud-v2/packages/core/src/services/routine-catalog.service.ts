import {TestRunModel} from "../models/test-run.model";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {RoutineDefinitionService} from "./routine-definition.service";

export interface CatalogExample {
  runId: string;
  startedAt: string;
  finishedAt: string;
  recordingAssetId: string;
}
export interface CatalogRunRepository {
  latestPassing(definition: RoutineEnrollment): Promise<CatalogExample | null>;
  history(routineId: string, platform: string, after: {startedAt: Date; runId: string} | null, limit: number): Promise<CatalogHistoryRun[]>;
}
export interface CatalogHistoryRun {runId: string; startedAt: string; outcome: string; uploadsComplete: boolean; definitionRevision: string}
export class RoutineCatalogError extends Error {
  constructor(readonly status: 400 | 404, message: string) {super(message);}
}
const mongoRuns: CatalogRunRepository = {
  async latestPassing(definition) {
    // Match the current source revision; an older example cannot qualify changed actions.
    const row = await TestRunModel.findOne({routineId: definition.routineId, platform: definition.platform,
      definitionRevision: definition.definitionRevision, outcome: "passed", uploadsComplete: true,
      "payload.result.setup.status": "passed",
      "payload.result.test": "passed", "payload.result.teardown.ready": true,
      "payload.recordingAssetId": {$type: "string"},
    }).sort({startedAt: -1, runId: -1}).lean();
    if (!row) return null;
    const payload = row.payload as {finishedAt: string; recordingAssetId: string};
    return {runId: row.runId, startedAt: row.startedAt.toISOString(),
      finishedAt: payload.finishedAt, recordingAssetId: payload.recordingAssetId};
  },
  async history(routineId, platform, after, limit) {
    const filter = {routineId, platform, ...(after ? {$or: [
      {startedAt: {$lt: after.startedAt}}, {startedAt: after.startedAt, runId: {$lt: after.runId}},
    ]} : {})};
    const rows = await TestRunModel.find(filter).sort({startedAt: -1, runId: -1}).limit(limit)
      .select({runId: 1, startedAt: 1, outcome: 1, uploadsComplete: 1, definitionRevision: 1}).lean();
    return rows.map(row => ({runId: row.runId, startedAt: row.startedAt.toISOString(),
      outcome: row.outcome, uploadsComplete: row.uploadsComplete, definitionRevision: row.definitionRevision!}));
  },
};

export class RoutineCatalogService {
  constructor(private readonly definitions: Pick<RoutineDefinitionService, "current" | "getCurrent"> = new RoutineDefinitionService(),
    private readonly runs: CatalogRunRepository = mongoRuns) {}
  async list() {
    const definitions = await this.definitions.current();
    return Promise.all(definitions.map(async definition => ({...definition,
      example: await this.runs.latestPassing(definition)})));
  }
  async detail(routineId: string, platform: string, cursor?: string, limit = 25) {
    if (!["ios-on-mac", "android"].includes(platform) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RoutineCatalogError(400, "Invalid routine history query");
    const definition = await this.definitions.getCurrent(routineId, platform);
    if (!definition) throw new RoutineCatalogError(404, "Routine is not enrolled on this platform");
    let after: {startedAt: Date; runId: string} | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (parsed.routineId !== routineId || parsed.platform !== platform || typeof parsed.runId !== "string"
          || !parsed.runId || !Number.isFinite(Date.parse(parsed.startedAt))) throw new Error("invalid");
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
