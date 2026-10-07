import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {expect, test, spyOn} from "bun:test";
import {FrameworkResultConflict, FrameworkResultService, frameworkResultCursorFilter, type FrameworkResultRepository} from "./framework-result.service";
import {createFrameworkRunSummaryProjection} from "./framework-run-summary.service";
import {requestInputDigest} from "./test-request.service";
import {TestAssetModel, TestRunModel} from "../models/test-run.model";
import type {FrameworkRun} from "../types/framework-run.types";

test('candidate result metadata remains outside immutable result and host reader requires original accepted host', async () => {
  const {frameworkRunSchema} = await import('../types/framework-run.types');
  const verification = {workId: 'work:one', attemptId: 3, sourceRevision: 'a'.repeat(40)}
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: 'candidate-result',
    routineId: "notes",
    definitionRevision: verification.sourceRevision,
    platform: 'android',
    laneId: 'android',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-05T10:00:00Z',
    finishedAt: '2026-10-05T10:01:00Z',
    assets: [],
    result: {runId: 'candidate-result', finishedAt: '2026-10-05T10:01:00Z', setup: {status: 'passed'}, test: 'passed',
      steps: [{id: 'required', status: 'passed', durationMs: 10}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: '2026-10-05T10:00:00Z', setupMs: 0, testMs: 10, teardownMs: 0}},
  })
  let metadata: unknown
  const service = new FrameworkResultService(
    {async insert(payload, hash, selected) {
    expect(payload).toEqual(run); expect(hash).toBe(requestInputDigest(run)); metadata = selected
  }, async getByRequest() {return {payload: run, payloadSha256: requestInputDigest(run), uploadsComplete: true}},
  async getByRun() {return null}, async getAsset() {return null}},
    async () => ({
      hostId: 'mini',
      input: {
        routineId: run.routineId,
        definitionRevision: run.definitionRevision,
        routineSource: run.routineSource,
        platform: run.platform,
        laneId: run.laneId,
        build: run.build,
        verification,
      },
    }),
    async () => {},
    async () => ({definition: {steps: [{id: "required"}]}}) as unknown as RoutineEnrollment,
  )
  await service.ingest(run, 'mini')
  expect(metadata).toEqual({verification, catalogEligible: false})
  expect((await service.detailForHost(run.requestId, 'mini')).verification).toEqual(verification)
  await expect(service.detailForHost(run.requestId, 'foreign')).rejects.toThrow('not found for this host')
  await expect(service.mediaForHost(run.requestId, 'recording', 'foreign', new Request('https://example.com')))
    .rejects.toThrow('not found for this host')
  expect(run).not.toHaveProperty('verification')
})

test("lost result acknowledgement returns same receipt and refuses rewritten terminal result", async () => {
  let stored: {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null = null;
  const repository: FrameworkResultRepository = {
    async insert(payload, payloadSha256) {
      if (stored) throw Object.assign(new Error("duplicate"), {code: 11000});
      stored = {payload, payloadSha256, uploadsComplete: true};
    },
    async getByRequest() {return stored;},
    async getByRun() {return stored;}, async getAsset() {return null;},
  };
  const run = {
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "r1",
    routineId: "notes",
    definitionRevision: 'a'.repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: "2026-10-02T19:00:00Z",
    finishedAt: "2026-10-02T19:01:00Z",
    assets: [],
    result: {runId: "r1", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "failed", actionId: "install"}, test: "not-run", steps: [{id: "required", status: "not-run", durationMs: 0, causedBy: "install"}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "setup", actionId: "install", message: "install failed"}], evidence: [],
      timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 100, testMs: 0, teardownMs: 100}},
  }
  let projectionAttempts = 0;
  const source = async () => ({definition: {steps: [{id: "required"}]}}) as unknown as RoutineEnrollment
  const service = new FrameworkResultService(
    repository,
    async () => ({
      hostId: 'mini',
      input: {
        routineSource: testRoutineSource(),
        routineId: "notes",
        definitionRevision: 'a'.repeat(40),
        platform: "ios-on-mac",
        laneId: "mac",
        build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
      },
    }),
    async () => {projectionAttempts++;},
    source,
    undefined,
    {async list() {return [];}, async complete() {throw new FrameworkResultConflict('not acknowledged');}},
    {async complete() {return undefined;}},
  )
  const first = await service.ingest(run, "mini"), duplicate = await service.ingest(run, "mini");
  expect(projectionAttempts).toBe(2);
  expect(first.created).toBe(true);
  expect(duplicate).toEqual({...first, created: false});
  expect((await service.detail("r1")).run.frameworkBinding).toEqual(testFrameworkBinding())
  expect((await service.detail("r1")).run.routineSource).toEqual(testRoutineSource())
  await expect(
    service.ingest(
      {...run, frameworkBinding: {...testFrameworkBinding(), revision: "9".repeat(40), version: 41}},
      'mini',
    ),
  ).rejects.toThrow('different terminal result')
  await expect(
    service.ingest({...run, routineSource: {...testRoutineSource(), commit: "9".repeat(40)}}, 'mini'),
  ).rejects.toThrow()
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
  const retrying = new FrameworkResultService(
    repository,
    async () => ({
      hostId: 'mini',
      input: {
        routineSource: testRoutineSource(),
        routineId: "notes",
        definitionRevision: 'a'.repeat(40),
        platform: "ios-on-mac",
        laneId: "mac",
        build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
      },
    }),
    async () => {if (++attempts === 1) throw new Error("request projection unavailable");},
    source,
  )
  await expect(retrying.ingest(run, "mini")).rejects.toThrow("projection unavailable");
  expect(await retrying.ingest(run, "mini")).toEqual({...first, created: false});
  expect(attempts).toBe(2);
  const incomplete = new FrameworkResultService(
    repository,
    async () => ({
      hostId: 'mini',
      input: {
        routineSource: testRoutineSource(),
        routineId: "notes",
        definitionRevision: 'a'.repeat(40),
        platform: "ios-on-mac",
        laneId: "mac",
        build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
      },
    }),
    async () => {},
    async () => ({definition: {steps: [{id: "required"}]}}) as unknown as RoutineEnrollment,
  )
  expect((await incomplete.ingest(run, "mini")).created).toBe(false);
  await expect(incomplete.ingest({...run, result: {...run.result, steps: []}}, "mini"))
    .rejects.toThrow("complete ordered source step list");
  stored!.uploadsComplete = true;
  stored!.payload.result.failures.push({phase: "evidence", actionId: "capture", message: "Recording failed"});
  // Cloud custody of the declared diagnostics still permits disposal after capture failed.
  expect((await service.complete("r1", "mini")).entityId).toBe(first.entityId);
  expect((await service.detail("r1")).evidenceStatus).toBe("failed");
})

