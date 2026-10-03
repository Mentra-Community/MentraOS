import {afterAll, beforeAll, describe, expect, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunSchema, type FrameworkRun} from "../types/framework-run.types";
import type {TestSuite} from "../types/test-suite.types";
import {TestHistoryService, type StoredHistoryRow} from "./test-history.service";

test("history validates cursor and page limits before querying", async () => {
  let reads = 0;
  const service = new TestHistoryService({detail: async () => {throw new Error("not used");}}, async () => {reads++; return [];});
  for (const query of [{cursor: "invalid"}, {limit: "0"}, {limit: "101"}, {limit: "2.5"}, {scope: "unexpected"}])
    await expect(service.list(query)).rejects.toMatchObject({status: 400});
  expect(reads).toBe(0);
});

test("history suite summaries retain the reader's frozen failed outcome and declared count", async () => {
  const suite = {suiteId: "suite:completed.v2", channel: "dev", trigger: "nightly", startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:01:00Z", outcome: "failed", passed: 1, build: {headSha: "a".repeat(40), release: "dev.42"},
    members: [{memberId: "published", status: "pass"}, {memberId: "unstarted", status: "not-run"}]} as any;
  const rows: StoredHistoryRow[] = [{historyKind: "suite", historyId: suite.suiteId, historyStartedAt: new Date(suite.startedAt)}];
  const service = new TestHistoryService({detail: async () => suite}, async () => rows);
  expect(await service.list()).toEqual({entries: [{kind: "suite", suiteId: suite.suiteId, channel: "dev", trigger: "nightly",
    startedAt: suite.startedAt, finishedAt: suite.finishedAt, outcome: "failed", passed: 1, expectedCount: 2, build: suite.build}], nextCursor: null});
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
  const saveSuite = async (payload: TestSuite) => TestSuiteModel.collection.insertOne({suiteId: payload.suiteId, payload});

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
    const ids = entries.map(entry => entry.kind === "suite" ? entry.suiteId : entry.runId);
    const expectedSuites = ["suite:large.v2", "suite:unstarted.v2", "suite:effective-sha",
      ...mismatches.map((_, index) => `suite:mismatch-${index}`)].sort().reverse();
    const expectedRuns = ["single-job", "mismatch-request", "mismatch-routine", "mismatch-platform", "mismatch-channel", "mismatch-sha",
      "standalone:z.v2", "standalone:a.v2"].sort().reverse();
    expect(ids).toEqual(["latest-run", ...expectedSuites, ...expectedRuns, "suite:earlier"]);
    expect(new Set(ids).size).toBe(ids.length);
    const large = entries.find(entry => entry.kind === "suite" && entry.suiteId === "suite:large.v2")!;
    expect(large.kind === "suite" && large.expectedCount).toBe(100);
    expect(large.kind === "suite" && large.passed).toBe(100);
    expect(large.outcome).toBe("running");
    const unstarted = entries.find(entry => entry.kind === "suite" && entry.suiteId === "suite:unstarted.v2")!;
    expect(unstarted.kind === "suite" && unstarted.expectedCount).toBe(2);
    expect(unstarted.kind === "suite" && unstarted.passed).toBe(1);
  });
});
