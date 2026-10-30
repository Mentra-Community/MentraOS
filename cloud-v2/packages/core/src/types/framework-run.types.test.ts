import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {expect, test} from "bun:test";
import {FRAMEWORK_RUN_ASSET_LIMIT, frameworkAssetIdSchema, frameworkEvidenceComplete, frameworkRunOutcome, frameworkRunSchema} from "./framework-run.types";
import {lifecycleRuns} from '../testing/framework-lifecycle.fixture';

function run() {
  return {
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: "mini",
    requestId: "run-1",
    routineId: "no-glasses",
    definitionRevision: "a".repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-02T19:00:00Z",
    finishedAt: "2026-10-02T19:02:00Z",
    assets: [],
    result: {runId: "run-1", finishedAt: "2026-10-02T19:02:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "settings", status: "passed", durationMs: 1000}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 1000, testMs: 1000, teardownMs: 1000}},
  }
}

test('frozen Harness results preserve diagnostic actions and failed verdict independently of physical readiness', () => {
  for (const fixture of lifecycleRuns) {
    const parsed = frameworkRunSchema.parse(fixture.run);
    expect(parsed as unknown).toEqual(fixture.producedRun);
    expect(parsed.result.teardown.ready).toBe(true);
    expect(parsed.result.diagnostics?.every(action => action.scope === 'shared')).toBe(true);
    expect(parsed.result.timing.diagnosticsMs).toBeCloseTo(parsed.result.diagnostics!.reduce((total, action) => total + action.durationMs, 0), 5);
    expect(frameworkRunOutcome(parsed)).toBe(fixture.scenario === 'diagnostic-failure' ? 'failed' : 'teardown-failed');
    expect(frameworkEvidenceComplete(parsed)).toBe(fixture.scenario === 'routine-teardown');
  }
});

test('diagnostic contract rejects missing timing, malformed actions, unreported failures and unbounded metadata', () => {
  const base = lifecycleRuns.find(fixture => fixture.scenario === 'diagnostic-failure')!.run;
  const [action] = base.result.diagnostics!;
  for (const result of [
    {...base.result, diagnostics: undefined},
    {...base.result, timing: {...base.result.timing, diagnosticsMs: undefined}},
    {...base.result, timing: {...base.result.timing, diagnosticsMs: -1}},
    {...base.result, timing: {...base.result.timing, diagnosticsMs: base.result.timing.diagnosticsMs! + 1}},
    {...base.result, diagnostics: [...base.result.diagnostics!, action]},
    {...base.result, diagnostics: [{...action, durationMs: -1}]},
    {...base.result, diagnostics: [{...action, scope: 'routine'}]},
    {...base.result, diagnostics: [{...action, fixtureProvider: 'arbitrary'}]},
    {...base.result, diagnostics: [{...action, stage: 'resource-cleanup'}]},
    {...base.result, diagnostics: [{...action, status: 'failed'}], timing: {...base.result.timing, diagnosticsMs: action.durationMs}},
    {...base.result, failures: base.result.failures.filter(error => error.phase !== 'evidence')},
    {...base.result, failures: [{...base.result.failures[0]!, diagnostics: {raw: 'x'.repeat(65536)}}]},
  ]) expect(frameworkRunSchema.safeParse({...base, result}).success).toBe(false);
});

test('ready cleanup rejects failed/live outcomes and retains secondary errors for every outcome state', () => {
  const good = run(), primary = {phase: 'teardown' as const, actionId: 'app', message: 'Uninstall failed'},
    secondary = {phase: 'evidence' as const, actionId: 'app:screenshot', message: 'Screenshot unavailable', diagnostics: {attempt: 1}};
  for (const outcome of [
    {state: 'failed' as const, resourceId: 'app', failure: primary, errors: [secondary]},
    {state: 'still-active' as const, resourceId: 'app', writer: {pid: 1}, evidence: [], errors: [secondary]},
  ]) {
    const failures = outcome.state === 'failed' ? [primary, secondary] : [secondary];
    const result = {...good.result, failures, teardown: {...good.result.teardown, ready: false, outcomes: [outcome], errors: failures,
      unavailableResources: [{resource: 'app', cause: 'Owned state unresolved', nextAction: 'Read back original operation'}]}};
    expect(frameworkRunSchema.parse({...good, result}).result.teardown.outcomes[0]).toEqual(outcome);
    expect(frameworkRunSchema.safeParse({...good, result: {...result, teardown: {...result.teardown, ready: true}}}).success).toBe(false);
    const retained = frameworkRunSchema.parse({...good, result: {...result, failures: []}});
    expect(retained.result.teardown.outcomes[0]).toEqual(outcome);
    expect(frameworkRunOutcome(retained)).toBe('teardown-failed');
    expect(frameworkEvidenceComplete(retained)).toBe(false);
  }
});

test('cleaned resource return checklists publish unchanged without altering the frozen verdict', () => {
  const good = run();
  const outcomes = ['app', 'recorder'].map(resourceId => ({state: 'cleaned' as const, resourceId,
    evidence: [`return:${resourceId}`], idleCheck: {resourceId, contractVersion: 'idle-v1', ownerGeneration: 7,
      operationId: `idle-check:${resourceId}`, stage: 'after-teardown' as const, outcome: 'passed' as const,
      checkedAt: good.finishedAt, conditions: [{id: 'original-process-absent', outcome: 'passed' as const}],
      evidenceRefs: [`return:${resourceId}`], qualifiedScope: {kind: 'same-controller' as const, controllerId: good.hostId}}}));
  for (const testOutcome of ['passed', 'failed'] as const) {
    const error = {phase: 'test' as const, actionId: 'settings', message: 'Original product assertion failed'};
    const result = {...good.result, test: testOutcome,
      steps: [{...good.result.steps[0]!, status: testOutcome}],
      failures: testOutcome === 'failed' ? [error] : [], teardown: {...good.result.teardown, outcomes}};
    const published = frameworkRunSchema.parse({...good, result});
    expect(published.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(published)).toBe(testOutcome === 'passed' ? 'pass' : 'failed');
    expect(frameworkEvidenceComplete(published)).toBe(true);
  }
  expect(frameworkRunSchema.parse(good).result.teardown.outcomes).toEqual([]);
});

test('cleanup diagnostics evolve without changing typed outcomes or the frozen verdict', () => {
  const good = run();
  const error = {phase: 'teardown' as const, actionId: 'app', message: 'Original cleanup failed'};
  const diagnostics = {idleCheck: {conditions: [{id: 'app-absent', outcome: 'unknown', observed: {processes: []}}],
    futureDetails: {interpretation: null, measurements: [true, 1, 'private-observation']}},
    newDiagnostic: {verdict: 'pass', owner: {id: 'foreign', generation: 9000}}};
  for (const state of ['cleaned', 'still-active', 'failed'] as const) {
    const outcome = state === 'failed' ? {state, resourceId: 'app', failure: error, ...diagnostics}
      : state === 'still-active' ? {state, resourceId: 'app', writer: {pid: 1}, evidence: [], ...diagnostics}
        : {state, resourceId: 'app', evidence: [], ...diagnostics};
    const result = {...good.result, failures: state === 'failed' ? [error] : [],
      teardown: {...good.result.teardown, ready: state === 'cleaned', outcomes: [outcome],
        errors: state === 'failed' ? [error] : [], unavailableResources: state === 'cleaned' ? []
          : [{resource: 'app', cause: 'Original cleanup unresolved', nextAction: 'Inspect original process'}]}};
    const published = frameworkRunSchema.parse({...good, result});
    expect(published.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(published)).toBe(state === 'cleaned' ? 'pass' : 'teardown-failed');
  }
});

test('opaque cleanup observations cannot replace authoritative outcome fields or contain non-JSON data', () => {
  const good = run();
  const cleaned = {state: 'cleaned', resourceId: 'app', evidence: [], diagnostic: {settled: true}};
  const withOutcome = (outcome: unknown) => ({...good, result: {...good.result,
    teardown: {...good.result.teardown, outcomes: [outcome]}}});
  for (const malformed of [
    {...cleaned, state: 'ready'}, {...cleaned, resourceId: ''}, {...cleaned, evidence: [false]},
    {...cleaned, errors: [{phase: 'arbitrary', actionId: 'app', message: 'Invalid failure phase'}]},
    {...cleaned, diagnostic: {measurement: Infinity}}, {...cleaned, diagnostic: () => true},
    {state: 'still-active', resourceId: 'app', evidence: [], diagnostic: {writer: 'absent'}},
    {state: 'failed', resourceId: 'app', diagnostic: {failure: 'none'}},
  ]) expect(frameworkRunSchema.safeParse(withOutcome(malformed)).success).toBe(false);
});

test('cleanup failures preserve independently recorded diagnostic copies and outcome state', () => {
  const good = run();
  const details = {measurements: [{mask: 'screen', pixels: 7}], context: {attempt: 1, settled: true}};
  for (const diagnostics of [details, null, false, [1, 'two'], undefined]) {
    const error = {phase: 'teardown' as const, actionId: 'app', message: 'Cleanup observation failed',
      ...(diagnostics !== undefined ? {diagnostics} : {})};
    for (const state of ['cleaned', 'still-active', 'failed'] as const) {
      const outcome = state === 'failed' ? {state, resourceId: 'app', failure: error, errors: [error]}
        : state === 'still-active' ? {state, resourceId: 'app', writer: {pid: 1}, evidence: [], errors: [error]}
          : {state, resourceId: 'app', evidence: [], errors: [error]};
      const result = {...good.result, failures: [error], teardown: {ready: state === 'cleaned', outcomes: [outcome],
        errors: [error], unavailableResources: state === 'cleaned' ? [] : [{resource: 'app', cause: 'Unresolved', nextAction: 'Inspect owned writer'}]}};
      expect(frameworkRunSchema.safeParse({...good, result}).success).toBe(true);
      for (const changedDiagnostics of [undefined, null, {measurements: [{mask: 'screen', pixels: 8}]}]) {
        if (JSON.stringify(changedDiagnostics) === JSON.stringify(diagnostics)) continue;
        const {diagnostics: _removed, ...without} = error as typeof error & {diagnostics?: unknown};
        const changed = {...without, ...(changedDiagnostics !== undefined ? {diagnostics: changedDiagnostics} : {})};
        for (const changedResult of [{...result, failures: [changed]}, {...result, teardown: {...result.teardown, errors: [changed]}}]) {
          const retained = frameworkRunSchema.parse({...good, result: changedResult});
          expect(retained.result as unknown).toEqual(changedResult);
          expect(frameworkRunOutcome(retained)).toBe('teardown-failed');
        }
      }
      if (diagnostics === details) {
        const reordered = {...error, diagnostics: {context: {settled: true, attempt: 1}, measurements: [{pixels: 7, mask: 'screen'}]}};
        expect(frameworkRunSchema.safeParse({...good, result: {...result, failures: [reordered]}}).success).toBe(true);
      }
    }
  }
});

test('failed setup publishes decorated cleanup and readback diagnostics without rewriting their original copies', () => {
  const base = run();
  const original = {phase: 'teardown' as const, actionId: 'fixture', message: 'Cleanup profile unavailable'};
  const decorated = {...original, diagnostics: {desktopAssetIds: ['screenshots/cleanup.png']}};
  const readback = {phase: 'teardown' as const, actionId: 'fixture:readback', message: 'Original owner remains unresolved'};
  const result = {...base.result, setup: {status: 'failed', actionId: 'between-runs-cleanup'}, test: 'not-run',
    steps: [{id: 'settings', status: 'not-run', durationMs: 0, causedBy: 'between-runs-cleanup'}],
    teardown: {ready: false, actions: [{id: 'cleanup:fixture', instruction: 'Settle the original fixture',
      expected: 'The fixture returns idle', scope: 'shared', status: 'failed', durationMs: 10}],
      outcomes: [{state: 'failed', resourceId: 'fixture', failure: decorated}], errors: [decorated, readback],
      unavailableResources: [{resource: 'fixture', cause: 'Original cleanup failed', nextAction: 'Inspect the recorded original owner'}]},
    failures: [original, {phase: 'setup', actionId: 'between-runs-cleanup', message: 'Setup did not begin'}]};
  const parsed = frameworkRunSchema.parse({...base, result});
  expect(parsed.result as unknown).toEqual(result);
  expect(frameworkRunOutcome(parsed)).toBe('setup-failed');
  expect(parsed.result.teardown.ready).toBe(false);
  expect(frameworkRunSchema.safeParse({...base, result: {...result, teardown: {...result.teardown, ready: true}}}).success).toBe(false);
});

test('typed cleanup errors remain verdict-bearing without either flattened diagnostic copy', () => {
  const base = run();
  for (const phase of ['teardown', 'evidence'] as const) {
    const error = {phase, actionId: 'app', message: 'Original cleanup observation failed'};
    const result = {...base.result, teardown: {...base.result.teardown,
      outcomes: [{state: 'cleaned', resourceId: 'app', evidence: [], errors: [error]}]}};
    const parsed = frameworkRunSchema.parse({...base, result});
    expect(parsed.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(parsed)).toBe(phase === 'teardown' ? 'teardown-failed' : 'pass');
    expect(frameworkEvidenceComplete(parsed)).toBe(phase !== 'evidence');
    for (const forbiddenPhase of ['setup', 'test'] as const) {
      expect(frameworkRunSchema.safeParse({...base, result: {...result, teardown: {...result.teardown,
        outcomes: [{state: 'cleaned', resourceId: 'app', evidence: [], errors: [{...error, phase: forbiddenPhase}]}]}}}).success).toBe(false);
    }
  }
});

test("large manifests preserve all evidence and retain a bounded cardinality", () => {
  const good = run();
  const assets = Array.from({length: FRAMEWORK_RUN_ASSET_LIMIT}, (_, index) => ({id: `report:${index}`, kind: "report",
    path: `setup-evidence/report-${index}.json`, sha256: "a".repeat(64), size: 10, mimeType: "application/json"}));
  const full = {...good, assets, result: {...good.result, evidence: assets.map(asset => asset.id)}};
  expect(frameworkRunSchema.parse(full).assets).toHaveLength(FRAMEWORK_RUN_ASSET_LIMIT);
  const overflow = {...full, assets: [...assets, {...assets[0]!, id: "extra", path: "extra.json"}]};
  expect(frameworkRunSchema.safeParse(overflow).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...full, result: {...full.result, evidence: [...full.result.evidence, assets[0]!.id]}}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...full, assets: [{...assets[0]!, size: 128 * 1024 * 1024 + 1}, ...assets.slice(1)]}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...full, assets: [{...assets[0]!, sha256: "not-a-digest"}, ...assets.slice(1)]}).success).toBe(false);
});

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

