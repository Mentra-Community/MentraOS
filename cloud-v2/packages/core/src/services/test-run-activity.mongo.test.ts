import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { TestRunModel } from "../models/test-run.model";
import type { TestRunClaim } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import { MongoTestRunFollowUpRepository, TestRunFollowUpService } from "./test-run-follow-up.service";
import { MongoTestRunOverviewRepository, TestRunOverviewService } from "./test-run-overview.service";

const uri = process.env.TEST_RUN_ACTIVITY_MONGO_URI;
describe.skipIf(!uri)("Mongo live activity reconciliation", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw Error("Activity tests require a plain loopback Mongo URL");
    url.pathname = "/test_activity_" + randomUUID().replaceAll("-", "");
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 }); connected = true;
    await TestRunClaimModel.createIndexes(); await TestRunModel.createIndexes();
  });
  afterAll(async () => { if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
  const stamp = "2026-09-24T20:00:00.000Z";
  const claim = (id: string, terminal = false): TestRunClaim => ({ requestId: id, requestSha256: "a".repeat(64), workerId: "mini-1",
    fixtureId: "03BE", executionId: id + "-execution", claimedAt: stamp, settledAt: stamp,
    ...(terminal ? { state: "terminal", settlement: { state: "terminal", resultRunId: id } } as const
      : { state: "recovery-required", settlement: { state: "recovery-required", reason: "Private retained fixture context" } } as const) });
  const run = (id: string, ready: boolean): TestRun => ({ runId: id, requestId: id, routineId: "day1-ota", routineVersion: "1",
    platform: "ios-mac", channel: "dev", startedAt: stamp, finishedAt: stamp, outcome: "failed",
    outcomes: { test: "failed", teardown: ready ? "passed" : "blocked", fixture: ready ? "ready" : "unavailable", evidence: "complete" },
    provenance: { repository: "Mentra-Community/MentraOS", requestSha256: "a".repeat(64), executionMode: "ci-registered",
      requestRelationship: "consumed", resultGeneration: "1", archiveSha256: "b".repeat(64), terminalSnapshotSha256: "c".repeat(64),
      returnVerification: ready ? "passed" : "deferred" }, fixture: { alias: "03BE" }, firmwareAssertions: [], chapters: [], assets: [] });
  const save = (value: TestRun) => TestRunModel.create({ runId: value.runId, requestId: value.requestId, startedAt: new Date(value.startedAt),
    payloadSha256: "d".repeat(64), payload: value, uploadsComplete: true, outcome: value.outcome });
  const github = { activity: async () => ({ jobs: [], warnings: [] }) };

  test("real stored late export and missing-original recovery close only their own follow-up; unsafe terminal export remains", async () => {
    const late = "routine-100-1-dev-day1-ota", recovered = "routine-101-1-dev-day1-ota", unsafe = "routine-102-1-dev-day1-ota";
    await TestRunClaimModel.create([late, recovered, unsafe].map(id => ({ requestId: id, claim: claim(id, id === unsafe), executionTokenSha256: "e".repeat(64) })));
    await save(run(late, true)); await save(run(unsafe, false));
    const recovery = run(recovered, true); recovery.runId = "recovery-" + "f".repeat(32) + "-5";
    recovery.provenance = { ...recovery.provenance, resultGeneration: "5", originalRunId: recovered,
      originalTerminalSnapshotSha256: "1".repeat(64), recoveryHistorySha256: "2".repeat(64) };
    await save(recovery);
    const view = await new TestRunOverviewService(new MongoTestRunOverviewRepository(), github).overview();
    expect(view.jobs.map(job => job.claims[0]?.requestId)).toEqual([unsafe]);
    expect(view.resolvedRecoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: late, kind: "late-result" }),
      expect.objectContaining({ requestId: recovered, originalAvailable: false }),
    ]));
    expect((await TestRunClaimModel.findOne({ requestId: late }).lean())?.claim).toEqual(claim(late));
    expect((await TestRunModel.findOne({ runId: late }).lean())?.payload.outcomes.test).toBe("failed");
  });
  test("the newest stored claim per exact worker and fixture includes ordinary terminal passes", async () => {
    const at = (minute: number) => new Date(Date.parse(stamp) + minute * 60_000).toISOString();
    const stored = (id: string, workerId: string, fixtureId: string, minute: number) => ({ ...claim(id, true), workerId, fixtureId, claimedAt: at(minute) });
    const rows = [stored("latest-a", "mini-1", "UNPAIRED", 20), stored("older-a", "mini-1", "UNPAIRED", 10),
      stored("other-worker", "mini-2", "UNPAIRED", 30), stored("unrequested", "mini-1", "OTHER", 40)];
    await TestRunClaimModel.create(rows.map(value => ({ requestId: value.requestId, claim: value, executionTokenSha256: "e".repeat(64) })));
    const latest = await new MongoTestRunOverviewRepository().latestFixtureClaims([{ workerId: "mini-1", fixtureId: "UNPAIRED" },
      { workerId: "mini-2", fixtureId: "UNPAIRED" }, { workerId: "mini-3", fixtureId: "UNPAIRED" }]);
    expect(latest.map(value => value.requestId).sort()).toEqual(["latest-a", "other-worker"]);
    expect(latest.find(value => value.requestId === "latest-a")).toEqual(rows[0]!);
  });
  test("competing cancellation persists one audit without rewriting settlement; a concurrent progress update rejects stale closure", async () => {
    const id = "routine-102-1-dev-day1-ota";
    const repository = new MongoTestRunFollowUpRepository();
    const service = new TestRunFollowUpService(repository, github, () => new Date(stamp));
    const responses = await Promise.all([service.cancel(id, "admin-1"), service.cancel(id, "admin-2")]);
    expect(responses[0]).toEqual(responses[1]);
    const stored = await TestRunClaimModel.findOne({ requestId: id }).lean();
    expect(stored?.claim).toEqual(claim(id, true)); expect(stored?.executionTokenSha256).toBe("e".repeat(64));
    let view = await new TestRunOverviewService(new MongoTestRunOverviewRepository(), github).overview();
    expect(view.jobs).toHaveLength(0); expect(view.fixtureAttention?.[0]?.claims[0]?.requestId).toBe(id);
    const racing = "routine-103-1-dev-day1-ota";
    await TestRunClaimModel.create({ requestId: racing, claim: claim(racing), executionTokenSha256: "e".repeat(64) });
    const before = await repository.get(racing);
    await TestRunClaimModel.updateOne({ requestId: racing }, { $set: { progress: { sequence: 10, mode: "recovering" } } });
    expect(await repository.cancel(before!, { cancelledAt: stamp, cancelledBy: "admin-1" })).toBeNull();
    expect((await repository.get(racing))?.followUpCancellation).toBeUndefined();
  });
});
