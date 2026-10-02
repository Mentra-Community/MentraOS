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
}
const mongoRuns: CatalogRunRepository = {
  async latestPassing(definition) {
    // Match the current source revision; an older example cannot qualify changed actions.
    const row = await TestRunModel.findOne({routineId: definition.routineId, platform: definition.platform,
      definitionRevision: definition.definitionRevision, outcome: "pass", uploadsComplete: true,
      "payload.publication.status": "complete", "payload.setup.status": "passed",
      "payload.test": "passed", "payload.teardown.ready": true,
      "payload.recordingAssetId": {$type: "string"},
    }).sort({startedAt: -1, runId: -1}).lean();
    if (!row) return null;
    const payload = row.payload as {finishedAt: string; recordingAssetId: string};
    return {runId: row.runId, startedAt: row.startedAt.toISOString(),
      finishedAt: payload.finishedAt, recordingAssetId: payload.recordingAssetId};
  },
};

export class RoutineCatalogService {
  constructor(private readonly definitions: Pick<RoutineDefinitionService, "current"> = new RoutineDefinitionService(),
    private readonly runs: CatalogRunRepository = mongoRuns) {}
  async list() {
    const definitions = await this.definitions.current();
    return Promise.all(definitions.map(async definition => ({...definition,
      example: await this.runs.latestPassing(definition)})));
  }
}