test("a completed test can publish a teardown failure without becoming a catalog pass", async () => {
  const {frameworkRunSchema, frameworkRunOutcome} = await import("../types/framework-run.types");
  let stored: FrameworkRun | undefined;
  const failure = {phase: "teardown" as const, actionId: "uninstall", message: "App removal failed"};
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "local:teardown",
    routineId: "notes",
    definitionRevision: 'a'.repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: "2026-10-02T19:00:00Z",
    finishedAt: "2026-10-02T19:01:00Z",
    assets: [],
    result: {runId: "local:teardown", finishedAt: "2026-10-02T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: false, outcomes: [{state: "failed", resourceId: "app", failure}], errors: [failure], unavailableResources: []},
      failures: [failure], evidence: [], timing: {startedAt: "2026-10-02T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}},
  })
  const service = new FrameworkResultService(
    {async insert(payload) {stored = payload;}, async getByRequest() {return null;}, async getByRun() {return null;}, async getAsset() {return null;}},
    async () => ({
      hostId: 'mini',
      input: {
        routineId: run.routineId,
        definitionRevision: run.definitionRevision,
        routineSource: run.routineSource,
        platform: run.platform,
        laneId: run.laneId,
        build: run.build,
      },
    }),
    async () => {},
    async () => ({definition: {steps: [{id: "required"}]}}) as unknown as RoutineEnrollment,
  )
  expect((await service.ingest(run, "mini")).created).toBe(true);
  expect(stored?.result.failures).toEqual([failure]);
  expect(frameworkRunOutcome(stored!)).toBe("teardown-failed");
  await expect(service.ingest({...run, result: {...run.result, steps: []}}, "mini")).rejects.toThrow("Invalid frozen");
  await expect(service.ingest({...run, result: {...run.result, failures: [{...failure, phase: "test"}]}}, "mini")).rejects.toThrow("Invalid frozen");
})

test("native result list scopes the archive digest and excludes retained old payloads", async () => {
  let filter: Record<string, unknown> | null = null;
  const find = spyOn(TestRunModel, "find").mockImplementation(((query: Record<string, unknown>) => {
    filter = query;
    const chain = {sort() {return chain;}, limit() {return chain;}, select() {return chain;}, read() {return chain;}, readConcern() {return chain;}, async lean() {return [];}};
    return chain;
  }) as any);
  try {
    const service = new FrameworkResultService();
    expect(await service.list({routineId: "walkthrough", platform: "ios-on-mac", archiveSha256: "a".repeat(64), prNumber: "12", channel: "pr"})).toEqual({runs: [], nextCursor: null});
    expect(filter as Record<string, unknown> | null).toEqual({
      "payload.schemaVersion": 1,
      "routineId": "walkthrough",
      "platform": "ios-on-mac",
      "payload.build.archive.sha256": "a".repeat(64),
      "payload.build.prNumber": 12,
      "payload.build.channel": "pr",
    })
  } finally {find.mockRestore();}
})

