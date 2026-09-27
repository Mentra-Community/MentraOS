import { afterEach, expect, test } from "bun:test";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestRepairReceipt } from "../types/test-repair.types";
import type { ContinuationLeaseRepair } from "./test-continuation-lease";
import { TestContinuationService } from "./test-continuation.service";
import { signTestContinuationGrant } from "./test-failure-auth";
import { TestRepairService, absentTestRepairExecutor, type TestRepairExecutor, type TestRepairRepository } from "./test-repair.service";
import type { TestRunService } from "./test-run.service";

const occurrenceId = "tfo_" + "a".repeat(64), headSha = "b".repeat(40), secret = "repair-test-only-signing-".repeat(2);
const grant: ContinuationGrant = { purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId, agentRunId: "run_123",
  candidate: { repository: "Mentra-Community/MentraOS", headSha, target: "original" }, executionAttempt: 1, leaseGeneration: 1,
  leaseTokenSha256: "e".repeat(64), routineIds: ["day1-ota"], actions: ["repair-state", "read-results"], expires: Math.floor(Date.now() / 1000) + 600 };
const request = { operationId: "11111111-2222-4333-a444-555555555555", operation: "day1.recovery", routineId: "day1-ota", reason: "Fixture firmware was left on the candidate build" };
const owner = { workerId: "mini", fixtureId: "glasses-03be" };
const evidence = (passed: boolean) => ({ before: { observationId: "obs-1" }, action: { journalId: "j-1" }, result: { terminalId: "t-1" }, check: { passed, returnVerification: passed ? "passed" : "failed" } });
/** An executor answer about the registered operation. */
const about = (extra: Record<string, unknown>) => ({ repairId: request.operationId, operation: "day1.recovery", ...extra });

function fixture(executor?: Partial<TestRepairExecutor>) {
  const packet = { occurrenceId, sourceStatus: "recorded", source: { repository: "Mentra-Community/MentraOS", headSha },
    delivery: { state: "acknowledged", agentRunId: "run_123" } } as unknown as Awaited<ReturnType<TestRunService["failureDetail"]>>;
  const rows = new Map<string, { inputSha256: string; receipt: TestRepairReceipt }>();
  const repository: TestRepairRepository = {
    get: async id => rows.get(id) ?? null,
    insert: async value => { const before = rows.get(value.receipt.repairId); if (before) return { stored: before, created: false };
      rows.set(value.receipt.repairId, value); return { stored: value, created: true }; },
    // Mirrors the Mongo compare-and-set: only `sending` is acknowledged; a reconciled receipt is returned as is.
    acknowledge: async (id, outcome) => { const value = rows.get(id)!.receipt;
      if (value.sendState === "sending") Object.assign(value, { sendState: outcome?.state ?? "unknown", ...(outcome?.state === "rejected" ? { rejectionReason: outcome.reason } : {}) });
      return value; },
    reconcile: async id => { const value = rows.get(id)!.receipt;
      if (["sending", "unknown"].includes(value.sendState)) Object.assign(value, { sendState: "accepted", reconciledAt: "2026-09-27T00:00:00Z" });
      return value; },
  };
  let sends = 0, status: unknown = about({ state: "running", owner });
  const leases: (ContinuationLeaseRepair | undefined)[] = []; let reserved = true;
  const broker: TestRepairExecutor = { supports: () => true, submit: async () => { sends++; return { state: "accepted" }; },
    status: async () => { if (status instanceof Error) throw status; return status; }, ...executor };
  const runs = { failureDetail: async () => packet } as unknown as TestRunService;
  const service = new TestRepairService(runs, broker, repository, async (_grant, _routine, _send, repair) => {
    leases.push(repair); if (!reserved) throw new Error("Mini lease changed or this state repair was not reserved"); });
  return { packet, rows, runs, service, leases, sends: () => sends, status: (value: unknown) => { status = value; }, unreserve: () => { reserved = false; } };
}

test("without an owned executor nothing is sent or recorded, and the registered ID stays usable", async () => {
  const f = fixture({ supports: () => false });
  await expect(f.service.request(grant, request)).rejects.toMatchObject({ status: 501 });
  expect(f.rows.size).toBe(0); expect(f.sends()).toBe(0);
  // Only an authenticated reservation learns that the capability is absent.
  expect(f.leases).toEqual([{ operation: "day1.recovery", operationId: request.operationId }]);
  const production = new TestRepairService(f.runs, absentTestRepairExecutor, { get: async () => null,
    insert: async () => { throw new Error("must not persist"); }, acknowledge: async () => { throw new Error("must not persist"); },
    reconcile: async () => { throw new Error("must not persist"); } }, async () => {});
  await expect(production.request(grant, request)).rejects.toThrow("No owned executor accepts this state repair; nothing was sent");
});

