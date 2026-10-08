import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {afterEach, beforeEach, expect, spyOn, test} from "bun:test";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestRunModel} from "../models/test-run.model";
import {TestRequestModel} from "../models/test-request.model";
import {TestSuiteService, terminalNightlySummary, suiteHistoryProjection} from "./test-suite.service";
import {requestInputDigest} from "./test-request.service";
import {NightlyRoutineService, type NightlyPlan, type NightlyResult} from "./nightly-routine.service";
import {testSuiteSchema} from "../types/test-suite.types";
import {createRecordedFrameworkRunSummaryProjection} from "./framework-run-summary.service";
const mocks: {mockRestore(): void}[] = [];
beforeEach(() => {
  mocks.push(spyOn(TestRequestModel, "find").mockReturnValue({select() {return this;}, limit() {return this;},
    read() {return this;}, readConcern() {return this;}, lean: async () => []} as any));
});
afterEach(() => {for (const mock of mocks.splice(0)) mock.mockRestore();});
test("terminal list summaries preserve original verdicts and refuse contradictory displayed bindings", () => {
  const suite = testSuiteSchema.parse({suiteId: "compact-terminal", channel: "dev", trigger: "nightly", startedAt: "2026-10-07T11:00:00Z",
    build: {headSha: "a".repeat(40)}, members: [
      {memberId: "one", requestId: "one", routineId: "notes", platform: "ios-on-mac"},
      {memberId: "two", requestId: "two", routineId: "camera", platform: "android"},
    ]});
  const members = suite.members.map(member => ({...member, requestId: member.requestId!, definitionRevision: "b".repeat(40),
    routineRevision: "b".repeat(40), hostId: "mini", laneId: member.platform, build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: suite.build.headSha}}));
  const plan = {suiteId: suite.suiteId, occurrenceId: "compact-occurrence", startedAt: suite.startedAt, trigger: suite.trigger, members};
  const result = {...plan, expectedCount: 2, finishedAt: "2026-10-07T12:00:00Z", members: members.map((member, index) => ({...member,
    status: index === 0 ? "pass" : "incomplete", publicationComplete: index === 0,
    ...(index === 1 ? {unavailableReason: "No compatible lane was available", rejectedAt: "2026-10-07T11:30:00Z"} : {}),
    ...(index === 0 ? {runId: member.requestId, preparedLaneId: member.laneId,
      runStartedAt: suite.startedAt, runFinishedAt: "2026-10-07T11:02:00Z"} : {})}))};
  const before = JSON.stringify(result);
  expect(terminalNightlySummary(suite, plan, result)).toMatchObject({outcome: "failed", passed: 1,
    members: [{status: "pass", publicationComplete: true}, {status: "not-run", publicationComplete: false, unavailableReason: "No compatible lane was available", rejectedAt: "2026-10-07T11:30:00Z"}]});
  expect(JSON.stringify(result)).toBe(before);
  for (const mutate of [
    (r: typeof result) => {r.members[0]!.requestId = "foreign";},
    (r: typeof result) => {r.members[0]!.definitionRevision = "c".repeat(40);},
    (r: typeof result) => {r.members[0]!.build.headSha = "c".repeat(40);},
    (r: typeof result) => {r.members[0]!.hostId = "other";},
    (r: typeof result) => {r.members[0]!.preparedLaneId = "android";},
    (r: typeof result) => {r.members[0]!.runId = undefined;},
    (r: typeof result) => {r.members[0]!.status = "waiting";},
    (r: typeof result) => {r.members[0]!.publicationComplete = false; r.members[0]!.runId = undefined;},
    (r: typeof result) => {r.members[1]!.memberId = r.members[0]!.memberId;},
  ]) {
    const changed = structuredClone(result); mutate(changed);
    expect(() => terminalNightlySummary(suite, plan, changed)).toThrow("frozen membership");
  }
  // Selection failure legitimately has no admitted request or prepared lane.
  const unadmitted = structuredClone(suite); delete unadmitted.members[1]!.requestId;
  expect(terminalNightlySummary(unadmitted, plan, result)).toMatchObject({passed: 1, members: [{status: "pass"}, {status: "not-run"}]});
});
test('historical suite member results remain readable without routine or framework provenance', async () => {
  const startedAt = '2026-10-01T11:00:00Z', finishedAt = '2026-10-01T11:01:00Z';
  const run = {schemaVersion: 1, hostId: 'mini', requestId: 'old-member', routineId: 'notes', definitionRevision: 'a'.repeat(40),
    platform: 'ios-on-mac', laneId: 'mac', build: {repository: 'Mentra-Community/MentraOS', headSha: 'b'.repeat(40), channel: 'dev'},
    startedAt, finishedAt, assets: [], result: {runId: 'old-member', finishedAt, setup: {status: 'passed'}, test: 'passed',
      steps: [{id: 'observe', status: 'passed', durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt, setupMs: 0, testMs: 1, teardownMs: 0}}};
  const payload = {suiteId: 'historical-suite', channel: 'dev', trigger: 'nightly', startedAt, build: {headSha: 'b'.repeat(40)},
    members: [{memberId: 'mac', requestId: run.requestId, routineId: 'notes', platform: 'ios-on-mac', definitionRevision: run.definitionRevision}]};
  const before = JSON.stringify(run);
  mocks.push(spyOn(TestSuiteModel, 'findOne').mockReturnValue({read() {return this;}, readConcern() {return this;},
    async lean() {return {payload};}} as any));
  mocks.push(spyOn(TestRunModel, 'find').mockReturnValue({select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;},
    async lean() {return [{payload: run, uploadsComplete: true}];}} as any));
  const result = await new TestSuiteService().detail(payload.suiteId);
  expect(result.members[0]).toMatchObject({runId: run.requestId, status: 'pass', publicationComplete: true, hostId: 'mini', laneId: 'mac'});
  expect(JSON.stringify(run)).toBe(before);
});
test("query overflow refuses a verdict rather than truncating duplicate evidence", async () => {
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;}, lean: async () => ({payload: {suiteId: "nightly-1", members: [{memberId: "mac", requestId: "req"}]}})} as any));
  const query = {select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;}, lean: async () => Array.from({length: 201}, () => ({}))};
  mocks.push(spyOn(TestRunModel, "find").mockReturnValue(query as any));
  await expect(new TestSuiteService().detail("nightly-1")).rejects.toThrow("no verdict available");
});
test("suite creation retries preserve the frozen plan and use durable writes", async () => {
  const {testSuiteSchema} = await import("../types/test-suite.types");
  const {requestInputDigest} = await import("./test-request.service");
  const payload = testSuiteSchema.parse({suiteId: "nightly-retry", channel: "dev", trigger: "nightly",
    startedAt: "2026-10-01T11:00:00Z", build: {headSha: "a".repeat(40)},
    members: [{memberId: "mac", routineId: "captions-phone", platform: "ios-on-mac"},
      {memberId: "android", routineId: "captions-phone", platform: "android"}]});
  const row = {payload, payloadSha256: requestInputDigest(payload)};
  mocks.push(spyOn(TestSuiteModel, "create").mockImplementation((async (rows: any, options: any) => {
    expect(options.writeConcern).toEqual({w: "majority", j: true, wtimeout: 10000});
    expect(rows[0].startedAt).toEqual(new Date(payload.startedAt));
    throw Object.assign(new Error("duplicate"), {code: 11000});
  }) as any));
  const query = {read(value: string) {expect(value).toBe("primary"); return this;},
    readConcern(value: string) {expect(value).toBe("majority"); return this;}, lean: async () => row};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any));
  const service = new TestSuiteService();
  mocks.push(spyOn(service, "detail").mockImplementation(async () => ({...payload, members: payload.members,
    passed: 0, outcome: "running", failedRoutines: []}) as any));
  await service.create(payload);
  await expect(service.create({...payload, build: {headSha: "b".repeat(40)}})).rejects.toThrow("different plan");
});