test("exact-request summary verifies the existing projection and frozen build without loading evidence or a definition", async () => {
  const {frameworkRunSchema} = await import('../types/framework-run.types');
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "summary:one",
    routineId: "notes",
    definitionRevision: 'a'.repeat(40),
    platform: 'android',
    laneId: 'android',
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40),
      archive: {sha256: "c".repeat(64)}, source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}},
    startedAt: "2026-10-06T10:00:00Z",
    finishedAt: "2026-10-06T10:01:00Z",
    assets: Array.from({length: 2371}, (_, index) => ({id: `diagnostic-${index}`, kind: "diagnostic", path: `private/${index}.json`,
      sha256: "d".repeat(64), size: 1, mimeType: "application/json"})),
    result: {runId: "summary:one", finishedAt: "2026-10-06T10:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "evidence", actionId: "recording", message: "private-evidence-detail"}], evidence: [],
      timing: {startedAt: "2026-10-06T10:00:00Z", setupMs: 0, testMs: 10, teardownMs: 0}},
  })
  const projection = createFrameworkRunSummaryProjection(run, requestInputDigest(run));
  let row: any = {runId: run.requestId, requestId: run.requestId, payloadSha256: projection.payloadSha256,
    summaryProjection: projection, uploadsComplete: false, payload: {build: run.build}};
  let queries = 0;
  const find = spyOn(TestRunModel, "findOne").mockImplementation(((filter: unknown) => {
    queries++;
    expect(filter).toEqual({"payload.schemaVersion": 1, "requestId": run.requestId})
    return {
      select(fields: unknown) {
        expect(fields).toEqual({
          "runId": 1,
          "requestId": 1,
          "payloadSha256": 1,
          "summaryProjection": 1,
          "uploadsComplete": 1,
          "payload.build": 1,
        })
        return this;
      },
      read(value: string) {expect(value).toBe("primary"); return this;},
      readConcern(value: string) {expect(value).toBe("majority"); return this;},
      setOptions(value: unknown) {expect(value).toEqual({timeoutMS: 10_000}); return this;},
      lean: async () => row,
    }
  }) as any)
  try {
    const service = new FrameworkResultService(undefined, undefined, undefined, async () => {throw Error("Must not fetch a definition");});
    const summary = await service.summary(run.requestId);
    expect(summary).toMatchObject({
      runId: run.requestId,
      requestId: run.requestId,
      hostId: run.hostId,
      routineId: run.routineId,
      definitionRevision: run.definitionRevision,
      routineSource: run.routineSource,
      platform: run.platform,
      laneId: run.laneId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      outcome: 'pass',
      evidenceStatus: 'failed',
      uploadsComplete: false,
      build: run.build,
    })
    expect(JSON.stringify(summary)).not.toContain("private-evidence-detail");
    expect(JSON.stringify(summary)).not.toContain("private/0.json");
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(2000);
    row.uploadsComplete = true;
    expect(await service.summary(run.requestId)).toMatchObject({outcome: "pass", evidenceStatus: "failed", uploadsComplete: true});
    const valid = structuredClone(row);
    const corruptions = [
      () => {row.summaryProjection.summarySha256 = "e".repeat(64);},
      () => {row.payloadSha256 = "e".repeat(64);},
      () => {row.requestId = "foreign";},
      () => {row.runId = "foreign";},
      () => {row.payload.build.headSha = "e".repeat(40);},
      () => {row.payload = undefined;},
    ];
    for (const corrupt of corruptions) {
      row = structuredClone(valid); corrupt(); const before = queries;
      await expect(service.summary(run.requestId)).rejects.toMatchObject({status: 503});
      expect(queries).toBe(before + 1);
    }
    row = null;
    await expect(service.summary(run.requestId)).rejects.toMatchObject({status: 404});
  } finally {find.mockRestore();}
})