test("an unreserved operation, PR candidate, other routine or mismatched operation never reaches the executor", async () => {
  const refused = fixture(); refused.unreserve();
  await expect(refused.service.request(grant, request)).rejects.toThrow("not reserved");
  for (const [value, input, message] of [
    [{ ...grant, candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 12, headSha } }, request, "original target"],
    [{ ...grant, candidate: { ...grant.candidate, headSha: "f".repeat(40) } }, request, "recorded source"],
    [grant, { ...request, routineId: "no-glasses" }, "outside this capability"],
    [{ ...grant, routineIds: ["day1-ota", "no-glasses"] }, { ...request, routineId: "no-glasses" }, "does not belong"],
  ] as [ContinuationGrant, typeof request, string][]) {
    const f = fixture(); await expect(f.service.request(value, input)).rejects.toThrow(message);
    expect(f.sends()).toBe(0); expect(f.leases).toEqual([]);
  }
  // No owned path: the runner helper and arbitrary commands are not operations.
  for (const operation of ["runner.recovery", "rm -rf lock"]) await expect(fixture().service.request(grant, { ...request, operation })).rejects.toThrow();
});

test("concurrent replays send once; a different repair cannot reuse the operation ID", async () => {
  const f = fixture();
  const views = await Promise.all(Array.from({ length: 4 }, () => f.service.request(grant, request)));
  expect(f.sends()).toBe(1); expect(f.rows.size).toBe(1);
  // A replay racing the winner may observe its unsettled send, never a second one.
  expect(views.every(view => view.repairId === request.operationId && ["sending", "running"].includes(view.state))).toBe(true);
  expect((await f.service.request(grant, request)).state).toBe("running");
  await expect(f.service.request(grant, { ...request, reason: "A different reason" })).rejects.toThrow("different repair");
  expect(f.sends()).toBe(1);
});

test("an uncertain send is reconciled read-only from the executor's answer about the same operation, never resent", async () => {
  // The executor started the operation, then the reply was lost and its status is briefly unavailable.
  let submits = 0;
  const f = fixture({ submit: async () => { submits++; throw new Error("socket closed after the executor started"); } });
  f.status(new Error("offline"));
  expect((await f.service.request(grant, request)).state).toBe("unknown");
  expect((await f.service.detail(grant, request.operationId)).state).toBe("unknown");
  expect(f.rows.get(request.operationId)!.receipt.sendState).toBe("unknown");
  // Missing, malformed, other-operation, executor-uncertain or unproven-completion answers settle nothing.
  const answers: unknown[] = [null, { state: "running", owner }, about({ state: "running", repairId: "99999999-2222-4333-a444-555555555555" }),
    about({ state: "running", operation: "android.sign-in-recovery" }), about({ state: "unknown" }),
    about({ state: "completed", owner, evidence: evidence(false) }), about({ state: "completed", evidence: evidence(true) })];
  for (const answer of answers) {
    f.status(answer);
    expect((await f.service.detail(grant, request.operationId)).state).toBe("unknown");
    expect((await f.service.request(grant, request)).state).toBe("unknown");
  }
  expect(f.rows.get(request.operationId)!.receipt.sendState).toBe("unknown");
  // The executor then reports this exact operation: repeated reads advance the recorded truth.
  f.status(about({ state: "running", owner }));
  expect(await f.service.detail(grant, request.operationId)).toMatchObject({ state: "running", owner });
  expect(f.rows.get(request.operationId)!.receipt).toMatchObject({ sendState: "accepted", reconciledAt: "2026-09-27T00:00:00Z" });
  f.status(about({ state: "completed", owner, evidence: evidence(true) }));
  expect(await f.service.request(grant, request)).toMatchObject({ state: "completed", owner, evidence: evidence(true) });
  expect(await f.service.detail(grant, request.operationId)).toMatchObject({ state: "completed" });
  // One send in total; the lease authorized it once; no new operation ID.
  expect(submits).toBe(1); expect(f.leases).toHaveLength(1);
  expect([...f.rows.keys()]).toEqual([request.operationId]);
});

test("a send interrupted before its acknowledgement reconciles from the executor, and replays never submit", async () => {
  const f = fixture();
  // A crash between the durable send fence and the executor reply leaves `sending`.
  f.rows.set(request.operationId, { inputSha256: "", receipt: { repairId: request.operationId, request: request as TestRepairReceipt["request"],
    binding: { occurrenceId, agentRunId: "run_123", candidate: grant.candidate }, createdAt: "2026-09-27T00:00:00Z", sendState: "sending" } });
  f.status(new Error("offline"));
  const view = await f.service.detail(grant, request.operationId);
  expect(view.state).toBe("sending");
  f.status(about({ state: "failed", owner, evidence: evidence(false) }));
  expect(await f.service.detail(grant, request.operationId)).toMatchObject({ state: "failed", evidence: evidence(false) });
  expect(f.rows.get(request.operationId)!.receipt.sendState).toBe("accepted");
  expect(f.sends()).toBe(0);
});

