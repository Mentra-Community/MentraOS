import { readTestRunLink, type TestRunListScope } from "../lib/test-run-links";

export type RunOutcome = "passed" | "failed" | "blocked" | "aborted";
export type CheckOutcome = "passed" | "failed" | "blocked" | "not-run";
export type RunChannel = "pr" | "dev" | "staging" | "local";
export type RunPlatform = "ios-mac" | "ios" | "android";
export type FirmwareCheckPhase =
  | "preflight"
  | "setup"
  | "test"
  | "final-assertions"
  | "teardown"
  | "return-verification"
  | "evidence";
export const FIRMWARE_PHASE_LABELS: Record<FirmwareCheckPhase, string> = {
  "preflight": "Preflight",
  "setup": "Setup",
  "test": "Test",
  "final-assertions": "Final test checks",
  "teardown": "Teardown",
  "return-verification": "Return verification",
  "evidence": "Evidence",
};

export interface TestRunSummary {
  runId: string;
  requestId: string;
  routineId: string;
  routineVersion: string;
  platform: RunPlatform;
  channel: RunChannel;
  prNumber?: number;
  release?: string;
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  outcomes: {
    test: CheckOutcome;
    teardown: CheckOutcome;
    fixture: "ready" | "unavailable" | "unknown";
    evidence: "complete" | "incomplete";
  };
  provenance: {
    repository: string;
    headSha?: string;
    baseSha?: string;
    buildSha?: string;
    harnessSha?: string;
    manifestSha256?: string;
    producerUrl?: string;
    [key: string]: string | undefined;
  };
  fixture: { alias: string };
}

export interface TestRunAsset {
  assetId: string;
  kind: "video" | "screenshot" | "log" | "metadata";
  contentType: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  uploaded: boolean;
}

export interface TestRunChapter {
  id: string;
  instruction: string;
  expected?: string;
  status: CheckOutcome;
  phase: "setup" | "test" | "verify" | "teardown";
  videoAssetId?: string;
  videoStart?: number;
  videoEnd?: number;
  screenshotAssetId?: string;
}

export interface TestRunDetail extends TestRunSummary {
  chapters: TestRunChapter[];
  assets: TestRunAsset[];
  firmwareAssertions: {
    component: string;
    expected: unknown;
    actual: unknown;
    status: CheckOutcome;
    phase?: FirmwareCheckPhase;
  }[];
  notes?: string;
}

export interface TestRunFilters {
  pr: string;
  channel: string;
  outcome: string;
  routineId: string;
  platform: string;
  fixtureAlias: string;
  startedAfter: string;
  startedBefore: string;
}

export const EMPTY_FILTERS: TestRunFilters = {
  pr: "",
  channel: "",
  outcome: "",
  routineId: "",
  platform: "",
  fixtureAlias: "",
  startedAfter: "",
  startedBefore: "",
};

export function testRunListPath(filters: TestRunFilters, cursor?: string, scope?: TestRunListScope | null) {
  if (!scope && filters.pr && !/^[1-9]\d*$/.test(filters.pr)) throw new Error("Enter a positive PR number.");
  const query = new URLSearchParams({ limit: "25" });
  for (const [key, value] of Object.entries(filters))
    if (value.trim()) {
      if (key === "startedAfter" || key === "startedBefore") {
        const parsed = new Date(`${value}T${key === "startedAfter" ? "00:00:00.000" : "23:59:59.999"}`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          Number.isNaN(parsed.getTime()) ||
          `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}` !==
            value
        )
          throw new Error("Choose valid dates for the run range.");
        query.set(key, parsed.toISOString());
      } else query.set(key, value.trim());
    }
  if (filters.startedAfter && filters.startedBefore && filters.startedAfter > filters.startedBefore)
    throw new Error("The start date must not follow the end date.");
  if (scope) {
    query.delete("pr");
    for (const [key, value] of Object.entries(scope)) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  return `/api/admin/test-runs?${query}`;
}

export function initialChapter(chapters: TestRunChapter[], requested?: string) {
  return (
    chapters.find((chapter) => chapter.id === requested) ??
    chapters.find((chapter) => chapter.status === "failed" || chapter.status === "blocked") ??
    chapters[0]
  );
}

/** Validate a chapter against the selected, uploaded recording and its actual metadata. */
export function chapterSeekTime(chapter: TestRunChapter, asset: TestRunAsset, duration: number): number | null {
  if (
    asset.kind !== "video" ||
    !asset.uploaded ||
    chapter.videoAssetId !== asset.assetId ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    typeof chapter.videoStart !== "number" ||
    !Number.isFinite(chapter.videoStart) ||
    chapter.videoStart < 0 ||
    chapter.videoStart > duration ||
    (chapter.videoEnd !== undefined &&
      (!Number.isFinite(chapter.videoEnd) ||
        chapter.videoEnd < chapter.videoStart ||
        chapter.videoEnd > duration + 0.25))
  )
    return null;
  return chapter.videoStart;
}

export function safeProducerUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export interface RelatedRun {
  kind: "recovery" | "source";
  runId: string;
}

const DIGEST = /^[a-f0-9]{64}$/;

function safeRelatedRunId(value: string | undefined, runId: string) {
  return typeof value === "string" && value !== runId
    ? readTestRunLink(new URLSearchParams({ testRun: value }).toString())?.runID ?? null
    : null;
}

/**
 * The run this result links back to. It is a recovery only when a registered,
 * consumed CI result declares an appended lifecycle generation with its original
 * and current terminal snapshot digests, the lineage Core accepts for recovery.
 * Optional previous-result and amendment metadata, and the recovery's own
 * outcome, do not decide the label. Any other safe, distinct original run ID
 * (development exports, legacy results) stays a neutral source link. Run ID
 * prefixes are never used as evidence.
 */
export function relatedRun(run: Pick<TestRunDetail, "runId" | "provenance">): RelatedRun | null {
  const provenance = run.provenance;
  const runId = safeRelatedRunId(provenance.originalRunId, run.runId);
  if (!runId) return null;
  const generation = Number(provenance.resultGeneration);
  const recovery =
    provenance.executionMode === "ci-registered" &&
    provenance.requestRelationship === "consumed" &&
    /^[1-9]\d*$/.test(provenance.resultGeneration ?? "") &&
    Number.isSafeInteger(generation) &&
    generation > 1 &&
    DIGEST.test(provenance.terminalSnapshotSha256 ?? "") &&
    DIGEST.test(provenance.originalTerminalSnapshotSha256 ?? "");
  return { kind: recovery ? "recovery" : "source", runId };
}

/**
 * Elapsed time between a run's recorded start and finish. Returns null when either
 * timestamp is missing or malformed, or when the finish precedes the start, so the
 * UI never shows an estimated or fabricated duration.
 */
export function runDuration(startedAt: unknown, finishedAt: unknown): string | null {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms === 0) return "0s";
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function valueText(value: unknown): string {
  return value === undefined || value === null
    ? "Not recorded"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
}
