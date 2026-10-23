import {afterAll, beforeAll, describe, expect, spyOn, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {NightlyRoutineService, nightlyPlanRepository} from "./nightly-routine.service";
import {GithubTestBuildGateway} from "./test-builds.service";
import {TestSuiteService, suiteHistoryProjection} from "./test-suite.service";
import {TestSuiteModel} from "../models/test-suite.model";
import {TestHistoryService, testHistoryQueries} from "./test-history.service";

// Every gateway and database write is stubbed; a failed selection cannot admit device work.
test("a pre-selection 403 retains all 27 original members in suite detail, index and history", async () => {
  const occurrence = {occurrenceId: "nightly-403-original", startedAt: "2026-10-23T11:00:00Z", trigger: "nightly" as const};
  const revision = "a".repeat(40), finishedAt = "2026-10-23T11:18:34.000Z";
  const calls: {url: string; method: string}[] = [];
  let stored: any = null, admissionCalls = 0;
  const query = {read() {return this;}, readConcern() {return this;}, async lean() {return stored;}};
  const mocks: {mockRestore(): void}[] = [
    spyOn(TestSuiteModel, "findOne").mockReturnValue(query as any),
    spyOn(TestSuiteModel, "create").mockImplementation((async (rows: any[], options: any) => {
      expect(options.writeConcern).toEqual({w: "majority", j: true, wtimeout: 10000});
      stored = structuredClone(rows[0]); return rows;
    }) as any),
    spyOn(TestSuiteModel, "updateOne").mockImplementation((async (_filter: any, update: any, options: any) => {
      expect(options.writeConcern).toEqual({w: "majority", j: true, wtimeout: 10000});
      if (!stored.nightlyResult) Object.assign(stored, structuredClone(update.$set));
      return {modifiedCount: 1};
    }) as any),
  ];
  try {
    const gateway = new GithubTestBuildGateway({token: "test-only-token", fetch: (async (url: string, init: RequestInit) => {
      calls.push({url, method: init?.method ?? "GET"}); return new Response("forbidden", {status: 403});
    }) as typeof fetch});
    const forbidden = async () => {admissionCalls++; throw new Error("Unexpected admission or native evidence read");};
    const nightly = new NightlyRoutineService({async list() {return Array.from({length: 27}, (_, i) => ({routineId: `original-${i}`, platform: i % 2 ? "ios-on-mac" : "android"}));}} as any,
      gateway, {get: forbidden}, nightlyPlanRepository, {summary: forbidden}, () => Date.parse(finishedAt), () => {},
      {async resolve(_source, boundary) {expect(boundary).toBe(occurrence.startedAt); return revision;}},
      {submitFrozen: forbidden, cancelFrozen: forbidden, cancel: forbidden} as any);
    const {plan} = await nightly.start(occurrence), result = await nightly.complete(occurrence.occurrenceId);
    expect(plan.suite).toBeUndefined(); expect(plan.publication).toBeUndefined(); expect(stored.payload).toBeUndefined();
    expect(result).toMatchObject({expectedCount: 27, passed: 0, status: "incomplete", startedAt: occurrence.startedAt, finishedAt});
    expect(result.resultUrl).toBe(`https://admin.dev.mentraglass.com/?testSuite=${result.suiteId}`);
    expect(result.members.map(m => [m.memberId, m.requestId, m.routineId, m.platform, m.definitionRevision, m.selectionErrors]))
      .toEqual(plan.members.map(m => [m.memberId, m.requestId, m.routineId, m.platform, m.definitionRevision, m.selectionErrors]));
    expect(calls).toEqual([{url: "https://api.github.com/repos/Mentra-Community/MentraOS/actions/workflows/coordinated-release.yml/runs?branch=dev&created=<=2026-10-23T11%3A00%3A00Z&per_page=100&page=1", method: "GET"}]);
    expect(admissionCalls).toBe(0);
    const service = new TestSuiteService({overview: forbidden} as any), detail = await service.detail(result.suiteId);
    expect(detail).toMatchObject({suiteId: result.suiteId, passed: 0, outcome: "failed", finishedAt, startedAt: occurrence.startedAt});
    expect(detail.build).toBeUndefined(); expect(detail.members).toHaveLength(27);
    expect(detail.members.every(m => m.status === "incomplete" && !m.runId && !m.hostId && m.publicationComplete === false
      && m.unavailableReason === "Build metadata unavailable (HTTP 403)")).toBe(true);
    mocks.push(spyOn(TestSuiteModel, "find").mockImplementation(((filter: any) => {
      expect(filter).toEqual({$or: [{"payload.members.1": {$exists: true}}, {"nightlyPlan.members.1": {$exists: true}}]});
      return {sort() {return this;}, select() {return this;}, limit() {return this;}, lean: async () => [stored]};
    }) as any));
    expect((await service.list()).suites).toEqual([detail]);
    mocks.push(spyOn(TestSuiteModel, "aggregate").mockReturnValue({read() {return this;}, readConcern() {return this;}, option() {return this;}, exec: async () => [{...stored, nightlyPlan: {...stored.nightlyPlan, hasSuite: false, hasPublication: false,
      members: stored.nightlyPlan.members.map((m: any) => ({...m, admitted: ["build", "selection", "dispatchIntent", "input", "inputSha256", "binding", "hostId", "laneId", "preparedLaneId", "runId", "runStartedAt", "runFinishedAt", "evidenceStatus", "requiredResourceKinds", "assignmentEvidence"].some(key => m[key] !== undefined), portable: !!m.selection}))},
      ...(stored.nightlyResult ? {nightlyResult: {...stored.nightlyResult, hasSuite: false, hasPublication: false,
      members: stored.nightlyResult.members.map((m: any) => ({...m, admitted: ["build", "selection", "dispatchIntent", "input", "inputSha256", "binding", "hostId", "laneId", "preparedLaneId", "runId", "runStartedAt", "runFinishedAt", "evidenceStatus", "requiredResourceKinds", "assignmentEvidence"].some(key => m[key] !== undefined), portable: !!m.selection}))}} : {})}]} as any));
    expect(await service.summary(result.suiteId)).toEqual(detail);
    expect(testHistoryQueries(null, 20).suites[0]).toMatchObject({$match: {$and: [{$or: [{"payload.members.1": {$exists: true}}, {"nightlyPlan.members.1": {$exists: true}}]}]}});
    const history = new TestHistoryService(service, async () => [[], [{historyKind: "suite", historyId: result.suiteId, historyStartedAt: new Date(occurrence.startedAt)}]], {latestAttempts: async () => new Map()} as any);
    const entry = (await history.list()).entries[0];
    expect(entry).toMatchObject({kind: "suite", suiteId: result.suiteId, expectedCount: 27, passed: 0, failedCount: 0, comparison: {original: {incomplete: 27, total: 27}}, lanes: []});
    expect((entry as {build?: unknown}).build).toBeUndefined();
    const frozen = structuredClone(stored);
    delete stored.nightlyResult; delete stored.finishedAt;
    const open = await service.summary(result.suiteId);
    expect(open).toMatchObject({passed: 0, outcome: "running"}); expect(open.build).toBeUndefined();
    stored = structuredClone(frozen);
    for (const mutate of [
      (s: any) => {s.nightlyResult.members = null;},
      (s: any) => {s.nightlyPlan.members = [];},
      (s: any) => {s.nightlyPlan.suiteId = s.nightlyResult.suiteId = "foreign-suite";},
      (s: any) => {s.startedAt = new Date("2026-10-23T11:01:00Z");},
      (s: any) => {s.finishedAt = "2026-10-23T11:18:35.000Z";},
      (s: any) => {s.nightlyResult.startedAt = "2026-10-23T11:01:00Z";},
      (s: any) => {s.nightlyResult.members[0].routineId = "foreign-routine";},
      (s: any) => {s.nightlyResult.members[0].selectionErrors[0].message = "changed";},
      (s: any) => {s.nightlyResult.members[0].selectionErrors.push({stage: "build", message: "extra"});},
      (s: any) => {s.nightlyPlan.members[0].selectionErrors = []; s.nightlyResult.members[0].selectionErrors = [];},
      (s: any) => {s.nightlyResult.members[0].requestId = "foreign";},
      (s: any) => {s.nightlyResult.members[0].definitionRevision = "f".repeat(40);},
      (s: any) => {s.nightlyResult.members[0].status = "pass";},
      (s: any) => {s.nightlyResult.members[0].publicationComplete = true;},
      (s: any) => {s.nightlyResult.members[0].runId = s.nightlyResult.members[0].requestId;},
      (s: any) => {s.nightlyPlan.members[0].selection = {requestId: "unsafe"};},
      (s: any) => {s.nightlyResult.members[0].build = null;},
      (s: any) => {s.nightlyResult.members[0].hostId = "foreign-host";},
      (s: any) => {s.nightlyResult.members[0].input = {};},
      (s: any) => {s.nightlyPlan.publication = {headSha: "f".repeat(40)};},
      (s: any) => {s.nightlyResult.members[0].unavailableReason = "changed";},
      (s: any) => {s.nightlyResult.members[1].memberId = s.nightlyResult.members[0].memberId;},
      (s: any) => {s.nightlyResult.expectedCount = 26;},
      (s: any) => {s.nightlyResult.finishedAt = "2026-10-23T10:59:59Z";},
    ]) {
      stored = structuredClone(frozen); mutate(stored);
      await expect(service.detail(result.suiteId)).rejects.toThrow("differs from its frozen plan");
    }
    stored = structuredClone(frozen); stored.nightlyResult.members[0].runId = stored.nightlyResult.members[0].requestId;
    await expect(service.summary(result.suiteId)).rejects.toThrow("differs from its frozen plan");
    stored = structuredClone(frozen); stored.nightlyResult.members[0].selectionErrors[0].status = 401;
    await expect(service.summary(result.suiteId)).rejects.toThrow("differs from its frozen plan");
    stored = frozen; expect(await service.detail(result.suiteId)).toEqual(detail);
    expect(admissionCalls).toBe(0); expect(calls).toHaveLength(1);
  } finally {for (const mock of mocks.reverse()) mock.mockRestore();}
});

test("compact nightly history uses the two-argument MongoDB 4.2 $ifNull dialect", () => {
  let expressions = 0;
  const check = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ifNull") {expect(Array.isArray(child) && child.length === 2).toBe(true); expressions++;}
      check(child);
    }
  };
  check(suiteHistoryProjection);
  expect(expressions).toBeGreaterThan(0);
});