test("native run summaries retain build identity and distinct execution and evidence outcomes", async () => {
  const build = {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40),
    releaseIdentity: "2.1.0-dev.42", source: {buildRunId: 1234}};
  const run = {
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "request:mac.v2",
    routineId: "notes.search_v2",
    definitionRevision: 'a'.repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build,
    startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:01:00Z",
    assets: [],
    result: {runId: "request:mac.v2", finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: "evidence", actionId: "capture", message: "Recording unavailable"}], evidence: [],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}},
  }
  const find = spyOn(TestRunModel, "find").mockImplementation((() => {
    return {sort() {return this;}, limit() {return this;}, select() {return this;}, read() {return this;}, readConcern() {return this;},
      lean: async () => [{runId: run.requestId, requestId: run.requestId, payloadSha256: requestInputDigest(run), summaryProjection: createFrameworkRunSummaryProjection(run, requestInputDigest(run)), uploadsComplete: false}]};
  }) as any);
  try {
    const summary = (await new FrameworkResultService().list()).runs[0]!;
    expect(summary.build).toEqual({repository: build.repository, channel: "dev", headSha: build.headSha,
      release: build.releaseIdentity, producerUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1234"});
    expect(summary.outcome).toBe("pass");
    expect(summary.evidenceStatus).toBe("failed");
    expect(summary.uploadsComplete).toBe(false);
    expect(summary.requestId).toBe("request:mac.v2");
    const rows = Array.from({length: 101}, (_, index) => {
      const runId = `run-${String(200 - index).padStart(3, "0")}`;
      const payload = {...run, requestId: runId, result: {...run.result, runId}};
      return {runId, requestId: runId, startedAt: new Date(run.startedAt), payloadSha256: requestInputDigest(payload),
        summaryProjection: createFrameworkRunSummaryProjection(payload, requestInputDigest(payload)), uploadsComplete: false};
    });
    const filters: Record<string, unknown>[] = [];
    find.mockImplementation(((filter: Record<string, unknown>) => {
      filters.push(filter);
      return {
        sort(value: unknown) {expect(value).toEqual({startedAt: -1, runId: -1}); return this;},
        limit(value: number) {expect(value).toBe(101); return this;},
        select() {return this;},
        read() {return this;},
        readConcern() {return this;},
        lean: async () => (filters.length === 1 ? rows : rows.slice(100)),
      }
    }) as any)
    const service = new FrameworkResultService();
    const scope = {headSha: build.headSha, channel: "dev"};
    const first = await service.list(scope);
    expect(first.runs).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({...scope, cursor: first.nextCursor!});
    expect(second.runs.map(row => row.runId)).toEqual(["run-100"]);
    expect(second.nextCursor).toBeNull();
    expect(filters[1]).toEqual({
      "payload.schemaVersion": 1,
      "payload.build.headSha": build.headSha,
      "payload.build.channel": "dev",
      "$or": [{startedAt: {$lt: new Date(run.startedAt)}}, {startedAt: new Date(run.startedAt), runId: {$lt: "run-101"}}],
    })
  } finally {find.mockRestore();}
})

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
  const {frameworkRunSchema} = await import('../types/framework-run.types');
  const {requestInputDigest} = await import("./test-request.service");
  const setup = [
    {id: "create-fixture", instruction: "Create the fixture note", expected: "The fixture note is saved"},
    {id: "prepare-search", instruction: "Prepare the fixture search", expected: "The fixture is searchable"},
  ];
  const teardown = [{id: "remove-fixture", instruction: "Remove the fixture note", expected: "The fixture note is absent"}];
  const definition: RoutineEnrollment["definition"] = {
    id: "notes",
    minimumRoutineApiVersion: 1,
    title: "Notes search",
    purpose: "Check Notes search",
    platforms: ["ios-on-mac"],
    entry: "home",
    account: "lane",
    requires: [],
    requirements: [],
    fixtures: [],
    setup,
    teardown,
    steps: [{id: "required", instruction: "Search for the fixture", expected: "The fixture note appears"}],
    source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision: "a".repeat(40), path: "routines/notes/routine.ts"},
  }
  const report = (action: (typeof setup)[number]) => ({...action, scope: "routine" as const, status: "passed" as const, durationMs: 10})
  const shared = {id: "shared:app", instruction: "Install the selected Mentra App", expected: "The selected build is installed",
    scope: "shared" as const, status: "passed" as const, durationMs: 10};
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "lifecycle",
    routineId: "notes",
    definitionRevision: definition.source.revision,
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:01:00Z",
    assets: [],
    result: {runId: "lifecycle", finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed", actions: [shared, ...setup.map(report)]},
      test: "passed", steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: true, actions: [...teardown.map(report), shared], outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}},
  })
  let writes = 0, stored: FrameworkRun | undefined;
  const source = {...definition};
  const service = new FrameworkResultService(
    {async insert(payload) {writes++; stored = payload;},
    async getByRequest() {return null;}, async getByRun() {return null;}, async getAsset() {return null;}},
    async () => ({
      hostId: 'mini',
      input: {
        routineId: run.routineId,
        definitionRevision: run.definitionRevision,
        routineSource: run.routineSource,
        platform: run.platform,
        laneId: run.laneId,
        build: run.build,
      },
    }),
    async () => {},
    async () => ({
      routineId: run.routineId,
      platform: run.platform,
      definitionRevision: run.definitionRevision,
      routineSource: run.routineSource,
      definitionSha256: requestInputDigest(source),
      definition: source,
    }),
  )
  for (const phase of ["setup", "teardown"] as const) {
    const actions = run.result[phase].actions!;
    const {actions: omitted, ...aggregate} = run.result[phase];
    const routine = actions.filter(action => action.scope === "routine");
    for (const invalid of [
      undefined,
      [shared],
      [...actions, {...routine[0]!, id: "undeclared"}],
      actions.map(action => action.scope === "routine" ? {...action, instruction: `${action.instruction} differently`} : action),
      actions.map(action => action.scope === "routine" ? {...action, expected: `${action.expected} differently`} : action),
      actions.map((action) => (action.scope === "routine" ? {...action, scope: "shared" as const} : action)),
    ])
      await expect(service.ingest({...run, result: {...run.result, [phase]: {...aggregate, ...(invalid ? {actions: invalid} : {})}}}, "mini"))
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
  const skipped = (action: (typeof setup)[number]) => ({...report(action), status: "not-run" as const, durationMs: 0, causedBy: shared.id})
  const setupStopped = {...run, result: {...run.result,
    setup: {status: "failed" as const, actionId: shared.id, actions: [{...shared, status: "failed" as const}, ...setup.map(skipped)]},
    test: "not-run" as const, steps: [{id: "required", status: "not-run" as const, durationMs: 0, causedBy: shared.id}],
    teardown: {...run.result.teardown, actions: [...teardown.map(skipped), shared]},
    failures: [{phase: "setup" as const, actionId: shared.id, message: "Selected app launch failed"}]}};
  await service.ingest(setupStopped, "mini");
  expect(stored?.result.teardown.ready).toBe(true);
  expect(stored?.result.teardown.actions?.[0]?.status).toBe("not-run");

  // Fixture providers declared by the routine are routine actions, alongside exact explicit hooks.
  source.fixtures = [{provider: "notes-data", description: "Owned Notes data"}];
  const fixture = {...report({id: "prepare-notes-data", instruction: "Prepare Notes data", expected: "Notes ready"}), fixtureProvider: "notes-data"};
  const fixtureRun = {...run, result: {...run.result,
    setup: {...run.result.setup, actions: [shared, fixture, ...setup.map(report)]},
    teardown: {...run.result.teardown, actions: [...teardown.map(report), {...fixture, id: "cleanup:notes-data"}, shared]}}};
  await service.ingest(fixtureRun, "mini");
  expect(stored?.result.setup.actions?.[1]).toEqual(fixture);
  expect(stored?.result.teardown.actions?.[1]?.fixtureProvider).toBe("notes-data");
  for (const phase of ["setup", "teardown"] as const) {
    const actions = fixtureRun.result[phase].actions!;
    for (const invalid of [
      actions.map(action => action === actions[1] ? {...action, fixtureProvider: "undeclared"} : action),
      actions.map(action => "fixtureProvider" in action ? {...action, scope: "shared"} : action),
      [...actions, {...fixture, id: "duplicate-fixture"}],
      [...actions, {...fixture, id: source[phase]![0]!.id}],
    ]) await expect(service.ingest({...fixtureRun, result: {...fixtureRun.result,
      [phase]: {...fixtureRun.result[phase], actions: invalid}}}, "mini")).rejects.toThrow();
    // A fixture marker must never excuse a missing explicit lifecycle hook.
    await expect(service.ingest({...fixtureRun, result: {...fixtureRun.result,
      [phase]: {...fixtureRun.result[phase], actions: [shared, fixture]}}}, "mini")).rejects.toThrow("complete ordered source");
  }

  // Missing metadata means no routine hooks; explicit arrays from a new producer still work.
  delete source.setup;
  delete source.teardown;
  const {actions: omittedTeardown, ...legacyTeardown} = run.result.teardown;
  const legacy = {...run, result: {...run.result, setup: {status: "passed" as const},
    teardown: legacyTeardown}};
  await service.ingest(legacy, "mini");
  await service.ingest({...legacy, result: {...legacy.result, setup: {...legacy.result.setup, actions: [shared]},
    teardown: {...legacy.result.teardown, actions: []}}}, "mini");
  await expect(service.ingest(run, "mini")).rejects.toThrow("complete ordered source setup action list");
  source.setup = [];
  source.teardown = [];
  await expect(service.ingest(legacy, "mini")).rejects.toThrow("complete ordered source setup action list");
  await service.ingest({...legacy, result: {...legacy.result, setup: {...legacy.result.setup, actions: []},
    teardown: {...legacy.result.teardown, actions: []}}}, "mini");
})

