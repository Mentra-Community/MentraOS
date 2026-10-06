import type {FrameworkRun, frameworkRunOutcome} from "./framework-run.types";
import type {TestSuite} from "./test-suite.types";

/** Dependency-light DTOs shared by the Core run/catalog APIs and Admin client. */
export interface CatalogExample {
  runId: string; startedAt: string; finishedAt: string; recordingAssetId: string;
  definitionRevision: string; build: FrameworkRun["build"];
}
export interface CatalogHistoryRun {
  runId: string; startedAt: string; outcome: string; uploadsComplete: boolean;
  evidenceStatus: "complete" | "failed"; definitionRevision: string;
}
export interface FrameworkRunSummary {
  stepCounts?: {passed: number; total: number; skipped: number};
  runId: string; requestId: string; hostId: string; routineId: string; platform: string; laneId: string;
  startedAt: string; finishedAt: string; outcome: ReturnType<typeof frameworkRunOutcome>; uploadsComplete: boolean; evidenceStatus: "complete" | "failed";
  build: Pick<FrameworkRun["build"], "repository" | "channel" | "headSha" | "prNumber"> & {release?: string; producerUrl?: string};
}
export interface FrameworkRunPage {runs: FrameworkRunSummary[]; nextCursor: string | null}
export type TestHistoryEntry = ({kind: "run"} & FrameworkRunSummary) | {
  kind: "suite"; suiteId: string; channel: TestSuite["channel"]; trigger: TestSuite["trigger"];
  startedAt: string; finishedAt?: string; outcome: string; expectedCount: number; passed: number; skipped?: number; build: TestSuite["build"];
  members?: Pick<TestSuite["members"][number], "routineId" | "platform">[];
} | {kind: "unavailable"; sourceKind: "run" | "suite"; id: string; startedAt: string; message: "Details unavailable."};
export interface TestHistoryPage {entries: TestHistoryEntry[]; nextCursor: string | null}
