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
export interface OverviewAttention {
  reason: string;
  responsible: "Test runner / operator" | "GitHub / runner operator";
  nextAction: string;
  cancelRequestId?: string;
  cancelledAt?: string;
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
 * Uses only claims and results already read for this overview. It never certifies
 * present readiness or changes an attempt's verdict.
 */
export interface OverviewFixtureSummary {
  workerId: string;
  fixtureId: string;
  /** Cancelled attempts without their own verified return, newest first (full history is in `fixtureAttention`). */
  cancelledRequestIds: string[];
  latestCancelledClaimAt: string;
  /**
   * `current-work`: a newer claim on this worker/fixture is in `jobs`.
   * `later-return-verified`: a newer claim on this worker/fixture published verified return evidence.
   * `unverified`: this view has no newer evidence; the fixture's present state is not proven here.
   */
  status: "current-work" | "later-return-verified" | "unverified";
  currentRequestIds?: string[];
  laterReturn?: { requestId: string; claimedAt: string; recoveryRunId: string };
}
export interface TestRunOverview {
  observedAt: string;
  jobs: OverviewJob[];
  warnings: string[];
  recentMaintenance: OverviewJob[];
  resolvedRecoveries: OverviewResolution[];
  /** Every cancelled attempt whose own return is unverified. Historical; not running jobs. */
  fixtureAttention?: OverviewJob[];
  fixtureSummary?: OverviewFixtureSummary[];
}