const mongoUri = process.env.TEST_HISTORY_MONGO_URI;
describe.skipIf(!mongoUri)("Mongo no-build nightly projection", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(mongoUri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("Nightly projection tests require plain loopback Mongo");
    url.pathname = `/nightly_selection_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, {autoIndex: false, serverSelectionTimeoutMS: 5000}); connected = true;
  });
  afterAll(async () => {if (connected) {await mongoose.connection.dropDatabase(); await mongoose.disconnect();}});
  test("the actual compact projection omits absent lanes but refuses recorded null claims", async () => {
    const startedAt = "2026-10-23T11:00:00.000Z", finishedAt = "2026-10-23T11:18:34.000Z", revision = "a".repeat(40);
    const members = Array.from({length: 27}, (_, i) => ({memberId: `member-${i}`, requestId: `request-${i}`, routineId: `routine-${i}`,
      platform: i % 2 ? "ios-on-mac" : "android", routineRevision: revision, definitionRevision: revision,
      unavailableReason: "Build metadata unavailable (HTTP 403)", selectionErrors: [{stage: "build", status: 502, message: "Build metadata unavailable (HTTP 403)"}]}));
    const plan = {suiteId: "no-build-mongo", occurrenceId: "no-build-mongo-occurrence", startedAt, trigger: "nightly", members};
    const result = {...plan, expectedCount: 27, passed: 0, status: "incomplete", finishedAt,
      members: members.map(m => ({...m, status: "incomplete", publicationComplete: false}))};
    const service = new TestSuiteService({overview: async () => {throw new Error("No lane read expected");}});
    for (const terminal of [false, true]) {
      await TestSuiteModel.collection.deleteMany({});
      await TestSuiteModel.collection.insertOne({suiteId: plan.suiteId, startedAt: new Date(startedAt), nightlyPlan: plan,
        ...(terminal ? {nightlyResult: result, finishedAt} : {})});
      const [projected] = await TestSuiteModel.aggregate([{$match: {suiteId: plan.suiteId}}, suiteHistoryProjection]);
      expect(projected.nightlyPlan.members).toHaveLength(27);
      for (const m of projected.nightlyPlan.members) {
        expect(m).not.toHaveProperty("laneId"); expect(m.admitted).toBe(false);
      }
      if (terminal) for (const m of projected.nightlyResult.members) {
        expect(m).not.toHaveProperty("laneId"); expect(m.admitted).toBe(false);
      }
      const summary = await service.summary(plan.suiteId);
      expect(summary).toMatchObject({passed: 0, outcome: terminal ? "failed" : "running"});
      expect(summary.members).toHaveLength(27); expect(summary.build).toBeUndefined();
      expect(summary.members.every(m => m.status === "incomplete" && !m.hostId && !m.laneId && !m.runId)).toBe(true);
      for (const field of ["laneId", "hostId", "input", "build", "dispatchIntent"] as const) {
        const path = `${terminal ? "nightlyResult" : "nightlyPlan"}.members.0.${field}`;
        await TestSuiteModel.collection.updateOne({suiteId: plan.suiteId}, {$set: {[path]: null}});
        const [mutant] = await TestSuiteModel.aggregate([{$match: {suiteId: plan.suiteId}}, suiteHistoryProjection]);
        expect((terminal ? mutant.nightlyResult : mutant.nightlyPlan).members[0].admitted).toBe(true);
        await expect(service.summary(plan.suiteId)).rejects.toThrow("differs from its frozen plan");
        await TestSuiteModel.collection.updateOne({suiteId: plan.suiteId}, {$unset: {[path]: ""}});
      }
      await expect(service.summary(plan.suiteId)).resolves.toMatchObject({passed: 0});
    }
  });
});
