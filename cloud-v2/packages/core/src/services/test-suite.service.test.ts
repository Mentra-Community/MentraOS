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
  const {canonical} = await import("./test-run.service");
  const {createHash} = await import("node:crypto");
  const payload = testSuiteSchema.parse({suiteId: "nightly-retry", channel: "dev", trigger: "nightly",
    startedAt: "2026-10-01T11:00:00Z", build: {headSha: "a".repeat(40)},
    members: [{memberId: "mac", routineId: "captions-phone", platform: "ios-mac"}]});
  const row = {payload, payloadSha256: createHash("sha256").update(canonical(payload)).digest("hex")};
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

test("finished suite stays frozen when later member evidence arrives", async () => {
  const completedResult = {suiteId: "finished", outcome: "failed", members: [], passed: 0};
  const query = {read() {return this;}, readConcern() {return this;}, lean: async () => ({completedResult})};
  mocks.push(spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any));
  const reads = spyOn(TestRunModel, "find"); mocks.push(reads);
  expect(await new TestSuiteService().detail("finished")).toEqual(completedResult as any);
  expect(reads).not.toHaveBeenCalled();
});
