import { TestRunModel } from "../models/test-run.model";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import type { TestRunClaim } from "../types/test-run-claim.types";
import type { TestDispatchView } from "../types/test-dispatch.types";
import { TestDispatchError } from "./test-builds.service";
import { recoveredClaim } from "./test-run-overview.service";
import type { TestRunService } from "./test-run.service";

export interface RegisteredResultRepository {
  results(requestId: string): Promise<string[]>;
  claim(requestId: string): Promise<TestRunClaim | null>;
}
export class MongoRegisteredResultRepository implements RegisteredResultRepository {
  async claim(requestId: string) {
    const row = await TestRunClaimModel.findOne({ requestId }).select({ claim: 1 }).lean();
    return row ? row.claim as TestRunClaim : null;
  }
  async results(requestId: string) {
    const rows = await TestRunModel.find({ requestId }).sort({ startedAt: 1, runId: 1 }).limit(21).select({ runId: 1 }).lean();
    if (rows.length > 20) throw new TestDispatchError(409, "Recorded result history exceeds the continuation bound");
    return rows.map(row => row.runId);
  }
}
/** What one registered request must have exercised; saved on its receipt, never read from a caller. */
export interface RegisteredResultBinding {
  routineId: string;
  archiveSha256: string;
  expectedHeadSha: string;
  expectedHarnessSha?: string;
}

/**
 * The exact recorded result lineage of one registered request: every result must carry the
 * request's ID, routine, archive, selected head and (where bound) worker revision, or the whole
 * read fails. `verifiedRecovery` is the existing verified-return resolution of a settled claim.
 */
export async function registeredResults(view: TestDispatchView, binding: RegisteredResultBinding,
  repository: RegisteredResultRepository, runs: Pick<TestRunService, "detail">) {
  const ids = view.requestId ? await repository.results(view.requestId) : [];
  if (view.result && !ids.includes(view.result.runId)) ids.push(view.result.runId);
  const results = await Promise.all(ids.map(async id => {
    const result = await runs.detail(id);
    if (result.requestId !== view.requestId || result.routineId !== binding.routineId
      || result.provenance.archiveSha256 !== binding.archiveSha256
      || (result.source?.headSha ?? result.provenance.headSha) !== binding.expectedHeadSha
      || (binding.expectedHarnessSha && (result.provenance.harnessSha ?? result.provenance.harnessRevision) !== binding.expectedHarnessSha))
      throw new TestDispatchError(409, "Recorded result differs from the registered candidate, archive, routine or worker revision");
    return result;
  }));
  const claim = view.requestId ? await repository.claim(view.requestId) : null;
  const resolution = claim && claim.state !== "claimed" ? recoveredClaim(claim, results) : null;
  const verifiedRecovery = resolution && results.find(result => result.runId === resolution.recoveryRunId)?.outcomes.evidence === "complete"
    ? resolution : null;
  const recordedResults = results.map(result => ({ runId: result.runId, outcome: result.outcome, outcomes: result.outcomes,
    reportPath: `/?testRun=${result.runId}`, source: result.source ?? null, provenance: {
      headSha: binding.expectedHeadSha, archiveSha256: binding.archiveSha256,
      ...(binding.expectedHarnessSha ? { harnessSha: binding.expectedHarnessSha } : {}) },
    failureOccurrenceIds: (result.failureOccurrences ?? []).map(item => item.occurrenceId) }));
  return { results, claim, recordedResults, verifiedRecovery };
}
