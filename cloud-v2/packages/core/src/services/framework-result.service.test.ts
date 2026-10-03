import type {RoutineEnrollment} from "../types/routine-definition.types";
import {expect, test, spyOn} from "bun:test";
import {FrameworkResultService, type FrameworkResultRepository} from "./framework-result.service";
import {TestRunModel} from "../models/test-run.model";
import type {FrameworkRun} from "../types/framework-run.types";

test("lost result acknowledgement returns same receipt and refuses rewritten terminal result", async () => {
  let stored: {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null = null;
  const repository: FrameworkResultRepository = {
    async insert(payload, payloadSha256) {
      if (stored) throw Object.assign(new Error("duplicate"), {code: 11000});
      stored = {payload, payloadSha256, uploadsComplete: true};
    },
    async getByRequest() {return stored;},
    async getByRun() {return stored;},
  };
  const run = {schemaVersion: 1, hostId: "mini", requestId: "r1", routineId: "notes", definitionRevision: "a".repeat(40),
    platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}, startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:01:00Z",
    assets: [], result: {runId: "r1", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "failed", actionId: "install"}, test: "not-run", steps: [{id: "required", status: "not-run", durationMs: 0, causedBy: "install"}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "setup", actionId: "install", message: "install failed"}], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 100, testMs: 0, teardownMs: 100}}};
  let projectionAttempts = 0;
  const source = async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment);
  const service = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}), async () => {projectionAttempts++;}, source);
  const first = await service.ingest(run, "mini"), duplicate = await service.ingest(run, "mini");
  expect(projectionAttempts).toBe(2);
  expect(first.created).toBe(true);
  expect(duplicate).toEqual({...first, created: false});
  expect(await service.complete("r1", "mini")).toEqual({entityId: first.entityId,
    payloadSha256: first.payloadSha256, manifestSha256: (await import("./test-request.service")).requestInputDigest([])});
  await expect(service.complete("r1", "other")).rejects.toThrow("not acknowledged");
  stored!.uploadsComplete = false;
  await expect(service.complete("r1", "mini")).rejects.toThrow("not acknowledged");
  await expect(service.ingest({...run, finishedAt: "2026-10-02T19:02:00Z", result: {...run.result, finishedAt: "2026-10-02T19:02:00Z"}}, "mini")).rejects.toThrow("different terminal result");
  await expect(service.ingest(run, "other")).rejects.toThrow("accepted request");
  await expect(service.ingest({...run, hostId: "other"}, "mini")).rejects.toThrow("accepted request");
  const {hostId: omitted, ...withoutHost} = run;
  await expect(service.ingest(withoutHost, "mini")).rejects.toThrow("Invalid frozen");
  await expect(service.ingest({...run, build: {...run.build, different: true}}, "mini")).rejects.toThrow("accepted request");
  let attempts = 0;
  const retrying = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}),
    async () => {if (++attempts === 1) throw new Error("request projection unavailable");}, source);
  await expect(retrying.ingest(run, "mini")).rejects.toThrow("projection unavailable");
  expect(await retrying.ingest(run, "mini")).toEqual({...first, created: false});
  expect(attempts).toBe(2);
  const incomplete = new FrameworkResultService(repository, async () => ({hostId: "mini", input: {
    routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}}}),
    async () => {}, async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment));
  expect((await incomplete.ingest(run, "mini")).created).toBe(false);
  await expect(incomplete.ingest({...run, result: {...run.result, steps: []}}, "mini"))
    .rejects.toThrow("complete ordered source step list");
  stored!.uploadsComplete = true;
  stored!.payload.result.failures.push({phase: "evidence", actionId: "capture", message: "Recording failed"});
  // Cloud custody of the declared diagnostics still permits disposal after capture failed.
  expect((await service.complete("r1", "mini")).entityId).toBe(first.entityId);
  expect((await service.detail("r1")).evidenceStatus).toBe("failed");

});