test("old saved lifecycle omissions remain readable without invented action reports", async () => {
  const {frameworkRunSchema} = await import('../types/framework-run.types');
  const {routineSource: _source, frameworkBinding: _binding, ...old} = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "old-run",
    routineId: "notes",
    definitionRevision: 'a'.repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:01:00Z",
    assets: [],
    result: {runId: "old-run", finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 10}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: [],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 10, testMs: 10, teardownMs: 10}},
  })
  const payloadSha256 = requestInputDigest(old), before = JSON.stringify(old);
  let writes = 0;
  const service = new FrameworkResultService({async insert() {writes++;},
    async getByRequest() {return {payload: old, payloadSha256, uploadsComplete: true};},
    async getByRun() {return null;}, async getAsset() {return null;}}, async () => null, async () => {}, async () => null);
  const detail = await service.detail("old-run");
  expect(detail.run).toEqual(old);
  expect(detail.outcome).toBe("pass");
  expect(detail.run.result.setup).not.toHaveProperty("actions");
  expect(detail.run.result.teardown).not.toHaveProperty("actions");
  expect(detail.run).not.toHaveProperty('routineSource');
  expect(detail.run).not.toHaveProperty('frameworkBinding');
  expect(JSON.stringify(old)).toBe(before);
  expect(requestInputDigest(old)).toBe(payloadSha256);
  await expect(service.ingest(old, 'mini')).rejects.toMatchObject({status: 400});
  await expect(service.ingest({...old, routineSource: testRoutineSource()}, 'mini')).rejects.toMatchObject({status: 400});
  await expect(service.ingest({...old, frameworkBinding: testFrameworkBinding()}, 'mini')).rejects.toMatchObject({status: 400});
  expect(writes).toBe(0);
})

