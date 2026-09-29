import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestRepairOperation, TestRepairReceipt } from "../types/test-repair.types";
import { configuredTestRepairExecutor, HttpTestRepairExecutor, REPAIR_STATUS, REPAIR_SUBMIT } from "./test-repair.http";
import { TestRepairService, absentTestRepairExecutor, type TestRepairExecutor, type TestRepairRepository } from "./test-repair.service";
import type { TestRunService } from "./test-run.service";

const secret = "repair-bridge-test-signing-secret-".repeat(2), origin = "https://agent.example.test", now = 1_790_000_000_000;
const occurrenceId = "tfo_" + "a".repeat(64), headSha = "b".repeat(40), operationId = "11111111-2222-4333-a444-555555555555";
const grant: ContinuationGrant = { purpose: "mentra-routine-fixer-continuation-v1", environment: "staging", occurrenceId, agentRunId: "run_123",
  candidate: { repository: "Mentra-Community/MentraOS", headSha, target: "original" }, executionAttempt: 1, leaseGeneration: 7,
  leaseTokenSha256: "c".repeat(64), routineIds: ["no-glasses-android"], actions: ["repair-state", "read-results"], expires: Math.floor(now / 1000) + 600 };
const request = { operationId, operation: "android.sign-in-recovery", routineId: "no-glasses-android", reason: "Setup sign-in left the app on the start screen" };
const owner = { workerId: "mini", fixtureId: "pixel-7" };
const evidence = (passed: boolean) => ({ before: { sequence: 3 }, action: { sequence: 4 }, result: { sequence: 5 },
  check: { passed, restore: "passed", returnVerification: passed ? "passed" : "failed", fixture: "ready" } });
const about = (extra: Record<string, unknown>) => ({ repairId: operationId, operation: "android.sign-in-recovery", ...extra });

/** A fake internal-tools bridge that verifies exactly what the wire requires before answering. */
function bridge(operation: TestRepairOperation = "android.sign-in-recovery") {
  const seen: { route: string; body: Record<string, unknown>; raw: string }[] = [];
  let submitMode: "accept" | "accept-lost" | number = "accept", statusMode: unknown = about({ state: "running", owner, operation });
  let admitted = 0;
  const fetch = (async (input: URL, init: RequestInit) => {
    const url = new URL(input), headers = new Headers(init.headers), raw = String(init.body);
    const route = url.pathname === REPAIR_SUBMIT.path ? REPAIR_SUBMIT : url.pathname === REPAIR_STATUS.path ? REPAIR_STATUS : null;
    expect(route).not.toBeNull(); expect(url.origin).toBe(origin); expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
    expect(headers.get("content-type")).toBe(route!.contentType);
    const expires = Number(headers.get("x-mentra-action-expires"));
    expect(expires).toBe(Math.floor(now / 1000) + 30);
    expect(headers.get("x-mentra-action-signature")).toBe(createHmac("sha256", secret).update(`${route!.domain}\n${expires}\n${raw}`).digest("hex"));
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);
    seen.push({ route: route!.path, body: JSON.parse(raw), raw });
    if (route === REPAIR_SUBMIT) {
      if (typeof submitMode === "number") return new Response(JSON.stringify({ error: "refused" }), { status: submitMode });
      admitted++;
      // The admission is durable on the bridge; only its reply is lost.
      if (submitMode === "accept-lost") throw new TypeError("socket closed after admission");
      return Response.json({ schemaVersion: 1, repairId: operationId, operation, state: "accepted" });
    }
    if (typeof statusMode === "number") return new Response("unavailable", { status: statusMode });
    if (statusMode instanceof Error) throw statusMode;
    return typeof statusMode === "string" ? new Response(statusMode) : Response.json(statusMode);
  }) as unknown as typeof globalThis.fetch;
  const executor = new HttpTestRepairExecutor({ url: origin, secret, operations: [operation], fetch, now: () => now });
  return { executor, seen, admitted: () => admitted, submit: (mode: typeof submitMode) => { submitMode = mode; },
    status: (mode: unknown) => { statusMode = mode; }, submits: () => seen.filter(item => item.route === REPAIR_SUBMIT.path).length };
}
function service(executor: TestRepairExecutor = bridge().executor) {
  const packet = { occurrenceId, sourceStatus: "recorded", source: { repository: "Mentra-Community/MentraOS", headSha },
    delivery: { state: "acknowledged", agentRunId: "run_123" } } as unknown as Awaited<ReturnType<TestRunService["failureDetail"]>>;
  const rows = new Map<string, { inputSha256: string; receipt: TestRepairReceipt }>();
  const repository: TestRepairRepository = {
    get: async id => rows.get(id) ?? null,
    insert: async value => { const before = rows.get(value.receipt.repairId); if (before) return { stored: before, created: false };
      rows.set(value.receipt.repairId, value); return { stored: value, created: true }; },
    acknowledge: async (id, outcome) => { const value = rows.get(id)!.receipt;
      if (value.sendState === "sending") Object.assign(value, { sendState: outcome?.state ?? "unknown", ...(outcome?.state === "rejected" ? { rejectionReason: outcome.reason } : {}) });
      return value; },
    reconcile: async id => { const value = rows.get(id)!.receipt;
      if (["sending", "unknown"].includes(value.sendState)) Object.assign(value, { sendState: "accepted", reconciledAt: "2026-09-27T00:00:00Z" });
      return value; },
  };
  const runs = { failureDetail: async () => packet } as unknown as TestRunService;
  return { rows, service: new TestRepairService(runs, executor, repository, async () => {}) };
}

