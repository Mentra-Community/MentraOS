import {expect, test} from "bun:test";
import {frameworkAssetIdSchema, frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunSchema} from "./framework-run.types";

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
  const cleaned = {state: "cleaned" as const, resourceId: "recorder", evidence: [], errors: []};
  expect(frameworkRunSchema.parse({...good, result: {...good.result,
    teardown: {...good.result.teardown, outcomes: [cleaned]}}}).result.teardown.outcomes[0]).toEqual(cleaned);
  const error = {phase: "evidence" as const, actionId: "finalize-recording", message: "Recorder report finalization failed"};
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

test("teardown evidence errors cannot disappear from run failures when outcome errors are absent or empty", () => {
  const good = run();
  const error = {phase: "evidence" as const, actionId: "finalize-recording", message: "Recording finalization failed"};
  for (const cleaned of [
    {state: "cleaned" as const, resourceId: "recorder", evidence: []},
    {state: "cleaned" as const, resourceId: "recorder", evidence: [], errors: []},
  ]) {
    const diagnostic = {...good, result: {...good.result,
      teardown: {...good.result.teardown, outcomes: [cleaned], errors: [error]}}};
    expect(frameworkRunSchema.safeParse(diagnostic).success).toBe(false);
    const preserved = frameworkRunSchema.parse({...diagnostic, result: {...diagnostic.result, failures: [error]}});
    expect(frameworkRunOutcome(preserved)).toBe("pass");
    expect(frameworkEvidenceComplete(preserved)).toBe(false);
    expect(preserved.result.teardown.outcomes[0]).toEqual(cleaned);
  }
});

test("lifecycle actions preserve old results and reject duplicate identities, invalid timing and recording locations", () => {
  const old = run();
  const legacy = frameworkRunSchema.parse(old);
  expect(legacy.result.setup).not.toHaveProperty("actions");
  expect(legacy.result.teardown).not.toHaveProperty("actions");
  const action = {id: "shared:install", instruction: "Install the selected Mentra App", expected: "The selected build is installed",
    scope: "shared" as const, status: "passed" as const, durationMs: 10, startedAt: old.startedAt, finishedAt: "2026-10-02T19:00:01Z"};
  const withSetup = (actions: unknown[]) => ({...old, result: {...old.result, setup: {...old.result.setup, actions}}});
  expect(frameworkRunSchema.parse(withSetup([action])).result.setup.actions).toEqual([action]);
  for (const actions of [
    [action, action], [{...action, id: ""}], [{...action, durationMs: -1}], [{...action, status: "unknown"}],
    [{...action, startedAt: "2026-10-02T18:59:59Z"}], [{...action, finishedAt: "2026-10-02T19:02:01Z"}],
    [{...action, startedAt: "2026-10-02T19:00:02Z"}], [{...action, startedAt: undefined}],
    [{...action, recordingLocation: {assetId: "capture", startOffsetMs: 0}}], Array(1001).fill(action),
    [{...action, status: "not-run", durationMs: 0}],
  ]) expect(frameworkRunSchema.safeParse(withSetup(actions)).success).toBe(false);
  const skipped = {...action, status: "not-run", durationMs: 0, startedAt: undefined, finishedAt: undefined, causedBy: "shared:entry"};
  expect(frameworkRunSchema.safeParse({...old, result: {...old.result, setup: {status: "failed", actions: [skipped]},
    test: "not-run", steps: [{id: "settings", status: "not-run", durationMs: 0}]}}).success).toBe(true);
});

test("passed setup cannot conceal failed, cancelled or unexecuted shared setup actions", () => {
  const old = run();
  const action = {id: "shared:install", instruction: "Install the selected Mentra App", expected: "The selected build is installed",
    scope: "shared" as const, status: "passed" as const, durationMs: 10};
  expect(frameworkRunSchema.safeParse({...old, result: {...old.result, setup: {...old.result.setup, actions: [action]}}}).success).toBe(true);
  for (const status of ["failed", "cancelled", "not-run"] as const) {
    const changed = {...action, status, durationMs: status === "not-run" ? 0 : 10};
    expect(frameworkRunSchema.safeParse({...old, result: {...old.result,
      setup: {...old.result.setup, actions: [changed]}}}).success).toBe(false);
  }
});

