import { TestRunClaimModel } from "../models/test-run-claim.model";
import type { TestRunClaim, TestRunProgressCheckpoint } from "../types/test-run-claim.types";
import type { TestRunFollowUpCancellation } from "../types/test-run-overview.types";
import { testRunIdSchema } from "../types/test-run.types";
import { GithubTestRunOverview, type TestRunOverviewGateway } from "./test-run-overview.github";

export class TestRunFollowUpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
}
export interface FollowUpRecord {
  claim: TestRunClaim;
  progress?: TestRunProgressCheckpoint;
  followUpCancellation?: TestRunFollowUpCancellation;
}
export interface TestRunFollowUpRepository {
  get(requestId: string): Promise<FollowUpRecord | null>;
  cancel(before: FollowUpRecord, cancellation: TestRunFollowUpCancellation): Promise<FollowUpRecord | null>;
}
export class MongoTestRunFollowUpRepository implements TestRunFollowUpRepository {
  async get(requestId: string) {
    return await TestRunClaimModel.findOne({ requestId }).select({ claim: 1, progress: 1, followUpCancellation: 1 })
      .read("primary").readConcern("majority").lean() as FollowUpRecord | null;
  }
  async cancel(before: FollowUpRecord, cancellation: TestRunFollowUpCancellation) {
    // A concurrent worker checkpoint/settlement requires a fresh activity check.
    // Never modify the claim, token, checkpoint, fixture lease, or recorded result.
    return await TestRunClaimModel.findOneAndUpdate({ requestId: before.claim.requestId, claim: before.claim,
      progress: before.progress ?? { $exists: false }, followUpCancellation: { $exists: false },
    }, { $set: { followUpCancellation: cancellation } }, { new: true, writeConcern: { w: "majority", j: true, wtimeout: 10_000 } })
      .select({ claim: 1, progress: 1, followUpCancellation: 1 }).lean() as FollowUpRecord | null;
  }
}

/** Closes abandoned follow-up work; it neither stops a job nor certifies a fixture. */
export class TestRunFollowUpService {
  constructor(private readonly repository: TestRunFollowUpRepository = new MongoTestRunFollowUpRepository(),
    private readonly github: TestRunOverviewGateway = new GithubTestRunOverview(), private readonly now = () => new Date()) {}
  async cancel(id: string, actor: string) {
    if (!testRunIdSchema.safeParse(id).success) throw new TestRunFollowUpError(400, "invalid request ID");
    if (!actor || actor.length > 240) throw new TestRunFollowUpError(403, "authenticated admin identity required");
    const before = await this.repository.get(id);
    if (!before) throw new TestRunFollowUpError(404, "claim not found");
    if (before.followUpCancellation) return before.followUpCancellation;
    let activity;
    try { activity = await this.github.activity({ fresh: true }); }
    catch { throw new TestRunFollowUpError(503, "GitHub activity could not be verified; follow-up remains open"); }
    if (activity.warnings.length || activity.jobs.some(job => job.kind === "routine" && job.requests.length !== 1
      || job.kind === "nightly" && job.requests.length !== 2))
      throw new TestRunFollowUpError(503, "GitHub activity is incomplete; follow-up remains open");
    if (activity.jobs.some(job => job.requests.some(request => request.requestId === id)))
      throw new TestRunFollowUpError(409, "This request still has an active or queued GitHub job. Let it finish before cancelling follow-up.");
    const cancellation = { cancelledAt: this.now().toISOString(), cancelledBy: actor };
    const result = await this.repository.cancel(before, cancellation);
    if (!result?.followUpCancellation) {
      const current = await this.repository.get(id);
      if (current?.followUpCancellation) return current.followUpCancellation;
      throw new TestRunFollowUpError(409, "Worker state changed; refresh activity before cancelling follow-up");
    }
    return result.followUpCancellation;
  }
}