test("physical readiness preserves explicit teardown failure and cannot turn its outcome into pass", () => {
  const good = run();
  const failed = frameworkRunSchema.parse({...good, result: {...good.result,
    failures: [{phase: "teardown", actionId: "uninstall", message: "failed"}]}});
  expect(failed.result.teardown.ready).toBe(true);
  expect(frameworkRunOutcome(failed)).toBe('teardown-failed');
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
  for (const result of [{...diagnostic.result, failures: []}, {...diagnostic.result, teardown: {...diagnostic.result.teardown, errors: []}}]) {
    const retained = frameworkRunSchema.parse({...diagnostic, result});
    expect(retained.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(retained)).toBe('pass');
    expect(frameworkEvidenceComplete(retained)).toBe(false);
  }
  const teardownError = {...error, phase: "teardown"};
  const failed = {...good, result: {...good.result, failures: [teardownError],
    teardown: {...good.result.teardown, outcomes: [{...cleaned, errors: [teardownError]}], errors: [teardownError]}}};
  expect(frameworkRunSchema.parse(failed).result.teardown.ready).toBe(true);
  expect(frameworkRunOutcome(frameworkRunSchema.parse(failed))).toBe('teardown-failed');
  expect(frameworkRunOutcome(frameworkRunSchema.parse({...failed, result: {...failed.result,
    teardown: {...failed.result.teardown, ready: false}}}))).toBe("teardown-failed");
  expect(frameworkRunSchema.safeParse({...good, result: {...good.result,
    teardown: {...good.result.teardown, outcomes: [{...cleaned, errors: [{...error, phase: "arbitrary"}]}]}}}).success).toBe(false);
});

