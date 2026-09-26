import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";
import { createTestDispatchAdminApi } from "../api/admin/test-dispatches.api";
import { adminAuth } from "../api/middleware/admin-auth.middleware";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import { GithubTestBuildGateway, TestDispatchError, type TestBuildGateway } from "./test-builds.service";
import { TestRunGithubApp } from "./test-run-github-app";
import type { TestDispatchInput, TestDispatchReceipt, TestDispatchView } from "../types/test-dispatch.types";
import type { AppEnv } from "../types/hono.types";
import type { TestContinuationBinding } from "../types/test-continuation.types";

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
  test("GitHub App token refresh never retries a dispatch whose response was lost", async () => {
    const f = fixture();
    let now = Date.parse("2026-09-23T12:00:00Z"), mints = 0, sends = 0;
    const fetch = (async (url: string) => {
      if (url.endsWith("/access_tokens")) {
        mints++;
        return Response.json({ token: `token-${mints}`, expires_at: new Date(now + 3600_000).toISOString() }, { status: 201 });
      }
      expect(url).toBe("https://api.github.com/repos/Mentra-Community/MentraOS/actions/workflows/request-e2e-routine.yml/dispatches");
      sends++; throw new Error("Connection lost after accepted send; private transport details");
    }) as typeof globalThis.fetch;
    const appAuth = new TestRunGithubApp({ fetch, now: () => now, credentials: { appId: "12345", installationId: "67890",
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString() } });
    const gateway = new GithubTestBuildGateway({ fetch, appAuth });
    gateway.resolve = f.github.resolve;
    const service = new TestDispatchService(f.repository, gateway);
    expect((await service.create(input, "admin@example.test")).state).toBe("unknown");
    now += 3600_000;
    expect(await appAuth.token("source")).toBe("token-2");
    const replay = await service.create(input, "admin@example.test");
    expect(replay.state).toBe("unknown"); expect(replay.message).not.toContain("private transport details");
    expect(sends).toBe(1); expect(mints).toBe(2);
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
  test("failed continuation admission keeps its unsent execution available for a fresh publication", async () => {
    const f = fixture(), resolve = f.github.resolve;
    const binding: TestContinuationBinding = { occurrenceId: "tfo_" + "e".repeat(64), agentRunId: "agent", executionAttempt: 1,
      candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 12, headSha: "a".repeat(40) }, expectedHeadSha: "a".repeat(40) };
    f.github.resolve = async () => { throw new TestDispatchError(409, "Publication expired"); };
    await expect(f.service.create(input, "agent", binding)).rejects.toThrow("Publication expired");
    expect(f.repository.rows.size).toBe(0); expect(f.sends()).toBe(0);
    f.github.resolve = resolve;
    const selected = { ...input, source: { ...input.source, publicationAttempt: 2 } };
    expect((await f.service.create(selected, "agent", binding)).sendState).toBe("accepted");
    await f.service.create(selected, "agent", binding); expect(f.sends()).toBe(1);
  });
  for (const first of ["rejection", "send"]) test(`continuation ${first} cannot replace the concurrent sent receipt`, async () => {
    const f = fixture(), valid = await f.github.resolve(input.source);
    const binding: TestContinuationBinding = { occurrenceId: "tfo_" + "e".repeat(64), agentRunId: "agent", executionAttempt: 1,
      candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 12, headSha: "a".repeat(40) }, expectedHeadSha: "a".repeat(40) };
    const pending = [deferred<typeof valid>(), deferred<typeof valid>()], entered = deferred<void>(); let calls = 0;
    f.github.resolve = async () => { const index = calls++; if (calls === 2) entered.resolve(); return pending[index]!.promise; };
    const sending = f.service.create(input, "agent", binding), rejecting = f.service.create(input, "agent", binding);
    await entered.promise;
    if (first === "rejection") {
      pending[1]!.reject(new TestDispatchError(409, "Expired publication"));
      await expect(rejecting).rejects.toThrow("Expired publication");
      expect(f.repository.rows.size).toBe(0); pending[0]!.resolve(valid);
      expect((await sending).sendState).toBe("accepted");
    } else {
      pending[0]!.resolve(valid); const sent = await sending;
      pending[1]!.reject(new TestDispatchError(409, "Expired publication")); expect(await rejecting).toEqual(sent);
    }
    expect(f.repository.rows.size).toBe(1); expect(f.sends()).toBe(1);
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
  test.each([["android-refused-install-released", "Android refused the app update"],
    ["preflight-abandoned-released", "preflight failed before setup"]] as const)(
    "an original-owner %s closure resolves the request as failed, never finished, and sends nothing", async (kind, cause) => {
      const f = fixture(); await f.service.create(input, "admin@example.test");
      f.repository.state = { state: "recovery-required", closure: kind };
      const result = await f.service.detail(input.idempotencyKey);
      expect(result).toMatchObject({ state: "failed", requestId: "routine-70-1-12-no-glasses" });
      expect(result.message).toContain(cause);
      expect(result.message).toContain("not a pass"); expect(result.message).toContain("uncommissioned");
      expect(result.message).not.toContain(kind === "preflight-abandoned-released" ? "Android" : "preflight");
      expect(result.result).toBeUndefined();
      expect(await f.service.create(input, "admin@example.test")).toEqual(result);
      expect(f.sends()).toBe(1);
    });
  test("recovery retains the worker evidence link without adopting the workflow verdict or resending", async () => {
    for (const state of ["running", "failed"] as const) {
      const f = fixture(); await f.service.create(input, "admin@example.test");
      f.repository.state = { state: "recovery-required" };
      const workerUrl = "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/80";
      f.github.progress = async (runId, savedInput) => {
        expect(runId).toBe(70); expect(savedInput).toEqual(input);
        return { state, requestId: "routine-70-1-12-no-glasses", workerUrl, message: "Workflow status" };
      };
      const result = await f.service.detail(input.idempotencyKey);
      expect(result).toMatchObject({ state: "recovery-required", workerUrl, requestId: "routine-70-1-12-no-glasses" });
      expect(result.message).toContain("retained this fixture for recovery"); expect(result.result).toBeUndefined();
      expect(await f.service.create(input, "admin@example.test")).toEqual(result);
      expect(f.sends()).toBe(1); expect(f.resolveCount()).toBe(1);
    }
  });
  test("unavailable workflow evidence cannot clear a recovery hold or authorize another send", async () => {
    const f = fixture(); await f.service.create(input, "admin@example.test");
    f.repository.state = { state: "recovery-required" };
    f.github.progress = async () => { throw new Error("GitHub unavailable; private transport details"); };
    const result = await f.service.detail(input.idempotencyKey);
    expect(result.state).toBe("recovery-required"); expect(result.workerUrl).toBeUndefined();
    expect(result.message).not.toContain("private transport details");
    expect(await f.service.create(input, "admin@example.test")).toEqual(result);
    expect(f.sends()).toBe(1); expect(f.resolveCount()).toBe(1);
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


test("Android dispatch resolves the selected routine's APK before its single send", async () => {
  const f = fixture();
  const androidInput = { ...input, routineId: "no-glasses-android" as const };
  let observed: unknown;
  f.github.resolve = async (source, routineId) => {
    observed = { source, routineId };
    return { source, platform: "android", title: "Android candidate", headSha: "a".repeat(40),
      buildUrl: "https://github.com/test", createdAt: new Date().toISOString(), availability: "available",
      archive: { name: "candidate.apk", sha256: input.archiveSha256, size: 100 },
      routines: [{ id: "no-glasses-android", available: true }] };
  };
  await f.service.create(androidInput, "admin@example.test");
  expect(observed).toEqual({ source: input.source, routineId: "no-glasses-android" });
  expect(f.sends()).toBe(1);
  await f.service.create(androidInput, "admin@example.test");
  expect(f.sends()).toBe(1);
});

test("Admin inventory forwards the optional routine selector and rejects arbitrary platforms", async () => {
  const f = fixture(); let observed: unknown;
  f.github.inventory = async query => { observed = query; return []; };
  const api = createTestDispatchAdminApi(f.service, f.github);
  expect((await api.request("/test-builds?channel=dev&routineId=no-glasses-android")).status).toBe(200);
  expect(observed).toEqual({ channel: "dev", routineId: "no-glasses-android" });
  expect((await api.request("/test-builds?channel=dev&platform=android")).status).toBe(400);
  const routines = await (await api.request("/test-routines")).json() as { routines: { id: string }[] };
  expect(routines.routines.some(routine => routine.id === "no-glasses-android")).toBe(true);
});
