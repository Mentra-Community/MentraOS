import {afterAll, beforeAll, describe, expect, spyOn, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunSchema} from "../types/framework-run.types";
import {backfillFrameworkRunSummaries, createFrameworkRunSummaryProjection, readFrameworkRunSummary, summarizeFrameworkRun} from "./framework-run-summary.service";
import {requestInputDigest} from "./test-request.service";
import {TestHistoryService, testHistoryQueries} from "./test-history.service";
import {FrameworkResultService} from "./framework-result.service";

const fixture = () => frameworkRunSchema.parse({schemaVersion: 1, hostId: "mini", requestId: "large-result", routineId: "notes",
  definitionRevision: "a".repeat(40), platform: "ios-on-mac", laneId: "mac",
  build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40), release: "dev.42"},
  startedAt: "2026-10-05T15:00:00Z", finishedAt: "2026-10-05T15:01:00Z", assets: [],
  result: {runId: "large-result", finishedAt: "2026-10-05T15:01:00Z", setup: {status: "passed"}, test: "passed",
    steps: [{id: "check", status: "passed", durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
    failures: [], evidence: [], timing: {startedAt: "2026-10-05T15:00:00Z", setupMs: 1, testMs: 1, teardownMs: 1}}});

test("summary projection retains the full validator and digest before deriving a verdict", () => {
  const run = fixture();
  expect(() => createFrameworkRunSummaryProjection({...run, result: {...run.result, steps: []}}, requestInputDigest(run))).toThrow();
  expect(() => createFrameworkRunSummaryProjection(run, "f".repeat(64))).toThrow("digest");
  const projection = createFrameworkRunSummaryProjection(run, requestInputDigest(run));
  const {uploadsComplete: _uploads, ...expected} = summarizeFrameworkRun(run, false);
  expect(JSON.stringify(projection.summary)).toBe(JSON.stringify(expected));
});

test("altered or foreign compact summaries fail closed without silently reloading a pass", async () => {
  const run = fixture(), payloadSha256 = requestInputDigest(run);
  const projection = createFrameworkRunSummaryProjection(run, payloadSha256);
  const find = spyOn(TestRunModel, "findOne").mockImplementation(() => {throw new Error("must not reload corrupt summary");});
  try {
    for (const summaryProjection of [null, {...projection, payloadSha256: "f".repeat(64)},
      {...projection, summary: {...projection.summary, outcome: "failed"}}, {...projection, summarySha256: "e".repeat(64)}])
      await expect(readFrameworkRunSummary({runId: run.requestId, payloadSha256, summaryProjection})).rejects.toMatchObject({status: 503});
    expect(await readFrameworkRunSummary({runId: run.requestId, payloadSha256, summaryProjection: projection, uploadsComplete: true}))
      .toEqual(summarizeFrameworkRun(run, true));
  } finally {find.mockRestore();}
});

const uri = process.env.TEST_HISTORY_MONGO_URI;
describe.skipIf(!uri)("Mongo frozen summary projection", () => {
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("Summary tests require plain loopback Mongo");
    url.pathname = `/test_run_summary_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, {autoIndex: false, autoCreate: false});
    await TestRunModel.createIndexes(); await TestSuiteModel.createIndexes();
  });
  afterAll(async () => {await mongoose.connection.dropDatabase(); await mongoose.disconnect();});

  test("backfill and native lists retain validated outcomes without transferring assets or active writers", async () => {
    const run = fixture();
    const privateWriter = "private-writer-state-".repeat(10000);
    run.result.teardown.ready = false;
    run.result.teardown.outcomes = [{state: "still-active", resourceId: "recorder", writer: {diagnostics: privateWriter}, evidence: []}];
    run.result.teardown.unavailableResources = [{resource: "recorder", cause: "Still writing", nextAction: "Wait for settlement"}];
    run.assets = Array.from({length: 500}, (_, index) => ({id: `evidence-${index}`, kind: "diagnostic", path: `private/${index}.json`,
      sha256: "c".repeat(64), size: 1, mimeType: "application/json"}));
    const payloadSha256 = requestInputDigest(run);
    await TestRunModel.collection.insertOne({runId: run.requestId, requestId: run.requestId, payloadSha256, payload: run,
      routineId: run.routineId, platform: run.platform, startedAt: new Date(run.startedAt), uploadsComplete: false, outcome: "teardown-failed"});
    const before = await TestRunModel.findOne({runId: run.requestId}).lean();
    expect(await readFrameworkRunSummary(before!)).toEqual(summarizeFrameworkRun(run, false));
    await backfillFrameworkRunSummaries(); await backfillFrameworkRunSummaries();
    const stored = await TestRunModel.findOne({runId: run.requestId}).lean();
    expect(stored!.payload).toEqual(run); expect(stored!.payloadSha256).toBe(payloadSha256);
    const rows = await TestRunModel.aggregate(testHistoryQueries(null, 25).runs);
    const wire = JSON.stringify(rows);
    expect(wire).not.toContain("private-writer-state"); expect(wire).not.toContain("private/0.json");
    expect(wire.length).toBeLessThan(2000);
    expect((await new TestHistoryService().list()).entries).toEqual([{kind: "run", ...summarizeFrameworkRun(run, false)}]);
    expect((await new FrameworkResultService().list()).runs).toEqual([summarizeFrameworkRun(run, false)]);
    await TestRunModel.updateOne({runId: run.requestId}, {$set: {uploadsComplete: true}});
    expect((await new TestHistoryService().list()).entries[0]).toEqual({kind: "run", ...summarizeFrameworkRun(run, true)});
  });
});
