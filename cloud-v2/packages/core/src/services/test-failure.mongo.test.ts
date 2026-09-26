import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TestRunModel } from "../models/test-run.model";
import type { TestRun } from "../types/test-run.types";
import { MongoTestRunRepository, TestRunService } from "./test-run.service";

// Optional real Mongo proof; never use an existing database or non-loopback host.
const uri = process.env.TEST_FAILURE_MONGO_URI;
describe.skipIf(!uri)("Mongo failure occurrence durability", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("Failure tests require a plain loopback Mongo URL");
    url.pathname = `/test_failures_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
    connected = true;
    await TestRunModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  });
  const fixture = (runId: string): TestRun => ({
    runId, requestId: "request", routineId: "no-glasses-android", routineVersion: "1", platform: "android", channel: "dev",
    startedAt: "2026-09-24T00:00:00Z", finishedAt: "2026-09-24T00:01:00Z", outcome: "failed",
    outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "incomplete" },
    provenance: { repository: "Mentra-Community/MentraOS" }, fixture: { alias: "phone" },
    firmwareAssertions: [], chapters: [], assets: [],
  });

  test("concurrent metadata retries create one occurrence, and passing runs share no failure identity", async () => {
    const run = fixture("concurrent");
    const results = await Promise.all(Array.from({ length: 12 }, () => new TestRunService().ingest(run)));
    expect(results.filter(item => item.created)).toHaveLength(1);
    expect(new Set(results.flatMap(item => item.occurrenceIds)).size).toBe(1);
    expect(await TestRunModel.countDocuments({ runId: run.runId })).toBe(1);
    for (const id of ["pass-1", "pass-2"]) {
      const passed = { ...fixture(id), outcome: "passed" as const,
        outcomes: { test: "passed" as const, teardown: "passed" as const, fixture: "ready" as const, evidence: "complete" as const } };
      expect((await new TestRunService().ingest(passed)).occurrenceIds).toEqual([]);
    }
  });

  test("competing acknowledgments choose one receipt and restart/replay preserves it", async () => {
    const run = fixture("ack-race");
    const id = (await new TestRunService().ingest(run)).occurrenceIds[0]!;
    const attempts = await Promise.allSettled(["agent_first", "agent_second"].map(agent => new TestRunService().acknowledgeFailure(id, agent)));
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const before = (await new TestRunService().failureDetail(id)).delivery;
    await new TestRunService().ingest(run);
    expect((await new TestRunService().failureDetail(id)).delivery).toEqual(before);
    expect((await new TestRunService().failureDetail(id)).originalOutcome).toBe("failed");
  });

  test("old-row reconciliation and pending delivery use persisted occurrence identity", async () => {
    const run = fixture("old-row");
    const id = (await new TestRunService().ingest(run)).occurrenceIds[0]!;
    await TestRunModel.updateOne({ runId: run.runId }, { $unset: { failureOccurrences: "" } });
    const reconciled = await Promise.all([new TestRunService().ingest(run), new TestRunService().ingest(run)]);
    expect(reconciled.map(item => item.occurrenceIds)).toEqual([[id], [id]]);
    const repository = new MongoTestRunRepository();
    await repository.noteFailureDeliveryAttempt(id);
    const pending = await repository.pendingFailures(10);
    expect(pending.flatMap(item => item.failureOccurrences ?? []).find(item => item.occurrenceId === id)?.delivery)
      .toMatchObject({ state: "pending", lastAttemptAt: expect.any(String) });
  });
});