test("configuration enables the executor only with the origin, secret and an explicit enrolled allowlist", () => {
  const base = { CLOUD_REPORT_AGENT_URL: origin, CLOUD_REPORT_AGENT_SIGNING_SECRET: secret, CLOUD_TEST_REPAIR_OPERATIONS: "android.sign-in-recovery" };
  const enabled = configuredTestRepairExecutor(base);
  expect(enabled).toBeInstanceOf(HttpTestRepairExecutor);
  expect(enabled!.supports("android.sign-in-recovery")).toBe(true);
  expect(enabled!.supports("day1.recovery")).toBe(false);
  expect(enabled!.supports("android.interrupted-search-return")).toBe(false);
  const search = configuredTestRepairExecutor({...base, CLOUD_TEST_REPAIR_OPERATIONS: "android.interrupted-search-return"});
  expect(search!.supports("android.interrupted-search-return")).toBe(true);
  expect(search!.supports("android.sign-in-recovery")).toBe(false);
  expect(configuredTestRepairExecutor({...base, CLOUD_TEST_REPAIR_OPERATIONS:
    "android.sign-in-recovery,android.interrupted-search-return"})!.supports("android.interrupted-search-return")).toBe(true);
  for (const change of [{ CLOUD_TEST_REPAIR_OPERATIONS: "" }, { CLOUD_TEST_REPAIR_OPERATIONS: undefined },
    { CLOUD_TEST_REPAIR_OPERATIONS: "android.sign-in-recovery,day1.recovery" }, { CLOUD_TEST_REPAIR_OPERATIONS: "runner.recovery" },
    { CLOUD_TEST_REPAIR_OPERATIONS: "android.sign-in-recovery,android.sign-in-recovery" },
    { CLOUD_REPORT_AGENT_URL: undefined }, { CLOUD_REPORT_AGENT_URL: "http://agent.example.test" },
    { CLOUD_REPORT_AGENT_URL: "https://user:pass@agent.example.test" }, { CLOUD_REPORT_AGENT_SIGNING_SECRET: "short" }])
    expect(configuredTestRepairExecutor({ ...base, ...change })).toBeNull();
});

test("interrupted-search return keeps the signed original binding and one-send fence, then requires matching status evidence", async () => {
  const operation = "android.interrupted-search-return", b = bridge(operation), f = service(b.executor);
  const input = {...request, operation};
  await expect(f.service.request(grant, {...input, routineId: "day1-ota"})).rejects.toThrow("Routine is outside this capability");
  expect(b.submits()).toBe(0);
  b.submit("accept-lost"); b.status(503);
  expect((await f.service.request(grant, input)).state).toBe("unknown");
  expect(b.seen[0]!.body).toMatchObject({occurrenceId, agentRunId: grant.agentRunId, candidate: grant.candidate,
    leaseGeneration: grant.leaseGeneration, leaseTokenSha256: grant.leaseTokenSha256,
    routineId: "no-glasses-android", repair: {operation, operationId}});
  // The existing fake bridge checks the signature/domain over these exact bytes.
  b.status(about({state: "completed", owner, evidence: evidence(true)}));
  await expect(f.service.detail(grant, operationId)).rejects.toMatchObject({status: 502});
  b.status({repairId: operationId, operation, state: "completed", owner, evidence: evidence(true)});
  expect(await f.service.request({...grant, leaseGeneration: 8}, input)).toMatchObject({state: "completed", operation, owner, evidence: evidence(true)});
  expect(b.submits()).toBe(1); expect(b.admitted()).toBe(1);
});

