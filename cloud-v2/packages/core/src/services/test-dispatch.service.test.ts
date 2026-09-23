import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createTestDispatchAdminApi } from "../api/admin/test-dispatches.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import { TestDispatchError, type TestBuildGateway } from "./test-builds.service";
import type { TestDispatchInput, TestDispatchReceipt, TestDispatchView } from "../types/test-dispatch.types";
import type { AppEnv } from "../types/hono.types";

const input: TestDispatchInput = { source: { channel: "pr", prNumber: 12, buildRunId: 50, publicationAttempt: 1 }, routineId: "no-glasses",
  archiveSha256: "d".repeat(64), idempotencyKey: "ad616c04-c5e5-4dcd-b7c4-d9d4a626166d" };
class MemoryRepository implements TestDispatchRepository {
  rows = new Map<string, { inputSha256: string; receipt: TestDispatchReceipt }>();
  state: Awaited<ReturnType<TestDispatchRepository["claim"]>> = null;
  outcome = "failed";
  async get(id: string) { return this.rows.get(id) ?? null; }
  async recent() { return [...this.rows.values()].map(row => row.receipt); }
  async insert(value: { inputSha256: string; receipt: TestDispatchReceipt }) {
    const before = this.rows.get(value.receipt.dispatchId);
    if (before) return { stored: before, created: false };
    this.rows.set(value.receipt.dispatchId, value); return { stored: value, created: true };
  }
  async acknowledge(id: string, response: { requestRunId: number; requestUrl: string } | null) {
    const row = this.rows.get(id)!;
    row.receipt = { ...row.receipt, sendState: response ? "accepted" : "unknown", ...response };
    return row.receipt;
  }
  async claim() { return this.state; }
  async result() { return { runId: "result-1", requestId: "routine-70-1-12-no-glasses", outcome: this.outcome,
    outcomes: { test: this.outcome, teardown: "passed", fixture: "ready", evidence: "complete" }, provenance: { archiveSha256: input.archiveSha256 } }; }
}
function fixture() {
  const repository = new MemoryRepository();
  let sends = 0, resolveCount = 0, ambiguous = false, available = true;
  const github: TestBuildGateway = {
    inventory: async () => [],
    resolve: async source => { resolveCount++; return { source, title: "Candidate", headSha: "a".repeat(40), buildUrl: "https://github.com/test", createdAt: new Date().toISOString(),
      availability: available ? "available" : "unavailable", archive: { name: "candidate.zip", sha256: input.archiveSha256, size: 100 },
      routines: [{ id: "no-glasses", available: true }, { id: "day1-ota", available: false, reason: "No compatible fixture" }] }; },
    dispatch: async () => { sends++; if (ambiguous) throw new Error("Connection lost after send"); return { requestRunId: 70, requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/70" }; },
    progress: async () => ({ state: "queued", requestId: "routine-70-1-12-no-glasses", message: "Waiting for worker" }),
  };
  const service = new TestDispatchService(repository, github);
  return { repository, service, github, sends: () => sends, resolveCount: () => resolveCount, ambiguous: () => { ambiguous = true; }, unavailable: () => { available = false; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("durable dispatch ownership", () => {
  test("concurrent identical submissions send only once and later replays only read the receipt", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 10 }, () => f.service.create(input, "admin@example.test")));
    expect(f.sends()).toBe(1);
    const before = f.resolveCount();
    expect((await f.service.create(input, "admin@example.test")).state).toBe("queued");
    expect(f.resolveCount()).toBe(before);
  });
  test("same idempotency key cannot be rebound to another actor, routine or archive", async () => {
    const f = fixture(); await f.service.create(input, "admin@example.test");
    await expect(f.service.create(input, "other@example.test")).rejects.toThrow("different request");
    await expect(f.service.create({ ...input, routineId: "day1-ota" }, "admin@example.test")).rejects.toThrow("different request");
    await expect(f.service.create({ ...input, archiveSha256: "e".repeat(64) }, "admin@example.test")).rejects.toThrow("different request");
    expect(f.sends()).toBe(1);
  });
  test("an ambiguous send remains unknown and never resends", async () => {
    const f = fixture(); f.ambiguous();
    expect((await f.service.create(input, "admin@example.test")).state).toBe("unknown");
    expect((await f.service.create(input, "admin@example.test")).state).toBe("unknown");
    expect(f.sends()).toBe(1);
  });
  test("unavailable, incompatible and changed builds save a rejection that exact retries cannot send", async () => {
    for (const scenario of ["unavailable", "incompatible", "changed"]) {
      const f = fixture();
      if (scenario === "unavailable") f.unavailable();
      const request = { ...input, ...(scenario === "incompatible" ? { routineId: "day1-ota" as const } : {}),
        ...(scenario === "changed" ? { archiveSha256: "e".repeat(64) } : {}) };
      const result = await f.service.create(request, "admin@example.test");
      expect(result.sendState).toBe("rejected"); expect(result.state).toBe("unavailable");
      expect(result.message).toContain("not sent");
      const before = f.resolveCount();
      expect(await f.service.detail(input.idempotencyKey)).toEqual(result);
      expect(await f.service.create(request, "admin@example.test")).toEqual(result);
      expect(f.resolveCount()).toBe(before);
      expect(f.sends()).toBe(0); expect(f.repository.rows.size).toBe(1);
      await expect(f.service.create(request, "other@example.test")).rejects.toThrow("different request");
    }
  });
  test("a resolver conflict is recoverable through the API instead of returning a permanent missing receipt", async () => {
    const f = fixture();
    f.github.resolve = async () => { throw new TestDispatchError(409, "Choose an open same-repository PR targeting dev"); };
    const root = new Hono<AppEnv>();
    root.use("*", async (c, next) => { c.set("developer", { developerId: "test-admin", email: "admin@example.test" }); await next(); });
    root.route("/", createTestDispatchAdminApi(f.service, f.github));
    const response = await root.request("/test-dispatches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(202);
    const body = await response.json() as TestDispatchView;
    expect(body).toMatchObject({ sendState: "rejected", state: "unavailable", dispatchId: input.idempotencyKey });
    expect(body.message).toContain("open same-repository PR");
    const detail = await root.request(`/test-dispatches/${input.idempotencyKey}`);
    expect(detail.status).toBe(200); expect(await detail.json()).toEqual(body);
    expect(f.sends()).toBe(0);
  });
  for (const first of ["rejection", "send"]) test(`${first} wins the unique receipt when concurrent validations disagree`, async () => {
    const f = fixture(), valid = await f.github.resolve(input.source);
    const pending = [deferred<typeof valid>(), deferred<typeof valid>()], entered = deferred<void>();
    let calls = 0;
    f.github.resolve = async () => { const position = calls++; if (calls === 2) entered.resolve(); return pending[position]!.promise; };
    const sending = f.service.create(input, "admin@example.test"), rejecting = f.service.create(input, "admin@example.test");
    await entered.promise;
    if (first === "rejection") {
      pending[1]!.reject(new TestDispatchError(409, "The PR closed during validation"));
      const rejected = await rejecting;
      pending[0]!.resolve(valid);
      expect(await sending).toEqual(rejected);
      expect(rejected.sendState).toBe("rejected"); expect(f.sends()).toBe(0);
    } else {
      pending[0]!.resolve(valid);
      const accepted = await sending;
      pending[1]!.reject(new TestDispatchError(409, "The PR closed during validation"));
      expect(await rejecting).toEqual(accepted);
      expect(accepted.sendState).toBe("accepted"); expect(f.sends()).toBe(1);
    }
    expect(f.repository.rows.size).toBe(1);
  });
  test("a lost rejection insert acknowledgement preserves the receipt for exact retry and status lookup", async () => {
    const f = fixture(); f.unavailable();
    const insert = f.repository.insert.bind(f.repository);
    f.repository.insert = async value => { await insert(value); throw new Error("Lost database acknowledgement"); };
    await expect(f.service.create(input, "admin@example.test")).rejects.toThrow("Lost database acknowledgement");
    expect((await f.service.detail(input.idempotencyKey)).sendState).toBe("rejected");
    expect((await f.service.create(input, "admin@example.test")).state).toBe("unavailable");
    expect(f.sends()).toBe(0);
  });
  test("transient source validation leaves the same submission available for retry", async () => {
    for (const failure of [new TestDispatchError(503, "GitHub unavailable"), new Error("Network timeout")]) {
      const f = fixture(), resolve = f.github.resolve;
      f.github.resolve = async () => { throw failure; };
      await expect(f.service.create(input, "admin@example.test")).rejects.toThrow(failure.message);
      expect(f.repository.rows.size).toBe(0);
      f.github.resolve = resolve;
      expect((await f.service.create(input, "admin@example.test")).sendState).toBe("accepted");
      expect(f.sends()).toBe(1);
    }
  });
  test("terminal claim uses the actual result verdict; failed tests and incomplete evidence never become passing", async () => {
    const f = fixture(); await f.service.create(input, "admin@example.test");
    f.repository.state = { state: "terminal", resultRunId: "result-1" };
    const result = await f.service.detail(input.idempotencyKey);
    expect(result.state).toBe("finished"); expect(result.result?.outcome).toBe("failed");
    expect(result.result?.reportPath).toBe("/?testRun=result-1");
    f.repository.state = { state: "recovery-required" };
    expect((await f.service.detail(input.idempotencyKey)).state).toBe("recovery-required");
  });
});

test("all dispatch endpoints require the same admin authentication as recorded results", async () => {
  const f = fixture();
  const root = new Hono(); root.use("*", adminAuth); root.route("/", createTestDispatchAdminApi(f.service, f.github));
  for (const [method, path] of [["GET", "/test-builds?channel=dev"], ["GET", "/test-dispatches"], ["POST", "/test-dispatches"], ["GET", "/test-routines"]]) {
    const response = await root.request(path!, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-worker-token" },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}) });
    expect(response.status).toBe(401);
  }
  expect(f.sends()).toBe(0);
});
