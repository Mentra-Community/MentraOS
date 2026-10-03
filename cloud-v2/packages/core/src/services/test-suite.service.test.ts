import {afterEach, expect, spyOn, test} from "bun:test";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteService} from "./test-suite.service";
const mocks: {mockRestore(): void}[] = [];
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
  mocks.push(spyOn(TestSuiteModel, "create").mockImplementation((async (_rows: unknown, options: any) => {
    expect(options.writeConcern).toEqual({w: "majority", j: true, wtimeout: 10000});
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