test("new suites reject a single declared member before writing", async () => {
  const writes = spyOn(TestSuiteModel, "create"); mocks.push(writes);
  await expect(new TestSuiteService().create({suiteId: "single-job", channel: "local", trigger: "manual",
    startedAt: "2026-10-03T19:00:00Z", build: {headSha: "a".repeat(40)},
    members: [{memberId: "mac", routineId: "notes", platform: "ios-on-mac"}]})).rejects.toThrow("invalid test suite");
  expect(writes).not.toHaveBeenCalled();
});

test("suite labels require multiple declared members and retain exact member identity", async () => {
  const member = {memberId: "mac", requestId: "request:mac.v2", routineId: "notes.search_v2", platform: "ios-on-mac" as const};
  const single = {suiteId: "single-job", channel: "local", trigger: "manual", build: {headSha: "a".repeat(40)}, members: [member]};
  const multiple = {...single, suiteId: "suite:nightly.v2", channel: "dev", trigger: "nightly", members: [
    {...member, headSha: "b".repeat(40)}, {memberId: "unstarted", routineId: "ota", platform: "android" as const},
  ]};
  const find = spyOn(TestSuiteModel, "find").mockImplementation(((filter: unknown) => {
    expect(filter).toEqual({"payload.members.1": {$exists: true}, "payload.members.requestId": {$in: [member.requestId]}});
    return {select() {return this;}, limit() {return this;}, lean: async () => [{payload: single}, {payload: multiple}]};
  }) as any); mocks.push(find);
  expect(await new TestSuiteService().labels([member.requestId])).toEqual({labels: [{...multiple.members[0],
    suiteId: multiple.suiteId, channel: "dev", headSha: "b".repeat(40), label: "dev nightly · aaaaaaa"}]});
});

