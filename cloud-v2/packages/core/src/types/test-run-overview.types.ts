import type { TestRunProgressCheckpoint } from "./test-run-claim.types";

export interface OverviewRequest {
  requestId: string;
  requestRunId: number;
  requestAttempt: number;
  routineId: string;
  platform?: "ios-on-mac" | "ios" | "android";
  trigger: "pr-label" | "successful-build" | "workflow-dispatch" | "nightly" | "admin" | "unknown";
  channel: "pr" | "dev" | "staging";
  prNumber?: number;
  release?: string;
  headSha?: string;
  buildRunId?: number;
  publicationAttempt?: number;
}
export interface OverviewClaim {
  requestId: string;
  workerId: string;
  fixtureId: string;
  claimedAt: string;
  progress?: TestRunProgressCheckpoint;
}
/** Cancels only outstanding follow-up. The original claim and physical ownership do not change. */
export interface TestRunFollowUpCancellation { cancelledAt: string; cancelledBy: string }
/**
 * What the latest uniquely correlated result recorded, from its reviewed metadata only.
 * History, not a diagnosis of the current recovery state. Text is bounded and plain.
 */
export interface OverviewRecordedFailure {
  resultRunId: string;
  /** The first failure the result lists; null when it published none. */
  failure: {
    phase: "preflight" | "setup" | "test" | "final-assertions" | "teardown" | "return-verification" | "evidence" | "unknown";
    step?: { id: string; label: string };
    message: string;
    expected?: string;
  } | null;
  /** The first failed (else blocked) authored chapter in that same phase, when one was recorded. */
  chapter?: { id: string; status: "failed" | "blocked"; instruction: string; expected?: string };
  /** The result declares that detailed failure information was not exported. */
  detailUnpublished: boolean;
}
export interface OverviewAttention {
  reason: string;
  responsible: "Test runner / operator" | "GitHub / runner operator";
  nextAction: string;
  cancelRequestId?: string;
  cancelledAt?: string;
  /** Original-owner closure time. The request is resolved; the fixture is not ready. */
  closedAt?: string;
  /** Recorded failure of the result behind this blocker, separate from `reason`. */
  recordedFailure?: OverviewRecordedFailure;
}
export interface OverviewJob {
  id: string;
  kind: "routine" | "nightly" | "maintenance" | "claim" | "fixture";
  state: "running" | "queued" | "waiting" | "blocked" | "unknown" | "finished";
  title: string;
  createdAt: string;
  startedAt?: string;
  workerName?: string;
  requests: OverviewRequest[];
  claims: OverviewClaim[];
  workflow?: { runId: number; url: string; status: string; conclusion?: string; step?: string; updatedAt: string };
  message?: string;
  resultRunId?: string;
  attention?: OverviewAttention;
}
export interface OverviewResolution {
  requestId: string;
  originalRunId: string;
  recoveryRunId: string;
  fixtureId: string;
  kind?: "late-result" | "recovery";
  originalAvailable?: boolean;
}
/**
 * One row per exact worker + fixture identity with cancelled, unverified attempts.
 * Decided only by the newest stored claim on that exact identity and that claim's
 * own results. It never changes an attempt's verdict, claim or cancellation.
 */
export interface OverviewFixtureSummary {
  workerId: string;
  fixtureId: string;
  /** Cancelled attempts without their own verified return, newest first (full history is in `fixtureAttention`). */
  cancelledRequestIds: string[];
  latestCancelledClaimAt: string;
  /**
   * `current-work`: the newest claim on this worker/fixture is unsettled or in `jobs`.
   * `latest-return-verified`: the newest claim settled and its own results prove verified
   *   return. This is the latest known routine return, not an observation of later activity.
   * `unverified`: the newest claim is a cancelled attempt, or its result failed, is missing or conflicts.
   * `not-checked`: the claim or result lookup failed or exceeded its bound; no older return is shown.
   */
  status: "current-work" | "latest-return-verified" | "unverified" | "not-checked";
  /** Newest claim on this worker/fixture after the newest cancelled attempt, when one exists. */
  latest?: { requestId: string; claimedAt: string; reason: string; resultRunId?: string };
}
export interface TestRunOverview {
  observedAt: string;
  jobs: OverviewJob[];
  warnings: string[];
  recentMaintenance: OverviewJob[];
  resolvedRecoveries: OverviewResolution[];
  /** Every cancelled attempt whose own return is unverified. Historical; not running jobs. */
  fixtureAttention?: OverviewJob[];
  /** One readiness summary per worker/fixture in `fixtureAttention`. */
  fixtureSummary: OverviewFixtureSummary[];
}