test("without configuration a repair is 501 and nothing is sent or recorded", async () => {
  const executor = configuredTestRepairExecutor({ CLOUD_REPORT_AGENT_URL: origin, CLOUD_REPORT_AGENT_SIGNING_SECRET: secret }) ?? absentTestRepairExecutor;
  const f = service(executor);
  await expect(f.service.request(grant, request)).rejects.toMatchObject({ status: 501 });
  expect(f.rows.size).toBe(0);
});

test("submit and status are exactly signed, bounded, domain-separated and bound to the registered operation and lease", async () => {
  const b = bridge(), f = service(b.executor);
  expect((await f.service.request(grant, request)).state).toBe("running");
  const [submit, status] = b.seen;
  expect(submit!.route).toBe(REPAIR_SUBMIT.path);
  // Exact wire order and values; the lease is the verified grant's, snapshotted on the receipt.
  expect(submit!.raw).toBe(JSON.stringify({ schemaVersion: 1, environment: "staging", occurrenceId, agentRunId: "run_123",
    executionAttempt: 1, leaseGeneration: 7, leaseTokenSha256: "c".repeat(64), candidate: grant.candidate, routineId: "no-glasses-android",
    repair: { operation: "android.sign-in-recovery", operationId }, reason: request.reason }));
  expect(status!.route).toBe(REPAIR_STATUS.path);
  expect(status!.raw).toBe(JSON.stringify({ schemaVersion: 1, environment: "staging", occurrenceId, agentRunId: "run_123",
    candidate: grant.candidate, routineId: "no-glasses-android", repair: { operation: "android.sign-in-recovery", operationId } }));
  expect(f.rows.get(operationId)!.receipt.lease).toEqual({ environment: "staging", executionAttempt: 1, leaseGeneration: 7, leaseTokenSha256: "c".repeat(64) });
  // The domains differ, so one route's signature can never authorize the other.
  expect(createHmac("sha256", secret).update(`${REPAIR_STATUS.domain}\n1\n${submit!.raw}`).digest("hex"))
    .not.toBe(createHmac("sha256", secret).update(`${REPAIR_SUBMIT.domain}\n1\n${submit!.raw}`).digest("hex"));
  // A replay under a renewed lease reaches the same operation: the lease is outside the stable identity.
  expect((await f.service.request({ ...grant, leaseGeneration: 8, leaseTokenSha256: "d".repeat(64) }, request)).repairId).toBe(operationId);
  expect(b.submits()).toBe(1);
  // Oversized requests are never sent.
  await expect(b.executor.submit({ ...f.rows.get(operationId)!.receipt, request: { ...request, reason: "x".repeat(5000) } as TestRepairReceipt["request"] }))
    .rejects.toThrow("bound");
  expect(b.submits()).toBe(1);
});

test("submit maps 200 to accepted, 400/409/501 to a definite refusal, and anything else to unknown", async () => {
  const receipt = (): TestRepairReceipt => ({ repairId: operationId, request: request as TestRepairReceipt["request"],
    binding: { occurrenceId, agentRunId: "run_123", candidate: grant.candidate },
    lease: { environment: "dev", executionAttempt: 1, leaseGeneration: 7, leaseTokenSha256: "c".repeat(64) }, createdAt: "2026-09-27T00:00:00Z", sendState: "sending" });
  const b = bridge();
  expect(await b.executor.submit(receipt())).toEqual({ state: "accepted" });
  for (const status of [400, 409, 501]) {
    b.submit(status);
    const outcome = await b.executor.submit(receipt());
    expect(outcome.state).toBe("rejected");
    expect(JSON.stringify(outcome)).not.toContain("refused\"");
  }
  for (const status of [401, 403, 404, 500, 503]) { b.submit(status); await expect(b.executor.submit(receipt())).rejects.toThrow(); }
  b.submit("accept-lost"); await expect(b.executor.submit(receipt())).rejects.toThrow();
  // A 200 that names another operation proves nothing about this one.
  const other = bridge(), mismatched = { ...receipt(), repairId: "99999999-2222-4333-a444-555555555555" };
  await expect(other.executor.submit(mismatched)).rejects.toThrow("does not name this operation");
});

