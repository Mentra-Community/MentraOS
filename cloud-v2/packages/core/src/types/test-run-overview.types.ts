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
export interface OverviewJob {
  id: string;
  kind: "routine" | "nightly" | "maintenance" | "claim";
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
}
export interface TestRunOverview {
  observedAt: string;
  jobs: OverviewJob[];
  warnings: string[];
  recentMaintenance: OverviewJob[];
  resolvedRecoveries: { requestId: string; originalRunId: string; recoveryRunId: string; fixtureId: string }[];
}