test("an executor rejection is terminal and ran nothing", async () => {
  let rejected = 0;
  const refusal = fixture({ submit: async () => { rejected++; return { state: "rejected", reason: "Fixture is owned by another run" }; } });
  expect(await refusal.service.request(grant, request)).toMatchObject({ state: "rejected" });
  await refusal.service.request(grant, request); expect(rejected).toBe(1);
});

test("completed requires the executor's owner and passing check; failures and malformed status are never promoted", async () => {
  const f = fixture(); await f.service.request(grant, request);
  f.status(about({ state: "completed", owner, evidence: evidence(true) }));
  expect(await f.service.detail(grant, request.operationId)).toMatchObject({ state: "completed", owner, evidence: evidence(true) });
  f.status(about({ state: "failed", owner, evidence: evidence(false) }));
  expect(await f.service.detail(grant, request.operationId)).toMatchObject({ state: "failed", evidence: evidence(false) });
  for (const value of [about({ state: "completed", owner, evidence: evidence(false) }), about({ state: "completed", evidence: evidence(true) }),
    about({ state: "completed", owner }), about({ state: "done", owner }), about({ state: "completed", owner, evidence: evidence(true), shell: "extra" }),
    { state: "completed", owner, evidence: evidence(true) }, about({ state: "completed", owner, evidence: evidence(true), operation: "android.sign-in-recovery" })]) {
    f.status(value); await expect(f.service.detail(grant, request.operationId)).rejects.toMatchObject({ status: 502 });
  }
  const offline = fixture({ status: async () => { throw new Error("offline"); } }); await offline.service.request(grant, request);
  expect((await offline.service.detail(grant, request.operationId)).state).toBe("accepted");
});

test("repair reads are bound to their occurrence, anchor, original target and case binding", async () => {
  const f = fixture(); await f.service.request(grant, request);
  for (const other of [{ ...grant, agentRunId: "run_other" }, { ...grant, candidate: { ...grant.candidate, repository: "Mentra-Community/Mentra-Automated-Testing" as const } },
    { ...grant, caseBinding: { caseId: "mfc_" + "5".repeat(64), candidateOwnerRunId: "run_owner" } }, { ...grant, routineIds: ["no-glasses" as const] }]) {
    if (other.agentRunId === "run_other") f.packet.delivery = { state: "acknowledged", agentRunId: "run_other", acknowledgedAt: "2026-09-27T00:00:00Z" };
    await expect(f.service.detail(other, request.operationId)).rejects.toThrow("not found");
    f.packet.delivery = { state: "acknowledged", agentRunId: "run_123", acknowledgedAt: "2026-09-27T00:00:00Z" };
  }
  await expect(f.service.detail(grant, "not-an-operation")).rejects.toThrow("Invalid");
});

const oldSecret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET, oldEnv = process.env.CLOUD_CORE_ENVIRONMENT;
afterEach(() => { if (oldSecret === undefined) delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; else process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = oldSecret;
  if (oldEnv === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = oldEnv; });
test("repair routes need repair-state to send and read-results to read; a missing executor is an explicit 501", async () => {
  process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  const f = fixture(), absent = fixture({ supports: () => false }), base = `/${occurrenceId}/repairs`;
  const auth = (actions: ContinuationGrant["actions"]) => ({ authorization: `Bearer ${signTestContinuationGrant({ ...grant, actions }, secret)}` });
  const app = createTestFailureAgentApi(f.runs, new TestContinuationService(f.runs), undefined, f.service);
  const post = (headers: Record<string, string>, body = JSON.stringify(request)) => app.request(base, { method: "POST", headers, body });
  expect((await post(auth(["request-routine", "read-results"]))).status).toBe(401);
  expect((await post({})).status).toBe(401);
  expect((await post(auth(["repair-state"]), "{")).status).toBe(400);
  expect((await post(auth(["repair-state"]), JSON.stringify({ ...request, operation: "runner.recovery" }))).status).toBe(400);
  const sent = await post(auth(["repair-state"])); expect(sent.status).toBe(202);
  expect(await sent.json()).toMatchObject({ repairId: request.operationId, operation: "day1.recovery", state: "running" });
  expect((await app.request(`${base}/${request.operationId}`, { headers: auth(["repair-state"]) })).status).toBe(401);
  expect((await app.request(`${base}/${request.operationId}`, { headers: auth(["read-results"]) })).status).toBe(200);
  const unavailable = await createTestFailureAgentApi(absent.runs, new TestContinuationService(absent.runs), undefined, absent.service)
    .request(base, { method: "POST", headers: auth(["repair-state"]), body: JSON.stringify(request) });
  expect(unavailable.status).toBe(501); expect(absent.sends()).toBe(0);
  expect(await unavailable.json()).toMatchObject({ error: "test_continuation_error" });
});
