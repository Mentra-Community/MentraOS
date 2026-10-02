import {expect, test} from "bun:test";
import {frameworkRunOutcome, frameworkRunSchema} from "./framework-run.types";

function run() {
  return {schemaVersion: 1, requestId: "run-1", routineId: "no-glasses", definitionRevision: "a".repeat(40),
    platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:02:00Z", assets: [],
    result: {runId: "run-1", finishedAt: "2026-10-02T19:02:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "settings", status: "passed", durationMs: 1000}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 1000, testMs: 1000, teardownMs: 1000}}};
}

test("framework outcomes preserve first failure independently of teardown", () => {
  const good = frameworkRunSchema.parse(run());
  expect(frameworkRunOutcome(good)).toBe("pass");
  const failed = {...good, result: {...good.result, test: "failed" as const,
    teardown: {...good.result.teardown, ready: false}}};
  expect(frameworkRunOutcome(failed)).toBe("failed");
  expect(frameworkRunOutcome({...failed, result: {...failed.result, setup: {status: "failed"}}})).toBe("setup-failed");
});

test("contradictory steps, foreign recording and unsafe asset paths cannot be published", () => {
  const good = run();
  expect(frameworkRunSchema.safeParse(good).success).toBe(true);
  expect(frameworkRunSchema.safeParse({...good, result: {...good.result,
    steps: [{id: "settings", status: "failed", durationMs: 1}]}}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...good, recordingAssetId: "missing"}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...good, assets: [{id: "log", kind: "diagnostic", path: "../log", size: 10,
    sha256: "a".repeat(64), mimeType: "text/plain"}]}).success).toBe(false);
});

 test("export finish time and recording purpose must match frozen evidence", () => {
  const good = run();
  expect(frameworkRunSchema.safeParse(good).success).toBe(true);
  const asset = {id: "capture", kind: "recording", path: "capture.mp4", size: 20,
    sha256: "a".repeat(64), mimeType: "video/mp4"};
  expect(frameworkRunSchema.safeParse({...good, assets: [asset], recordingAssetId: "capture"}).success).toBe(true);
  expect(frameworkRunSchema.safeParse({...good, assets: [{...asset, kind: "diagnostic"}], recordingAssetId: "capture"}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...good, result: {...good.result, finishedAt: "2026-10-02T19:03:00Z"}}).success).toBe(false);
});

test("empty steps and recorded failures cannot qualify a passing test", () => {
  const good = run();
  expect(frameworkRunSchema.safeParse(good).success).toBe(true);
  expect(frameworkRunSchema.safeParse({...good, result: {...good.result, steps: []}}).success).toBe(false);
  const evidenceFailure = frameworkRunSchema.parse({...good, result: {...good.result, failures: [{phase: "evidence", actionId: "recording", message: "missing"}]}});
  expect(frameworkRunOutcome(evidenceFailure)).toBe("evidence-failed");
});
