import {afterEach, beforeEach, expect, spyOn, test} from "bun:test";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestRunModel} from "../models/test-run.model";
import {TestRequestModel} from "../models/test-request.model";
import {TestSuiteService} from "./test-suite.service";
import {NightlyRoutineService, type NightlyPlan, type NightlyResult} from "./nightly-routine.service";
import {testSuiteSchema} from "../types/test-suite.types";
const mocks: {mockRestore(): void}[] = [];
beforeEach(() => {
  mocks.push(spyOn(TestRequestModel, "find").mockReturnValue({select() {return this;}, limit() {return this;},
    read() {return this;}, readConcern() {return this;}, lean: async () => []} as any));
});
afterEach(() => {for (const mock of mocks.splice(0)) mock.mockRestore();});
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
 const run = {schemaVersion: 1, hostId: "mini", requestId: "request", routineId: "notes", definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac",
  build: {repository: "Mentra-Community/MentraOS", headSha: "a".repeat(40), channel: "dev"}, startedAt: payload.startedAt, finishedAt: "2026-10-01T11:01:00Z", assets: [],
  result: {runId: "request", finishedAt: "2026-10-01T11:01:00Z", setup: {status: "passed"}, test: "passed", steps: [{id: "one", status: "passed", durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []}, failures: [], evidence: [], timing: {startedAt: payload.startedAt, setupMs: 1, testMs: 1, teardownMs: 1}}};
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
});

test("suite rejection projects the exact request reason without fabricating a run", async () => {
  const input = {routineId: "another-product", platform: "android", definitionRevision: "a".repeat(40), laneId: "phone",
    resources: [], build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
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
    unavailableReason: "missing-definition: Selected source is not installed.", rejectedAt: rejection.rejectedAt});
  expect(result.members[0]!.runId).toBeUndefined();
  expect(result.passed).toBe(0);
  row.hostRejection.inputSha256 = "c".repeat(64);
  await expect(new TestSuiteService().detail(payload.suiteId)).rejects.toThrow("rejection identity");
});

test("a live nightly keeps waiting members out of failed routines and its terminal receipt retains missing outcomes", async () => {
  const payload = testSuiteSchema.parse({suiteId: "live-nightly", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T11:00:00Z",
    build: {headSha: "a".repeat(40)}, members: [
      {memberId: "phone", requestId: "phone-request", routineId: "phone-product", platform: "android", definitionRevision: "b".repeat(40)},
      {memberId: "desktop", requestId: "desktop-request", routineId: "desktop-product", platform: "ios-on-mac", definitionRevision: "b".repeat(40)},
    ]});
  const plan: NightlyPlan = {occurrenceId: "live-occurrence", suiteId: payload.suiteId, startedAt: payload.startedAt, trigger: "nightly", suite: payload,
    members: payload.members.map(member => ({...member, requestId: member.requestId!, definitionRevision: member.definitionRevision!, definitionSha256: "c".repeat(64)}))};
  const result: NightlyResult = {occurrenceId: plan.occurrenceId, suiteId: plan.suiteId, startedAt: plan.startedAt, trigger: plan.trigger,
    members: plan.members.map(member => ({...member, status: "waiting", publicationComplete: false})), expectedCount: 2, passed: 0, status: "running"};
  const row: {payload: typeof payload; nightlyPlan: NightlyPlan; nightlyResult?: NightlyResult} = {payload, nightlyPlan: plan};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue({read() {return this;}, readConcern() {return this;}, lean: async () => row} as any));
  const liveDetail = spyOn(NightlyRoutineService.prototype, "detail").mockResolvedValue(result); mocks.push(liveDetail);
  const service = new TestSuiteService();
  expect(await service.detail(plan.suiteId)).toMatchObject({outcome: "running", passed: 0, failedRoutines: [], members: [
    {status: "waiting"}, {status: "waiting"},
  ]});
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
