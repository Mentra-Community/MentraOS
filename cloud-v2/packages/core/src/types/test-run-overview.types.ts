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
export interface TestRunOverview {
  observedAt: string;
  jobs: OverviewJob[];
  warnings: string[];
  recentMaintenance: OverviewJob[];
  resolvedRecoveries: OverviewResolution[];
  fixtureAttention?: OverviewJob[];
}