test("routine lifecycle failures cannot hide behind aggregate pass while shared evidence failures remain independent", () => {
  const old = run();
  const action = {id: "notes-fixture", instruction: "Create the fixture note", expected: "The fixture note is saved",
    scope: "routine" as const, status: "passed" as const, durationMs: 10};
  const good = {...old, result: {...old.result, setup: {...old.result.setup, actions: [action]},
    teardown: {...old.result.teardown, actions: [{...action, id: "remove-fixture"}]}}};
  expect(frameworkRunOutcome(frameworkRunSchema.parse(good))).toBe("pass");
  for (const status of ["failed", "cancelled", "not-run"] as const) {
    const changed = {...action, status, durationMs: status === "not-run" ? 0 : 10};
    expect(frameworkRunSchema.safeParse({...good, result: {...good.result, setup: {...good.result.setup, actions: [changed]}}}).success).toBe(false);
    expect(frameworkRunSchema.safeParse({...good, result: {...good.result, teardown: {...good.result.teardown, actions: [changed]}}}).success).toBe(false);
    const setupFailure = {...good, result: {...good.result, setup: {status: "failed", actions: [changed]}, test: "not-run",
      steps: [{id: "settings", status: "not-run", durationMs: 0}]}};
    expect(frameworkRunOutcome(frameworkRunSchema.parse(setupFailure))).toBe("setup-failed");
    expect(frameworkRunOutcome(frameworkRunSchema.parse({...good, result: {...good.result,
      teardown: {...good.result.teardown, ready: false, actions: [changed]}}}))).toBe("teardown-failed");
  }
  const evidenceError = {phase: "evidence" as const, actionId: "finalize-recording", message: "Recording finalization failed"};
  const sharedEvidence = {...good, result: {...good.result, failures: [evidenceError], teardown: {...good.result.teardown,
    actions: [{...action, id: "cleanup:recorder", scope: "shared", status: "failed"}], errors: [evidenceError],
    outcomes: [{state: "cleaned", resourceId: "recorder", evidence: [], errors: [evidenceError]}]}}};
  const preserved = frameworkRunSchema.parse(sharedEvidence);
  expect(frameworkRunOutcome(preserved)).toBe("pass");
  expect(frameworkEvidenceComplete(preserved)).toBe(false);
  for (const status of ["failed", "cancelled"] as const) {
    const skipped = {...action, status: "not-run", durationMs: 0};
    const setupStopped = {...good, result: {...good.result, setup: {status, actions: [skipped]}, test: "not-run",
      steps: [{id: "settings", status: "not-run", durationMs: 0}], teardown: {...good.result.teardown, actions: [skipped]}}};
    expect(frameworkRunSchema.safeParse(setupStopped).success).toBe(true);
    expect(frameworkRunSchema.safeParse({...setupStopped, result: {...setupStopped.result,
      teardown: {...setupStopped.result.teardown, actions: [{...skipped, status: "failed"}]}}}).success).toBe(false);
  }
});

test("failed shared teardown actions require their own outcome diagnostics and cannot conceal cleanup failure", () => {
  const old = run();
  const action = {id: "cleanup:app", instruction: "Uninstall the selected Mentra App", expected: "The app and test data are absent",
    scope: "shared" as const, status: "failed" as const, durationMs: 10};
  const error = {phase: "teardown" as const, actionId: "app", message: "App removal failed"};
  const report = {...old, result: {...old.result, teardown: {...old.result.teardown, actions: [action]}}};
  expect(frameworkRunSchema.safeParse(report).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...report, result: {...report.result,
    teardown: {...report.result.teardown, ready: false}}}).success).toBe(false);
  const diagnosed = {...report, result: {...report.result, failures: [error], teardown: {...report.result.teardown,
    ready: false, errors: [error], outcomes: [{state: "failed", resourceId: "app", failure: error}]}}};
  expect(frameworkRunOutcome(frameworkRunSchema.parse(diagnosed))).toBe("teardown-failed");
  expect(frameworkRunSchema.safeParse({...diagnosed, result: {...diagnosed.result,
    teardown: {...diagnosed.result.teardown, ready: true}}}).success).toBe(false);
  for (const invalid of [
    {...diagnosed, result: {...diagnosed.result, failures: []}},
    {...diagnosed, result: {...diagnosed.result, teardown: {...diagnosed.result.teardown, errors: []}}},
    {...diagnosed, result: {...diagnosed.result, teardown: {...diagnosed.result.teardown,
      outcomes: [{state: "failed", resourceId: "other-app", failure: error}]}}},
  ]) expect(frameworkRunSchema.safeParse(invalid).success).toBe(false);
  const active = {...report, result: {...report.result, teardown: {...report.result.teardown, ready: false,
    outcomes: [{state: "still-active", resourceId: "app", writer: {pid: 12}, evidence: []}],
    unavailableResources: [{resource: "app", cause: "Owned app process is still active", nextAction: "Inspect the recorded app process"}]}}};
  expect(frameworkRunOutcome(frameworkRunSchema.parse(active))).toBe("teardown-failed");
});