test("suite index excludes single-member jobs and includes an unstarted declared second member", async () => {
  const find = spyOn(TestSuiteModel, "find").mockImplementation(((filter: unknown) => {
    expect(filter).toEqual({"payload.members.1": {$exists: true}});
    return {sort() {return this;}, select() {return this;}, limit() {return this;}, lean: async () => [
      {suiteId: "single-job", payload: {members: [{memberId: "mac", requestId: "request"}]}},
      {suiteId: "multiple-job", payload: {members: [{memberId: "mac", requestId: "request"}, {memberId: "unstarted"}]}},
    ]};
  }) as any); mocks.push(find);
  const service = new TestSuiteService();
  const detail = spyOn(service, "detail").mockResolvedValue({suiteId: "multiple-job"} as any); mocks.push(detail);
  expect(await service.list()).toEqual({suites: [{suiteId: "multiple-job"}] as any});
  expect(detail).toHaveBeenCalledTimes(1);
  expect(detail).toHaveBeenCalledWith("multiple-job");
});

test("finished suite stays frozen when later member evidence arrives", async () => {
  const completedResult = {suiteId: "finished", outcome: "failed", members: [], passed: 0};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => ({completedResult})};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any));
  const reads = spyOn(TestRunModel, "find"); mocks.push(reads);
  expect(await new TestSuiteService().detail("finished")).toEqual(completedResult as any);
  expect(reads).not.toHaveBeenCalled();
});

test("completion fences a concurrent binding and retries preserve the first verdict", async () => {
  const payload = {suiteId: "fenced", channel: "dev", trigger: "nightly", startedAt: "2026-10-01T11:00:00Z",
    build: {headSha: "a".repeat(40)}, members: [{memberId: "mac", routineId: "captions-phone", platform: "ios-on-mac"}]};
  const row: any = {payload};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => row};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any));
  const runQuery = {select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;}, lean: async () => []};
  mocks.push(spyOn(TestRunModel, "find").mockReturnValue(runQuery as any));
  const updates: any[] = [];
  mocks.push(spyOn(TestSuiteModel, "updateOne").mockImplementation((async (filter: any, update: any) => {
    updates.push(filter);
    if (update.$set.finalizingAt && !row.finalizingAt) {
      // Binding wins just before the fence: final evidence must see it.
      row.payload.members[0].requestId = "concurrent-request";
      row.finalizingAt = update.$set.finalizingAt;
    }
    if (update.$set.completedResult && !row.completedResult) Object.assign(row, update.$set);
    return {modifiedCount: 1};
  }) as any));
  const service = new TestSuiteService();
  const result = await service.complete("fenced", {finishedAt: "2026-10-01T11:03:00Z"});
  expect(result.members[0]!.requestId).toBe("concurrent-request");
  expect(result.members[0]!.status).toBe("not-run");
  expect(updates[0].finalizingAt).toEqual({$exists: false});
  expect(await service.complete("fenced", {finishedAt: "2026-10-01T12:00:00Z"})).toEqual(result);
  expect(updates).toHaveLength(2);
});

test("persisted suite completion lists passing members with incomplete publication", async () => {
  const payload = {suiteId: "pending-publish", channel: "dev", trigger: "nightly", startedAt: "2026-10-01T11:00:00Z",
  build: {headSha: "a".repeat(40)}, members: [{memberId: "mac", requestId: "request", routineId: "notes", platform: "ios-on-mac"}]};
  const row: any = {payload};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => row};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any));
  const run = {
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: "mini",
    requestId: "request",
    routineId: "notes",
    definitionRevision: "a".repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", headSha: "a".repeat(40), channel: "dev"},
    startedAt: payload.startedAt,
    finishedAt: "2026-10-01T11:01:00Z",
    assets: [],
    result: {runId: "request", finishedAt: "2026-10-01T11:01:00Z", setup: {status: "passed"}, test: "passed", steps: [{id: "one", status: "passed", durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: [], timing: {startedAt: payload.startedAt, setupMs: 1, testMs: 1, teardownMs: 1}},
  }
  const runs = {select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;}, lean: async () => [{payload: run, uploadsComplete: false}]};
  mocks.push(spyOn(TestRunModel, "find").mockReturnValue(runs as any));
  mocks.push(spyOn(TestSuiteModel, "updateOne").mockImplementation((async (_filter: any, update: any) => {
  Object.assign(row, update.$set);return {modifiedCount: 1};
 }) as any));
  const result = await new TestSuiteService().complete(payload.suiteId, {finishedAt: "2026-10-01T11:03:00Z"});
  expect(result.outcome).toBe("failed");
  expect(result.members[0]!.status).toBe("pass");
  expect(result.failedRoutines).toEqual(["notes"]);
  expect(row.completedResult).toEqual(result);
})

