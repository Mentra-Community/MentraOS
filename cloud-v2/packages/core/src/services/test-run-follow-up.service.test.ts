import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import type { AppEnv } from "../types/hono.types";
import type { OverviewJob, TestRunFollowUpCancellation } from "../types/test-run-overview.types";
import { MongoTestRunFollowUpRepository, TestRunFollowUpService, type FollowUpRecord, type TestRunFollowUpRepository } from "./test-run-follow-up.service";
const stamp = "2026-09-24T20:00:00.000Z";
const original = (): FollowUpRecord => ({ claim: { requestId: "request-1", requestSha256: "a".repeat(64),
  workerId: "mini-1", fixtureId: "glasses-1", executionId: "execution-1", claimedAt: stamp,
  state: "recovery-required", settlement: { state: "recovery-required", reason: "Retained fixture" }, settledAt: stamp } });
class Repository implements TestRunFollowUpRepository {
  row: FollowUpRecord | null = original(); calls = 0;
  async get() { return structuredClone(this.row); }
  async cancel(before: FollowUpRecord, value: TestRunFollowUpCancellation) {
    this.calls++;
    if (!this.row || this.row.followUpCancellation || JSON.stringify(before) !== JSON.stringify(this.row)) return null;
    this.row = { ...this.row, followUpCancellation: value }; return structuredClone(this.row);
  }
}
const job = (state: OverviewJob["state"]): OverviewJob => ({ id: "job-1", kind: "routine", state, title: "Job", createdAt: stamp, claims: [],
  requests: [{ requestId: "request-1", requestRunId: 1, requestAttempt: 1, routineId: "day1-ota", trigger: "admin", channel: "dev" }] });
test("cancellation is audited and idempotent, preserving the original settlement and last checkpoint", async () => {
  const repository = new Repository(); let reads = 0;
  const service = new TestRunFollowUpService(repository, { activity: async options => {
    expect(options).toEqual({ fresh: true }); reads++; return { jobs: [], warnings: [] };
  } }, () => new Date(stamp));
  const before = structuredClone(repository.row);
  expect(await service.cancel("request-1", "admin-1")).toEqual({ cancelledAt: stamp, cancelledBy: "admin-1" });
  expect(await service.cancel("request-1", "admin-2")).toEqual({ cancelledAt: stamp, cancelledBy: "admin-1" });
  expect(repository.row?.claim).toEqual(before?.claim); expect(reads).toBe(1); expect(repository.calls).toBe(1);
});
test("active, queued, waiting, incomplete or unavailable GitHub activity cannot be cancelled", async () => {
  for (const state of ["running", "queued", "waiting"] as const) {
    const repository = new Repository();
    const service = new TestRunFollowUpService(repository, { activity: async () => ({ jobs: [job(state)], warnings: [] }) });
    await expect(service.cancel("request-1", "admin-1")).rejects.toMatchObject({ status: 409 }); expect(repository.calls).toBe(0);
  }
  for (const activity of [async () => { throw Error("private"); }, async () => ({ jobs: [], warnings: ["Incomplete queue"] }),
    async () => ({ jobs: [{ ...job("queued"), requests: [] }], warnings: [] }),
    async () => ({ jobs: [{ ...job("queued"), kind: "nightly" as const }], warnings: [] })]) {
    const repository = new Repository();
    await expect(new TestRunFollowUpService(repository, { activity }).cancel("request-1", "admin-1")).rejects.toMatchObject({ status: 503 });
    expect(repository.calls).toBe(0);
  }
});
test("a concurrent worker checkpoint prevents cancellation from using stale observations", async () => {
  const repository = new Repository();
  const service = new TestRunFollowUpService(repository, { activity: async () => {
    repository.row!.progress = { sequence: 1, phase: "teardown", mode: "recovering", step: null, completedSteps: 0, totalSteps: 1, receivedAt: stamp };
    return { jobs: [], warnings: [] };
  } });
  await expect(service.cancel("request-1", "admin-1")).rejects.toMatchObject({ status: 409 });
  expect(repository.row?.followUpCancellation).toBeUndefined();
});
test("Mongo writes only cancellation metadata with durable concern and an exact state comparison", async () => {
  const update = spyOn(TestRunClaimModel, "findOneAndUpdate").mockImplementation((() => ({ select: () => ({ lean: async () => null }) })) as never);
  try {
    const cancellation = { cancelledAt: stamp, cancelledBy: "admin-1" };
    await new MongoTestRunFollowUpRepository().cancel(original(), cancellation);
    expect(update.mock.calls[0]).toEqual([{ requestId: "request-1", claim: original().claim,
      progress: { $exists: false }, followUpCancellation: { $exists: false } },
    { $set: { followUpCancellation: cancellation } }, { new: true, writeConcern: { w: "majority", j: true, wtimeout: 10_000 } }]);
  } finally { update.mockRestore(); }
});
test("the endpoint requires Admin auth and explicit JSON confirmation; worker credentials cannot close follow-up", async () => {
  const repository = new Repository();
  const service = new TestRunFollowUpService(repository, { activity: async () => ({ jobs: [], warnings: [] }) });
  const route = createTestRunAdminApi(undefined, undefined, service);
  const gated = new Hono<AppEnv>(); gated.use("*", adminAuth); gated.route("/", route);
  expect((await gated.request("/claims/request-1/cancel-follow-up", { method: "POST", headers: { Authorization: "Bearer synthetic-worker-token" } })).status).toBe(401);
  expect((await route.request("/claims/request-1/cancel-follow-up", { method: "POST" })).status).toBe(403);
  const admin = new Hono<AppEnv>(); admin.use("*", async (c, next) => {
    c.set("isAdmin", true); c.set("developer", { developerId: "admin-1", email: "admin@example.test" }); await next();
  }); admin.route("/", route);
  expect((await admin.request("/claims/request-1/cancel-follow-up", { method: "POST" })).status).toBe(400);
  expect((await admin.request("/claims/request-1/cancel-follow-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: "cancel-follow-up" }) })).status).toBe(200);
  expect(repository.calls).toBe(1);
});
