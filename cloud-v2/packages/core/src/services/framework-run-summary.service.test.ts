import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {afterAll, beforeAll, describe, expect, spyOn, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunSchema} from "../types/framework-run.types";
import {backfillFrameworkRunSummaries, createFrameworkRunSummaryProjection, createRecordedFrameworkRunSummaryProjection, readFrameworkRunSummary, startFrameworkRunSummaryBackfill, summarizeFrameworkRun} from "./framework-run-summary.service";
import {requestInputDigest} from "./test-request.service";
import {TestHistoryService, testHistoryQueries} from "./test-history.service";
import {FrameworkResultService} from "./framework-result.service";
import {RoutineCatalogService} from "./routine-catalog.service";
import type {RoutineEnrollment} from "../types/routine-definition.types";

const fixture = () =>
  frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource(),
    frameworkBinding: testFrameworkBinding(),
    hostId: "mini",
    requestId: "large-result",
    routineId: "notes",
    definitionRevision: "a".repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40), release: "dev.42"},
    startedAt: "2026-10-05T15:00:00Z",
    finishedAt: "2026-10-05T15:01:00Z",
    assets: [],
    result: {runId: "large-result", finishedAt: "2026-10-05T15:01:00Z", setup: {status: "passed"}, test: "passed",
    steps: [{id: "check", status: "passed", durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
    failures: [], evidence: [], timing: {startedAt: "2026-10-05T15:00:00Z", setupMs: 1, testMs: 1, teardownMs: 1}},
  })

test("summary projection retains the full validator and digest before deriving a verdict", () => {
  const run = fixture();
  expect(() => createFrameworkRunSummaryProjection({...run, result: {...run.result, steps: []}}, requestInputDigest(run))).toThrow();
  expect(() => createFrameworkRunSummaryProjection(run, "f".repeat(64))).toThrow("digest");
  const projection = createFrameworkRunSummaryProjection(run, requestInputDigest(run));
  const {uploadsComplete: _uploads, ...expected} = summarizeFrameworkRun(run, false);
  expect(projection.summary).toEqual({...expected, platform: run.platform, routineSource: run.routineSource, frameworkBinding: run.frameworkBinding})
  expect(projection.summary.routineSource).toEqual(run.routineSource)
  expect(projection.summary.frameworkBinding).toEqual(run.frameworkBinding)
})

test("compact summaries count passed and skipped test steps independently of the run verdict", () => {
  const run = fixture();
  run.result.test = "failed";
  run.result.steps = ["passed", "failed", "not-run"].map((status, index) => ({
    id: `step-${index}`, status: status as "passed" | "failed" | "not-run", durationMs: 0,
  }));
  const projection = createFrameworkRunSummaryProjection(run, requestInputDigest(run));
  expect(projection.summary.stepCounts).toEqual({passed: 1, total: 3, skipped: 1});
});

test('historical payloads without provenance project without changing bytes or inventing identities', async () => {
  const {routineSource: _source, frameworkBinding: _binding, ...old} = fixture();
  const payloadSha256 = requestInputDigest(old), before = JSON.stringify(old);
  const projection = createRecordedFrameworkRunSummaryProjection(old, payloadSha256);
  expect(projection.payloadSha256).toBe(payloadSha256);
  expect(projection.summary).not.toHaveProperty('routineSource');
  expect(projection.summary).not.toHaveProperty('frameworkBinding');
  expect(JSON.stringify(old)).toBe(before);
  expect(requestInputDigest(old)).toBe(payloadSha256);
  expect(() => createFrameworkRunSummaryProjection(old, payloadSha256)).toThrow();
  const find = spyOn(TestRunModel, 'findOne').mockReturnValue({select() {return this;}, read() {return this;},
    readConcern() {return this;}, setOptions() {return this;}, async lean() {return {payload: old, payloadSha256};}} as never);
  const update = spyOn(TestRunModel, 'updateOne').mockResolvedValue({} as never);
  try {
    const summary = await readFrameworkRunSummary({runId: old.requestId, payloadSha256, uploadsComplete: true});
    expect(summary.outcome).toBe('pass');
    expect(summary).not.toHaveProperty('routineSource');
    const updateArguments = update.mock.calls[0] as unknown as unknown[];
    expect(updateArguments[1]).toEqual({$set: {summaryProjection: projection}});
    expect(requestInputDigest(old)).toBe(payloadSha256);
    const history = new TestHistoryService({detail: async () => {throw new Error('not a suite');}}, async () => [[{
      historyKind: 'run', historyId: old.requestId, historyStartedAt: new Date(old.startedAt), requestId: old.requestId,
      payloadSha256, summaryProjection: projection, uploadsComplete: true,
    }], []]);
    expect((await history.list()).entries[0]).toMatchObject({kind: 'run', runId: old.requestId, outcome: 'pass'});
    expect((await history.list()).entries[0]).not.toHaveProperty('frameworkBinding');
  } finally {find.mockRestore(); update.mockRestore();}
});

test('existing historical summary and digest remain unchanged when provenance and step counts are absent', async () => {
  const {routineSource: _source, frameworkBinding: _binding, ...old} = fixture();
  const payloadSha256 = requestInputDigest(old), projection = createRecordedFrameworkRunSummaryProjection(old, payloadSha256);
  delete projection.summary.stepCounts;
  projection.summarySha256 = requestInputDigest({summary: projection.summary, definitionRevision: projection.definitionRevision,
    recordingAssetId: projection.recordingAssetId ?? null});
  const before = JSON.stringify(projection), find = spyOn(TestRunModel, 'findOne').mockImplementation(() => {throw new Error('must not reload historical projection');});
  const update = spyOn(TestRunModel, 'updateOne').mockImplementation(() => {throw new Error('must not rewrite historical projection');});
  try {
    expect((await readFrameworkRunSummary({runId: old.requestId, payloadSha256, summaryProjection: projection})).outcome).toBe('pass');
    expect(JSON.stringify(projection)).toBe(before);
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  } finally {find.mockRestore(); update.mockRestore();}
});