test("suite rejection projects the exact request reason without fabricating a run", async () => {
  const input = {
    routineId: "another-product",
    platform: "android",
    definitionRevision: "a".repeat(40),
    laneId: "phone",
    resources: [],
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
  }
  const {requestInputDigest} = await import("./test-request.service"), inputSha256 = requestInputDigest(input);
  const payload = {suiteId: "rejected-suite", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T11:00:00Z", build: {headSha: input.build.headSha},
    members: [{memberId: "phone", requestId: "rejected-request", routineId: input.routineId, platform: input.platform, definitionRevision: input.definitionRevision},
      {memberId: "other", routineId: "other-product", platform: "android"}]};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;}, lean: async () => ({payload})} as any));
  mocks.push(spyOn(TestRunModel, "find").mockReturnValue({select() {return this;}, limit() {return this;},
    read() {return this;}, readConcern() {return this;}, lean: async () => []} as any));
  const rejection = {requestId: "rejected-request", hostId: "mini", inputSha256, rejectedAt: "2026-10-03T11:01:00Z",
    code: "missing-definition", reason: "Selected source is not installed."};
  const row = {requestId: rejection.requestId, hostId: rejection.hostId, inputSha256, input, state: "terminal", terminalStatus: "not-run", hostRejection: rejection};
  mocks.push(spyOn(TestRequestModel, "find").mockReturnValue({select() {return this;}, limit() {return this;},
    read() {return this;}, readConcern() {return this;}, lean: async () => [row]} as any));
  const result = await new TestSuiteService().detail(payload.suiteId);
  expect(result.members[0]).toMatchObject({status: "not-run", publicationComplete: false,
    unavailableReason: "missing-definition: Selected source is not installed.", rejectedAt: rejection.rejectedAt, hostId: "mini", laneId: "phone"});
  expect(result.members[0]!.runId).toBeUndefined();
  expect(result.passed).toBe(0);
  row.hostRejection.inputSha256 = "c".repeat(64);
  await expect(new TestSuiteService().detail(payload.suiteId)).rejects.toThrow("rejection identity");
})

