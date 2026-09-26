import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TestResourceObservationModel } from "../models/test-resource-observation.model";
import { TestRunModel } from "../models/test-run.model";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../types/test-resource-observation.examples";
import type { TestResourceObservation, TestResourceObservationPut } from "../types/test-resource-observation.types";
import { TestResourceObservationService } from "./test-resource-observation.service";
import { MongoTestRunOverviewRepository } from "./test-run-overview.service";

// Opt-in real compare-and-set checks. Always create/drop our own DB on loopback only.
const uri = process.env.TEST_RESOURCE_OBSERVATION_MONGO_URI;
describe.skipIf(!uri)("Mongo resource observation compare-and-set", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search)
      throw new Error("Resource observation integration tests require a plain loopback Mongo URL");
    url.pathname = `/test_resource_observations_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
    connected = true;
    await TestResourceObservationModel.createIndexes();
    await TestRunModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  });
  const put = (hostId: string, observation: TestResourceObservation, expectedRevision: number,
    extra: Partial<TestResourceObservationPut> = {}, resourceKey = "shared"): TestResourceObservationPut =>
    ({ schemaVersion: 1, hostId, resourceKey, expectedRevision, observation, ...extra });

  test("competing first writers and competing writers at one revision: exactly one applies, the rest conflict", async () => {
    for (const expectedRevision of [0, 1]) {
      const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
        new TestResourceObservationService().put("race", "shared", put("race", aliveObservation("run-" + index, 1000 + index), expectedRevision))));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason.status).toBe(409);
    }
    expect(await TestResourceObservationModel.countDocuments({ hostId: "race" })).toBe(1);
    expect((await new TestResourceObservationService().get("race", "shared")).revision).toBe(2);
  });

  test("identical concurrent retries acknowledge one revision with one receipt time", async () => {
    const request = put("retry", retainedObservation(), 0);
    const results = await Promise.all(Array.from({ length: 12 }, () => new TestResourceObservationService().put("retry", "shared", request)));
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect(new Set(results.map(result => result.receivedAt)).size).toBe(1);
    expect(new Set(results.map(result => result.revision))).toEqual(new Set([1]));
  });

  test("an old owner's in-flight snapshot cannot replace a newer owner; progress ordering survives the store", async () => {
    const service = new TestResourceObservationService();
    await service.put("owners", "shared", put("owners", aliveObservation("old-run", 100), 0, { progress: resourceProgress("old-run", 7) }));
    const oldRevision = (await service.get("owners", "shared")).revision;
    await service.put("owners", "shared", put("owners", aliveObservation("new-run", 200), oldRevision));
    await expect(service.put("owners", "shared", put("owners", retainedObservation("old-run", 100), oldRevision))).rejects.toMatchObject({ status: 409 });
    let current = await service.get("owners", "shared");
    expect(current.observation?.owner).toMatchObject({ pid: 200 });
    expect(current.progress).toBeNull();
    await service.put("owners", "shared", put("owners", aliveObservation("new-run", 200), current.revision, { progress: resourceProgress("new-run", 4) }));
    current = await service.get("owners", "shared");
    await service.put("owners", "shared", put("owners", aliveObservation("new-run", 200), current.revision, { progress: resourceProgress("new-run", 2, "Older") }));
    current = await service.get("owners", "shared");
    expect(current.progress).toMatchObject({ runId: "new-run", sequence: 4, step: { label: "Stop recording" } });
    await expect(service.put("owners", "shared", put("owners", aliveObservation("new-run", 200), current.revision,
      { progress: resourceProgress("new-run", 4, "Rewritten") }))).rejects.toMatchObject({ status: 409 });
  });

  test("the overview keeps owned observations beyond the recency bound and links only published run IDs", async () => {
    const service = new TestResourceObservationService();
    await service.put("held", "shared", put("held", retainedObservation("held-run"), 0));
    for (const host of ["idle-1", "idle-2", "idle-3"]) await service.put(host, "shared", put(host, noOwnerObservation(), 0));
    await service.put("held", "android-0123456789ab", put("held", noOwnerObservation(), 0, {}, "android-0123456789ab"));
    const repository = new MongoTestRunOverviewRepository();
    const { rows, truncated } = await repository.resourceObservations(2);
    expect(truncated).toBe(true);
    expect(rows.some(row => row.hostId === "held" && row.resourceKey === "shared")).toBe(true);
    await TestRunModel.create({ runId: "held-run", requestId: "held-run", startedAt: new Date(), payloadSha256: "d".repeat(64),
      payload: { runId: "held-run" }, uploadsComplete: true, outcome: "failed" });
    expect(await repository.publishedRunIds(["held-run", "missing-run"])).toEqual(["held-run"]);
  });
});
