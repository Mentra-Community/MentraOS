import {testRoutineSource, testFrameworkBinding} from "../testing/framework-fixtures"
import {afterAll, beforeAll, describe, expect, spyOn, test} from "bun:test";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {TestRunModel} from "../models/test-run.model";
import {TestSuiteModel} from "../models/test-suite.model";
import {frameworkRunSchema} from "../types/framework-run.types";
import {createFrameworkRunSummaryProjection, createRecordedFrameworkRunSummaryProjection, readFrameworkRunSummary, summarizeFrameworkRun} from "./framework-run-summary.service";
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

test('missing compact projection fails without querying evidence or rewriting Mongo', async () => {
  const run = fixture(), find = spyOn(TestRunModel, 'findOne'), update = spyOn(TestRunModel, 'updateOne');
  try {
    await expect(readFrameworkRunSummary({runId: run.requestId, payloadSha256: requestInputDigest(run)})).rejects.toMatchObject({status: 503});
    expect(find).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
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