test("a completed test can publish a teardown failure without becoming a catalog pass", async () => {
  const {frameworkRunSchema, frameworkRunOutcome} = await import("../types/framework-run.types");
  let stored: FrameworkRun | undefined;
  const failure = {phase: "teardown" as const, actionId: "uninstall", message: "App removal failed"};
  const run = frameworkRunSchema.parse({schemaVersion: 1, hostId: "mini", requestId: "local:teardown", routineId: "notes",
    definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-02T19:00:00Z", finishedAt: "2026-10-02T19:01:00Z", assets: [],
    result: {runId: "local:teardown", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: false, outcomes: [{state: "failed", resourceId: "app", failure}], errors: [failure], unavailableResources: []},
      failures: [failure], evidence: [], timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}}});
  const service = new FrameworkResultService({async insert(payload) {stored = payload;}, async getByRequest() {return null;}, async getByRun() {return null;}},
    async () => ({hostId: "mini", input: {routineId: run.routineId, definitionRevision: run.definitionRevision,
      platform: run.platform, laneId: run.laneId, build: run.build}}), async () => {},
    async () => ({definition: {steps: [{id: "required"}]}} as unknown as RoutineEnrollment));
  expect((await service.ingest(run, "mini")).created).toBe(true);
  expect(stored?.result.failures).toEqual([failure]);
  expect(frameworkRunOutcome(stored!)).toBe("teardown-failed");
  await expect(service.ingest({...run, result: {...run.result, steps: []}}, "mini")).rejects.toThrow("Invalid frozen");
  await expect(service.ingest({...run, result: {...run.result, failures: [{...failure, phase: "test"}]}}, "mini")).rejects.toThrow("Invalid frozen");
});


test("native result list scopes the archive digest and excludes retained old payloads", async () => {
  let filter: Record<string, unknown> | null = null;
  const find = spyOn(TestRunModel, "find").mockImplementation(((query: Record<string, unknown>) => {
    filter = query;
    const chain = {sort() {return chain;}, limit() {return chain;}, read() {return chain;}, readConcern() {return chain;}, async lean() {return [];}};
    return chain;
  }) as any);
  try {
    const service = new FrameworkResultService();
    expect(await service.list({routineId: "walkthrough", platform: "ios-on-mac", archiveSha256: "a".repeat(64), prNumber: "12", channel: "pr"})).toEqual({runs: []});
    expect(filter as Record<string, unknown> | null).toEqual({"payload.schemaVersion": 1, routineId: "walkthrough", platform: "ios-on-mac", "payload.build.archive.sha256": "a".repeat(64), "payload.build.prNumber": 12, "payload.build.channel": "pr"});
  } finally {find.mockRestore();}
});

test("native run summaries retain build identity and distinct execution and evidence outcomes", async () => {
  const build = {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40),
    releaseIdentity: "2.1.0-dev.42", source: {buildRunId: 1234}};
  const run = {schemaVersion: 1, hostId: "mini", requestId: "request:mac.v2", routineId: "notes.search_v2",
    definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac", build,
    startedAt: "2026-10-03T19:00:00Z", finishedAt: "2026-10-03T19:01:00Z", assets: [],
    result: {runId: "request:mac.v2", finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "evidence", actionId: "capture", message: "Recording unavailable"}], evidence: [],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}}};
  const find = spyOn(TestRunModel, "find").mockImplementation((() => {
    return {sort() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;},
      lean: async () => [{payload: run, uploadsComplete: false}]};
  }) as any);
  try {
    const summary = (await new FrameworkResultService().list()).runs[0]!;
    expect(summary.build).toEqual({repository: build.repository, channel: "dev", headSha: build.headSha,
      release: build.releaseIdentity, producerUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1234"});
    expect(summary.outcome).toBe("pass");
    expect(summary.evidenceStatus).toBe("failed");
    expect(summary.uploadsComplete).toBe(false);
    expect(summary.requestId).toBe("request:mac.v2");
  } finally {find.mockRestore();}
});

