import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TestHostLatestModel, TestHostSampleModel } from "../models/test-host-health.model";
import type { TestHostSample } from "../types/test-host-health.types";
import { TestHostHealthService } from "./test-host-health.service";

const uri = process.env.TEST_HOST_HEALTH_MONGO_URI;
describe.skipIf(!uri)("Mongo host sample ordering and bounded indexed history", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("Host health integration tests require plain loopback Mongo");
    url.pathname = `/host_health_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5_000 }); connected = true;
    await TestHostSampleModel.createIndexes(); await TestHostLatestModel.createIndexes();
  });
  afterAll(async () => { if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
  const base = Date.now();
  const sample = (hostId: string, at: number): TestHostSample => ({ schemaVersion: 1, hostId, sampleId: randomUUID(), sampledAt: new Date(at).toISOString(),
    freeBytes: 20 * 1024 ** 3, components: [], cleanupEvents: [] });
  test("identical concurrent retries share one receipt and late delivery cannot replace the latest sample", async () => {
    const service = new TestHostHealthService(), input = sample("race", base - 60_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.ingest(input)));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.receivedAt)).size).toBe(1);
    const newer = sample("race", base); await service.ingest(newer); await service.ingest(sample("race", base - 120_000));
    expect((await service.list()).hosts.find(host => host.hostId === "race")?.sampleId).toBe(newer.sampleId);
    await expect(service.ingest({ ...input, freeBytes: 1 })).rejects.toMatchObject({ status: 409 });
  });
  test("history uses compound index with no global sort; retained host registry has no TTL", async () => {
    const service = new TestHostHealthService();
    await Promise.all(Array.from({ length: 120 }, (_, index) => service.ingest(sample("series", base - index * 60_000))));
    await service.ingest(sample("other-host", base));
    const history = await service.history("series", "1");
    expect(history.points).toHaveLength(120);
    expect(history.points[0].sampledAt).toBe(new Date(base - 119 * 60_000).toISOString());
    expect(history.points.at(-1)?.sampledAt).toBe(new Date(base).toISOString());
    const explain = await TestHostSampleModel.collection.find({ hostId: "series", sampledAt: { $gte: new Date(base - 86_400_000), $lte: new Date() } })
      .sort({ sampledAt: -1, sampleId: -1 }).hint("host_sample_history").limit(10).explain("executionStats");
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain("IXSCAN");
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
    expect(explain.executionStats.totalDocsExamined).toBe(10);
    expect(explain.executionStats.totalKeysExamined).toBe(10);
    expect((await TestHostSampleModel.collection.indexes()).some(index => index.expireAfterSeconds === 0)).toBe(true);
    expect((await TestHostLatestModel.collection.indexes()).some(index => index.expireAfterSeconds !== undefined)).toBe(false);
    console.log(JSON.stringify({ proof: "host-history-index", documents: 120, examined: explain.executionStats.totalDocsExamined, index: "host_sample_history" }));
  });
});