test("asset reads project one immutable declaration and preserve missing and unauthorized outcomes", async () => {
  const {TestAssetService} = await import("./test-asset.service");
  const declaration = {id: "report:final", kind: "report" as const, path: "setup-evidence/final.json",
    sha256: "c".repeat(64), size: 100, mimeType: "application/json" as const};
  const calls: Array<{pipeline: any[]; options: any}> = [];
  const aggregate = spyOn(TestRunModel.collection, "aggregate").mockImplementation(((pipeline: any[], options: any) => {
    calls.push({pipeline, options});
    const filter = pipeline[0].$match;
    return {async toArray() {return (filter.requestId ?? filter.runId) === "missing-run" ? []
      : [{payload: {result: {runId: "frozen-run"}, assets:
        pipeline[2].$project["payload.assets"].$filter.cond.$eq[1].$literal === declaration.id ? [declaration] : []}}];}};
  }) as any);
  let acknowledged = false;
  const custody = spyOn(TestAssetModel, "findOne").mockImplementation(() => ({read() {return this;}, readConcern() {return this;},
    async lean() {return acknowledged ? {runId: "frozen-run", assetId: declaration.id} : null;}}) as any);
  const upload = spyOn(TestAssetService.prototype, "uploadDeclaredAsset").mockImplementation(async (runId, asset) => {
    expect(runId).toBe("frozen-run");
    expect(asset).toEqual({assetId: declaration.id, kind: "metadata", contentType: declaration.mimeType,
      filename: "final.json", sizeBytes: declaration.size, sha256: declaration.sha256});
    return {assetId: declaration.id, uploaded: true, created: true};
  });
  const media = spyOn(TestAssetService.prototype, "mediaDeclaredAsset").mockImplementation(async (asset, _stored, request) => {
    expect(asset).toEqual({assetId: declaration.id, kind: "metadata", contentType: declaration.mimeType,
      filename: "final.json", sizeBytes: declaration.size, sha256: declaration.sha256});
    expect(request.method).toBe("HEAD");
    return new Response(null, {status: 206, headers: {"content-range": "bytes 0-1/100", "content-length": "2"}});
  });
  let owner = "mini";
  const service = new FrameworkResultService(undefined, async () => ({
    hostId: owner,
    input: {routineSource: testRoutineSource()} as any,
  }))
  const headers = new Headers({"content-type": declaration.mimeType});
  const mediaRequest = new Request("http://localhost/asset", {method: "HEAD"});
  try {
    expect(await service.upload("request", declaration.id, "mini", null, headers)).toMatchObject({uploaded: true, sha256: declaration.sha256, size: declaration.size});
    owner = "other";
    await expect(service.upload("request", declaration.id, "mini", null, headers)).rejects.toThrow("not owned");
    owner = "mini";
    await expect(service.upload("missing-run", declaration.id, "mini", null, headers)).rejects.toThrow("not owned");
    await expect(service.upload("request", "undeclared", "mini", null, headers)).rejects.toThrow("not declared");
    expect(upload).toHaveBeenCalledTimes(1);
    await expect(service.media("request", declaration.id, mediaRequest)).rejects.toThrow("not acknowledged");
    await expect(service.mediaByRun("frozen-run", "undeclared", mediaRequest)).rejects.toThrow("not declared");
    await expect(service.mediaByRun("missing-run", declaration.id, mediaRequest)).rejects.toThrow("not declared");
    expect(custody).toHaveBeenCalledTimes(1);
    expect(custody.mock.calls[0]).toEqual([{runId: "frozen-run", assetId: declaration.id}]);
    for (const [index, call] of calls.entries()) {
      expect(call.pipeline[0].$match).toMatchObject({"payload.schemaVersion": 1});
      expect(call.pipeline[1]).toEqual({$limit: 1});
      expect(call.pipeline[2].$project).toEqual({
        "payload.result.runId": 1,
        "payload.assets": {$filter: {input: "$payload.assets", as: "asset",
          cond: {$eq: ["$$asset.id", {$literal: [3, 5].includes(index) ? "undeclared" : declaration.id}]}}},
        "_id": 0,
      })
      expect(call.options.readPreference.mode).toBe("primary");
      expect(call.options.readConcern).toEqual({level: "majority"});
    }
    expect(calls[0].pipeline[0].$match).toEqual({"payload.schemaVersion": 1, "requestId": "request"})
    expect(calls[5].pipeline[0].$match).toEqual({"payload.schemaVersion": 1, "runId": "frozen-run"})
    acknowledged = true;
    const response = await service.mediaByRun("frozen-run", declaration.id, mediaRequest);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("2");
    expect(media).toHaveBeenCalledTimes(1);
  } finally {aggregate.mockRestore(); custody.mockRestore(); upload.mockRestore(); media.mockRestore();}
})

