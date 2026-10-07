import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {afterAll, beforeAll, describe, expect, spyOn, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {TestRunModel, TEST_RUN_NATIVE_HISTORY_INDEX} from "../models/test-run.model";
import {TestRerunModel} from "../models/test-rerun.model";
import {TestRequestModel} from "../models/test-request.model";
import {backfillTestSuiteStartedAt, TEST_SUITE_HISTORY_INDEX, TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import type {TestSuite} from "../types/test-suite.types";
import {TestHistoryService, testHistoryQueries, historySuiteBuild, enrichHistoryPrBuilds, type StoredHistoryRow} from "./test-history.service";
import {TestSuiteService, type SuiteSummaryRead} from "./test-suite.service";
import {createFrameworkRunSummaryProjection} from "./framework-run-summary.service";
import {requestInputDigest} from "./test-request.service";
import {TestRunError} from "./test-result-error";

const summaryReader = (detail: (id: string) => Promise<any>) => ({
  async summaries(ids: string[]) {
    return new Map(await Promise.all(ids.map(async id => {
      try {return [id, await detail(id)] as [string, SuiteSummaryRead];}
      catch (error) {return [id, error as Error] as [string, SuiteSummaryRead];}
    })));
  },
});

test("history validates cursor and page limits before querying", async () => {
  let reads = 0;
  const service = new TestHistoryService(summaryReader(async () => {throw new Error("not used");}), async () => {reads++; return [];});
  const invalid: Record<string, string>[] = [{cursor: "invalid"}, {limit: "0"}, {limit: "101"}, {limit: "2.5"},
    {includeReruns: "1"}, {includeReruns: "TRUE"}, {includeReruns: ""}, {scope: "unexpected"}];
  for (const query of invalid)
    await expect(service.list(query)).rejects.toMatchObject({status: 400});
  expect(reads).toBe(0);
});

test("history hides accepted reruns by default and validates the explicit toggle", async () => {
  const flags: boolean[] = [];
  const service = new TestHistoryService(summaryReader(async () => {throw new Error("not used");}), async query => {
    flags.push(query.includeReruns); return [];
  });
  await service.list(); await service.list({includeReruns: "false"}); await service.list({includeReruns: "true"});
  expect(flags).toEqual([false, false, true]);
  const queries = testHistoryQueries(null, 2);
  const rerunLookup = queries.runs.find(stage => "$lookup" in stage && stage.$lookup.from === TestRerunModel.collection.name);
  expect(rerunLookup).toMatchObject({$lookup: {localField: "payload.requestId", foreignField: "plan.members.requestId",
    pipeline: [{$match: {state: "accepted"}}, {$limit: 1}, {$project: {_id: 0, rerunId: 1, parentSuiteId: "$plan.parent.suiteId"}}]}});
  const summary = queries.runs.find(stage => "$project" in stage) as any;
  expect(summary.$project.historySuppressed.$or).toContainEqual({$gt: [{$size: "$historyReruns"}, 0]});
  const shown = testHistoryQueries(null, 2, true).runs.find(stage => "$project" in stage) as any;
  expect(shown.$project.historySuppressed.$or).not.toContainEqual({$gt: [{$size: "$historyReruns"}, 0]});
});

test("a database execution timeout is a retryable history error", async () => {
  const service = new TestHistoryService(summaryReader(async () => {throw new Error("not used");}), async () => {
    throw Object.assign(new Error("private provider details"), {code: 50});
  });
  await expect(service.list()).rejects.toMatchObject({status: 503, message: "Test history query timed out. Try again."});
});

test("suite backfill recomputes its budget before the second database command", async () => {
  let elapsed = 0;
  const budgets: number[] = [];
  const collection = {
    updateMany: async (_filter: unknown, _update: unknown, options: {maxTimeMS: number}) => {
      budgets.push(options.maxTimeMS);
      elapsed += 9000;
    },
    find: (_filter: unknown, options: {maxTimeMS: number}) => {
      budgets.push(options.maxTimeMS);
      return {project: () => ({limit: () => ({toArray: async () => []})})};
    },
  };
  await backfillTestSuiteStartedAt(collection as any, () => ({maxTimeMS: 10000 - elapsed}));
  expect(budgets).toEqual([10000, 1000]);
});

test("history suite summaries retain the reader's frozen failed outcome and declared count", async () => {
  const suite = {suiteId: "suite:completed.v2", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:01:00Z", outcome: "failed", passed: 1, build: {headSha: "a".repeat(40), release: "dev.42"},
    members: [{memberId: "published", routineId: "notes-phone", platform: "ios-on-mac", status: "pass"}, {memberId: "unstarted", routineId: "camera", platform: "android", status: "not-run"}]} as any;
  const rows: StoredHistoryRow[] = [{historyKind: "suite", historyId: suite.suiteId, historyStartedAt: new Date(suite.startedAt)}];
  const service = new TestHistoryService(summaryReader(async () => suite), async () => [[], rows]);
  expect(await service.list()).toEqual({entries: [{kind: "suite", suiteId: suite.suiteId, channel: "dev", trigger: "nightly",
    startedAt: suite.startedAt, finishedAt: suite.finishedAt, outcome: "failed", passed: 1, skipped: 1, expectedCount: 2, build: suite.build,
    rerunCount: 0, failedCount: 0, lanes: [], members: [{routineId: "notes-phone", platform: "ios-on-mac"}, {routineId: "camera", platform: "android"}]}], nextCursor: null});
});

test("suite history retains accepted job count and exact distinct host/lane pairs", async () => {
  const suite = {suiteId: "suite:lanes", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T19:00:00Z",
    outcome: "running", passed: 0, build: {headSha: "a".repeat(40)}, members: [
      {routineId: "notes", platform: "ios-on-mac", hostId: "mini", dispatchIntent: {laneId: "mac"}},
      {routineId: "settings", platform: "ios-on-mac", hostId: "mini", laneId: "mac"},
      {routineId: "camera", platform: "android", hostId: "other", laneId: "android"},
      {routineId: "historical", platform: "android"},
    ]} as any;
  const service = new TestHistoryService(summaryReader(async () => suite), async () => [[], [
    {historyKind: "suite", historyId: suite.suiteId, historyStartedAt: new Date(suite.startedAt), rerunCount: 5},
  ]]);
  expect((await service.list()).entries[0]).toMatchObject({kind: "suite", rerunCount: 5,
    lanes: [{hostId: "mini", laneId: "mac"}, {hostId: "other", laneId: "android"}],
    members: [{routineId: "notes", hostId: "mini", laneId: "mac"}, {routineId: "settings", hostId: "mini", laneId: "mac"},
      {routineId: "camera", hostId: "other", laneId: "android"}, {routineId: "historical"}],
  });
  expect(testHistoryQueries(null, 1).suites).toContainEqual({$lookup: {from: TestRerunModel.collection.name,
    localField: "suiteId", foreignField: "plan.parent.suiteId", pipeline: [{$match: {state: "accepted"}}, {$count: "count"}], as: "historyReruns"}});
});

test("one unavailable row preserves its page slot and cursor without failing neighboring entries", async () => {
  const rows: StoredHistoryRow[] = ["suite:c", "suite:b", "suite:a"].map(historyId => ({
    historyKind: "suite", historyId, historyStartedAt: new Date("2026-10-03T19:00:00Z"),
  }));
  const suite = {suiteId: "suite:c", channel: "dev", trigger: "manual", startedAt: "2026-10-03T19:00:00Z",
    outcome: "running", passed: 0, members: [{memberId: "a"}, {memberId: "b"}], build: {headSha: "a".repeat(40)}} as any;
  const service = new TestHistoryService(summaryReader(async id => {
    if (id === suite.suiteId) return suite;
    throw new TestRunError(404, "missing");
  }), async () => [[], rows]);
  const page = await service.list({limit: "2"});
  expect(page.entries[0]!.kind).toBe("suite");
  expect(page.entries[1]).toEqual({kind: "unavailable", sourceKind: "suite", id: "suite:b",
    startedAt: "2026-10-03T19:00:00.000Z", message: "Details unavailable."});
  expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toEqual({
    kind: "suite", id: "suite:b", startedAt: "2026-10-03T19:00:00.000Z",
  });
  const failing = new TestHistoryService(summaryReader(async () => {throw new Error("not used");}), async () => {throw new Error("query failed");});
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
    await TestRunModel.createIndexes(); await TestSuiteModel.createIndexes(); await TestRerunModel.createIndexes(); await TestRequestModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) {await mongoose.connection.dropDatabase(); await mongoose.disconnect();}
  });
  const run = (requestId: string, buildSha = sha): FrameworkRun =>
    frameworkRunSchema.parse({
      schemaVersion: 1,
      routineSource: testRoutineSource("b".repeat(40)),
      frameworkBinding: testFrameworkBinding(),
      hostId: "mini",
      requestId,
      routineId: "notes",
      definitionRevision: "b".repeat(40),
      platform: "ios-on-mac",
      laneId: "mac",
      build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: buildSha},
      startedAt: at,
      finishedAt: "2026-10-03T19:01:00Z",
      assets: [],
      result: {runId: requestId, finishedAt: "2026-10-03T19:01:00Z", setup: {status: "passed"}, test: "passed",
      steps: [{id: "required", status: "passed", durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: at, setupMs: 1, testMs: 1, teardownMs: 1}},
    })
  const plan = (suiteId: string, members: TestSuite["members"]): TestSuite => ({suiteId, channel: "dev", trigger: "nightly",
    startedAt: at, build: {headSha: sha}, members});
  const member = (requestId: string) => ({memberId: requestId, requestId, routineId: "notes", platform: "ios-on-mac" as const});
  const saveRun = async (payload: FrameworkRun) => TestRunModel.collection.insertOne({runId: payload.result.runId,
    requestId: payload.requestId, routineId: payload.routineId, platform: payload.platform, startedAt: new Date(payload.startedAt),
    payload, payloadSha256: requestInputDigest(payload), summaryProjection: createFrameworkRunSummaryProjection(payload, requestInputDigest(payload)), outcome: "pass", uploadsComplete: true});
  const saveSuite = async (payload: TestSuite) => TestSuiteModel.collection.insertOne({suiteId: payload.suiteId, payload,
    startedAt: new Date(payload.startedAt)});

  test("open nightly summaries batch member reads and preserve waiting, failures and frozen completion", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({}); await TestRequestModel.deleteMany({}); await TestRerunModel.deleteMany({});
    const requests: any[] = [];
    const frozenRows: any[] = [];
    const suites: any[] = [];
    for (let index = 0; index < 4; index++) {
      const payload = plan(`open-suite-${index}`, [member(`open-${index}-a`), member(`open-${index}-b`)]);
      const members = payload.members.map(selected => {
        const input = {routineId: selected.routineId, platform: selected.platform, definitionRevision: "b".repeat(40),
          routineSource: testRoutineSource("b".repeat(40)), laneId: "mac", resources: [], build: run(selected.requestId!).build};
        const dispatchIntent = {requestId: selected.requestId!, routineId: selected.routineId, platform: selected.platform,
          routineRevision: input.definitionRevision, laneId: input.laneId, build: input.build, source: {channel: "dev", buildRunId: 42}};
        requests.push({requestId: selected.requestId, hostId: "mini", input, inputSha256: requestInputDigest(input),
          dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent), state: "running"});
        return {...selected, requestId: selected.requestId!, hostId: "mini", routineRevision: input.definitionRevision,
          definitionRevision: input.definitionRevision, build: input.build, dispatchIntent};
      });
      const nightlyPlan = {suiteId: payload.suiteId, occurrenceId: `open-occurrence-${index}`, startedAt: payload.startedAt,
        trigger: "nightly", suite: payload, members};
      suites.push({suiteId: payload.suiteId, payload, startedAt: new Date(at), nightlyPlan});
      const result = run(members[0]!.requestId);
      if (index === 1) {
        result.result.test = "failed"; result.result.steps[0]!.status = "failed";
        result.result.failures = [{phase: "test", actionId: "required", message: "observed failure"}];
      }
      const payloadSha256 = requestInputDigest(result);
      const summaryProjection = createFrameworkRunSummaryProjection(result, payloadSha256);
      if (index === 2) summaryProjection.summarySha256 = "f".repeat(64);
      frozenRows.push({runId: result.requestId, requestId: result.requestId, startedAt: new Date(at),
        payload: result, payloadSha256, summaryProjection, uploadsComplete: index !== 3});
    }
    await TestSuiteModel.collection.insertMany(suites);
    await TestRequestModel.collection.insertMany(requests);
    await TestRunModel.collection.insertMany(frozenRows);
    const requestFind = spyOn(TestRequestModel, "find"), runFind = spyOn(TestRunModel, "find");
    const requestOne = spyOn(TestRequestModel, "findOne"), runOne = spyOn(TestRunModel, "findOne");
    const fullDetail = spyOn(TestSuiteService.prototype, "detail"), nightlyDetail = spyOn((await import("./nightly-routine.service")).NightlyRoutineService.prototype, "detail");
    const writes = spyOn(TestSuiteModel, "updateMany");
    try {
      const page = await new TestHistoryService().list();
      expect(page.entries.filter(entry => entry.kind === "suite")).toHaveLength(4);
      expect(page.entries.find(entry => entry.kind === "suite" && entry.suiteId === "open-suite-0")).toMatchObject({outcome: "running", passed: 1, expectedCount: 2, failedCount: 0});
      expect(page.entries.find(entry => entry.kind === "suite" && entry.suiteId === "open-suite-1")).toMatchObject({outcome: "running", passed: 0, failedCount: 1});
      expect(page.entries.find(entry => entry.kind === "suite" && entry.suiteId === "open-suite-2")).toMatchObject({outcome: "running", passed: 0, failedCount: 0});
      expect(page.entries.find(entry => entry.kind === "suite" && entry.suiteId === "open-suite-3")).toMatchObject({outcome: "running", passed: 0});
      expect(requestFind).toHaveBeenCalledTimes(1); expect(runFind).toHaveBeenCalledTimes(1);
      expect(requestOne).not.toHaveBeenCalled(); expect(runOne).not.toHaveBeenCalled();
      expect(fullDetail).not.toHaveBeenCalled(); expect(nightlyDetail).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      const projection = (runFind.mock.results[0]!.value as any)._fields;
      expect(projection).toHaveProperty("summaryProjection", 1);
      expect(projection).not.toHaveProperty("payload");
      const completed = {occurrenceId: suites[0].nightlyPlan.occurrenceId, suiteId: suites[0].suiteId, startedAt: at,
        trigger: "nightly", expectedCount: 2, passed: 0, status: "incomplete", finishedAt: "2026-10-03T20:00:00Z",
        members: suites[0].nightlyPlan.members.map((selected: any) => ({...selected, status: "incomplete", publicationComplete: false}))};
      await TestSuiteModel.collection.updateOne({suiteId: suites[0].suiteId}, {$set: {nightlyResult: completed}});
      const second = await new TestSuiteService().summaries([suites[0].suiteId], Date.now() + 5000);
      expect(second.get(suites[0].suiteId)).toMatchObject({outcome: "failed", passed: 0, members: [{status: "not-run"}, {status: "not-run"}]});
      expect(requestFind).toHaveBeenCalledTimes(1); expect(runFind).toHaveBeenCalledTimes(1);
    } finally {
      for (const mock of [requestFind, runFind, requestOne, runOne, fullDetail, nightlyDetail, writes]) mock.mockRestore();
      await TestRequestModel.deleteMany({});
    }
  });

  test("open and terminal build-selection failures stay readable without a fabricated build", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({}); await TestRequestModel.deleteMany({}); await TestRerunModel.deleteMany({});
    const {requestId: _missingRequest, ...missing} = member("missing-b");
    const payload = plan("missing-build-suite", [member("available-a"), missing]);
    const input = {routineId: "notes", platform: "ios-on-mac", definitionRevision: "b".repeat(40), routineSource: testRoutineSource("b".repeat(40)),
      laneId: "mac", resources: [], build: run("available-a").build};
    const dispatchIntent = {requestId: "available-a", routineId: input.routineId, platform: input.platform, routineRevision: input.definitionRevision,
      laneId: input.laneId, build: input.build, source: {channel: "dev", buildRunId: 42}};
    const members = payload.members.map(selected => ({...selected, requestId: selected.memberId, definitionRevision: input.definitionRevision,
      routineRevision: input.definitionRevision, ...(selected.memberId === "available-a" ? {hostId: "mini", build: input.build, dispatchIntent} : {})}));
    const nightlyPlan = {suiteId: payload.suiteId, occurrenceId: "missing-build-occurrence", startedAt: at, trigger: "nightly", suite: payload, members};
    await TestSuiteModel.collection.insertOne({suiteId: payload.suiteId, payload, nightlyPlan, startedAt: new Date(at)});
    await TestRequestModel.collection.insertOne({requestId: "available-a", hostId: "mini", input, inputSha256: requestInputDigest(input),
      dispatchIntent, dispatchIntentSha256: requestInputDigest(dispatchIntent), state: "running"});
    await saveRun(run("available-a"));
    const history = new TestHistoryService();
    expect((await history.list()).entries[0]).toMatchObject({kind: "suite", outcome: "running", passed: 1, skipped: 1, lanes: [{hostId: "mini", laneId: "mac"}]});
    const nightlyResult = {...nightlyPlan, expectedCount: 2, finishedAt: "2026-10-03T20:00:00Z", members: members.map(selected => ({...selected,
      status: selected.memberId === "available-a" ? "pass" : "incomplete", publicationComplete: selected.memberId === "available-a",
      ...(selected.memberId === "available-a" ? {input, runId: selected.memberId, runStartedAt: at, runFinishedAt: "2026-10-03T19:01:00Z"} : {})}))};
    await TestSuiteModel.collection.updateOne({suiteId: payload.suiteId}, {$set: {nightlyResult}});
    expect((await history.list()).entries[0]).toMatchObject({kind: "suite", outcome: "failed", passed: 1, skipped: 1, lanes: [{hostId: "mini", laneId: "mac"}]});
  });

  test("missing native suite projections use the shared frozen reader, while corrupt projections stay unavailable", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({}); await TestRequestModel.deleteMany({}); await TestRerunModel.deleteMany({});
    const payload = plan("native-missing-summary", [member("native-one"), member("native-two")]);
    await saveSuite(payload); await saveRun(run("native-one")); await saveRun(run("native-two"));
    await TestRunModel.collection.updateOne({runId: "native-one"}, {$unset: {summaryProjection: ""}});
    const page = await new TestHistoryService().list();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({kind: "suite", outcome: "running", passed: 2});
    expect((await TestRunModel.collection.findOne({runId: "native-one"}))?.summaryProjection).toBeDefined();
    await TestRunModel.collection.updateOne({runId: "native-one"}, {$set: {"summaryProjection.summarySha256": "f".repeat(64)}});
    expect((await new TestHistoryService().list()).entries[0]).toMatchObject({kind: "unavailable", id: payload.suiteId});
  });

  test("standalone missing and enriched projections retain the remaining page deadline", async () => {
    const payload = run("deadline-run"), payloadSha256 = requestInputDigest(payload);
    let now = Date.parse(at);
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    const find = spyOn(TestRunModel, "findOne").mockReturnValue({select() {return this;}, read() {return this;}, readConcern() {return this;},
      setOptions(options: {timeoutMS: number}) {budgets.push(options.timeoutMS); return this;}, async lean() {now += 200; return {payload, payloadSha256};}} as any);
    const update = spyOn(TestRunModel, "updateOne").mockImplementation((async (_filter: unknown, _value: unknown, options: {timeoutMS: number}) => {
      budgets.push(options.timeoutMS); return {};
    }) as any);
    try {
      for (const enrichment of [false, true]) {
        now = Date.parse(at); budgets.length = 0;
        const projection = createFrameworkRunSummaryProjection(payload, payloadSha256);
        delete projection.summary.stepCounts;
        projection.summarySha256 = requestInputDigest({summary: projection.summary, definitionRevision: projection.definitionRevision, recordingAssetId: null});
        const service = new TestHistoryService({summaries: async () => new Map()}, async () => {
          now += 9000;
          return [[{historyKind: "run", historyId: payload.requestId, historyStartedAt: new Date(at), requestId: payload.requestId,
            payloadSha256, uploadsComplete: true, ...(enrichment ? {summaryProjection: projection} : {})}], []];
        });
        expect((await service.list()).entries[0]).toMatchObject({kind: "run", outcome: "pass"});
        expect(budgets).toEqual([1000, 800]);
      }
    } finally {clock.mockRestore(); find.mockRestore(); update.mockRestore();}
  });

  test("accepted reruns are excluded before page and cursor selection, counted as jobs, and shown on request", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({}); await TestRerunModel.deleteMany({});
    const parent = {...plan("suite:rerun-parent", [member("original-a"), member("original-b")]), startedAt: "2026-10-03T18:00:00Z"};
    await saveSuite(parent);
    const hidden = Array.from({length: 30}, (_, index) => `ordinary-request-${index.toString().padStart(2, "0")}`);
    await Promise.all(hidden.map(id => saveRun(run(id))));
    await saveRun(run("rerun-visible-standalone"));
    await saveRun(run("preview-member"));
    await TestRerunModel.collection.insertMany([
      {rerunId: "accepted-many", state: "accepted", plan: {parent: {suiteId: parent.suiteId}, members: hidden.map(requestId => ({requestId}))}},
      {rerunId: "accepted-unpublished", state: "accepted", plan: {parent: {suiteId: parent.suiteId}, members: [{requestId: "not-published"}]}},
      {rerunId: "preview-only", state: "preview", plan: {parent: {suiteId: parent.suiteId}, members: [{requestId: "preview-member"}]}},
    ]);
    const history = new TestHistoryService();
    const first = await history.list({limit: "1"});
    expect(first.entries.map(entry => entry.kind === "run" ? entry.runId : "unexpected")).toEqual(["rerun-visible-standalone"]);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()).id).toBe("rerun-visible-standalone");
    const second = await history.list({limit: "1", cursor: first.nextCursor!});
    expect(second.entries.map(entry => entry.kind === "run" ? entry.runId : "unexpected")).toEqual(["preview-member"]);
    const third = await history.list({limit: "1", cursor: second.nextCursor!});
    expect(third.entries[0]).toMatchObject({kind: "suite", suiteId: parent.suiteId, rerunCount: 2});
    expect(third.nextCursor).toBeNull();
    const shown = await history.list({limit: "100", includeReruns: "true"});
    expect(shown.entries.filter(entry => entry.kind === "run")).toHaveLength(32);
    expect(shown.entries.find(entry => entry.kind === "run" && entry.runId === hidden[0])).toMatchObject({kind: "run",
      rerun: {rerunId: "accepted-many", parentSuiteId: parent.suiteId}});
    expect(shown.entries.find(entry => entry.kind === "run" && entry.runId === "preview-member")).not.toHaveProperty("rerun");
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({}); await TestRerunModel.deleteMany({});
  });

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

  test("nightly terminal authority groups only its exact frozen runs and leaves late publication visible", async () => {
    await TestRunModel.deleteMany({});
    await TestSuiteModel.deleteMany({});
    const suite = plan("suite:nightly-authority", [member("on-time"), member("late")]);
    const expected = suite.members.map((selected) => ({
      ...selected,
      requestId: selected.requestId!,
      definitionRevision: "b".repeat(40),
      definitionSha256: "c".repeat(64),
      hostId: "mini",
      input: {
        routineSource: testRoutineSource("b".repeat(40)),
        routineId: selected.routineId,
        platform: selected.platform,
        definitionRevision: "b".repeat(40),
        laneId: "mac",
        resources: [],
        build: run(selected.requestId!).build,
      },
    }))
    const nightlyPlan = {suiteId: suite.suiteId, occurrenceId: "history-nightly", startedAt: suite.startedAt, trigger: "nightly", suite, members: expected};
    const nightlyResult = {...nightlyPlan, expectedCount: 2, passed: 1, status: "incomplete", finishedAt: "2026-10-03T19:02:00Z",
      members: expected.map((selected, index) => ({...selected, status: index === 0 ? "pass" : "incomplete", publicationComplete: index === 0,
        ...(index === 0 ? {runId: selected.requestId, runStartedAt: at, runFinishedAt: "2026-10-03T19:01:00Z"} : {})}))};
    await TestSuiteModel.collection.insertOne({suiteId: suite.suiteId, payload: suite, startedAt: new Date(suite.startedAt), nightlyPlan, nightlyResult});
    await saveRun(run("on-time"));
    await saveRun(run("late"));
    const entries = (await new TestHistoryService().list()).entries;
    expect(
      entries.map((entry) => (entry.kind === "suite" ? entry.suiteId : entry.kind === "run" ? entry.runId : entry.id)),
    ).toEqual([suite.suiteId, "late"])
    expect(entries[0]).toMatchObject({kind: "suite", passed: 1, outcome: "failed", finishedAt: nightlyResult.finishedAt});
    const row = await TestSuiteModel.collection.findOne({suiteId: suite.suiteId});
    expect(row!.completedResult).toBeUndefined();
    expect(await new TestSuiteService().detail(suite.suiteId)).toMatchObject({passed: 1, outcome: "failed"});
  })

  test("one aggregation advances past a newer large suite without dropping older standalone results", async () => {
    await TestRunModel.deleteMany({});
    await TestSuiteModel.deleteMany({});
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
    expect(second.entries.map((entry) => (entry.kind === "run" ? entry.runId : "unexpected"))).toEqual(["older-c", "older-b", "older-a"])
    expect(second.nextCursor).toBeNull();
  })

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

  test("corrupt payload timestamps are logged and cannot break valid history rows", async () => {
    await TestRunModel.deleteMany({}); await TestSuiteModel.deleteMany({});
    await saveSuite(plan("valid", [member("a"), member("b")]));
    await saveRun(run("c"));
    const payload = {...plan("invalid", [member("c"), member("d")]), startedAt: "not-a-date"};
    await TestSuiteModel.collection.insertOne({suiteId: payload.suiteId, payload, startedAt: null});
    const page = await new TestHistoryService().list();
    expect(page.entries.map(entry => entry.kind === "suite" ? entry.suiteId : entry.kind === "run" ? entry.runId : "unexpected"))
      .toEqual(["valid", "c"]);
    expect(page.nextCursor).toBeNull();
  });

  test("source keysets bound raw scanning to256 indexed candidates per command", async () => {
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
      expect(runStats.executionStats.totalDocsExamined).toBeLessThanOrEqual(257); // one equal-time cursor boundary may be filtered
      expect(suiteStats.executionStats.totalDocsExamined).toBeLessThan(60);
      console.log(JSON.stringify({proof: "history-source-index", page: after ? "keyset" : "first",
        storedRuns: 5000, storedSuites: 500, runsExamined: runStats.executionStats.totalDocsExamined,
        suitesExamined: suiteStats.executionStats.totalDocsExamined}));
    }
  });

  test("history shares its deadline with the batch suite reader and never serially rescans", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const originalAggregate = TestRunModel.aggregate.bind(TestRunModel);
    let commands = 0;
    const aggregate = spyOn(TestRunModel, "aggregate").mockImplementation(((...args: any[]) => {
      const query = originalAggregate(...(args as Parameters<typeof TestRunModel.aggregate>));
      query.exec = (async () => {commands++; now += 6000; return [];}) as typeof query.exec;
      return query;
    }) as any);
    const summaries = {async summaries(_ids: string[], deadline: number) {
      expect(deadline - Date.now()).toBe(4000);
      now += 4001;
      throw new TestRunError(503, "Test history query timed out. Try again.");
    }};
    try {
      await expect(new TestHistoryService(summaries).list()).rejects.toMatchObject({status: 503});
      expect(commands).toBe(1);
    } finally {aggregate.mockRestore(); clock.mockRestore();}
  });

  test("native history exhausts a short page without scanning retained legacy results", async () => {
    await TestRunModel.deleteMany({});
    await TestSuiteModel.deleteMany({});
    const legacy = Array.from({length: 5000}, (_, index) => ({runId: `legacy-${index}`, requestId: `legacy-${index}`,
      startedAt: new Date(Date.parse(at) - index * 1000), payload: {schemaVersion: 0, data: "legacy"}}));
    await TestRunModel.collection.insertMany(legacy);
    for (const id of ["native-a", "native-b"]) await saveRun(run(id));
    const after = {kind: "run" as const, id: "native-a", startedAt: at};
    for (const cursor of [null, after]) {
      const explain: any = await TestRunModel.aggregate(testHistoryQueries(cursor, 25).runs)
        .collation({locale: "simple"}).explain("executionStats");
      const stats = explain.stages?.find((stage: any) => stage.$cursor)?.$cursor ?? explain;
      expect(JSON.stringify(stats.queryPlanner.winningPlan)).toContain(TEST_RUN_NATIVE_HISTORY_INDEX);
      expect(stats.executionStats.totalDocsExamined).toBeLessThan(5);
      expect(JSON.stringify(stats.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
      console.log(JSON.stringify({proof: "native-history-legacy-exclusion", page: cursor ? "keyset" : "first",
        storedLegacyRuns: legacy.length, nativeRuns: 2, runsExamined: stats.executionStats.totalDocsExamined}));
    }
    const page = await new TestHistoryService().list();
    expect(page.entries.map((entry) => (entry.kind === "run" ? entry.runId : "unexpected"))).toEqual(["native-b", "native-a"])
    expect(page.nextCursor).toBeNull();
  })
})

