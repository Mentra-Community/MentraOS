import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {TestRunModel} from "../models/test-run.model";
import {backfillTestSuiteStartedAt, TEST_SUITE_HISTORY_INDEX, TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import type {TestSuite} from "../types/test-suite.types";
import {TestHistoryService, testHistoryQueries, type StoredHistoryRow} from "./test-history.service";
import {TestSuiteService} from "./test-suite.service";
import {TestRunError} from "./test-result-error";

test("history validates cursor and page limits before querying", async () => {
  let reads = 0;
  const service = new TestHistoryService({detail: async () => {throw new Error("not used");}}, async () => {reads++; return [];});
  const invalid: Record<string, string>[] = [{cursor: "invalid"}, {limit: "0"}, {limit: "101"}, {limit: "2.5"}, {scope: "unexpected"}];
  for (const query of invalid)
    await expect(service.list(query)).rejects.toMatchObject({status: 400});
  expect(reads).toBe(0);
});

test("history suite summaries retain the reader's frozen failed outcome and declared count", async () => {
  const suite = {suiteId: "suite:completed.v2", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:01:00Z", outcome: "failed", passed: 1, build: {headSha: "a".repeat(40), release: "dev.42"},
    members: [{memberId: "published", status: "pass"}, {memberId: "unstarted", status: "not-run"}]} as any;
  const rows: StoredHistoryRow[] = [{historyKind: "suite", historyId: suite.suiteId, historyStartedAt: new Date(suite.startedAt)}];
  const service = new TestHistoryService({detail: async () => suite}, async () => [[], rows]);
  expect(await service.list()).toEqual({entries: [{kind: "suite", suiteId: suite.suiteId, channel: "dev", trigger: "nightly",
    startedAt: suite.startedAt, finishedAt: suite.finishedAt, outcome: "failed", passed: 1, expectedCount: 2, build: suite.build}], nextCursor: null});
});

test("one unavailable row preserves its page slot and cursor without failing neighboring entries", async () => {
  const rows: StoredHistoryRow[] = ["suite:c", "suite:b", "suite:a"].map(historyId => ({
    historyKind: "suite", historyId, historyStartedAt: new Date("2026-10-03T19:00:00Z"),
  }));
  const suite = {suiteId: "suite:c", channel: "dev", trigger: "manual", startedAt: "2026-10-03T19:00:00Z",
    outcome: "running", passed: 0, members: [{memberId: "a"}, {memberId: "b"}], build: {headSha: "a".repeat(40)}} as any;
  const service = new TestHistoryService({detail: async id => {
    if (id === suite.suiteId) return suite;
    throw new TestRunError(404, "missing");
  }}, async () => [[], rows]);
  const page = await service.list({limit: "2"});
  expect(page.entries[0]!.kind).toBe("suite");
  expect(page.entries[1]).toEqual({kind: "unavailable", sourceKind: "suite", id: "suite:b",
    startedAt: "2026-10-03T19:00:00.000Z", message: "Details unavailable."});
  expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toEqual({
    kind: "suite", id: "suite:b", startedAt: "2026-10-03T19:00:00.000Z",
  });
  const failing = new TestHistoryService({detail: async () => {throw new Error("not used");}}, async () => {throw new Error("query failed");});
  await expect(failing.list()).rejects.toThrow("query failed");
});

const uri = process.env.TEST_HISTORY_MONGO_URI;
describe.skipIf(!uri)("Mongo combined routine and suite history", () => {
  let connected = false;
  const at = "2026-10-03T19:00:00Z";
  const sha = "a".repeat(40);
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("History integration tests require plain loopback Mongo");
    url.pathname = `/test_history_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, {autoIndex: false, serverSelectionTimeoutMS: 5000}); connected = true;
    await TestRunModel.createIndexes(); await TestSuiteModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) {await mongoose.connection.dropDatabase(); await mongoose.disconnect();}
  });
  const run = (requestId: string, buildSha = sha): FrameworkRun => frameworkRunSchema.parse({schemaVersion: 1,
    hostId: "mini", requestId, routineId: "notes", definitionRevision: "b".repeat(40), platform: "ios-on-mac", laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: buildSha}, startedAt: at, finishedAt: "2026-10-03T19:01:00Z", assets: [],
    result: {runId: requestId, finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: at, setupMs: 1, testMs: 1, teardownMs: 1}}});
  const plan = (suiteId: string, members: TestSuite["members"]): TestSuite => ({suiteId, channel: "dev", trigger: "nightly",
    startedAt: at, build: {headSha: sha}, members});
  const member = (requestId: string) => ({memberId: requestId, requestId, routineId: "notes", platform: "ios-on-mac" as const});
  const saveRun = async (payload: FrameworkRun) => TestRunModel.collection.insertOne({runId: payload.result.runId,
    requestId: payload.requestId, routineId: payload.routineId, platform: payload.platform, startedAt: new Date(payload.startedAt),
    payload, outcome: "pass", uploadsComplete: true});
  const saveSuite = async (payload: TestSuite) => TestSuiteModel.collection.insertOne({suiteId: payload.suiteId, payload,
    startedAt: new Date(payload.startedAt)});

  test("groups many exact members before pagination, keeps single jobs and mismatches, and orders equal times deterministically", async () => {
    const grouped = Array.from({length: 100}, (_, index) => `member-${index.toString().padStart(3, "0")}`);
    await Promise.all(grouped.map(id => saveRun(run(id))));
    await saveSuite(plan("suite:large.v2", grouped.map(member)));
    await saveRun(run("single-job"));
    await saveSuite(plan("single-plan", [member("single-job")]));
    await saveRun(run("unstarted-member"));
    await saveSuite(plan("suite:unstarted.v2", [member("unstarted-member"),
      {memberId: "never-started", routineId: "ota", platform: "android"}]));
    const mismatches = [
      {...member("mismatch-request"), requestId: "other-request"},
      {...member("mismatch-routine"), routineId: "other-routine"},
      {...member("mismatch-platform"), platform: "android" as const},
      member("mismatch-channel"), {...member("mismatch-sha"), headSha: "c".repeat(40)},
    ];
    for (const [index, candidate] of mismatches.entries()) {
      const id = ["mismatch-request", "mismatch-routine", "mismatch-platform", "mismatch-channel", "mismatch-sha"][index]!;
      await saveRun(run(id));
      await saveSuite({...plan(`suite:mismatch-${index}`, [candidate, {memberId: "unstarted", routineId: "ota", platform: "android"}]),
        ...(index === 3 ? {channel: "staging" as const} : {})});
    }
    await saveRun(run("member-effective-sha", "d".repeat(40)));
    await saveSuite(plan("suite:effective-sha", [{...member("member-effective-sha"), headSha: "d".repeat(40)},
      {memberId: "unstarted", routineId: "ota", platform: "android"}]));
    await saveRun(run("standalone:z.v2")); await saveRun(run("standalone:a.v2"));
    const shifted = run("latest-run");
    shifted.startedAt = "2026-10-03T19:02:00Z";
    shifted.finishedAt = "2026-10-03T19:03:00Z";
    shifted.result.timing.startedAt = shifted.startedAt; shifted.result.finishedAt = shifted.finishedAt;
    await saveRun(shifted);
    const earlier = {...plan("suite:earlier", [{memberId: "first", routineId: "notes", platform: "ios-on-mac"},
      {memberId: "second", routineId: "ota", platform: "android"}]), startedAt: "2026-10-03T18:59:00Z"};
    await saveSuite(earlier);
    const service = new TestHistoryService();
    const first = await service.list({limit: "3"});
    expect(first.entries).toHaveLength(3); expect(first.nextCursor).not.toBeNull();
    const entries = [...first.entries]; let cursor = first.nextCursor;
    while (cursor) {
      const page = await service.list({limit: "3", cursor});
      entries.push(...page.entries); cursor = page.nextCursor;
    }
    const ids = entries.map(entry => entry.kind === "suite" ? entry.suiteId : entry.kind === "run" ? entry.runId : entry.id);
    const expectedSuites = ["suite:large.v2", "suite:unstarted.v2", "suite:effective-sha",
      ...mismatches.map((_, index) => `suite:mismatch-${index}`)].sort().reverse();
    const expectedRuns = ["single-job", "mismatch-request", "mismatch-routine", "mismatch-platform", "mismatch-channel", "mismatch-sha",
      "standalone:z.v2", "standalone:a.v2"].sort().reverse();
    expect(ids).toEqual(["latest-run", ...expectedSuites, ...expectedRuns, "suite:earlier"]);
    expect(new Set(ids).size).toBe(ids.length);
    const large = entries.find(entry => entry.kind === "suite" && entry.suiteId === "suite:large.v2")!;
    expect(large.kind === "suite" && large.expectedCount).toBe(100);
    expect(large.kind === "suite" && large.passed).toBe(100);
    expect(large.kind === "suite" && large.outcome).toBe("running");
    const unstarted = entries.find(entry => entry.kind === "suite" && entry.suiteId === "suite:unstarted.v2")!;
    expect(unstarted.kind === "suite" && unstarted.expectedCount).toBe(2);
    expect(unstarted.kind === "suite" && unstarted.passed).toBe(1);
  });

  test("a late bound result stays visible after a missing member was frozen as not-run", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({});
    const suite = plan("suite:late", [member("on-time"), member("late")]);
    await saveSuite(suite); await saveRun(run("on-time"));
    const suites = new TestSuiteService();
    const frozen = await suites.complete(suite.suiteId, {finishedAt: "2026-10-03T19:02:00Z"});
    expect(frozen.outcome).toBe("failed"); expect(frozen.members[1]!.status).toBe("not-run");
    await saveRun(run("late"));
    const history = await new TestHistoryService().list();
    expect(history.entries.map(entry => entry.kind === "suite" ? entry.suiteId : entry.kind === "run" ? entry.runId : entry.id))
      .toEqual([suite.suiteId, "late"]);
    expect(await suites.detail(suite.suiteId)).toEqual(frozen);
  });

  test("raw batches advance past a newer large suite to older standalone results without a total cap", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({});
    const ids = Array.from({length: 100}, (_, index) => `grouped-${index.toString().padStart(3, "0")}`);
    await Promise.all(ids.map(id => saveRun(run(id))));
    await saveSuite(plan("suite:newest", ids.map(member)));
    for (const id of ["older-a", "older-b", "older-c", "older-d", "older-e"]) {
      const payload = run(id);
      payload.startedAt = "2026-10-03T18:00:00Z"; payload.finishedAt = "2026-10-03T18:01:00Z";
      payload.result.timing.startedAt = payload.startedAt; payload.result.finishedAt = payload.finishedAt;
      await saveRun(payload);
    }
    const service = new TestHistoryService();
    const first = await service.list({limit: "3"});
    expect(first.entries.map(entry => entry.kind === "suite" ? entry.suiteId : entry.kind === "run" ? entry.runId : entry.id))
      .toEqual(["suite:newest", "older-e", "older-d"]);
    const second = await service.list({limit: "3", cursor: first.nextCursor!});
    expect(second.entries.map(entry => entry.kind === "run" ? entry.runId : "unexpected"))
      .toEqual(["older-c", "older-b", "older-a"]);
    expect(second.nextCursor).toBeNull();
  });

  test("suite timestamp backfill preserves frozen payloads and accepts offset timestamps", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({});
    const suite = {...plan("suite:offset", [member("a"), member("b")]), startedAt: "2026-10-03T14:00:00-07:00"};
    await TestSuiteModel.collection.insertOne({suiteId: suite.suiteId, payload: suite, payloadSha256: "frozen-hash"});
    await backfillTestSuiteStartedAt(); await backfillTestSuiteStartedAt();
    const row = await TestSuiteModel.collection.findOne({suiteId: suite.suiteId});
    expect(row!.startedAt).toEqual(new Date("2026-10-03T21:00:00Z"));
    expect(row!.payload).toEqual(suite); expect(row!.payloadSha256).toBe("frozen-hash");
    expect((await new TestHistoryService().list()).entries[0]!.startedAt).toBe(suite.startedAt);
  });

  test("source keysets use indexes and stop after eligible candidates instead of scanning all history", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({});
    const base = Date.parse(at);
    const runs = Array.from({length: 5000}, (_, index) => {
      const payload = run(`history-${index.toString().padStart(5, "0")}`);
      payload.startedAt = new Date(base - index * 1000).toISOString();
      payload.finishedAt = new Date(base - index * 1000 + 100).toISOString();
      payload.result.timing.startedAt = payload.startedAt; payload.result.finishedAt = payload.finishedAt;
      return {runId: payload.requestId, requestId: payload.requestId, routineId: payload.routineId, platform: payload.platform,
        startedAt: new Date(payload.startedAt), payload, outcome: "pass", uploadsComplete: true};
    });
    await TestRunModel.collection.insertMany(runs);
    await TestSuiteModel.collection.insertMany(Array.from({length: 500}, (_, index) => {
      const payload = {...plan(`suite:history-${index}`, [member(`suite-request-${index}`),
        {memberId: "unstarted", routineId: "ota", platform: "android"}]), startedAt: new Date(base - index * 1000).toISOString()};
      return {suiteId: payload.suiteId, payload, startedAt: new Date(payload.startedAt)};
    }));
    for (const after of [null, {kind: "run" as const, id: "history-00100", startedAt: new Date(base - 100000).toISOString()}]) {
      const queries = testHistoryQueries(after, 25);
      const runExplain: any = await TestRunModel.aggregate(queries.runs).collation({locale: "simple"}).explain("executionStats");
      const suiteExplain: any = await TestSuiteModel.aggregate(queries.suites).collation({locale: "simple"}).explain("executionStats");
      const cursorStats = (explain: any) => explain.stages?.find((stage: any) => stage.$cursor)?.$cursor ?? explain;
      const runStats = cursorStats(runExplain), suiteStats = cursorStats(suiteExplain);
      expect(JSON.stringify(runStats.queryPlanner.winningPlan)).toContain("IXSCAN");
      expect(JSON.stringify(suiteStats.queryPlanner.winningPlan)).toContain(TEST_SUITE_HISTORY_INDEX);
      expect(JSON.stringify(runStats.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
      expect(JSON.stringify(suiteStats.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
      expect(runStats.executionStats.totalDocsExamined).toBeLessThan(60);
      expect(suiteStats.executionStats.totalDocsExamined).toBeLessThan(60);
      console.log(JSON.stringify({proof: "history-source-index", page: after ? "keyset" : "first",
        storedRuns: 5000, storedSuites: 500, runsExamined: runStats.executionStats.totalDocsExamined,
        suitesExamined: suiteStats.executionStats.totalDocsExamined}));
    }
  });
});