test("routine fixture cleanup retains classified diagnostics independently of physical readiness", () => {
  const good = run();
  const action = {id: 'cleanup:fixture', instruction: 'Return the stream receiver', expected: 'The receiver is stopped',
    scope: 'routine' as const, fixtureProvider: 'stream-receivers', stage: 'resource-cleanup', status: 'failed' as const, durationMs: 10};
  for (const phase of ['evidence', 'teardown'] as const) {
    const error = {phase, actionId: 'external-recording-incomplete', message: 'Original recording is incomplete'};
    const result = {...good.result, failures: [error], teardown: {...good.result.teardown, actions: [action], errors: [error],
      outcomes: [{state: 'cleaned' as const, resourceId: 'fixture', evidence: [], errors: [error]}]}};
    const retained = frameworkRunSchema.parse({...good, result});
    expect(retained.result as unknown).toEqual(result);
    expect(retained.result.teardown.ready).toBe(true);
    expect(frameworkRunOutcome(retained)).toBe(phase === 'evidence' ? 'pass' : 'teardown-failed');
    expect(frameworkEvidenceComplete(retained)).toBe(phase !== 'evidence');
    if (phase === 'evidence') {
      const original = {...result, test: 'failed', failures: [...result.failures,
        {phase: 'test', actionId: good.result.steps[0]!.id, message: 'Original selector failed'}],
        steps: good.result.steps.map(step => ({...step, status: 'failed'}))};
      const failed = frameworkRunSchema.parse({...good, result: original});
      expect(failed.result as unknown).toEqual(original);
      expect(frameworkRunOutcome(failed)).toBe('failed');
    }
    expect(frameworkRunSchema.safeParse({...good, result: {...result, failures: [],
      teardown: {...result.teardown, errors: [], outcomes: [{state: 'cleaned', resourceId: 'fixture', evidence: []}]}}}).success).toBe(false);
    expect(frameworkRunSchema.safeParse({...good, result: {...result,
      teardown: {...result.teardown, outcomes: [{state: 'failed', resourceId: 'fixture', failure: error}]}}}).success).toBe(false);
    expect(frameworkRunSchema.safeParse({...good, result: {...result,
      teardown: {...result.teardown, actions: [{...action, status: 'not-run', durationMs: 0}]}}}).success).toBe(false);
  }
});

