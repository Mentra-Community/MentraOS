import type {FrameworkRun} from "../types/framework-run.types";
import {frameworkRunOutcome} from "../types/framework-run.types";
import type {TestRun} from "../types/test-run.types";

/** Display projection only. The accepted framework payload and its digest remain unchanged. */
export function frameworkRunView(run: FrameworkRun): TestRun {
  const build = run.build && typeof run.build === "object" && !Array.isArray(run.build)
    ? run.build as Record<string, unknown> : {};
  const provenance = Object.fromEntries(Object.entries(build).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const status = frameworkRunOutcome(run);
  const outcome = status === "pass" ? "passed" : status === "cancelled" ? "aborted" : "failed";
  return {
    runId: run.result.runId, requestId: run.requestId, routineId: run.routineId,
    routineVersion: run.definitionRevision, platform: run.platform === "ios-on-mac" ? "ios-mac" : "android",
    channel: ["dev", "staging", "pr", "local"].includes(String(build.channel)) ? build.channel as TestRun["channel"] : "local",
    ...(typeof build.prNumber === "number" ? {prNumber: build.prNumber} : {}),
    startedAt: run.startedAt, finishedAt: run.finishedAt, outcome,
    phaseDurationsMs: {setup: run.result.timing.setupMs, teardown: run.result.timing.teardownMs},
    outcomes: {test: run.result.test === "cancelled" ? "not-run" : run.result.test,
      teardown: run.result.teardown.ready ? "passed" : "failed",
      fixture: run.result.teardown.ready ? "ready" : "unavailable", evidence: "complete"},
    provenance: {repository: typeof build.repository === "string" ? build.repository : "Mentra-Community/MentraOS", ...provenance},
    fixture: {alias: run.laneId}, firmwareAssertions: [],
    chapters: run.result.steps.map(step => ({id: step.id, instruction: step.id, status: step.status, phase: "test"})),
    assets: run.assets.map(asset => ({assetId: asset.id,
      kind: asset.kind === "recording" ? "video" : asset.kind === "screenshot" ? "screenshot" : "log",
      contentType: asset.mimeType, filename: asset.path.split("/").at(-1)!, sizeBytes: asset.size, sha256: asset.sha256})),
    notes: run.result.failures.map(failure => `${failure.phase}/${failure.actionId}: ${failure.message}`).join("\n"),
  };
}