test("verified older summaries gain step counts from their frozen payload", async () => {
  const run = fixture(), payloadSha256 = requestInputDigest(run);
  const projection = createFrameworkRunSummaryProjection(run, payloadSha256);
  delete projection.summary.stepCounts;
  projection.summarySha256 = requestInputDigest({summary: projection.summary, definitionRevision: projection.definitionRevision,
    recordingAssetId: projection.recordingAssetId ?? null});
  const find = spyOn(TestRunModel, "findOne").mockReturnValue({select: () => ({read: () => ({readConcern: () => ({setOptions: () => ({
    lean: async () => ({payload: run, payloadSha256}),
  })})})})} as never);
  const update = spyOn(TestRunModel, "updateOne").mockResolvedValue({} as never);
  try {
    expect((await readFrameworkRunSummary({runId: run.requestId, payloadSha256, summaryProjection: projection})).stepCounts)
      .toEqual({passed: 1, total: 1, skipped: 0});
    expect(update).toHaveBeenCalledTimes(1);
  } finally {find.mockRestore(); update.mockRestore();}
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

test("optional backfill leaves HTTP serving during slow reads, cancels on stop, and contains failed writes", async () => {
  const run = fixture(), row = {runId: run.requestId, payloadSha256: requestInputDigest(run), payload: run};
  let closed = 0, slow = true, suppliedSignal: AbortSignal | undefined;
  const find = spyOn(TestRunModel.collection, "find").mockImplementation(((...args: unknown[]) => {
    suppliedSignal = (args[1] as {signal: AbortSignal}).signal;
    return {
      async *[Symbol.asyncIterator]() {
        if (slow) await new Promise((_resolve, reject) => suppliedSignal!.addEventListener("abort", () => reject(suppliedSignal!.reason), {once: true}));
        else yield row;
      },
      async close() {closed++;},
    } as unknown as ReturnType<typeof TestRunModel.collection.find>;
  }) as typeof TestRunModel.collection.find);
  const update = spyOn(TestRunModel.collection, "updateOne").mockRejectedValue(new Error("write unavailable"));
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready")});
  try {
    const stop = startFrameworkRunSummaryBackfill();
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
    expect(closed).toBe(0);
    await stop();
    expect(suppliedSignal!.aborted).toBe(true); expect(closed).toBe(1);
    expect(update).not.toHaveBeenCalled();
    slow = false;
    const failed = startFrameworkRunSummaryBackfill();
    await new Promise(resolve => setTimeout(resolve, 0));
    await failed();
    expect(update).toHaveBeenCalledTimes(1); expect(closed).toBe(2);
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
  } finally {find.mockRestore(); update.mockRestore(); await server.stop(true);}
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
    expect((await TestRunModel.findOne({runId: run.requestId}).lean())!.summaryProjection).toBeDefined();
    await TestRunModel.updateOne({runId: run.requestId}, {$unset: {summaryProjection: 1}});
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

  test("catalog retains frozen revision and full build metadata through rollout and rejects altered projected evidence", async () => {
    const run = fixture();
    run.requestId = run.result.runId = "recorded-example";
    run.build = {...run.build, channel: "pr", prNumber: 4459, archive: {sha256: "d".repeat(64)}};
    run.recordingAssetId = "recording";
    run.assets = [{id: "recording", kind: "recording", path: "recording.mp4", sha256: "c".repeat(64), size: 1, mimeType: "video/mp4"}];
    const payloadSha256 = requestInputDigest(run);
    // Early retained rows need not have a denormalized top-level definition revision.
    await TestRunModel.collection.insertOne({runId: run.requestId, requestId: run.requestId, payloadSha256, payload: run,
      routineId: run.routineId, platform: run.platform, startedAt: new Date(run.startedAt), uploadsComplete: true, outcome: "pass"});
    const definition = {routineId: run.routineId, platform: run.platform, definitionRevision: "e".repeat(40)} as RoutineEnrollment;
    const service = new RoutineCatalogService({async current() {return [definition];}, async getCurrent() {return definition;}}, undefined,
      {async list() {return [];}, async get() {return null;}, async set() {}});
    const expected = {
      runId: run.requestId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      recordingAssetId: run.recordingAssetId,
      definitionRevision: run.definitionRevision,
      routineSource: run.routineSource,
      build: run.build,
    }
    const initial = await service.detail(run.routineId, run.platform);
    expect(initial.example).toEqual(expected);
    expect(initial.history.find(row => row.runId === run.requestId)?.definitionRevision).toBe(run.definitionRevision);
    await backfillFrameworkRunSummaries();
    expect((await service.detail(run.routineId, run.platform)).example).toEqual(expected);
    await TestRunModel.updateOne({runId: run.requestId}, {$set: {"payload.build.headSha": "f".repeat(40)}});
    await expect(service.detail(run.routineId, run.platform)).rejects.toMatchObject({status: 503});
    await TestRunModel.updateOne({runId: run.requestId}, {$unset: {summaryProjection: 1}});
    await expect(service.detail(run.routineId, run.platform)).rejects.toMatchObject({status: 503});
    await backfillFrameworkRunSummaries();
    expect((await TestRunModel.findOne({runId: run.requestId}).lean())!.summaryProjection).toBeUndefined();
  })
})
