import { afterEach, expect, test } from "bun:test";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestDispatchReceipt } from "../types/test-dispatch.types";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import { TestContinuationService, continuationOperationId } from "./test-continuation.service";
import { signTestContinuationGrant, signTestFailureReadGrant, verifyTestContinuationGrant } from "./test-failure-auth";
import type { TestBuildGateway } from "./test-builds.service";
import type { TestRunService } from "./test-run.service";
import type { ContinuationTarget } from "./test-continuation.github";
const occurrenceId = "tfo_" + "a".repeat(64), headSha = "b".repeat(40), archiveSha256 = "c".repeat(64);
const secret = "continuation-test-only-".repeat(3);
const grant: ContinuationGrant = { purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId,
  agentRunId: "run_123", executionAttempt: 1, leaseGeneration: 1, leaseTokenSha256: "e".repeat(64), candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 44, headSha },
  routineIds: ["no-glasses"], actions: ["request-routine", "read-results"], expires: Math.floor(Date.now() / 1000) + 600 };
const input = { source: { channel: "pr" as const, prNumber: 44, buildRunId: 80, publicationAttempt: 1 }, routineId: "no-glasses" as const, archiveSha256 };
function fixture() {
  const packet = { schemaVersion: 1, occurrenceId, sourceStatus: "recorded", source: { repository: "Mentra-Community/MentraOS", headSha },
    delivery: { state: "acknowledged", agentRunId: "run_123" }, evidence: { complete: true, assets: [{ assetId: "asset" }] } } as unknown as Awaited<ReturnType<TestRunService["failureDetail"]>>;
  let sends = 0, since = "", existing: { requestRunId: number; requestUrl: string } | null = null;
  let target: ContinuationTarget = { query: { channel: "pr", pr: 44 }, expectedHeadSha: headSha, automaticExpected: false };
  let claim: { state: string; resultRunId?: string } | null = null;
  const result = { runId: "result1", requestId: "routine-90-1-44-no-glasses", routineId: "no-glasses", source: { headSha },
    outcome: "failed", outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "complete" },
    provenance: { archiveSha256 }, failureOccurrences: [{ occurrenceId: "tfo_" + "d".repeat(64) }] };
  const rows = new Map<string, { inputSha256: string; receipt: TestDispatchReceipt }>();
  const repository: TestDispatchRepository = {
    get: async id => rows.get(id) ?? null, recent: async () => [...rows.values()].map(value => value.receipt),
    insert: async value => { const before = rows.get(value.receipt.dispatchId); if (before) return { stored: before, created: false };
      rows.set(value.receipt.dispatchId, value); return { stored: value, created: true }; },
    acknowledge: async (id, response) => { const value = rows.get(id)!.receipt;
      Object.assign(value, { sendState: response ? "accepted" : "unknown", ...response }); return value; },
    claim: async () => claim, result: async () => result,
  };
  const builds: TestBuildGateway = { inventory: async () => [], resolve: async source => ({ source, title: "Candidate", headSha,
    availability: "available", archive: { name: "app.zip", sha256: archiveSha256, size: 12 }, buildUrl: "https://github.com/build",
    createdAt: "2026-09-25T08:00:00Z", routines: [{ id: "no-glasses", available: true }] }),
    dispatch: async () => { sends++; return { requestRunId: 90, requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/90" }; },
    progress: async () => ({ state: "running", requestId: "routine-90-1-44-no-glasses", message: "Running" }),
    findExisting: async (_, value) => { since = value; return existing; },
  };
  let ids: string[] = [];
  const runs = { failureDetail: async (id: string) => id === occurrenceId ? packet : { ...packet, occurrenceId: id },
    detail: async () => result, failureMedia: async () => new Response("assigned") } as unknown as TestRunService;
  const dispatch = new TestDispatchService(repository, builds);
  let leaseValid = true;
  const service = new TestContinuationService(runs, dispatch, builds, { target: async () => target }, {
    list: async () => [...rows.values()].map(row => row.receipt), results: async () => ids,
  }, async () => { if (!leaseValid) throw new Error("Stale lease"); });
  return { packet, rows, builds, runs, service, result, loseLease: () => { leaseValid = false; }, sends: () => sends, since: () => since,
    target: (value: Partial<ContinuationTarget>) => { target = { ...target, ...value }; },
    claim: (value: typeof claim) => { claim = value; }, results: () => { ids = [result.runId]; },
    existing: () => { existing = { requestRunId: 90, requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/90" }; } };
}
test("capability signature, expiry, environment, purpose and occurrence are bound", () => {
  const token = signTestContinuationGrant(grant, secret);
  expect(verifyTestContinuationGrant(token, occurrenceId, secret, "dev")).toEqual(grant);
  for (const [id, key, env] of [["tfo_" + "f".repeat(64), secret, "dev"], [occurrenceId, secret + "x", "dev"], [occurrenceId, secret, "staging"]])
    expect(verifyTestContinuationGrant(token, id!, key!, env!)).toBeNull();
  expect(verifyTestContinuationGrant(token, occurrenceId, secret, "dev", Date.now() + 700_000)).toBeNull();
  expect(verifyTestContinuationGrant(signTestFailureReadGrant(occurrenceId, "dev", grant.expires, secret), occurrenceId, secret, "dev")).toBeNull();
});
test("concurrent replay sends once; candidate/routine operation cannot be rebound", async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 4 }, () => f.service.request(grant, input)));
  expect(f.sends()).toBe(1); expect(f.rows.size).toBe(1);
  await expect(f.service.request(grant, { ...input, source: { ...input.source, buildRunId: 81 } })).rejects.toThrow("different build");
  expect(f.sends()).toBe(1);
});
test("missing source, wrong owner, disallowed routine and unrelated PR are nonadmitted", async () => {
  for (const mutation of ["source", "owner", "routine", "pr"]) {
    const f = fixture();
    if (mutation === "source") f.packet.source = null;
    if (mutation === "owner") f.packet.delivery = { state: "acknowledged", agentRunId: "another", acknowledgedAt: new Date().toISOString() };
    const request = mutation === "routine" ? { ...input, routineId: "day1-ota" } : mutation === "pr" ? { ...input, source: { ...input.source, prNumber: 45 } } : input;
    await expect(f.service.request(grant, request)).rejects.toThrow(); expect(f.sends()).toBe(0);
  }
});
test("matching automatic request is adopted; pending automatic work never duplicates", async () => {
  const f = fixture(); f.target({ automaticExpected: true });
  await expect(f.service.request(grant, input)).rejects.toThrow("Waiting for the existing automatic request");
  expect(f.rows.size).toBe(0); f.existing();
  expect(await f.service.request(grant, input)).toMatchObject({ adopted: true, state: "running" }); expect(f.sends()).toBe(0);
});
test("new harness candidate excludes requests created before its merge", async () => {
  const f = fixture(); f.target({ expectedHarnessSha: "e".repeat(40), requestNotBefore: "2026-09-25T09:00:00Z" });
  await f.service.request(grant, input); expect(f.since()).toBe("2026-09-25T09:00:00Z"); expect(f.sends()).toBe(1);
});
test("cross-candidate reads and arbitrary result IDs are refused", async () => {
  const f = fixture(); await f.service.request(grant, input); const id = continuationOperationId(grant, input.routineId);
  await expect(f.service.detail({ ...grant, candidate: { ...grant.candidate, headSha: "f".repeat(40) } }, id)).rejects.toThrow("not found");
  await expect(f.service.detail(grant, "not-a-request")).rejects.toThrow("Invalid");
  await expect(f.service.failure(grant, id, "tfo_" + "0".repeat(64))).rejects.toThrow("not part");
});
test("results are head/archive/routine/worker bound and failure remains failure", async () => {
  for (const field of ["valid", "head", "archive", "routine", "request", "harness"]) {
    const f = fixture(); if (field === "harness") f.target({ expectedHarnessSha: "e".repeat(40) });
    await f.service.request(grant, input); f.results();
    if (field === "head") f.result.source.headSha = "f".repeat(40);
    if (field === "archive") f.result.provenance.archiveSha256 = "e".repeat(64);
    if (field === "routine") f.result.routineId = "day1-ota";
    if (field === "request") f.result.requestId = "another";
    const read = f.service.detail(grant, continuationOperationId(grant, input.routineId));
    if (field !== "valid") await expect(read).rejects.toThrow("differs"); else expect((await read).recordedResults[0]?.outcome).toBe("failed");
  }
});
test("recovery hold exposes assigned failed evidence without clearing recovery-required", async () => {
  const f = fixture(); await f.service.request(grant, input); f.results(); f.claim({ state: "recovery-required" });
  const id = continuationOperationId(grant, input.routineId), value = await f.service.detail(grant, id);
  expect(value.state).toBe("recovery-required"); expect(value.recordedResults[0]?.outcome).toBe("failed");
  const failureId = f.result.failureOccurrences[0]!.occurrenceId;
  expect((await f.service.failure(grant, id, failureId)).occurrenceId).toBe(failureId);
  expect(await (await f.service.media(grant, id, failureId, "asset", new Request("https://example.test"))).text()).toBe("assigned");
});
const oldSecret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET, oldEnv = process.env.CLOUD_CORE_ENVIRONMENT;
afterEach(() => { if (oldSecret === undefined) delete process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET; else process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = oldSecret;
  if (oldEnv === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = oldEnv; });
test("original read grant cannot dispatch; continuation grant cannot read arbitrary assets", async () => {
  const f = fixture(); process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  const app = createTestFailureAgentApi(f.runs, f.service), base = `/${occurrenceId}`;
  const read = signTestFailureReadGrant(occurrenceId, "dev", grant.expires, secret), continuation = signTestContinuationGrant(grant, secret);
  expect((await app.request(base + "/reruns", { method: "POST", headers: { authorization: `Bearer ${read}` }, body: JSON.stringify(input) })).status).toBe(401);
  expect((await app.request(base + "/assets/arbitrary", { headers: { authorization: `Bearer ${continuation}` } })).status).toBe(401);
  const writeOnly = signTestContinuationGrant({ ...grant, actions: ["request-routine"] }, secret);
  expect((await app.request(base + "/reruns", { headers: { authorization: `Bearer ${writeOnly}` } })).status).toBe(401);
  expect((await app.request(base + "/reruns", { method: "POST", headers: { authorization: `Bearer ${continuation}` }, body: JSON.stringify(input) })).status).toBe(202);
});

test("reclaim rejects a delayed signed request before dispatch, while old registered results remain readable", async () => {
  const f = fixture(); f.loseLease();
  await expect(f.service.request(grant, input)).rejects.toThrow("Stale lease"); expect(f.sends()).toBe(0);
  const g = fixture(); await g.service.request(grant, input); g.loseLease(); g.results();
  expect((await g.service.detail(grant, continuationOperationId(grant, input.routineId))).recordedResults).toHaveLength(1);
});

test("lease lost during artifact validation is checked again before the durable send fence", async () => {
  const f = fixture(), original = f.builds.resolve; let calls = 0;
  f.builds.resolve = async (...args) => { const value = await original(...args); if (++calls === 2) f.loseLease(); return value; };
  await expect(f.service.request(grant, input)).rejects.toThrow("Stale lease");
  expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
});

test("known cleaned-up attempt permits one budgeted same-head retry with its own permanent receipt", async () => {
  const f = fixture(); await f.service.request(grant, input);
  const retryGrant = { ...grant, executionAttempt: 2 };
  await expect(f.service.request(retryGrant, { ...input, executionAttempt: 2, retryReason: "Recovered fixture infrastructure" })).rejects.toThrow("verified fixture cleanup");
  f.claim({ state: "terminal", resultRunId: "result1" }); f.results();
  const request = { ...input, executionAttempt: 2, retryReason: "Recovered fixture infrastructure" };
  const second = await f.service.request(retryGrant, request);
  expect(second.dispatchId).not.toBe(continuationOperationId(grant, input.routineId)); expect(f.sends()).toBe(2);
  await f.service.request(retryGrant, request); expect(f.sends()).toBe(2); expect(f.rows.size).toBe(2);
});

test("registered failure asset links are followable with the same narrow continuation grant", async () => {
  const f = fixture(); process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  await f.service.request(grant, input); f.results(); f.claim({ state: "recovery-required" });
  const app = createTestFailureAgentApi(f.runs, f.service), id = continuationOperationId(grant, input.routineId);
  const failureId = f.result.failureOccurrences[0]!.occurrenceId, headers = { authorization: `Bearer ${signTestContinuationGrant(grant, secret)}` };
  const response = await app.request(`/${occurrenceId}/reruns/${id}/failures/${failureId}`, { headers });
  expect(response.status).toBe(200);
  const packet = await response.json() as { evidence: { assets: { path: string }[] } };
  const path = packet.evidence.assets[0]!.path;
  expect(path).toBe(`/api/agent/test-failures/${occurrenceId}/reruns/${id}/failures/${failureId}/assets/asset`);
  const asset = await app.request(path.replace("/api/agent/test-failures", ""), { headers });
  expect(asset.status).toBe(200); expect(await asset.text()).toBe("assigned");
});
