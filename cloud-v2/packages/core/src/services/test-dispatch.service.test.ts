import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createTestDispatchAdminApi } from "../api/admin/test-dispatches.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import type { TestBuildGateway } from "./test-builds.service";
import type { TestDispatchInput, TestDispatchReceipt } from "../types/test-dispatch.types";

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
  test("unavailable, incompatible and changed builds never create a send fence or dispatch", async () => {
    const f = fixture();
    await expect(f.service.create({ ...input, routineId: "day1-ota" }, "admin@example.test")).rejects.toThrow("No compatible fixture");
    await expect(f.service.create({ ...input, archiveSha256: "e".repeat(64) }, "admin@example.test")).rejects.toThrow("changed");
    f.unavailable(); await expect(f.service.create(input, "admin@example.test")).rejects.toThrow("unavailable");
    expect(f.sends()).toBe(0); expect(f.repository.rows.size).toBe(0);
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