test("a live nightly keeps waiting members out of failed routines and its terminal receipt retains missing outcomes", async () => {
  const payload = testSuiteSchema.parse({suiteId: "live-nightly", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T11:00:00Z",
    build: {headSha: "a".repeat(40)}, members: [
      {memberId: "phone", requestId: "phone-request", routineId: "phone-product", platform: "android", definitionRevision: "b".repeat(40)},
      {memberId: "desktop", requestId: "desktop-request", routineId: "desktop-product", platform: "ios-on-mac", definitionRevision: "b".repeat(40)},
    ]});
  const plan: NightlyPlan = {occurrenceId: "live-occurrence", suiteId: payload.suiteId, startedAt: payload.startedAt, trigger: "nightly", suite: payload,
    members: payload.members.map(member => {
      const build = {repository: "Mentra-Community/MentraOS" as const, headSha: payload.build.headSha, channel: "dev" as const,
        kind: member.platform === "android" ? "android-apk" as const : "mac-ci-package" as const,
        source: {channel: "dev" as const, buildRunId: 21, publicationAttempt: 2},
        archive: {name: "app", url: "https://artifactscdn.mentraglass.com/app", size: 100, sha256: "c".repeat(64)},
        receipt: {url: "https://artifactscdn.mentraglass.com/receipt", size: 100, sha256: "d".repeat(64)}};
      return {...member, requestId: member.requestId!, definitionRevision: member.definitionRevision!, routineRevision: member.definitionRevision!,
        hostId: "mini", build, dispatchIntent: {requestId: member.requestId!, routineId: member.routineId, platform: member.platform,
          routineRevision: member.definitionRevision!, laneId: member.platform, source: build.source, build}};
    })};
  const result: NightlyResult = {occurrenceId: plan.occurrenceId, suiteId: plan.suiteId, startedAt: plan.startedAt, trigger: plan.trigger,
    members: plan.members.map(member => ({...member, status: "waiting", publicationComplete: false})), expectedCount: 2, passed: 0, status: "running"};
  const row: {payload: typeof payload; nightlyPlan: NightlyPlan; nightlyResult?: NightlyResult} = {payload, nightlyPlan: plan};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;}, lean: async () => row} as any));
  const liveDetail = spyOn(NightlyRoutineService.prototype, "detail").mockResolvedValue(result); mocks.push(liveDetail);
  const service = new TestSuiteService();
  expect(await service.detail(plan.suiteId)).toMatchObject({outcome: "running", passed: 0, failedRoutines: [], members: [
    {status: "waiting"}, {status: "waiting"},
  ]});
  const prepared = plan.members[0]!;
  const input = {routineId: prepared.routineId, platform: prepared.platform, definitionRevision: prepared.routineRevision,
    routineSource: testRoutineSource(prepared.routineRevision), laneId: prepared.dispatchIntent!.laneId, resources: [], build: prepared.build!};
  result.members[0]!.input = input; result.members[0]!.inputSha256 = requestInputDigest(input);
  result.members[0]!.status = "failed"; result.members[0]!.publicationComplete = true;
  expect((await service.detail(plan.suiteId)).failedRoutines).toEqual(["phone-product"]);
  expect(liveDetail).toHaveBeenCalledTimes(2);
  result.finishedAt = "2026-10-03T14:00:00Z"; result.status = "incomplete"; result.members[1]!.status = "incomplete";
  row.nightlyResult = result;
  expect(await service.detail(plan.suiteId)).toMatchObject({outcome: "failed", passed: 0, failedRoutines: ["phone-product", "desktop-product"],
    members: [{status: "failed"}, {status: "not-run"}]});
  expect(liveDetail).toHaveBeenCalledTimes(2);
});

test("suite completion refuses empty or single nightly occurrences before delegating or writing", async () => {
  const complete = spyOn(NightlyRoutineService.prototype, "complete"); mocks.push(complete);
  const write = spyOn(TestSuiteModel, "updateOne"); mocks.push(write);
  for (const payload of [undefined, {members: []}, {members: [{memberId: "single"}]}]) {
    const find = spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;},
      lean: async () => ({payload, nightlyPlan: {occurrenceId: "not-suite", startedAt: "2026-10-03T11:00:00Z"}})} as any);
    try {await expect(new TestSuiteService().complete("not-suite", {finishedAt: "2026-10-03T14:00:00Z"})).rejects.toThrow("no multi-member test suite");}
    finally {find.mockRestore();}
  }
  expect(complete).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