test("suite PR identity comes only from a verified bound request at the tested commit", () => {
  const source = {channel: "pr", prNumber: 698, buildRunId: 10, publicationAttempt: 1};
  const asset = {url: "https://artifactscdn.mentraglass.com/fixture", size: 100, sha256: "a".repeat(64)};
  const intent = {requestId: "request", routineId: "notes", platform: "android", laneId: "android", routineRevision: "b".repeat(40), source,
    build: {repository: "Mentra-Community/MentraOS", channel: "pr", prNumber: 698, headSha: "c".repeat(40), kind: "android-apk", source, archive: {...asset, name: "app.apk"}, receipt: asset}};
  const suite = {channel: "pr", build: {headSha: "c".repeat(40)}, members: [{requestId: "request", routineId: "notes", platform: "android"}]};
  const request = {requestId: "request", dispatchIntent: intent, dispatchIntentSha256: requestInputDigest(intent)};
  expect(historySuiteBuild(suite, [request])).toEqual({...suite.build, repository: "Mentra-Community/MentraOS", prNumber: 698});
  expect(historySuiteBuild(suite, [{...request, dispatchIntentSha256: "d".repeat(64)}])).toEqual(suite.build);
  expect(historySuiteBuild(suite, [request, request])).toEqual(suite.build);
  expect(historySuiteBuild({...suite, build: {headSha: "e".repeat(40)}}, [request])).toEqual({headSha: "e".repeat(40)});
  expect(historySuiteBuild(suite, [])).toEqual(suite.build);
});

test("optional PR metadata failure and timeout preserve readable entries", async () => {
  const suite = {suiteId: "pr-suite", channel: "pr", build: {headSha: "c".repeat(40)}, members: [{requestId: "request", routineId: "notes", platform: "android"}]} as any;
  const entries = [{kind: "suite", ...suite}, {kind: "unavailable", sourceKind: "run", id: "missing", startedAt: "2026-10-07T18:00:00Z", message: "Details unavailable."}] as any;
  for (const error of [new Error("lookup failed"), Object.assign(new Error("timed out"), {code: 50})]) {
    expect(await enrichHistoryPrBuilds(entries, async () => {throw error;}, new Map([[suite.suiteId, suite]]))).toBe(entries);
  }
});