test("4096 streamed assets acknowledge once at complete with immutable metadata and concurrent retry custody", async () => {
  const {createHash} = await import("node:crypto");
  const {mkdtemp, rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const {TestAssetService} = await import("./test-asset.service");
  const {StorageService} = await import("./storage/storage.service");
  const {LocalStorageProvider} = await import("./storage/providers/local-storage.provider");
  const {FRAMEWORK_RUN_ASSET_LIMIT, frameworkRunSchema} = await import("../types/framework-run.types");
  const directory = await mkdtemp(join(tmpdir(), "framework-large-ack-"));
  const bytes = Buffer.from("{}");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const declared = Array.from({length: FRAMEWORK_RUN_ASSET_LIMIT}, (_, index) => ({id: `report:${index}`, kind: "report",
    path: `report-${index}.json`, size: bytes.length, sha256, mimeType: "application/json"}));
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: "large",
    routineId: "notes",
    definitionRevision: 'a'.repeat(40),
    platform: 'android',
    laneId: 'android',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: "2026-10-05T15:00:00Z",
    finishedAt: "2026-10-05T15:01:00Z",
    assets: declared,
    result: {runId: "large", finishedAt: "2026-10-05T15:01:00Z", setup: {status: "passed"}, test: "failed",
      steps: [{id: "required", status: "failed", durationMs: 10}], failures: [{phase: "test", actionId: "required", message: "Original failure"}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, evidence: declared.map(asset => asset.id),
      timing: {startedAt: "2026-10-05T15:00:00Z", setupMs: 0, testMs: 10, teardownMs: 0}},
  })
  const stored = {payload: run, payloadSha256: requestInputDigest(run), uploadsComplete: false};
  const rows = new Map<string, import("./test-asset.service").StoredTestAsset>();
  let inventoryReads = 0, duplicateLookups = 0, completionWrites = 0;
  let corrupt: "digest" | "size" | "duplicate" | undefined;
  const storage = new StorageService(new LocalStorageProvider({rootDir: directory}));
  const assets = new TestAssetService({async findAsset(runId, assetId) {
    duplicateLookups++; expect(runId).toBe(run.result.runId); return rows.get(assetId) ?? null;
  }, async insertAsset(row) {
    const winner = rows.get(row.assetId);
    if (winner) {
      if (winner.sha256 !== row.sha256 || winner.sizeBytes !== row.sizeBytes) throw Error("Conflicting immutable upload");
      return winner;
    }
    rows.set(row.assetId, row); return row;
  }}, () => storage);
  const service = new FrameworkResultService(
    {async insert() {}, async getByRequest() {return stored;}, async getByRun() {return stored;}, async getAsset(_identity, assetId) {return {runId: stored.payload.result.runId, asset: stored.payload.assets.find(asset => asset.id === assetId) ?? null};}},
    async () => ({
      hostId: 'mini',
      input: {
        routineId: run.routineId,
        definitionRevision: run.definitionRevision,
        routineSource: run.routineSource,
        platform: run.platform,
        laneId: run.laneId,
        build: run.build,
      },
    }),
    async () => {},
    async () => ({definition: {steps: [{id: "required"}]}}) as unknown as RoutineEnrollment,
    assets,
    {
      async list() {
        inventoryReads++; const all = [...rows.values()];
        if (corrupt === "duplicate") all[1] = {...all[0]!};
        if (corrupt === "digest") all[0] = {...all[0]!, sha256: "d".repeat(64)};
        if (corrupt === "size") all[0] = {...all[0]!, sizeBytes: bytes.length + 1};
        return all;
      }, async complete(value) {expect(value.payloadSha256).toBe(stored.payloadSha256); completionWrites++; stored.uploadsComplete = true;},
    },
    {async complete() {return undefined;}},
  )
  const headers = new Headers({"content-type": "application/json", "content-length": String(bytes.length)});
  const body = () => new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(bytes); controller.close();}});
  const upload = (assetId: string) => service.upload(run.requestId, assetId, "mini", body(), headers);
  try {
    let next = 0;
    await Promise.all(Array.from({length: 4}, async () => {
      while (next < declared.length - 1) await upload(declared[next++]!.id);
    }));
    expect(rows.size).toBe(FRAMEWORK_RUN_ASSET_LIMIT - 1);
    expect(inventoryReads).toBe(0); // No full collection scan in any PUT.
    await expect(service.complete(run.requestId, "mini")).rejects.toThrow("not acknowledged");
    expect(stored.uploadsComplete).toBe(false);
    const final = declared.at(-1)!;
    const retries = await Promise.all([upload(final.id), upload(final.id)]);
    expect(retries.every(receipt => receipt.uploaded && receipt.sha256 === final.sha256 && receipt.size === final.size)).toBe(true);
    expect(rows.size).toBe(FRAMEWORK_RUN_ASSET_LIMIT);
    for (const fault of ["digest", "size", "duplicate"] as const) {
      corrupt = fault;
      await expect(service.complete(run.requestId, "mini")).rejects.toThrow("not acknowledged");
      expect(stored.uploadsComplete).toBe(false);
    }
    corrupt = undefined;
    const receipt = await service.complete(run.requestId, "mini");
    expect(receipt).toEqual({entityId: run.result.runId, payloadSha256: stored.payloadSha256, manifestSha256: requestInputDigest(run.assets)});
    expect(completionWrites).toBe(1); expect(inventoryReads).toBe(5);
    expect(duplicateLookups).toBe(FRAMEWORK_RUN_ASSET_LIMIT + 1);
    expect(await service.complete(run.requestId, "mini")).toEqual(receipt);
    expect(inventoryReads).toBe(5);
    expect((await upload(final.id)).created).toBe(false);
    expect(await service.complete(run.requestId, "mini")).toEqual(receipt);
    const bad = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(Buffer.from("[]")); controller.close();}});
    await expect(service.upload(run.requestId, final.id, "mini", bad, headers)).rejects.toThrow("SHA256");
    expect((await service.detail(run.requestId)).outcome).toBe("failed");
  } finally {await rm(directory, {recursive: true, force: true});}
})

