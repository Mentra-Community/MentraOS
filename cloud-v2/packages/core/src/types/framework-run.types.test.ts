import {expect, test} from "bun:test";
import {frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunSchema} from "./framework-run.types";

function run() {
  return {schemaVersion: 1, hostId: "mini", requestId: "run-1", routineId: "no-glasses", definitionRevision: "a".repeat(40),
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
  expect(frameworkRunOutcome(evidenceFailure)).toBe("pass");
  expect(frameworkEvidenceComplete(evidenceFailure)).toBe(false);
});

 test("ready teardown cannot conceal an explicit teardown failure", () => {
  const good = run();
  expect(frameworkRunSchema.safeParse({...good, result: {...good.result,
    failures: [{phase: "teardown", actionId: "uninstall", message: "failed"}]}}).success).toBe(false);
 });

test("cleaned recorder diagnostics preserve evidence failure independently of hardware readiness", () => {
  const good = run();
  const cleaned = {state: "cleaned", resourceId: "recorder", evidence: [], errors: []};
  expect(frameworkRunSchema.parse({...good, result: {...good.result,
    teardown: {...good.result.teardown, outcomes: [cleaned]}}}).result.teardown.outcomes[0]).toEqual(cleaned);
  const error = {phase: "evidence", actionId: "finalize-recording", message: "Recorder report finalization failed"};
  const diagnostic = {...good, result: {...good.result, failures: [error],
    teardown: {...good.result.teardown, outcomes: [{...cleaned, errors: [error]}], errors: [error]}}};
  const preserved = frameworkRunSchema.parse(diagnostic);
  expect(preserved.result.teardown.outcomes[0]).toEqual({...cleaned, errors: [error]});
  expect(frameworkRunOutcome(preserved)).toBe("pass");
  expect(frameworkEvidenceComplete(preserved)).toBe(false);
  expect(frameworkRunSchema.safeParse({...diagnostic, result: {...diagnostic.result, failures: []}}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...diagnostic, result: {...diagnostic.result,
    teardown: {...diagnostic.result.teardown, errors: []}}}).success).toBe(false);
  const teardownError = {...error, phase: "teardown"};
  const failed = {...good, result: {...good.result, failures: [teardownError],
    teardown: {...good.result.teardown, outcomes: [{...cleaned, errors: [teardownError]}], errors: [teardownError]}}};
  expect(frameworkRunSchema.safeParse(failed).success).toBe(false);
  expect(frameworkRunOutcome(frameworkRunSchema.parse({...failed, result: {...failed.result,
    teardown: {...failed.result.teardown, ready: false}}}))).toBe("teardown-failed");
  expect(frameworkRunSchema.safeParse({...good, result: {...good.result,
    teardown: {...good.result.teardown, outcomes: [{...cleaned, errors: [{...error, phase: "arbitrary"}]}]}}}).success).toBe(false);
});
