import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import { existingWorkBindingDigest, existingWorkBindingOrdered, type ExistingWorkGrant, type ExistingWorkIdentity } from "../types/test-existing-work.types";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestBuild, TestDispatchReceipt } from "../types/test-dispatch.types";
import type { TestRunClaim } from "../types/test-run-claim.types";
import type { TestRunBackendDeployment } from "../types/test-run.types";
import { GithubTestBuildGateway, type TestBuildGateway } from "./test-builds.service";
import { TestContinuationService } from "./test-continuation.service";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import { requireExistingWorkOperation } from "./test-existing-work-authority";
import { TestExistingWorkService, existingWorkOperationId, existingWorkVerification } from "./test-existing-work.service";
import { signTestContinuationGrant, signTestExistingWorkGrant, signTestFailureReadGrant, verifyTestContinuationGrant,
  verifyTestExistingWorkGrant } from "./test-failure-auth";
import type { TestRunService } from "./test-run.service";

// The frozen shared contract, byte-identical to the controller's copy.
const contract = JSON.parse(readFileSync(join(import.meta.dir, "test-existing-work.contract.json"), "utf8")) as {
  identity: ExistingWorkIdentity; bindingOrdered: unknown[]; bindingSerialization: string; bindingSha256: string;
  operation: { source: { channel: "dev"; buildRunId: number; publicationAttempt: number }; archiveSha256: string;
    expectedHeadSha: string; routineId: "no-glasses"; verificationAttempt: 1 };
  operationSerialization: string; operationId: string };
const { identity, operation } = contract;
const secret = "existing-work-test-only-".repeat(3);
const occurrenceId = identity.occurrenceId, agentRunId = identity.agentRunId, headSha = operation.expectedHeadSha;
const mergeCommitSha = "3".repeat(40), requestId = "routine-90-1-dev-no-glasses";
const bundle = { repository: "Mentra-Community/MentraOS" as const, pullRequest: identity.bundle.pullRequest, mergeCommitSha,
  artifactPath: identity.bundle.artifactPath, artifactBlobSha: identity.bundle.artifactBlobSha, baseBranch: "dev" as const };
const grant: ExistingWorkGrant = { purpose: "mentra-routine-fixer-existing-work-v1", environment: "dev", occurrenceId, agentRunId,
  binding: { sha256: contract.bindingSha256, revision: 3 }, bundle, routineId: "no-glasses", verificationAttempt: 1,
  backendRequirement: null, actions: ["request-routine", "read-results"], expires: Math.floor(Date.now() / 1000) + 600 };
const input = { source: operation.source, routineId: "no-glasses", archiveSha256: operation.archiveSha256, verificationAttempt: 1 };
/** Reverse every object's key order, recursively. */
const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;