test("results cursor validates before querying and handles equal timestamps by run identity", () => {
  expect(frameworkResultCursorFilter()).toEqual({});
  for (const cursor of ["invalid", "x".repeat(2001), Buffer.from(JSON.stringify({startedAt: "invalid", runId: "run"})).toString("base64url")])
    expect(() => frameworkResultCursorFilter(cursor)).toThrow("Invalid routine results cursor");
});

test('failed recording publication preserves immutable step offsets and settled evidence failure on retry', async () => {
  const {frameworkRunSchema} = await import('../types/framework-run.types');
  const diagnostic = {phase: 'evidence' as const, actionId: 'finalize-recording', message: 'Public recording could not be finalized'};
  const frozen: FrameworkRun = {
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: 'mini',
    requestId: 'recording-result',
    routineId: 'wifi-connect-android',
    definitionRevision: 'a'.repeat(40),
    platform: 'android',
    laneId: 'android',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-06T18:00:00Z',
    finishedAt: '2026-10-06T18:02:00Z',
    assets: [],
    result: {runId: 'recording-result', finishedAt: '2026-10-06T18:02:00Z', setup: {status: 'passed'}, test: 'passed',
      steps: Array.from({length: 5}, (_, index) => ({id: `step-${index}`, status: 'passed', durationMs: 1000,
        recordingLocation: {assetId: 'recording', startOffsetMs: index * 1000}})),
      teardown: {ready: true, actions: [{id: 'cleanup:recorder', instruction: 'Finalize the original recording',
        expected: 'The recorder is settled', scope: 'shared', status: 'failed', durationMs: 1000}],
        outcomes: [{state: 'cleaned', resourceId: 'recorder', evidence: [], errors: [diagnostic]}],
        errors: [diagnostic], unavailableResources: []}, failures: [diagnostic], evidence: [],
      timing: {startedAt: '2026-10-06T18:00:00Z', setupMs: 1000, testMs: 5000, teardownMs: 1000}},
  }
  let stored: {payload: FrameworkRun; payloadSha256: string; uploadsComplete: boolean} | null = null;
  let writes = 0;
  const repository: FrameworkResultRepository = {
    async insert(payload, payloadSha256) {
      if (stored) throw Object.assign(new Error('duplicate'), {code: 11000});
      writes++;
      stored = {payload, payloadSha256, uploadsComplete: true};
    },
    async getByRequest() {return stored;}, async getByRun() {return stored;}, async getAsset() {return null;},
  };
  const service = new FrameworkResultService(
    repository,
    async () => ({
      hostId: frozen.hostId,
      input: {
        routineId: frozen.routineId,
        definitionRevision: frozen.definitionRevision,
        routineSource: frozen.routineSource,
        platform: frozen.platform,
        laneId: frozen.laneId,
        build: frozen.build,
      },
    }),
    async () => {},
    async () =>
      ({definition: {steps: frozen.result.steps.map(step => ({id: step.id}))}}) as unknown as RoutineEnrollment,
    undefined,
    {async list() {return [];}, async complete() {}},
    {async complete() {return undefined;}},
  )
  const originalDigest = requestInputDigest(frozen);
  const first = await service.ingest(frozen, frozen.hostId);
  expect(first).toMatchObject({payloadSha256: originalDigest, created: true});
  expect(await service.ingest(frozen, frozen.hostId)).toEqual({...first, created: false});
  expect(writes).toBe(1);
  expect(stored!.payload).toEqual(frozen);
  expect(requestInputDigest(frozen)).toBe(originalDigest);
  expect(await service.detail(frozen.requestId)).toMatchObject({outcome: 'pass', uploadsComplete: true, evidenceStatus: 'failed'})
  expect((await service.detail(frozen.requestId)).run.recordingAssetId).toBeUndefined();
  expect(await service.complete(frozen.requestId, frozen.hostId)).toMatchObject({entityId: frozen.requestId, payloadSha256: originalDigest});
  const refused = {...frozen, result: {...frozen.result, steps: frozen.result.steps.map(step => ({...step,
    recordingLocation: {...step.recordingLocation, assetId: 'foreign-recording'}}))}};
  expect(frameworkRunSchema.safeParse(refused).success).toBe(false);
  await expect(service.ingest(refused, frozen.hostId)).rejects.toThrow('custom at result.steps.0.recordingLocation');
  await expect(service.ingest({...frozen, result: {...frozen.result, steps: frozen.result.steps.map(step => ({...step,
    recordingLocation: {...step.recordingLocation, startOffsetMs: step.recordingLocation!.startOffsetMs + 1}}))}}, frozen.hostId))
    .rejects.toThrow('different terminal result');
})