test("invalid frozen result reports bounded issue codes and paths without payload values", async () => {
  const service = new FrameworkResultService();
  try {
    await service.ingest({requestId: "private-payload-value", schemaVersion: "secret-invalid-version"}, "mini");
    throw new Error("Expected schema refusal");
  } catch (error) {
    expect(error).toMatchObject({status: 400});
    expect((error as Error).message).toContain("Invalid frozen framework result: invalid_literal at schemaVersion");
    expect((error as Error).message).not.toContain("secret-invalid-version");
    expect((error as Error).message).not.toContain("private-payload-value");
    expect((error as Error).message.split(";").length).toBeLessThanOrEqual(5);
  }
});

test("result ingestion binds every routine lifecycle action to the complete ordered declaration before writing", async () => {
  const {frameworkRunSchema} = await import("../types/framework-run.types");
  const {requestInputDigest} = await import("./test-request.service");
  const setup = [
    {id: "create-fixture", instruction: "Create the fixture note", expected: "The fixture note is saved"},
    {id: "prepare-search", instruction: "Prepare the fixture search", expected: "The fixture is searchable"},
  ];
  const teardown = [{id: "remove-fixture", instruction: "Remove the fixture note", expected: "The fixture note is absent"}];
  const definition: RoutineEnrollment["definition"] = {id: "notes", title: "Notes search", purpose: "Check Notes search",
    platforms: ["ios-on-mac"], entry: "home", account: "lane", requires: [], requirements: [], fixtures: [], setup, teardown,
    steps: [{id: "required", instruction: "Search for the fixture", expected: "The fixture note appears"}],
    source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: "a".repeat(40), path: "routines/notes/routine.ts"}};
  const report = (action: typeof setup[number]) => ({...action, scope: "routine" as const, status: "passed" as const, durationMs: 10});
  const shared = {id: "shared:app", instruction: "Install the selected Mentra App", expected: "The selected build is installed",
    scope: "shared" as const, status: "passed" as const, durationMs: 10};
  const run = frameworkRunSchema.parse({schemaVersion: 1, hostId: "mini", requestId: "lifecycle", routineId: "notes",
    definitionRevision: definition.source.revision, platform: "ios-on-mac", laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-03T19:00:00Z", finishedAt: "2026-10-03T19:01:00Z", assets: [],
    result: {runId: "lifecycle", finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed", actions: [shared, ...setup.map(report)]},
      test: "passed", steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: true, actions: [...teardown.map(report), shared], outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}}});
  let writes = 0, stored: FrameworkRun | undefined;
  const source = {...definition};
  const service = new FrameworkResultService({async insert(payload) {writes++; stored = payload;},
    async getByRequest() {return null;}, async getByRun() {return null;}},
    async () => ({hostId: "mini", input: {routineId: run.routineId, definitionRevision: run.definitionRevision,
      platform: run.platform, laneId: run.laneId, build: run.build}}), async () => {},
    async () => ({routineId: run.routineId, platform: run.platform, definitionRevision: run.definitionRevision,
      definitionSha256: requestInputDigest(source), definition: source}));
  for (const phase of ["setup", "teardown"] as const) {
    const actions = run.result[phase].actions!;
    const {actions: omitted, ...aggregate} = run.result[phase];
    const routine = actions.filter(action => action.scope === "routine");
    for (const invalid of [
      undefined, [shared], [...actions, {...routine[0]!, id: "undeclared"}],
      actions.map(action => action.scope === "routine" ? {...action, instruction: `${action.instruction} differently`} : action),
      actions.map(action => action.scope === "routine" ? {...action, expected: `${action.expected} differently`} : action),
      actions.map(action => action.scope === "routine" ? {...action, scope: "shared" as const} : action),
    ]) await expect(service.ingest({...run, result: {...run.result, [phase]: {...aggregate, ...(invalid ? {actions: invalid} : {})}}}, "mini"))
      .rejects.toThrow(`complete ordered source ${phase} action list`);
  }
  await expect(service.ingest({...run, result: {...run.result, setup: {...run.result.setup,
    actions: [shared, ...setup.map(report).reverse()]}}}, "mini")).rejects.toThrow("complete ordered source setup action list");
  await expect(service.ingest({...run, result: {...run.result, setup: {...run.result.setup,
    actions: [shared, report(setup[0]!)]}}}, "mini")).rejects.toThrow("complete ordered source setup action list");
  expect(writes).toBe(0);
  expect((await service.ingest(run, "mini")).created).toBe(true);
  expect(stored?.result.setup.actions).toEqual(run.result.setup.actions);
  expect(stored?.result.teardown.actions).toEqual(run.result.teardown.actions);
  expect(writes).toBe(1);

  // Shared entry may fail before any routine hook starts; normal shared disposal still establishes readiness.
  const skipped = (action: typeof setup[number]) => ({...report(action), status: "not-run" as const, durationMs: 0, causedBy: shared.id});
  const setupStopped = {...run, result: {...run.result,
    setup: {status: "failed" as const, actionId: shared.id, actions: [{...shared, status: "failed" as const}, ...setup.map(skipped)]},
    test: "not-run" as const, steps: [{id: "required", status: "not-run" as const, durationMs: 0, causedBy: shared.id}],
    teardown: {...run.result.teardown, actions: [...teardown.map(skipped), shared]},
    failures: [{phase: "setup" as const, actionId: shared.id, message: "Selected app launch failed"}]}};
  await service.ingest(setupStopped, "mini");
  expect(stored?.result.teardown.ready).toBe(true);
  expect(stored?.result.teardown.actions?.[0]?.status).toBe("not-run");

  // Missing metadata means no routine hooks; explicit arrays from a new producer still work.
  delete source.setup; delete source.teardown;
  const {actions: omittedTeardown, ...legacyTeardown} = run.result.teardown;
  const legacy = {...run, result: {...run.result, setup: {status: "passed" as const},
    teardown: legacyTeardown}};
  await service.ingest(legacy, "mini");
  await service.ingest({...legacy, result: {...legacy.result, setup: {...legacy.result.setup, actions: [shared]},
    teardown: {...legacy.result.teardown, actions: []}}}, "mini");
  await expect(service.ingest(run, "mini")).rejects.toThrow("complete ordered source setup action list");
  source.setup = []; source.teardown = [];
  await expect(service.ingest(legacy, "mini")).rejects.toThrow("complete ordered source setup action list");
  await service.ingest({...legacy, result: {...legacy.result, setup: {...legacy.result.setup, actions: []},
    teardown: {...legacy.result.teardown, actions: []}}}, "mini");
});

test("old saved lifecycle omissions remain readable without invented action reports", async () => {
  const {frameworkRunSchema} = await import("../types/framework-run.types");
  const old = frameworkRunSchema.parse({schemaVersion: 1, hostId: "mini", requestId: "old-run", routineId: "notes",
    definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-03T19:00:00Z", finishedAt: "2026-10-03T19:01:00Z", assets: [],
    result: {runId: "old-run", finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: [],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}}});
  const service = new FrameworkResultService({async insert() {},
    async getByRequest() {return {payload: old, payloadSha256: "f".repeat(64), uploadsComplete: true};},
    async getByRun() {return null;}}, async () => null, async () => {}, async () => null);
  const detail = await service.detail("old-run");
  expect(detail.run).toEqual(old);
  expect(detail.outcome).toBe("pass");
  expect(detail.run.result.setup).not.toHaveProperty("actions");
  expect(detail.run.result.teardown).not.toHaveProperty("actions");
});
