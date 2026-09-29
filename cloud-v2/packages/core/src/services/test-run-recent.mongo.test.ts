import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { backfillTestRunCompletionDates } from "../migrations/test-run-completion.migration";
import { TEST_RUN_COMPLETION_INDEX, TestRunModel } from "../models/test-run.model";
import type { TestRun } from "../types/test-run.types";
import { MongoTestRunRepository } from "./test-run.service";

const uri = process.env.TEST_RUN_RECENT_MONGO_URI;
type QueryPlan = { queryPlanner: { winningPlan: unknown }; executionStats: { nReturned: number; totalDocsExamined: number } };
describe.skipIf(!uri)("Mongo recently completed test runs", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw Error("Recent-run tests require a plain loopback Mongo URL");
    url.pathname = "/test_recent_" + randomUUID().replaceAll("-", "");
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
    connected = true;
    await TestRunModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  });

  test("six latest actual finish times include an old-start job, all channels, ties and legacy records", async () => {
    const rows = [
      { id: "old-start-late-finish", start: "2026-09-19T00:00:00Z", finish: "2026-09-21T13:00:00Z", channel: "pr" },
      { id: "offset-finish", finish: "2026-09-21T07:30:00-05:00", channel: "staging" },
      { id: "tie-z", finish: "2026-09-21T12:00:00Z", channel: "dev" },
      { id: "tie-a", finish: "2026-09-21T12:00:00Z", channel: "pr" },
      { id: "fifth", finish: "2026-09-21T11:00:00Z", channel: "staging" },
      { id: "sixth", finish: "2026-09-21T10:00:00Z", channel: "dev" },
      { id: "seventh", finish: "2026-09-21T09:00:00Z", channel: "dev" },
      { id: "invalid", finish: "not-a-time", channel: "pr" },
      { id: "missing", channel: "pr" },
    ];
    // These predate any completion index/occurrence projection: only immutable payload has a finish time.
    await TestRunModel.collection.insertMany(rows.map(row => ({ runId: row.id, requestId: row.id,
      startedAt: new Date(row.start ?? "2026-09-21T08:00:00Z"), payloadSha256: "a".repeat(64), outcome: "failed",
      payload: { runId: row.id, channel: row.channel, startedAt: row.start ?? "2026-09-21T08:00:00Z",
        ...(row.finish ? { finishedAt: row.finish } : {}) } })));
    await TestRunModel.collection.insertMany(Array.from({ length: 1000 }, (_, i) => ({ runId: `retained-${i}`, requestId: `retained-${i}`,
      startedAt: new Date("2026-09-20T00:00:00Z"), payloadSha256: "b".repeat(64), outcome: "passed",
      payload: { runId: `retained-${i}`, startedAt: "2026-09-20T00:00:00Z", finishedAt: "2026-09-20T01:00:00Z" } })));
    const repository = new MongoTestRunRepository();
    await expect(repository.recent()).rejects.toMatchObject({ status: 503 });
    const before = await TestRunModel.collection.find({}).sort({ runId: 1 }).toArray();
    expect(await backfillTestRunCompletionDates()).toEqual({ matchedCount: 1009, modifiedCount: 1009, complete: true });
    expect(await backfillTestRunCompletionDates()).toEqual({ matchedCount: 0, modifiedCount: 0, complete: true });
    const after = await TestRunModel.collection.find({}).sort({ runId: 1 }).toArray();
    expect(after.map(({ completedAt: _date, completionProjectionVersion: _version, ...row }) => row)).toEqual(before);
    const recent = await repository.recent();
    expect(recent.map(row => row.run.runId))
      .toEqual(["old-start-late-finish", "offset-finish", "tie-z", "tie-a", "fifth", "sixth"]);
    expect(recent.every(row => row.failureOccurrences === undefined)).toBe(true);
    expect((await TestRunModel.collection.findOne({ runId: "missing" }))?.payload).not.toHaveProperty("finishedAt");
    // The existing history endpoint still uses startedAt and its own pagination.
    const history = await repository.list({ limit: 1 });
    expect(history).toHaveLength(2);
    expect(history.map(row => row.run.runId)).not.toContain("old-start-late-finish");
    expect((recent[0]!.run as TestRun).finishedAt).toBe("2026-09-21T13:00:00Z");
    const plan = await TestRunModel.find({ completionProjectionVersion: 1, completedAt: { $type: "date" } })
      .sort({ completedAt: -1, runId: -1 }).limit(6).hint(TEST_RUN_COMPLETION_INDEX).explain("executionStats") as unknown as QueryPlan;
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('"IXSCAN"');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toMatch(/"(?:COLLSCAN|SORT)"/);
    expect(plan.executionStats.nReturned).toBe(6);
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(6);
    const missingPlan = await TestRunModel.find({ completionProjectionVersion: { $ne: 1 } }).select({ _id: 1 })
      .limit(1).hint(TEST_RUN_COMPLETION_INDEX).explain("executionStats") as unknown as QueryPlan;
    expect(JSON.stringify(missingPlan.queryPlanner.winningPlan)).toContain('"IXSCAN"');
    expect(missingPlan.executionStats.totalDocsExamined).toBe(0);
    // A still-old pod can insert after startup; it must surface a temporary error until the explicit retry.
    await TestRunModel.collection.insertOne({ runId: "rolling-writer", requestId: "rolling-writer",
      startedAt: new Date("2026-09-20T00:00:00Z"), payloadSha256: "c".repeat(64), outcome: "failed",
      payload: { runId: "rolling-writer", startedAt: "2026-09-20T00:00:00Z", finishedAt: "2026-09-21T14:00:00Z" } });
    await expect(repository.recent()).rejects.toMatchObject({ status: 503 });
    expect((await backfillTestRunCompletionDates()).modifiedCount).toBe(1);
    expect((await repository.recent())[0]?.run.runId).toBe("rolling-writer");
  });
});