test("nightly projection exposes only prepared source and preserves full frozen firmware references", async () => {
  const {nightlySuiteProjection} = await import("./test-suite.service");
  const manifest = {url: "https://artifactscdn.mentraglass.com/exact/firmware.json", size: 100, sha256: "c".repeat(64)};
  const build = {repository: "Mentra-Community/MentraOS" as const, headSha: "a".repeat(40), channel: "dev" as const, kind: "android-apk" as const,
    source: {channel: "dev" as const, buildRunId: 21, publicationAttempt: 2},
    archive: {name: "app", url: "https://artifactscdn.mentraglass.com/app", size: 100, sha256: "d".repeat(64)},
    receipt: {url: "https://artifactscdn.mentraglass.com/receipt", size: 100, sha256: "e".repeat(64)}, manifest, manifestSha256: manifest.sha256};
  const suite = testSuiteSchema.parse({suiteId: "firmware-nightly", channel: "dev", trigger: "nightly", startedAt: "2026-10-06T11:00:00Z",
    build: {headSha: build.headSha}, members: [{memberId: "admitted", requestId: "one", routineId: "camera", platform: "android"},
      {memberId: "unadmitted", requestId: "two", routineId: "camera-two", platform: "android"}]});
  const members = suite.members.map(member => ({...member, requestId: member.requestId!, platform: "android" as const,
    routineRevision: "a".repeat(40), definitionRevision: "a".repeat(40), hostId: "mini", build,
    dispatchIntent: {requestId: member.requestId!, routineId: member.routineId, platform: "android" as const, routineRevision: "a".repeat(40),
      laneId: "lane", source: build.source, build}}));
  const plan: NightlyPlan = {occurrenceId: "firmware-occurrence", suiteId: suite.suiteId, startedAt: suite.startedAt, trigger: "nightly", suite, members};
  const input = {routineId: "camera", definitionRevision: "a".repeat(40), routineSource: testRoutineSource("a".repeat(40)),
    platform: "android" as const, laneId: "lane", resources: [], build};
  const result: NightlyResult = {occurrenceId: plan.occurrenceId, suiteId: suite.suiteId, startedAt: suite.startedAt, trigger: "nightly",
    members: members.map((member, index) => ({...member, status: "setup-failed", publicationComplete: false,
      ...(index === 0 ? {input, inputSha256: requestInputDigest(input)} : {})})), expectedCount: 2, passed: 0, status: "running"};
  const projection = nightlySuiteProjection(suite, plan, result);
  expect(projection.members).toEqual(expect.arrayContaining([
    expect.objectContaining({memberId: "admitted", hostId: "mini", laneId: "lane"}),
    expect.objectContaining({memberId: "unadmitted", hostId: "mini", laneId: "lane"}),
  ]));
  expect((projection.members[0] as any).build.manifest).toEqual(manifest);
  expect((projection.members[1] as any).build.manifest).toEqual(manifest);
  expect((projection.members[0] as any).routineSource).toEqual(input.routineSource);
  expect((projection.members[1] as any).routineSource).toBeUndefined();
  expect((projection.members[1] as any).routineRevision).toBe("a".repeat(40));
  for (const altered of [{...input, definitionRevision: "b".repeat(40), routineSource: testRoutineSource("b".repeat(40))},
    {...input, build: {...build, source: {...build.source, publicationAttempt: 3}}}]) {
    const changed = structuredClone(result);
    changed.members[0]!.input = altered;
    changed.members[0]!.inputSha256 = requestInputDigest(altered);
    expect(() => nightlySuiteProjection(suite, plan, changed)).toThrow("frozen input");
  }
});


test("ordinary waiting members expose exact queued and preparing lane bindings before a run exists", async () => {
  const input = {routineId: "notes", platform: "ios-on-mac", definitionRevision: "a".repeat(40), laneId: "mac", resources: [],
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
  const source = {channel: "dev", buildRunId: 21, publicationAttempt: 1};
  const build = {...input.build, kind: "android-apk", source,
    archive: {name: "app", url: "https://artifactscdn.mentraglass.com/app", size: 10, sha256: "c".repeat(64)},
    receipt: {url: "https://artifactscdn.mentraglass.com/receipt", size: 10, sha256: "d".repeat(64)}};
  const intent = {requestId: "preparing", routineId: "captions", platform: "android", routineRevision: "a".repeat(40), laneId: "android", source, build};
  const payload = {suiteId: "waiting-lanes", channel: "dev", trigger: "manual", startedAt: "2026-10-07T11:00:00Z", build: {headSha: input.build.headSha},
    members: [{memberId: "mac", requestId: "queued", routineId: input.routineId, platform: input.platform, definitionRevision: input.definitionRevision},
      {memberId: "android", requestId: intent.requestId, routineId: intent.routineId, platform: intent.platform, definitionRevision: intent.routineRevision}]};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;}, lean: async () => ({payload})} as any));
  mocks.push(spyOn(TestRunModel, "find").mockReturnValue({select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;}, lean: async () => []} as any));
  const requests = [{requestId: "queued", hostId: "mini", input, inputSha256: requestInputDigest(input), state: "queued"},
    {requestId: intent.requestId, hostId: "second-host", dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent), state: "preparing"}];
  mocks.push(spyOn(TestRequestModel, "find").mockReturnValue({select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;}, lean: async () => requests} as any));
  const result = await new TestSuiteService().detail(payload.suiteId);
  expect(result.members).toEqual([expect.objectContaining({status: "waiting", hostId: "mini", laneId: "mac"}),
    expect.objectContaining({status: "waiting", hostId: "second-host", laneId: "android"})]);
  expect(result.passed).toBe(0);
  expect(result.members.every(member => !member.runId)).toBe(true);
  requests[0]!.inputSha256 = "f".repeat(64);
  requests[1]!.dispatchIntentSha256 = "f".repeat(64);
  const mismatched = await new TestSuiteService().detail(payload.suiteId);
  expect(mismatched.members.every(member => !("hostId" in member) && !("laneId" in member))).toBe(true);
});