function fixture() {
  const events: string[] = [];
  const packet = { schemaVersion: 1, occurrenceId, sourceStatus: "recorded", testRunId: identity.testRunId,
    routine: { id: "no-glasses", version: "1" }, source: { repository: "Mentra-Community/MentraOS", channel: "local", headSha: "4".repeat(40) },
    delivery: { state: "acknowledged", agentRunId } } as unknown as Awaited<ReturnType<TestRunService["failureDetail"]>>;
  const result = { runId: requestId, requestId, routineId: "no-glasses", source: { headSha }, outcome: "passed",
    startedAt: "2026-09-28T06:00:00.000Z", finishedAt: "2026-09-28T06:00:05.000Z",
    assets: [] as { assetId: string; kind: string; contentType: string; filename: string; sizeBytes: number; sha256: string; uploaded?: boolean }[],
    backendDeployment: undefined as TestRunBackendDeployment | undefined,
    outcomes: { test: "passed", teardown: "passed", fixture: "ready", evidence: "complete" }, fixture: { alias: "mac-01" },
    provenance: { repository: "Mentra-Community/MentraOS", archiveSha256: operation.archiveSha256, requestSha256: "9".repeat(64),
      executionMode: "ci-registered", requestRelationship: "consumed", resultGeneration: "1", terminalSnapshotSha256: "8".repeat(64),
      returnVerification: "passed" } as Record<string, string>, failureOccurrences: [] as { occurrenceId: string }[] };
  let claim: TestRunClaim | null = null, extra: typeof result[] = [], sendFails = false, sends = 0;
  // Unique dispatch ID insert, as the Mongo repository's unique index enforces.
  const rows = new Map<string, { inputSha256: string; receipt: TestDispatchReceipt }>();
  const repository: TestDispatchRepository = {
    get: async id => rows.get(id) ?? null, recent: async () => [...rows.values()].map(row => row.receipt),
    insert: async value => { events.push(`insert:${value.receipt.sendState}`); const before = rows.get(value.receipt.dispatchId);
      if (before) return { stored: before, created: false }; rows.set(value.receipt.dispatchId, value); return { stored: value, created: true }; },
    acknowledge: async (id, response) => { const value = rows.get(id)!.receipt;
      Object.assign(value, { sendState: response ? "accepted" : "unknown", ...response }); return value; },
    claim: async () => claim ? { state: claim.state, ...(claim.settlement?.state === "terminal" ? { resultRunId: claim.settlement.resultRunId } : {}) } : null,
    result: async runId => [result, ...extra].find(item => item.runId === runId)!,
  };
  // GitHub source facts for the bundling PR, served to the real gateway over mocked HTTP.
  const github = { merged: true, merge: mergeCommitSha, status: "ahead", blob: bundle.artifactBlobSha as string | null, paths: [] as string[] };
  const providerFetch = (async (url: string) => {
    const path = new URL(url).pathname.replace("/repos/Mentra-Community/MentraOS/", ""), query = new URL(url).search;
    github.paths.push(path + query);
    if (path === `pulls/${bundle.pullRequest}`) return Response.json({ number: bundle.pullRequest, merged: github.merged,
      merge_commit_sha: github.merge, base: { ref: "dev", repo: { full_name: "Mentra-Community/MentraOS" } } });
    if (path === `compare/${mergeCommitSha}...${headSha}`) return Response.json({ status: github.status });
    if (path === "contents/mobile/assets/miniapps" && query === `?ref=${headSha}`) return Response.json(github.blob === null ? []
      : [{ path: bundle.artifactPath, type: "file", sha: github.blob }, { path: "mobile/assets/miniapps/other-1.0.0.zip", type: "file", sha: "5".repeat(40) }]);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const source = new GithubTestBuildGateway({ token: "synthetic-source-token", fetch: providerFetch });
  const routine = { id: "no-glasses" as const, available: true, reason: undefined as string | undefined };
  let publication: Partial<TestBuild> = {};
  const build = (value = operation.source): TestBuild => ({ source: value, title: "dev publication", headSha, buildUrl: "https://github.com/build",
    createdAt: "2026-09-27T08:00:00Z", availability: "available", archive: { name: "app.zip", sha256: operation.archiveSha256, size: 12 },
    routines: [{ ...routine }], ...publication });
  const builds: TestBuildGateway = {
    inventory: async () => [build()], resolve: async value => build(value as typeof operation.source),
    dispatch: async () => { events.push("send"); sends++; if (sendFails) throw new Error("connection lost after send");
      return { requestRunId: 90, requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/90" }; },
    progress: async () => ({ state: "running", requestId, message: "Running" }),
    // Present so a test can prove it is never consulted: existing work sends one new exact request.
    findExisting: async () => { events.push("findExisting"); return { requestRunId: 77, requestUrl: "https://github.com/x/actions/runs/77" }; },
    existingWorkBundle: (value, heads) => source.existingWorkBundle(value, heads),
  };
  // The real authority adapter; only the controller transport is mocked.
  let reply: (body: Record<string, unknown>) => Response = body => Response.json({ schemaVersion: 1, valid: true,
    agentRunId: body.agentRunId, bindingSha256: (body.binding as { sha256: string }).sha256,
    bindingRevision: (body.binding as { revision: number }).revision, operationId: (body.operation as { operationId: string }).operationId });
  const authorityBodies: Record<string, unknown>[] = [];
  const controller = (async (url: URL, init: RequestInit) => {
    events.push("authority");
    const headers = new Headers(init.headers), body = String(init.body);
    expect(url.href).toBe("https://agent.example.test/internal/routine-existing-work-operation");
    expect(init.redirect).toBe("error"); expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-mentra-action-signature")).toBe(createHmac("sha256", secret)
      .update(`mentra-existing-work-operation-check-v1\n${headers.get("x-mentra-action-expires")}\n${body}`).digest("hex"));
    const parsed = JSON.parse(body) as Record<string, unknown>; authorityBodies.push(parsed);
    return reply(parsed);
  }) as unknown as typeof fetch;
  const runs = { failureDetail: async () => packet, detail: async (id: string) => [result, ...extra].find(item => item.runId === id)! } as unknown as TestRunService;
  const dispatch = new TestDispatchService(repository, builds);
  const service = new TestExistingWorkService(runs, dispatch, builds, {
    results: async () => [result, ...extra].map(item => item.runId), claim: async () => claim,
  }, (value, op) => requireExistingWorkOperation(value, op, controller));
  const terminal = (resultRunId = result.runId, state: "terminal" | "recovery-required" = "terminal") => {
    claim = { requestId, requestSha256: "9".repeat(64), fixtureId: "mac-01", workerId: "mini", executionId: "execution",
      claimedAt: "2026-09-27T08:00:00Z", settledAt: "2026-09-27T09:00:00Z", state,
      settlement: state === "terminal" ? { state, resultRunId } : { state, reason: "Retained for recovery" } } as TestRunClaim;
  };
  return { events, packet, result, rows, github, routine, service, dispatch, runs, authorityBodies, terminal,
    sends: () => sends, sendFails: () => { sendFails = true; }, extra: (value: typeof result[]) => { extra = value; },
    publication: (value: Partial<TestBuild>) => { publication = value; }, reply: (value: typeof reply) => { reply = value; } };
}
const old = { url: process.env.CLOUD_REPORT_AGENT_URL, secret: process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET, env: process.env.CLOUD_CORE_ENVIRONMENT };
beforeEach(() => { process.env.CLOUD_REPORT_AGENT_URL = "https://agent.example.test";
  process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev"; });
afterEach(() => { for (const [key, value] of [["CLOUD_REPORT_AGENT_URL", old.url], ["CLOUD_REPORT_AGENT_SIGNING_SECRET", old.secret],
  ["CLOUD_CORE_ENVIRONMENT", old.env]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value; });

describe("frozen shared contract", () => {
  test("binding digest is the versioned ordered array and ignores object key order", () => {
    expect(existingWorkBindingOrdered(identity)).toEqual(contract.bindingOrdered);
    expect(JSON.stringify(existingWorkBindingOrdered(identity))).toBe(contract.bindingSerialization);
    expect(existingWorkBindingDigest(identity)).toBe(contract.bindingSha256);
    expect(existingWorkBindingDigest(reorder(identity) as ExistingWorkIdentity)).toBe(contract.bindingSha256);
    // Merge commits and volatile revision/check times are not identity.
    expect(existingWorkBindingDigest({ ...identity, bundle: { ...identity.bundle, mergeCommitSha: "a".repeat(40) },
      revision: 9, checkedAt: "2026-09-28T00:00:00Z" } as ExistingWorkIdentity)).toBe(contract.bindingSha256);
  });
  test("operation ID is the fixture UUID for canonical and reordered sources, and ignores the binding revision", () => {
    const id = existingWorkOperationId(contract.bindingSha256, operation.source, operation.archiveSha256, headSha, "no-glasses", 1);
    expect(id).toBe(contract.operationId);
    const reordered = reorder(operation.source) as typeof operation.source;
    expect(Object.keys(reordered)).toEqual(["publicationAttempt", "buildRunId", "channel"]);
    expect(existingWorkOperationId(contract.bindingSha256, reordered, operation.archiveSha256, headSha, "no-glasses", 1)).toBe(id);
    expect(existingWorkOperationId(contract.bindingSha256, { ...operation.source, publicationAttempt: 2 }, operation.archiveSha256,
      headSha, "no-glasses", 1)).not.toBe(id);
  });
});

describe("purpose-separated capability", () => {
  test("signature, expiry, environment, occurrence and purpose are bound; no grant stands in for another", () => {
    const token = signTestExistingWorkGrant(grant, secret);
    expect(verifyTestExistingWorkGrant(token, occurrenceId, secret, "dev")).toEqual(grant);
    expect(verifyTestExistingWorkGrant(token, "tfo_" + "f".repeat(64), secret, "dev")).toBeNull();
    expect(verifyTestExistingWorkGrant(token, occurrenceId, secret + "x", "dev")).toBeNull();
    expect(verifyTestExistingWorkGrant(token, occurrenceId, secret, "staging")).toBeNull();
    expect(verifyTestExistingWorkGrant(token, occurrenceId, secret, "dev", Date.now() + 700_000)).toBeNull();
    expect(verifyTestContinuationGrant(token, occurrenceId, secret, "dev")).toBeNull();
    expect(verifyTestExistingWorkGrant(signTestFailureReadGrant(occurrenceId, "dev", grant.expires, secret), occurrenceId, secret, "dev")).toBeNull();
    const continuation = signTestContinuationGrant({ purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId, agentRunId,
      candidate: { repository: "Mentra-Community/MentraOS", headSha, target: "original" }, executionAttempt: 1, leaseGeneration: 1,
      leaseTokenSha256: "e".repeat(64), routineIds: ["no-glasses"], actions: ["request-routine", "read-results"], expires: grant.expires } satisfies ContinuationGrant, secret);
    expect(verifyTestExistingWorkGrant(continuation, occurrenceId, secret, "dev")).toBeNull();
  });
  test("strict schema: backend requirement is explicit, attempt is 1, no lease or extra fields", () => {
    const { backendRequirement: _, ...omitted } = grant;
    for (const invalid of [omitted, { ...grant, verificationAttempt: 2 }, { ...grant, leaseGeneration: 1 }, { ...grant, actions: ["repair-state"] },
      { ...grant, bundle: { ...bundle, repository: "Mentra-Community/Other" } }, { ...grant, bundle: { ...bundle, baseBranch: "main" } },
      { ...grant, bundle: { ...bundle, artifactPath: "mobile/assets/miniapps/../x-1.0.0.zip" } },
      { ...grant, backendRequirement: { repository: "Mentra-Community/Mentra-Notes-Miniapp", mergeCommitSha: "b3a38baa", deployment: "prod" } }])
      expect(() => signTestExistingWorkGrant(invalid as ExistingWorkGrant, secret)).toThrow();
    const backend = { ...grant, backendRequirement: { repository: "Mentra-Community/Mentra-Notes-Miniapp", mergeCommitSha: "b3a38baa98ae3e030e7ee42678fd19c37c8bcb4e" } };
    expect(verifyTestExistingWorkGrant(signTestExistingWorkGrant(backend, secret), occurrenceId, secret, "dev")).toEqual(backend);
  });
  test("routes accept only this grant with the matching action; it reaches no other route", async () => {
    const f = fixture(), app = createTestFailureAgentApi(f.runs, new TestContinuationService(f.runs), undefined, undefined, f.service);
    const auth = (token: string) => ({ authorization: `Bearer ${token}` }), base = `/${occurrenceId}/existing-work`;
    const post = (token: string) => app.request(`${base}/requests`, { method: "POST", headers: auth(token), body: JSON.stringify(input) });
    const readOnly = signTestExistingWorkGrant({ ...grant, actions: ["read-results"] }, secret);
    const expired = signTestExistingWorkGrant({ ...grant, expires: Math.floor(Date.now() / 1000) - 1 }, secret);
    const other = signTestExistingWorkGrant({ ...grant, occurrenceId: "tfo_" + "f".repeat(64) }, secret);
    const read = signTestFailureReadGrant(occurrenceId, "dev", grant.expires, secret);
    for (const token of [readOnly, expired, other, read, "garbage"]) expect((await post(token)).status).toBe(401);
    const full = signTestExistingWorkGrant(grant, secret);
    expect((await app.request(`/${occurrenceId}`, { headers: auth(full) })).status).toBe(401);
    expect((await app.request(`/${occurrenceId}/reruns`, { method: "POST", headers: auth(full), body: JSON.stringify(input) })).status).toBe(401);
    expect((await app.request(`/${occurrenceId}/builds`, { headers: auth(full) })).status).toBe(401);
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"; expect((await post(full)).status).toBe(401);
    process.env.CLOUD_CORE_ENVIRONMENT = "dev";
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
    const writeOnly = signTestExistingWorkGrant({ ...grant, actions: ["request-routine"] }, secret);
    const sent = await post(writeOnly); expect(sent.status).toBe(202); expect(sent.headers.get("cache-control")).toBe("private, no-store");
    const acknowledgement = await sent.json() as Record<string, unknown>;
    expect(acknowledgement).toEqual({ dispatchId: contract.operationId, sendState: "accepted", requestRunId: 90,
      requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/90" });
    expect((await app.request(`${base}/requests/${contract.operationId}`, { headers: auth(writeOnly) })).status).toBe(401);
    const detail = await app.request(`${base}/requests/${contract.operationId}`, { headers: auth(readOnly) });
    expect(detail.status).toBe(200); expect(detail.headers.get("cache-control")).toBe("private, no-store");
    const builds = await app.request(`${base}/builds`, { headers: auth(readOnly) });
    expect(builds.status).toBe(200); expect(builds.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("one bound real dispatch receipt", () => {
  test("an exact publication writes one existing-work receipt after the controller authority check, then sends once", async () => {
    const f = fixture(), sent = await f.service.request(grant, reorder(input));
    expect(sent).toMatchObject({ dispatchId: contract.operationId, sendState: "accepted", requestRunId: 90 });
    expect(f.events).toEqual(["authority", "insert:sending", "send"]);
    const receipt = f.rows.get(contract.operationId)!.receipt;
    expect(receipt.continuation).toBeUndefined(); expect(receipt.adopted).toBeUndefined();
    expect(receipt.input).toEqual({ source: operation.source, routineId: "no-glasses", archiveSha256: operation.archiveSha256, idempotencyKey: contract.operationId });
    expect(receipt.existingWork).toEqual({ kind: "existing-work-verification-v1", occurrenceId, agentRunId, bindingSha256: contract.bindingSha256,
      authorizedBindingRevision: 3, bundle, backendRequirement: null, routineId: "no-glasses", verificationAttempt: 1, expectedHeadSha: headSha });
    expect(f.authorityBodies).toEqual([{ schemaVersion: 1, environment: "dev", occurrenceId, agentRunId,
      binding: { sha256: contract.bindingSha256, revision: 3 }, operation: { operationId: contract.operationId, source: operation.source,
        archiveSha256: operation.archiveSha256, expectedHeadSha: headSha, routineId: "no-glasses", verificationAttempt: 1 } }]);
    expect(JSON.stringify((f.authorityBodies[0]!.operation as { source: unknown }).source)).toBe(JSON.stringify(operation.source));
    // Source access is the existing gateway's fixed PR, compare and contents reads.
    expect(f.github.paths).toEqual([`pulls/${bundle.pullRequest}`, `compare/${mergeCommitSha}...${headSha}?per_page=1`, `contents/mobile/assets/miniapps?ref=${headSha}`]);
  });
  test("concurrent, repeated and later-revision submits reuse the receipt and never resend", async () => {
    const f = fixture();
    const first = await Promise.all(Array.from({ length: 4 }, () => f.service.request(grant, input)));
    expect(new Set(first.map(item => item.dispatchId))).toEqual(new Set([contract.operationId]));
    expect(f.sends()).toBe(1); expect(f.rows.size).toBe(1);
    const advanced = { ...grant, binding: { ...grant.binding, revision: 4 } };
    expect(await f.service.request(advanced, input)).toEqual(first[0]!);
    expect(f.sends()).toBe(1); expect(f.events.filter(item => item === "authority").length).toBeLessThanOrEqual(4);
    expect((await f.service.detail(advanced, contract.operationId)).dispatchId).toBe(contract.operationId);
    expect(f.rows.get(contract.operationId)!.receipt.existingWork!.authorizedBindingRevision).toBe(3);
    expect(f.events).not.toContain("findExisting");
  });
  test("an unknown send acknowledgement never authorizes a replacement or duplicate", async () => {
    const f = fixture(); f.sendFails();
    expect((await f.service.request(grant, input)).sendState).toBe("unknown");
    const authority = f.events.filter(item => item === "authority").length;
    expect((await f.service.request(grant, input)).sendState).toBe("unknown");
    expect((await f.service.request({ ...grant, binding: { ...grant.binding, revision: 5 } }, input)).sendState).toBe("unknown");
    expect(f.sends()).toBe(1); expect(f.rows.size).toBe(1);
    expect(f.events.filter(item => item === "authority").length).toBe(authority);
    expect((await f.service.detail(grant, contract.operationId)).verification.state).toBe("pending");
  });
  test("a replay with a changed bundle, backend requirement or identity is refused and cannot read the receipt", async () => {
    const f = fixture(); await f.service.request(grant, input);
    for (const changed of [{ ...grant, bundle: { ...bundle, mergeCommitSha: "6".repeat(40) } },
      { ...grant, backendRequirement: { repository: "Mentra-Community/Mentra-Notes-Miniapp", mergeCommitSha: "7".repeat(40) } }]) {
      await expect(f.service.request(changed, input)).rejects.toThrow("different existing-work binding");
      await expect(f.service.detail(changed, contract.operationId)).rejects.toThrow("not found");
    }
    // A different binding digest or agent run names a different operation or occurrence owner.
    await expect(f.service.detail({ ...grant, binding: { sha256: "0".repeat(64), revision: 3 } }, contract.operationId)).rejects.toThrow("not found");
    f.packet.delivery = { state: "acknowledged", agentRunId: "another-run", acknowledgedAt: "2026-09-27T00:00:00Z" };
    await expect(f.service.detail({ ...grant, agentRunId: "another-run" }, contract.operationId)).rejects.toThrow("not found");
    expect(f.sends()).toBe(1);
  });
  test("a continuation grant cannot read an existing-work receipt", async () => {
    const f = fixture(); await f.service.request(grant, input);
    const continuation = new TestContinuationService(f.runs, f.dispatch);
    await expect(continuation.detail({ purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId, agentRunId,
      candidate: { repository: "Mentra-Community/MentraOS", headSha, target: "original" }, executionAttempt: 1, leaseGeneration: 1,
      leaseTokenSha256: "e".repeat(64), routineIds: ["no-glasses"], actions: ["read-results"], expires: grant.expires }, contract.operationId)).rejects.toThrow("not found");
  });
});

describe("nothing is sent without exact occurrence, binding, publication and worker", () => {
  const refusals: Record<string, [string, (f: ReturnType<typeof fixture>) => unknown]> = {
    "unacknowledged occurrence": ["acknowledged case ownership", f => { f.packet.delivery = { state: "pending" } as never; }],
    "another agent run": ["acknowledged case ownership", f => { f.packet.delivery = { state: "acknowledged", agentRunId: "other", acknowledgedAt: "x" }; }],
    "another recorded routine": ["recorded routine", f => { f.packet.routine = { id: "day1-ota", version: "1" }; }],
    "unpublished build": ["still running", f => f.publication({ availability: "unavailable", reason: "Build is still running" })],
    "changed archive": ["archive differs", f => f.publication({ archive: { name: "app.zip", sha256: "4".repeat(64), size: 12 } })],
    "unavailable worker": ["not enabled on the test workers", f => { f.routine.available = false; f.routine.reason = "This routine is not enabled on the test workers yet"; }],
    "unmerged bundle": ["merged into its base", f => { f.github.merged = false; }],
    "different merge": ["merged into its base", f => { f.github.merge = "6".repeat(40); }],
    "head without merge": ["does not contain the bundling merge", f => { f.github.status = "behind"; }],
    "diverged head": ["does not contain the bundling merge", f => { f.github.status = "diverged"; }],
    "different ZIP blob": ["artifact blob", f => { f.github.blob = "6".repeat(40); }],
    "absent ZIP": ["artifact blob", f => { f.github.blob = null; }],
  };
  for (const [name, [message, mutate]] of Object.entries(refusals)) test(name, async () => {
    const f = fixture(); mutate(f);
    await expect(f.service.request(grant, input)).rejects.toThrow(message);
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0); expect(f.events).not.toContain("authority");
  });
  test("request fields outside the capability refuse; PR selections are explicitly unsupported", async () => {
    const f = fixture();
    const cases: [unknown, string][] = [
      [{ ...input, source: { channel: "pr", prNumber: 4273, buildRunId: 1, publicationAttempt: 1 } }, "PR publications are not supported"],
      [{ ...input, source: { channel: "staging", buildRunId: 1, publicationAttempt: 1 } }, "differs from the bundling PR base"],
      [{ ...input, routineId: "day1-ota" }, "Routine differs"]];
    for (const [value, message] of cases) await expect(f.service.request(grant, value)).rejects.toThrow(message);
    for (const value of [{ ...input, verificationAttempt: 2 }, { ...input, expectedHeadSha: headSha }, { ...input, requestId: "routine-1-1-dev-no-glasses" }])
      await expect(f.service.request(grant, value)).rejects.toThrow();
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
  });
  test("an unregistered routine is unavailable and never replaced by a registered one", async () => {
    const f = fixture(); f.packet.routine = { id: "notes-phone", version: "1" };
    const notes = { ...grant, routineId: "notes-phone" };
    const inventory = await f.service.inventory(notes);
    expect(inventory).toMatchObject({ routineId: "notes-phone", available: false, builds: [] });
    expect((inventory as { reason: string }).reason).toContain("no other routine is substituted");
    await expect(f.service.request(notes, { ...input, routineId: "notes-phone" })).rejects.toThrow("not registered");
    // A no-glasses capability cannot verify a notes-phone occurrence either.
    await expect(f.service.request(grant, input)).rejects.toThrow("recorded routine");
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
  });
  test("inventory marks only the exact bundled publication selectable, with its operation ID and scope", async () => {
    const f = fixture();
    const selectable = await f.service.inventory(grant);
    expect(selectable).toMatchObject({ available: true, scope: { publications: "merged-dev-staging", pullRequestPublications: "unsupported" },
      builds: [{ headSha, existingWork: { selectable: true, operationId: contract.operationId } }] });
    f.github.blob = "6".repeat(40);
    expect((await f.service.inventory(grant)).builds[0]!.existingWork).toEqual({ selectable: false,
      reason: "This publication does not carry the reviewed miniapp artifact blob" });
    expect(f.sends()).toBe(0);
  });
});

describe("operation authority callback", () => {
  const echo = (body: Record<string, unknown>) => ({ schemaVersion: 1, valid: true, agentRunId: body.agentRunId,
    bindingSha256: (body.binding as { sha256: string }).sha256, bindingRevision: (body.binding as { revision: number }).revision,
    operationId: (body.operation as { operationId: string }).operationId });
  const replies: Record<string, [string, (body: Record<string, unknown>) => Response]> = {
    "stale revision": ["not reserved at the signed revision", () => new Response(null, { status: 409 })],
    "endpoint absent": ["does not support existing-work operation checks", () => new Response("missing", { status: 404 })],
    "server error": ["unknown response", () => new Response("boom", { status: 500 })],
    "malformed": ["unknown response", () => new Response("{", { status: 200 })],
    "valid false": ["did not confirm", body => Response.json({ ...echo(body), valid: false })],
    "schema version": ["did not confirm", body => Response.json({ ...echo(body), schemaVersion: 2 })],
    "agent run echo": ["did not confirm", body => Response.json({ ...echo(body), agentRunId: "other" })],
    "binding echo": ["did not confirm", body => Response.json({ ...echo(body), bindingSha256: "0".repeat(64) })],
    "revision echo": ["did not confirm", body => Response.json({ ...echo(body), bindingRevision: 4 })],
    "operation echo": ["did not confirm", body => Response.json({ ...echo(body), operationId: "11111111-2222-4333-a444-555555555555" })],
    "lease field": ["did not confirm", body => Response.json({ ...echo(body), leaseGeneration: 1 })],
    "missing echo": ["did not confirm", () => Response.json({ schemaVersion: 1, valid: true })],
  };
  for (const [name, [message, reply]] of Object.entries(replies)) test(`${name} fails before the durable send`, async () => {
    const f = fixture(); f.reply(reply);
    await expect(f.service.request(grant, input)).rejects.toThrow(message);
    expect(f.events).toEqual(["authority"]); expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
    // A refused authority does not burn the operation: once the controller confirms, the same ID sends once.
    f.reply(body => Response.json(echo(body)));
    expect((await f.service.request(grant, input)).dispatchId).toBe(contract.operationId); expect(f.sends()).toBe(1);
  });
  test("absent configuration, insecure origin and unreachable controller send nothing", async () => {
    for (const [mutate, message] of [[() => { delete process.env.CLOUD_REPORT_AGENT_URL; }, "not configured"],
      [() => { process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = "short"; }, "not configured"],
      [() => { process.env.CLOUD_REPORT_AGENT_URL = "http://agent.example.test"; }, "Invalid existing-work authority origin"],
      [() => { process.env.CLOUD_REPORT_AGENT_URL = "https://user:pass@agent.example.test"; }, "Invalid existing-work authority origin"]] as const) {
      process.env.CLOUD_REPORT_AGENT_URL = "https://agent.example.test"; process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret;
      const f = fixture(); mutate();
      await expect(f.service.request(grant, input)).rejects.toThrow(message);
      expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
    }
    process.env.CLOUD_REPORT_AGENT_URL = "https://agent.example.test";
    const f = fixture(); f.reply(() => { throw new TypeError("network down"); });
    await expect(f.service.request(grant, input)).rejects.toThrow("unreachable"); expect(f.rows.size).toBe(0);
  });
});

describe("exact result lineage and verification verdict", () => {
  test("the request's own terminal pass with complete evidence and verified return verifies the fix", async () => {
    const f = fixture(); await f.service.request(grant, input); f.terminal();
    const view = await f.service.detail(grant, contract.operationId);
    expect(view.state).toBe("finished");
    expect(view.recordedResults).toMatchObject([{ runId: requestId, outcome: "passed", provenance: { headSha, archiveSha256: operation.archiveSha256 } }]);
    expect(view.verification).toEqual({ state: "verified", client: { state: "passed", resultRunId: requestId }, backend: { required: false } });
  });
  test("a wrong request, archive, head or routine in the recorded lineage refuses the read", async () => {
    for (const field of ["request", "archive", "head", "routine"]) {
      const f = fixture(); await f.service.request(grant, input); f.terminal();
      const later = structuredClone(f.result); later.runId = "unrelated-later-pass";
      if (field === "request") later.requestId = "routine-91-1-dev-no-glasses";
      if (field === "archive") later.provenance.archiveSha256 = "4".repeat(64);
      if (field === "head") later.source.headSha = "5".repeat(40);
      if (field === "routine") later.routineId = "no-glasses-android";
      f.extra([later]);
      await expect(f.service.detail(grant, contract.operationId)).rejects.toThrow("differs from the registered");
    }
  });
  test("failed, incomplete, unverified-return, retained, recovery-only and pending results never verify", async () => {
    const cases: Record<string, [string, (f: ReturnType<typeof fixture>) => void]> = {
      "failed test": ["did not pass", f => { f.result.outcome = "failed"; f.result.outcomes.test = "failed"; }],
      "incomplete evidence": ["evidence is incomplete", f => { f.result.outcomes.evidence = "incomplete"; }],
      "unverified return": ["return after this result was not verified", f => { f.result.provenance.returnVerification = "failed"; }],
      "teardown failed": ["return after this result was not verified", f => { f.result.outcomes.teardown = "failed"; }],
      "retained fixture": ["retained the fixture", f => f.terminal(undefined, "recovery-required")],
      "other terminal result": ["not this request's registered result", f => f.terminal("another-result")],
      "recovery only": ["Only a recovery generation", f => {
        f.result.outcomes.fixture = "unknown"; f.result.outcomes.teardown = "failed";
        const recovery = structuredClone(f.result); recovery.runId = "recovery-2";
        recovery.outcomes = { ...recovery.outcomes, fixture: "ready", teardown: "passed" };
        recovery.provenance = { ...recovery.provenance, resultGeneration: "2", originalRunId: f.result.runId,
          originalTerminalSnapshotSha256: f.result.provenance.terminalSnapshotSha256!, terminalSnapshotSha256: "7".repeat(64) };
        f.extra([recovery]); }],
    };
    for (const [name, [reason, mutate]] of Object.entries(cases)) {
      const f = fixture(); await f.service.request(grant, input); f.terminal(); mutate(f);
      const read = f.service.detail(grant, contract.operationId);
      if (name === "other terminal result") { await expect(read).rejects.toThrow(); continue; }
      const { verification } = await read;
      expect(verification.state).toBe("unverified"); expect(verification.client.state).toBe("not-verified");
      expect((verification.client as { reason: string }).reason).toContain(reason);
    }
    const f = fixture(); await f.service.request(grant, input);
    expect((await f.service.detail(grant, contract.operationId)).verification).toMatchObject({ state: "pending", client: { state: "pending" } });
    // The pure verdict also refuses a terminal claim that names a result outside the lineage.
    const elsewhere = { requestId, requestSha256: "9".repeat(64), fixtureId: "mac-01", workerId: "mini", executionId: "execution",
      claimedAt: "2026-09-27T08:00:00Z", settledAt: "2026-09-27T09:00:00Z", state: "terminal",
      settlement: { state: "terminal", resultRunId: "another-result" } } as TestRunClaim;
    expect(existingWorkVerification({ sendState: "accepted", state: "finished" }, [f.result as never], elsewhere, null, null))
      .toMatchObject({ state: "unverified", client: { state: "not-verified", reason: "The terminal result is not this request's registered result" } });
  });
  test("a required backend fix stays unverified with missing run-bound provenance even when the client run passes", async () => {
    const backend = { ...grant, backendRequirement: { repository: "Mentra-Community/Mentra-Notes-Miniapp", mergeCommitSha: "b3a38baa98ae3e030e7ee42678fd19c37c8bcb4e" } };
    const f = fixture(); await f.service.request(backend, input); f.terminal();
    expect(f.rows.get(contract.operationId)!.receipt.existingWork!.backendRequirement).toEqual(backend.backendRequirement);
    const { verification } = await f.service.detail(backend, contract.operationId);
    expect(verification.state).toBe("unverified"); expect(verification.client.state).toBe("passed");
    expect(verification.backend).toMatchObject({ required: true, state: "unverified", reason: "missing-backend-provenance",
      requirement: backend.backendRequirement });
  });
});

describe("run-bound Notes backend deployment", () => {
  // The same synthetic shared fixture the result schema suite parses; never a live receipt.
  const projection = JSON.parse(readFileSync(join(import.meta.dir, "test-run-backend-deployment.fixture.json"), "utf8")) as TestRunBackendDeployment;
  const requiredCommit = "102312a3f3d074b0cd9c4f1bc6ae891c2e0fed96";
  const requirement = { repository: "Mentra-Community/Mentra-Notes-Miniapp", mergeCommitSha: requiredCommit };
  const backendGrant: ExistingWorkGrant = { ...grant, backendRequirement: requirement };
  /** Attach a projection bound to the fixture's first-generation result, claim hash and uploaded metadata asset. */
  const prove = (f: ReturnType<typeof fixture>, patch: Partial<TestRunBackendDeployment> = {}) => {
    const evidence = { assetId: projection.evidence.assetId, sha256: "5".repeat(64) };
    f.result.assets.push({ assetId: evidence.assetId, kind: "metadata", contentType: "application/json", filename: "notes-backend.json",
      sizeBytes: 120, sha256: evidence.sha256, uploaded: true });
    f.result.backendDeployment = { ...projection, runId: requestId, requestId, claimSha256: "9".repeat(64), commitSha: requiredCommit, evidence, ...patch };
    return f.result.backendDeployment;
  };
  const settled = async (value: ExistingWorkGrant = backendGrant) => {
    const f = fixture(); await f.service.request(value, input); f.terminal(); return f;
  };
  test("the exact passing first-generation result with a matching observation verifies a required backend", async () => {
    const f = await settled(), proof = prove(f);
    const { verification } = await f.service.detail(backendGrant, contract.operationId);
    expect(verification).toEqual({ state: "verified", client: { state: "passed", resultRunId: requestId },
      backend: { required: true, requirement, state: "verified", resultRunId: requestId, proof } });
    // The agent API returns the exact projection object for the internal bridge to strict-parse.
    const app = createTestFailureAgentApi(f.runs, new TestContinuationService(f.runs), undefined, undefined, f.service);
    const response = await app.request(`/${occurrenceId}/existing-work/requests/${contract.operationId}`,
      { headers: { authorization: `Bearer ${signTestExistingWorkGrant({ ...backendGrant, actions: ["read-results"] }, secret)}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { verification: { backend: { proof: unknown } } };
    expect(body.verification.backend.proof).toEqual(proof);
    expect(Object.keys(body.verification.backend).sort()).toEqual(["proof", "required", "requirement", "resultRunId", "state"]);
    expect(f.sends()).toBe(1);
  });
  test("a null requirement is unchanged by a present observation", async () => {
    const f = await settled(grant); prove(f);
    expect((await f.service.detail(grant, contract.operationId)).verification).toEqual({ state: "verified",
      client: { state: "passed", resultRunId: requestId }, backend: { required: false } });
  });
  test("another commit or repository, and any unbound observation, leave the backend unverified", async () => {
    const cases: Record<string, [string, (f: ReturnType<typeof fixture>) => void, ExistingWorkGrant?]> = {
      "later descendant commit": ["backend-commit-mismatch", f => { prove(f, { commitSha: "7".repeat(40) }); }],
      "historical PR9 commit": ["backend-commit-mismatch", f => { prove(f, { commitSha: "b3a38baa98ae3e030e7ee42678fd19c37c8bcb4e" }); }],
      "other required repository": ["backend-commit-mismatch", f => { prove(f); },
        { ...grant, backendRequirement: { repository: "Mentra-Community/Mentra-AI-Miniapp", mergeCommitSha: requiredCommit } }],
      "other run": ["backend-proof-invalid", f => { prove(f, { runId: "routine-91-1-dev-no-glasses" }); }],
      "other request": ["backend-proof-invalid", f => { prove(f, { requestId: "routine-91-1-dev-no-glasses" }); }],
      "other claim hash": ["backend-proof-invalid", f => { prove(f, { claimSha256: "6".repeat(64) }); }],
      "evidence hash": ["backend-proof-invalid", f => { prove(f); f.result.assets[0]!.sha256 = "6".repeat(64); }],
      "evidence asset missing": ["backend-proof-invalid", f => { prove(f); f.result.assets = []; }],
      "outside the run": ["backend-proof-invalid", f => { prove(f, { observedAfter: "2026-09-28T06:00:06.000Z" }); }],
      "exercise not enclosed": ["backend-proof-invalid", f => { prove(f, { exerciseStartedAt: "2026-09-28T06:00:00.500Z" }); }],
      "malformed stored projection": ["backend-proof-invalid", f => { prove(f, { origin: "https://example.com" as never }); }],
      "legacy producer": ["missing-backend-provenance", () => undefined],
    };
    for (const [name, [reason, mutate, value]] of Object.entries(cases)) {
      const f = await settled(value); mutate(f);
      const { verification } = await f.service.detail(value ?? backendGrant, contract.operationId);
      expect(verification.client.state, name).toBe("passed");
      expect(verification.state, name).toBe("unverified");
      expect(verification.backend, name).toMatchObject({ required: true, state: "unverified", reason });
      expect("proof" in verification.backend, name).toBe(false);
    }
  });
  test("a valid observation never overrides failed, incomplete, unreturned, retained, recovery-only, pending or unknown results", async () => {
    const cases: Record<string, (f: ReturnType<typeof fixture>) => void> = {
      "failed test": f => { f.result.outcome = "failed"; f.result.outcomes.test = "failed"; },
      "incomplete evidence": f => { f.result.outcomes.evidence = "incomplete"; },
      "unverified return": f => { f.result.provenance.returnVerification = "failed"; },
      "retained fixture": f => f.terminal(undefined, "recovery-required"),
      "claim of another request hash": f => { f.result.provenance.requestSha256 = "6".repeat(64); prove(f, { claimSha256: "6".repeat(64) }); },
      "recovery only": f => {
        f.result.outcomes.fixture = "unknown"; f.result.outcomes.teardown = "failed";
        const recovery = structuredClone(f.result); recovery.runId = "recovery-2";
        recovery.outcomes = { ...recovery.outcomes, fixture: "ready", teardown: "passed" };
        recovery.provenance = { ...recovery.provenance, resultGeneration: "2", originalRunId: f.result.runId,
          originalTerminalSnapshotSha256: f.result.provenance.terminalSnapshotSha256!, terminalSnapshotSha256: "7".repeat(64) };
        recovery.backendDeployment = { ...recovery.backendDeployment!, runId: "recovery-2" };
        f.extra([recovery]); },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const f = await settled(); prove(f); mutate(f);
      const { verification } = await f.service.detail(backendGrant, contract.operationId);
      expect(verification.client.state, name).toBe("not-verified"); expect(verification.state, name).toBe("unverified");
      expect(verification.backend, name).toMatchObject({ required: true, state: "unverified", reason: "client-not-verified" });
    }
    const pending = fixture(); await pending.service.request(backendGrant, input); prove(pending);
    expect((await pending.service.detail(backendGrant, contract.operationId)).verification)
      .toMatchObject({ state: "pending", backend: { state: "unverified", reason: "client-not-verified" } });
    const unknown = fixture(); unknown.sendFails(); await unknown.service.request(backendGrant, input); prove(unknown); unknown.terminal();
    expect((await unknown.service.detail(backendGrant, contract.operationId)).verification)
      .toMatchObject({ state: "pending", backend: { state: "unverified", reason: "client-not-verified" } });
  });
  test("the operation identity is unchanged by the backend requirement", async () => {
    const f = await settled();
    expect(f.rows.get(contract.operationId)!.receipt.existingWork!.backendRequirement).toEqual(requirement);
    expect([...f.rows.keys()]).toEqual([contract.operationId]);
  });
});

describe("dispatcher compatibility", () => {
  test("a failed existing-work admission does not burn its ID, and an existing-work binding cannot adopt a request", async () => {
    const f = fixture(), request = { ...input, verificationAttempt: undefined, idempotencyKey: contract.operationId };
    delete (request as Record<string, unknown>).verificationAttempt;
    const binding = { kind: "existing-work-verification-v1" as const, occurrenceId, agentRunId, bindingSha256: contract.bindingSha256,
      authorizedBindingRevision: 3, bundle, backendRequirement: null, routineId: "no-glasses", verificationAttempt: 1 as const, expectedHeadSha: headSha };
    await expect(f.dispatch.create(request, "agent", binding, { requestRunId: 77, requestUrl: "https://github.com/x/actions/runs/77" })).rejects.toThrow("Invalid");
    await expect(f.dispatch.create(request, "agent", { ...binding, expectedHeadSha: "5".repeat(40) })).rejects.toThrow("Candidate head differs");
    await expect(f.dispatch.create(request, "agent", { ...binding, extra: true } as never)).rejects.toThrow("Invalid");
    expect(f.rows.size).toBe(0); expect(f.sends()).toBe(0);
    expect((await f.dispatch.create(request, "agent", binding)).sendState).toBe("accepted");
    expect(f.rows.get(contract.operationId)!.receipt.existingWork).toEqual(binding); expect(f.sends()).toBe(1);
  });
});