test("ready shared cleanup failures are allowed only for flattened evidence diagnostics on the matching cleaned resource", () => {
  const old = run();
  const action = {id: "cleanup:recorder", instruction: "Stop and finalize the original recording", expected: "The recorder is settled",
    scope: "shared" as const, status: "failed" as const, durationMs: 10};
  const error = {phase: "evidence" as const, actionId: "finalize-recording", message: "Report finalization failed"};
  const report = {...old, result: {...old.result, failures: [error], teardown: {...old.result.teardown,
    actions: [action], errors: [error], outcomes: [{state: "cleaned", resourceId: "recorder", evidence: [], errors: [error]}]}}};
  const preserved = frameworkRunSchema.parse(report);
  expect(frameworkRunOutcome(preserved)).toBe("pass");
  expect(frameworkEvidenceComplete(preserved)).toBe(false);
  for (const invalid of [
    {...report, result: {...report.result, failures: []}},
    {...report, result: {...report.result, teardown: {...report.result.teardown, errors: []}}},
    {...report, result: {...report.result, teardown: {...report.result.teardown, outcomes: []}}},
    {...report, result: {...report.result, teardown: {...report.result.teardown,
      outcomes: [{state: "cleaned", resourceId: "recorder", evidence: [], errors: []}]}}},
    {...report, result: {...report.result, teardown: {...report.result.teardown,
      outcomes: [{state: "cleaned", resourceId: "different-recorder", evidence: [], errors: [error]}]}}},
  ]) expect(frameworkRunSchema.safeParse(invalid).success).toBe(false);
  for (const status of ["cancelled", "not-run"] as const) {
    const changed = {...report, result: {...report.result, teardown: {...report.result.teardown,
      actions: [{...action, status, durationMs: status === "not-run" ? 0 : 10}]}}};
    expect(frameworkRunSchema.safeParse(changed).success).toBe(false);
    expect(frameworkRunSchema.safeParse({...changed, result: {...changed.result,
      teardown: {...changed.result.teardown, ready: false}}}).success).toBe(true);
  }
});


test("Android frozen exports preserve 373 asset identities including nested diagnostic journals", () => {
  const base = run();
  const rootIds = ["recording", "recording.json", "recorder-process.json", "framework-result.json", "recorder-readiness.json"];
  const ids = [...rootIds, ...Array.from({length: 368}, (_, index) =>
    `setup-evidence/mentra-live-command-result-${index}.json`)];
  const frozen = {...base, platform: "android", recordingAssetId: "recording", assets: ids.map(id => ({id,
    kind: id === "recording" ? "recording" : "report", path: id === "recording" ? "routine.mp4" : id,
    sha256: "c".repeat(64), size: 20, mimeType: id === "recording" ? "video/mp4" : "application/json"})),
    result: {...base.result, evidence: ids, steps: ["home", "settings", "return-home"].map((id, index) =>
      ({id, status: "passed", durationMs: 1000, recordingLocation: {assetId: "recording", startOffsetMs: index * 1000, endOffsetMs: (index + 1) * 1000}}))}};
  const parsed = frameworkRunSchema.parse(frozen);
  expect(parsed.assets).toHaveLength(373);
  expect(parsed.assets.map(asset => asset.id)).toEqual(ids);
  expect(parsed.result.evidence).toEqual(ids);
  expect(frameworkRunSchema.safeParse({...frozen, requestId: "run/nested"}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...frozen, assets: frozen.assets.map((asset, index) =>
    index === 5 ? {...asset, path: "../outside.json"} : asset)}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...frozen, result: {...frozen.result, evidence: [...ids, "missing/asset"]}}).success).toBe(false);
});

test("asset identities allow bounded safe segments without entity or path grammar changes", () => {
  for (const id of ["recording", "asset:" + "a".repeat(64), "setup-evidence/commands/0.json", "a".repeat(500)])
    expect(frameworkAssetIdSchema.safeParse(id).success).toBe(true);
  for (const id of ["", ".", "..", "/root", "root/", "root//file", "root/./file", "root/../file",
    "root\\file", "root%2Ffile", "root?file", "root#file", "root\nfile", "a".repeat(501)])
    expect(frameworkAssetIdSchema.safeParse(id).success).toBe(false);
  const base = run(), assetId = "capture/video.mp4";
  expect(frameworkRunSchema.safeParse({...base, recordingAssetId: assetId, assets: [{id: assetId, kind: "recording",
    path: "video.mp4", size: 20, sha256: "c".repeat(64), mimeType: "video/mp4"}], result: {...base.result,
      evidence: [assetId], steps: [{id: "settings", status: "passed", durationMs: 1,
        recordingLocation: {assetId, startOffsetMs: 0, endOffsetMs: 1}}]}}).success).toBe(true);
});
