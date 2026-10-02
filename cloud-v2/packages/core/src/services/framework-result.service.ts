import {TestRunModel} from "../models/test-run.model";
import {frameworkRunOutcome, frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import {requestInputDigest} from "./test-request.service";

export class FrameworkResultConflict extends Error {}
export interface FrameworkResultRepository {
  insert(run: FrameworkRun, payloadSha256: string): Promise<void>;
  getByRequest(requestId: string): Promise<{payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null>;
}
const mongoRepository: FrameworkResultRepository = {
  async insert(run, payloadSha256) {
    await TestRunModel.create({runId: run.result.runId, requestId: run.requestId, routineId: run.routineId,
      definitionRevision: run.definitionRevision, platform: run.platform, laneId: run.laneId,
      startedAt: new Date(run.startedAt), completedAt: new Date(run.finishedAt), completionProjectionVersion: 1,
      outcome: frameworkRunOutcome(run), payloadSha256, payload: run, uploadsComplete: run.assets.length === 0});
  },
  async getByRequest(requestId) {
    const row = await TestRunModel.findOne({requestId, definitionRevision: {$exists: true}}).lean();
    return row ? {payload: row.payload as FrameworkRun, payloadSha256: row.payloadSha256, uploadsComplete: row.uploadsComplete} : null;
  },
};

/** One frozen terminal result per controller request; publication never rewrites verdicts. */
export class FrameworkResultService {
  constructor(private readonly repository: FrameworkResultRepository = mongoRepository) {}
  async ingest(input: unknown) {
    const parsed = frameworkRunSchema.safeParse(input);
    if (!parsed.success) throw new FrameworkResultConflict("Invalid frozen framework result");
    const run = parsed.data, payloadSha256 = requestInputDigest(run);
    let created = true;
    try {await this.repository.insert(run, payloadSha256);}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      const existing = await this.repository.getByRequest(run.requestId);
      if (!existing || existing.payloadSha256 !== payloadSha256)
        throw new FrameworkResultConflict("Request already has a different terminal result");
      created = false;
    }
    return {entityId: run.result.runId, payloadSha256, created};
  }
}
