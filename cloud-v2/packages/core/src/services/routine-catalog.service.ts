import {z} from "zod";
import {frameworkRunIdSchema} from "../types/framework-run.types";
import {frameworkBuildSchema} from "../types/framework-request.types";
import {TestRunModel} from "../models/test-run.model";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import type {CatalogExample, CatalogHistoryRun} from "../types/test-history.types";
import {RoutineDefinitionService} from "./routine-definition.service";
import {nativeRunFilter, readFrameworkRunSummaryProjection} from "./framework-run-summary.service";
import {TestRunError} from "./test-result-error";
import {routinePreferences, type RoutinePreferenceRepository} from "./routine-preference.service";

export interface CatalogRunRepository {
  latestPassing(definition: RoutineEnrollment): Promise<CatalogExample | null>;
  history(routineId: string, platform: string, after: {startedAt: Date; runId: string} | null, limit: number): Promise<CatalogHistoryRun[]>;
}
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
    }).sort({startedAt: -1, runId: -1}).select({runId: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1, uploadsComplete: 1, "payload.recordingAssetId": 1, "payload.build": 1})
      .read("primary").readConcern("majority").lean();
    if (!row) return null;
    const projection = await readFrameworkRunSummaryProjection(row), summary = projection.summary;
    const payload = row.payload as {build?: unknown; recordingAssetId?: unknown};
    const build = frameworkBuildSchema.safeParse(payload.build);
    if (!build.success || !projection.recordingAssetId || projection.recordingAssetId !== payload.recordingAssetId
      || build.data.repository !== summary.build.repository || build.data.channel !== summary.build.channel
      || build.data.headSha !== summary.build.headSha || build.data.prNumber !== summary.build.prNumber)
      throw new TestRunError(503, "Recorded example build or recording is unavailable");
    return {runId: summary.runId, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
      recordingAssetId: projection.recordingAssetId,
      definitionRevision: projection.definitionRevision, build: build.data};
  },
  async history(routineId, platform, after, limit) {
    const filter = {...nativeRunFilter, routineId, platform, ...(after ? {$or: [
      {startedAt: {$lt: after.startedAt}}, {startedAt: after.startedAt, runId: {$lt: after.runId}},
    ]} : {})};
    const rows = await TestRunModel.find(filter).sort({startedAt: -1, runId: -1}).limit(limit)
      .select({runId: 1, requestId: 1, payloadSha256: 1, summaryProjection: 1, uploadsComplete: 1})
      .read("primary").readConcern("majority").lean();
    return await Promise.all(rows.map(async row => {
      const projection = await readFrameworkRunSummaryProjection(row), summary = projection.summary;
      return {runId: summary.runId, startedAt: summary.startedAt, outcome: summary.outcome,
        uploadsComplete: row.uploadsComplete === true, definitionRevision: projection.definitionRevision,
        evidenceStatus: summary.evidenceStatus};
    }));
  },
};
const cursorSchema = z.object({routineId: z.string(), platform: z.string(),
  startedAt: z.string().datetime({offset: true}), runId: frameworkRunIdSchema}).strict();

export class RoutineCatalogService {
  constructor(private readonly definitions: Pick<RoutineDefinitionService, "current" | "getCurrent"> = new RoutineDefinitionService(),
    private readonly runs: CatalogRunRepository = mongoRuns,
    private readonly preferences: RoutinePreferenceRepository = routinePreferences) {}
  async list() {
    const [definitions, preferences] = await Promise.all([this.definitions.current(), this.preferences.list()]);
    const entries = await Promise.all(definitions.map(async definition => {
      const [example, history] = await Promise.all([this.runs.latestPassing(definition), this.runs.history(definition.routineId, definition.platform, null, 1)]);
      const nightlyEnabled = preferences.find(row => row.routineId === definition.routineId && row.platform === definition.platform)?.nightlyEnabled ?? true;
      return {...definition, example, latestAttempt: history[0] ?? null, nightlyEnabled};
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
    const [example, rows, preference] = await Promise.all([this.runs.latestPassing(definition),
      this.runs.history(routineId, platform, after, limit + 1), this.preferences.get(routineId, platform)]);
    const history = rows.slice(0, limit), last = history.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({routineId, platform,
      startedAt: last.startedAt, runId: last.runId})).toString("base64url") : null;
    return {...definition, example, history, nextCursor, nightlyEnabled: preference?.nightlyEnabled ?? true};
  }
  async setPreference(routineId: string, platform: string, nightlyEnabled: boolean) {
    const detail = await this.detail(routineId, platform, undefined, 1);
    if (!detail.example) throw new RoutineCatalogError(404, "Routine has no recorded passing example");
    await this.preferences.set({routineId, platform, nightlyEnabled});
    return {routineId, platform, nightlyEnabled};
  }
}