test("teardown evidence errors remain effective without a flattened run failure copy", () => {
  const good = run();
  const error = {phase: "evidence" as const, actionId: "finalize-recording", message: "Recording finalization failed"};
  for (const cleaned of [
    {state: "cleaned" as const, resourceId: "recorder", evidence: []},
    {state: "cleaned" as const, resourceId: "recorder", evidence: [], errors: []},
  ]) {
    const diagnostic = {...good, result: {...good.result,
      teardown: {...good.result.teardown, outcomes: [cleaned], errors: [error]}}};
    const preserved = frameworkRunSchema.parse(diagnostic);
    expect(preserved.result.failures).toEqual([]);
    expect(preserved.result.teardown.errors).toEqual([error]);
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
  for (const result of [{...diagnosed.result, failures: []}, {...diagnosed.result, teardown: {...diagnosed.result.teardown, errors: []}}]) {
    const retained = frameworkRunSchema.parse({...diagnosed, result});
    expect(retained.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(retained)).toBe('teardown-failed');
  }
  expect(frameworkRunSchema.safeParse({...diagnosed, result: {...diagnosed.result, teardown: {...diagnosed.result.teardown,
    outcomes: [{state: 'failed', resourceId: 'other-app', failure: error}]}}}).success).toBe(false);
  const active = {...report, result: {...report.result, teardown: {...report.result.teardown, ready: false,
    outcomes: [{state: "still-active", resourceId: "app", writer: {pid: 12}, evidence: []}],
    unavailableResources: [{resource: "app", cause: "Owned app process is still active", nextAction: "Inspect the recorded app process"}]}}};
  expect(frameworkRunOutcome(frameworkRunSchema.parse(active))).toBe("teardown-failed");
});

test("interrupted shared cleanup publishes its original failure without inventing a resource outcome", () => {
  const old = run();
  const action = {id: "cleanup:glasses", instruction: "Settle the requested glasses software",
    expected: "The glasses are ready to release", scope: "shared" as const, status: "failed" as const,
    startedAt: old.startedAt, durationMs: 1000};
  const original = {phase: "test" as const, actionId: "settings", message: "The app reported Check Failed"};
  const error = {phase: "teardown" as const, actionId: action.id, message: "Cleanup exceeded its deadline; inspect writer settlement"};
  const report = {...old, result: {...old.result, test: "failed", steps: [{id: "settings", status: "failed", durationMs: 1000}],
    failures: [original, error], teardown: {ready: false, actions: [action], outcomes: [], errors: [error],
      unavailableResources: [{resource: "glasses", cause: "Cleanup has not returned", nextAction: "Inspect and settle retained custody"}]}}};
  const parsed = frameworkRunSchema.parse(report);
  expect(frameworkRunOutcome(parsed)).toBe("failed");
  expect(parsed.result.failures).toEqual([original, error]);
  expect(parsed.result.teardown.ready).toBe(false);
  expect(parsed.result.teardown.outcomes).toEqual([]);
  expect(frameworkEvidenceComplete(parsed)).toBe(true);
  for (const result of [
    {...report.result, failures: [original]},
    {...report.result, teardown: {...report.result.teardown, errors: []}},
    {...report.result, failures: [original, {...error, diagnostics: {screenshot: 'late-observation'}}]},
  ]) {
    const retained = frameworkRunSchema.parse({...report, result});
    expect(retained.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(retained)).toBe('failed');
    expect(retained.result.teardown.ready).toBe(false);
  }
  for (const invalid of [
    {...report, result: {...report.result, teardown: {...report.result.teardown, ready: true}}},
    {...report, result: {...report.result, teardown: {...report.result.teardown, unavailableResources: []}}},
    {...report, result: {...report.result, teardown: {...report.result.teardown,
      unavailableResources: [{resource: "other", cause: "Unrelated cleanup", nextAction: "Inspect"}]}}},
    {...report, result: {...report.result, teardown: {...report.result.teardown,
      outcomes: [{state: "cleaned", resourceId: "glasses", evidence: [], errors: []}]}}},
  ]) expect(frameworkRunSchema.safeParse(invalid).success).toBe(false);
});

test("ready shared cleanup failures retain matching cleaned resource evidence without duplicate copies", () => {
  const old = run();
  const action = {id: "cleanup:recorder", instruction: "Stop and finalize the original recording", expected: "The recorder is settled",
    scope: "shared" as const, status: "failed" as const, durationMs: 10};
  const error = {phase: "evidence" as const, actionId: "finalize-recording", message: "Report finalization failed"};
  const report = {...old, result: {...old.result, failures: [error], teardown: {...old.result.teardown,
    actions: [action], errors: [error], outcomes: [{state: "cleaned", resourceId: "recorder", evidence: [], errors: [error]}]}}};
  const preserved = frameworkRunSchema.parse(report);
  expect(frameworkRunOutcome(preserved)).toBe("pass");
  expect(frameworkEvidenceComplete(preserved)).toBe(false);
  for (const result of [{...report.result, failures: []}, {...report.result, teardown: {...report.result.teardown, errors: []}}]) {
    const retained = frameworkRunSchema.parse({...report, result});
    expect(retained.result as unknown).toEqual(result);
    expect(frameworkRunOutcome(retained)).toBe('pass');
    expect(frameworkEvidenceComplete(retained)).toBe(false);
  }
  for (const invalid of [
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
  expect(
    frameworkRunSchema.safeParse({
      ...frozen,
      assets: frozen.assets.map((asset, index) => (index === 5 ? {...asset, path: "../outside.json"} : asset)),
    }).success,
  ).toBe(false)
  expect(frameworkRunSchema.safeParse({...frozen, result: {...frozen.result, evidence: [...ids, "missing/asset"]}}).success).toBe(false);
})

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

test('rejected public recording retains original step offsets only with matching finalization diagnostics', () => {
  const base = run();
  const error = {phase: 'evidence' as const, actionId: 'finalize-recording', message: 'Public recording duration differs'};
  const action = {id: 'cleanup:recorder', instruction: 'Stop and finalize the original recording',
    expected: 'The recorder is settled', scope: 'shared', status: 'failed', durationMs: 10};
  const steps = Array.from({length: 5}, (_, index) => ({id: `step-${index}`, status: 'passed' as const, durationMs: 1000,
    recordingLocation: {assetId: 'recording', startOffsetMs: index * 1000}}));
  const frozen = {...base, result: {...base.result, steps, failures: [error], teardown: {...base.result.teardown,
    actions: [action], errors: [error], outcomes: [{state: 'cleaned', resourceId: 'recorder', evidence: [], errors: [error]}]}}};
  const parsed = frameworkRunSchema.parse(frozen);
  expect(parsed.result.steps).toEqual(steps);
  expect(parsed.assets).toEqual([]);
  expect(parsed.recordingAssetId).toBeUndefined();
  expect(frameworkRunOutcome(parsed)).toBe('pass');
  expect(frameworkEvidenceComplete(parsed)).toBe(false);
  for (const result of [{...frozen.result, failures: []}, {...frozen.result, teardown: {...frozen.result.teardown, errors: []}}]) {
    const retained = frameworkRunSchema.parse({...frozen, result});
    expect(retained.result as unknown).toEqual(result);
    expect(retained.result.steps).toEqual(steps);
    expect(frameworkRunOutcome(retained)).toBe('pass');
    expect(frameworkEvidenceComplete(retained)).toBe(false);
  }
  for (const invalid of [
    {...frozen, result: {...frozen.result, teardown: {...frozen.result.teardown, outcomes: []}}},
    {...frozen, result: {...frozen.result, teardown: {...frozen.result.teardown, actions: []}}},
    {...frozen, result: {...frozen.result, teardown: {...frozen.result.teardown, actions: [{...action, status: 'passed'}]}}},
    {...frozen, result: {...frozen.result, teardown: {...frozen.result.teardown,
      outcomes: [{state: 'cleaned', resourceId: 'other-recorder', evidence: [], errors: [error]}]}}},
    {...frozen, result: {...frozen.result, steps: steps.map(step => ({...step,
      recordingLocation: {...step.recordingLocation, assetId: 'foreign-recording'}}))}},
    {...frozen, result: {...frozen.result, steps: [{...steps[0], recordingLocation: {assetId: 'recording', startOffsetMs: 10, endOffsetMs: 9}}]}},
    {...frozen, recordingAssetId: 'recording'},
    {...frozen, assets: [{id: 'recording', kind: 'diagnostic', path: 'recording.json', size: 10,
      sha256: 'a'.repeat(64), mimeType: 'application/json'}]},
  ]) expect(frameworkRunSchema.safeParse(invalid).success).toBe(false);
  const unrelated = {phase: 'evidence', actionId: 'snapshot', message: 'Snapshot capture failed'};
  const snapshotFailure = {...frozen, result: {...frozen.result, failures: [unrelated], teardown: {...frozen.result.teardown,
    errors: [unrelated], outcomes: [{state: 'cleaned', resourceId: 'recorder', evidence: [], errors: [unrelated]}]}}};
  const rejected = frameworkRunSchema.safeParse(snapshotFailure);
  expect(rejected.success).toBe(false);
  if (!rejected.success) expect(rejected.error.issues.map(issue => issue.path)).toEqual(
    steps.map((_, index) => ['result', 'steps', index, 'recordingLocation']));
});

test('step source pins are bounded and tied to the recorded routine and installed framework commits', () => {
  const good = run(), source = {id: 'settings', repository: 'Mentra-Community/Mentra-Automated-Testing', revision: good.definitionRevision,
    path: 'routines/no-glasses/routine.ts', line: 28};
  const pinned = {...good, result: {...good.result, stepSources: {setup: [], test: [source], teardown: []}}};
  expect(frameworkRunSchema.safeParse(pinned).success).toBe(true);
  for (const changes of [{revision: 'c'.repeat(40)}, {path: 'routines/../secrets.ts'}, {line: 0}, {id: 'foreign'},
    {repository: 'someone/else'}, {path: 'framework/run.ts'}])
    expect(frameworkRunSchema.safeParse({...pinned, result: {...pinned.result, stepSources: {setup: [], test: [{...source, ...changes}], teardown: []}}}).success).toBe(false);
});


test.each([
  ['Mentra-Community/Mentra-Automated-Testing', ''],
  ['Mentra-Community/Mentra', 'testing/'],
])('step provenance uses the repository root for routine and shared actions: %s', (repository, root) => {
  const good = run(), action = {id: 'prepare', instruction: 'Prepare', expected: 'Ready', scope: 'routine', status: 'passed', durationMs: 1};
  const routine = {id: 'settings', repository, revision: good.definitionRevision, path: `${root}routines/no-glasses/routine.ts`, line: 1};
  const shared = {id: 'cleanup', repository, revision: good.frameworkBinding.revision, path: `${root}framework/run.ts`, line: 1};
  const pinned = {...good, routineSource: {...good.routineSource, repository}, frameworkBinding: {...good.frameworkBinding, repository},
    result: {...good.result, setup: {...good.result.setup, actions: [action]},
    teardown: {...good.result.teardown, actions: [{...action, id: 'cleanup', scope: 'shared'}]},
    stepSources: {setup: [{...routine, id: 'prepare', path: `${root}routines/no-glasses/fixture.ts`}], test: [routine], teardown: [shared]}}};
  expect(frameworkRunSchema.safeParse(pinned).success).toBe(true);
  for (const source of [{...routine, revision: good.frameworkBinding.revision}, {...shared, id: 'settings'}])
    expect(frameworkRunSchema.safeParse({...pinned, result: {...pinned.result, stepSources: {...pinned.result.stepSources, test: [source]}}}).success).toBe(false);
  expect(frameworkRunSchema.safeParse({...pinned, result: {...pinned.result,
    stepSources: {...pinned.result.stepSources, teardown: [{...shared, revision: good.definitionRevision}]}}}).success).toBe(false);
});