test("an accepted submit whose reply was lost is reconciled by status to running, then completed, with exactly one send", async () => {
  const b = bridge(), f = service(b.executor);
  b.submit("accept-lost"); b.status(503);
  expect((await f.service.request(grant, request)).state).toBe("unknown");
  expect((await f.service.detail(grant, operationId)).state).toBe("unknown");
  b.status(about({ state: "running", owner }));
  expect(await f.service.detail(grant, operationId)).toMatchObject({ state: "running", owner });
  expect(f.rows.get(operationId)!.receipt.sendState).toBe("accepted");
  b.status(about({ state: "completed", owner, evidence: evidence(true) }));
  expect(await f.service.request(grant, request)).toMatchObject({ state: "completed", owner, evidence: evidence(true) });
  expect(b.submits()).toBe(1); expect(b.admitted()).toBe(1);
});

test("an interrupted send reconciles from status without ever submitting", async () => {
  const b = bridge(), f = service(b.executor);
  f.rows.set(operationId, { inputSha256: "", receipt: { repairId: operationId, request: request as TestRepairReceipt["request"],
    binding: { occurrenceId, agentRunId: "run_123", candidate: grant.candidate },
    lease: { environment: "staging", executionAttempt: 1, leaseGeneration: 7, leaseTokenSha256: "c".repeat(64) },
    createdAt: "2026-09-27T00:00:00Z", sendState: "sending" } });
  b.status(404);
  expect((await f.service.detail(grant, operationId)).state).toBe("sending");
  b.status(about({ state: "running", owner }));
  expect((await f.service.detail(grant, operationId)).state).toBe("running");
  expect(b.submits()).toBe(0);
});

test("a malformed or inconsistent status is a 502 in every pending state, and true unavailability keeps the state", async () => {
  const malformed: unknown[] = ["<html>not json</html>", { state: "running" }, about({ state: "running", repairId: "99999999-2222-4333-a444-555555555555" }),
    about({ state: "running", operation: "day1.recovery" }), about({ state: "completed", owner, evidence: evidence(false) }),
    about({ state: "completed", evidence: evidence(true) }), about({ state: "done", owner }), "x".repeat(70 * 1024)];
  for (const state of ["sending", "unknown", "accepted"] as const) {
    const b = bridge(), f = service(b.executor);
    f.rows.set(operationId, { inputSha256: "", receipt: { repairId: operationId, request: request as TestRepairReceipt["request"],
      binding: { occurrenceId, agentRunId: "run_123", candidate: grant.candidate },
      lease: { environment: "staging", executionAttempt: 1, leaseGeneration: 7, leaseTokenSha256: "c".repeat(64) },
      createdAt: "2026-09-27T00:00:00Z", sendState: state } });
    for (const answer of malformed) {
      b.status(answer);
      await expect(f.service.detail(grant, operationId), `${state}: ${JSON.stringify(answer).slice(0, 40)}`).rejects.toMatchObject({ status: 502 });
      expect(f.rows.get(operationId)!.receipt.sendState).toBe(state);
    }
    for (const outage of [503, 404, 500, new TypeError("connection reset")]) {
      b.status(outage);
      expect((await f.service.detail(grant, operationId)).state).toBe(state);
    }
    // An executor that does not know the operation keeps an uncertain send pending.
    b.status(about({ state: "unknown" }));
    expect((await f.service.detail(grant, operationId)).state).toBe(state === "accepted" ? "unknown" : state);
    expect(b.submits()).toBe(0);
  }
});

test("a repair is bound to execution attempt 1", async () => {
  const b = bridge(), f = service(b.executor);
  await expect(f.service.request({ ...grant, executionAttempt: 2 }, request)).rejects.toThrow("execution attempt 1");
  expect(b.submits()).toBe(0);
});