test("request location enriches an old completion without changing its frozen verdict or reading later runs", async () => {
  const input = {routineId: "notes", platform: "ios-on-mac", definitionRevision: "a".repeat(40), laneId: "mac", resources: [],
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
  const frozen = {suiteId: "old-location", channel: "dev", trigger: "manual", startedAt: "2026-10-07T11:00:00Z", finishedAt: "2026-10-07T11:01:00Z",
    build: {headSha: input.build.headSha}, outcome: "failed", passed: 0, failedRoutines: [input.routineId],
    members: [{memberId: "mac", requestId: "old-request", routineId: input.routineId, platform: input.platform, definitionRevision: input.definitionRevision,
      status: "not-run", publicationComplete: false}]};
  const before = JSON.stringify(frozen);
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;}, lean: async () => ({completedResult: frozen})} as any));
  const request = {requestId: "old-request", hostId: "mini", input, inputSha256: requestInputDigest(input)};
  mocks.push(spyOn(TestRequestModel, "find").mockReturnValue({select() {return this;}, limit() {return this;}, read() {return this;}, readConcern() {return this;}, lean: async () => [request]} as any));
  const reads = spyOn(TestRunModel, "find"); mocks.push(reads);
  const result = await new TestSuiteService().detail(frozen.suiteId);
  expect(result).toEqual({...frozen, members: [{...frozen.members[0], hostId: "mini", laneId: "mac"}]} as any);
  expect(JSON.stringify(frozen)).toBe(before);
  expect(reads).not.toHaveBeenCalled();
  request.input = {...input, build: {...input.build, headSha: "c".repeat(40)}};
  request.inputSha256 = requestInputDigest(request.input);
  expect(await new TestSuiteService().detail(frozen.suiteId)).toEqual(frozen as any);
});

