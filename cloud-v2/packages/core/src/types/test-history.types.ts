import type {FrameworkBinding, RoutineSourceRef} from './framework-version.types';
import type {FrameworkRun, frameworkRunOutcome} from "./framework-run.types";
import type {TestSuite} from "./test-suite.types";
import type {RoutineCardDefinition} from './routine-definition.types';

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
  /** Missing provenance belongs to an immutable historical record; never a guessed installed identity. */
  routineSource?: RoutineSourceRef; frameworkBinding?: FrameworkBinding;
  stepCounts?: {passed: number; total: number; skipped: number};
  runId: string; requestId: string; hostId: string; routineId: string; platform: string; laneId: string;
  startedAt: string; finishedAt: string; outcome: ReturnType<typeof frameworkRunOutcome>; uploadsComplete: boolean; evidenceStatus: "complete" | "failed";
  build: Pick<FrameworkRun["build"], "repository" | "channel" | "headSha" | "prNumber"> & {release?: string; producerUrl?: string};
}
export type RoutineCatalogCard = RoutineCardDefinition & {
  example: CatalogExample | null; latestAttempt: CatalogHistoryRun | null; nightlyEnabled: boolean;
};
export interface FrameworkRunPage {runs: FrameworkRunSummary[]; nextCursor: string | null}
export type TestHistoryEntry = ({kind: "run"; rerun?: {rerunId: string; parentSuiteId?: string}} & FrameworkRunSummary) | {
  kind: "suite"; suiteId: string; channel: TestSuite["channel"]; trigger: TestSuite["trigger"];
  startedAt: string; finishedAt?: string; outcome: string; expectedCount: number; passed: number; skipped?: number; build: TestSuite["build"] & {repository?: string; prNumber?: number};
  /** Accepted child rerun jobs, independent of the current history page and member count. */
  rerunCount: number; failedCount: number; lanes: {hostId: string; laneId: string}[];
  members?: (Pick<TestSuite["members"][number], "routineId" | "platform"> & {laneId?: string; hostId?: string})[];
} | {kind: "unavailable"; sourceKind: "run" | "suite"; id: string; startedAt: string; message: "Details unavailable."};
export interface TestHistoryPage {entries: TestHistoryEntry[]; nextCursor: string | null}
