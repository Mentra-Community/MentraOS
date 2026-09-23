import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import type { TestRunClaimRequest } from "../types/test-run-claim.types";
import { TestRunClaimService } from "./test-run-claim.service";

// Opt-in real atomicity checks. Always create/drop our own DB on loopback only.
const uri = process.env.TEST_RUN_CLAIM_MONGO_URI;
describe.skipIf(!uri)("Mongo cross-worker claims", () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== "mongodb:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search) {
      throw new Error("Claim integration tests require a plain loopback Mongo URL");
    }
    url.pathname = `/test_run_claims_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(url.href, { autoIndex: false, serverSelectionTimeoutMS: 5000 });
    connected = true;
    await TestRunClaimModel.createIndexes();
  });
  afterAll(async () => {
    if (connected) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  });
  const request = (requestId: string, worker = 1): TestRunClaimRequest => ({ requestId, requestSha256: "a".repeat(64),
    workerId: `mini-${worker}`, fixtureId: `glasses-${worker}`, executionId: randomUUID(), executionToken: randomBytes(32).toString("hex") });

  test("the unique index grants exactly one competing worker across independent service instances", async () => {
    const attempts = Array.from({ length: 24 }, (_, index) => request("competing", index));
    const results = await Promise.allSettled(attempts.map(input => new TestRunClaimService().claim(input)));
    const grants = results.filter(result => result.status === "fulfilled" && result.value.executionGranted);
    expect(grants).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(23);
    for (const result of results) if (result.status === "rejected") expect(result.reason.status).toBe(409);
    expect(await TestRunClaimModel.countDocuments({ requestId: "competing" })).toBe(1);
    const read = await new TestRunClaimService().get("competing");
    expect(read.executionGranted).toBe(false);
    const owner = attempts.find(attempt => attempt.executionId === read.claim.executionId)!;
    expect((await new TestRunClaimService().claim(owner)).executionGranted).toBe(false);
  });

  test("identical concurrent POSTs produce one grant and immutable claimed time", async () => {
    const input = request("same-owner");
    const results = await Promise.all(Array.from({ length: 16 }, () => new TestRunClaimService().claim(input)));
    expect(results.filter(result => result.executionGranted)).toHaveLength(1);
    expect(new Set(results.map(result => result.claim.claimedAt)).size).toBe(1);
  });

  test("atomic settlement chooses one outcome and leaves recovery ownership sticky", async () => {
    const input = request("settlement");
    await new TestRunClaimService().claim(input);
    const settlements = [
      { state: "terminal" as const, resultRunId: "result-1" },
      { state: "recovery-required" as const, reason: "Needs explicit reconciliation" },
    ];
    const results = await Promise.allSettled(settlements.map(settlement =>
      new TestRunClaimService().settle(input.requestId, { executionToken: input.executionToken, settlement })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const read = await new TestRunClaimService().get(input.requestId);
    expect(await new TestRunClaimService().settle(input.requestId,
      { executionToken: input.executionToken, settlement: read.claim.settlement })).toEqual(read);
    expect((await new TestRunClaimService().claim(input)).executionGranted).toBe(false);
  });
});