test('history summaries read portable members through the real nightly snapshot and retain bound preparation location', async () => {
 const source={channel:'dev' as const,buildRunId:21,publicationAttempt:1},build={repository:'Mentra-Community/MentraOS' as const,
  channel:'dev' as const,headSha:'b'.repeat(40),kind:'android-apk' as const,source,
  archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',size:100,sha256:'c'.repeat(64)},
  receipt:{url:'https://artifactscdn.mentraglass.com/receipt.json',size:30,sha256:'d'.repeat(64)}};
 const suite=testSuiteSchema.parse({suiteId:'portable-summary',channel:'dev',trigger:'nightly',startedAt:'2026-10-08T00:00:00Z',
  build:{headSha:build.headSha},members:[{memberId:'one',requestId:'one',routineId:'camera',platform:'android',definitionRevision:'a'.repeat(40)},
   {memberId:'two',requestId:'two',routineId:'settings',platform:'android',definitionRevision:'a'.repeat(40)}]});
 const members=suite.members.map(member=>({...member,requestId:member.requestId!,platform:'android' as const,routineRevision:'a'.repeat(40),
  definitionRevision:'a'.repeat(40),build,selection:{requestId:member.requestId!,routineId:member.routineId,platform:'android' as const,
   routineRevision:'a'.repeat(40),source,build}}));
 const binding={jobId:'two',requestId:'two',hostId:'second-host',laneId:'android',descriptorRevision:'e'.repeat(64),
  actionsRunId:'10',actionsJobId:'20',boundAt:'2026-10-08T00:01:00Z'};
 const intent={...members[1]!.selection,laneId:binding.laneId,routineSource:testRoutineSource('a'.repeat(40))};
 const requests=[{requestId:'one',state:'awaiting-source',fleetSelection:members[0]!.selection,
  fleetSelectionSha256:requestInputDigest(members[0]!.selection)},
  {requestId:'two',state:'preparing',hostId:binding.hostId,fleetSelection:members[1]!.selection,
   fleetSelectionSha256:requestInputDigest(members[1]!.selection),fleetBinding:binding,dispatchIntent:intent,dispatchIntentSha256:requestInputDigest(intent)}];
 const compactBuild={repository:build.repository,channel:build.channel,headSha:build.headSha};
 // Emulate the actual Mongo history projection, rather than supplying the unprojected plan.
 let terminal=false;
 const projected=()=>({suiteId:suite.suiteId,payload:suite,nightlyPlan:{suiteId:suite.suiteId,occurrenceId:'portable-occurrence',
  startedAt:suite.startedAt,trigger:'nightly',members:members.map(member=>({...member,portable:true,build:compactBuild,
   ...(terminal?{selection:undefined}:{selection:member.selection})}))},
  ...(terminal?{nightlyResult:{suiteId:suite.suiteId,occurrenceId:'portable-occurrence',startedAt:suite.startedAt,trigger:'nightly',
   finishedAt:'2026-10-08T03:00:00Z',expectedCount:2,members:members.map((member,index)=>({memberId:member.memberId,
    requestId:member.requestId,routineId:member.routineId,platform:member.platform,definitionRevision:member.definitionRevision,
    routineRevision:member.routineRevision,portable:true,build:compactBuild,status:'incomplete',publicationComplete:false,
    ...(index===1?{hostId:binding.hostId,laneId:binding.laneId,binding}:{})}))}}:{})});
 mocks.push(spyOn(TestSuiteModel,'aggregate').mockImplementation(((pipeline:unknown[])=>{
  expect(pipeline[2]).toEqual(suiteHistoryProjection);
  return {read(){return this},readConcern(){return this},option(){return this},async exec(){return [projected()]}};
 }) as any));
 const queried:string[][]=[];
 mocks.push(spyOn(TestRequestModel,'find').mockImplementation(((filter:{requestId:{$in:string[]}})=>{
  queried.push(filter.requestId.$in);return {select(){return this},limit(){return this},read(){return this},readConcern(){return this},
   setOptions(){return this},async lean(){return requests}};
 }) as any));
 let publishedRows:unknown[]=[];
 const runReads=spyOn(TestRunModel,'find').mockReturnValue({select(){return this},limit(){return this},read(){return this},
  readConcern(){return this},setOptions(){return this},async lean(){return publishedRows}} as any);mocks.push(runReads);
 const service=new TestSuiteService(),first=(await service.summaries([suite.suiteId],Date.now()+5000)).get(suite.suiteId);
 expect(queried).toEqual([['one','two']]);expect(first).not.toBeInstanceOf(Error);
 expect(first).toMatchObject({outcome:'running',passed:0,members:[{status:'waiting',requestId:'one'},
  {status:'waiting',requestId:'two',hostId:binding.hostId,laneId:binding.laneId}]});
 const input={routineId:intent.routineId,platform:intent.platform,definitionRevision:intent.routineRevision,
  routineSource:intent.routineSource,laneId:intent.laneId,resources:[],build};
 Object.assign(requests[1]!,{state:'accepted',input,inputSha256:requestInputDigest(input)});
 const executable=(await service.summaries([suite.suiteId],Date.now()+5000)).get(suite.suiteId);
 expect(executable).not.toBeInstanceOf(Error);
 expect(executable).toMatchObject({outcome:'running',passed:0,members:[{status:'waiting'},
  {status:'waiting',hostId:binding.hostId,laneId:binding.laneId}]});
 const finishedAt='2026-10-08T00:02:00Z';
 const run={schemaVersion:1,requestId:'two',hostId:binding.hostId,routineId:intent.routineId,
  definitionRevision:intent.routineRevision,routineSource:intent.routineSource,frameworkBinding:testFrameworkBinding(),
  platform:'android',laneId:binding.laneId,build,startedAt:binding.boundAt,finishedAt,assets:[],
  result:{runId:'two',finishedAt,setup:{status:'passed'},test:'passed',steps:[{id:'observe',status:'passed',durationMs:1}],
   teardown:{ready:true,outcomes:[],errors:[],unavailableResources:[]},failures:[],evidence:[],
   timing:{startedAt:binding.boundAt,setupMs:0,testMs:1,teardownMs:0}}};
 const payloadSha256=requestInputDigest(run);
 publishedRows=[{runId:'two',requestId:'two',payloadSha256,uploadsComplete:true,payload:{build},
  summaryProjection:createRecordedFrameworkRunSummaryProjection(run,payloadSha256)}];
 Object.assign(requests[0]!,{state:'terminal',fleetCancellation:{requestedAt:finishedAt,reason:'Occurrence cancelled before assignment.'}});
 const published=(await service.summaries([suite.suiteId],Date.now()+5000)).get(suite.suiteId);
 expect(published).not.toBeInstanceOf(Error);
 expect(published).toMatchObject({outcome:'running',passed:1,members:[{status:'not-run',publicationComplete:false},
  {status:'pass',publicationComplete:true,runId:'two',hostId:binding.hostId,laneId:binding.laneId}]});
 expect(queried.at(-1)).toEqual(['one','two']);
 terminal=true;const readsBefore=queried.length,runReadsBefore=runReads.mock.calls.length;
 const final=(await service.summaries([suite.suiteId],Date.now()+5000)).get(suite.suiteId);
 expect(final).toMatchObject({outcome:'failed',passed:0,members:[{status:'not-run'},{status:'not-run',hostId:binding.hostId,laneId:binding.laneId}]});
 expect(queried).toHaveLength(readsBefore);expect(runReads.mock.calls).toHaveLength(runReadsBefore);
});
