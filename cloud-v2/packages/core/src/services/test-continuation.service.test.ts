import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createTestFailureAgentApi } from "../api/agent/test-failures.api";
import type { ContinuationGrant } from "../types/test-continuation.types";
import type { TestBuild, TestDispatchReceipt } from "../types/test-dispatch.types";
import { TestDispatchService, type TestDispatchRepository } from "./test-dispatch.service";
import { TestContinuationService, acknowledgedCase, continuationOperationId } from "./test-continuation.service";
import { signTestContinuationGrant, signTestFailureReadGrant, verifyTestContinuationGrant } from "./test-failure-auth";
import type { TestBuildGateway } from "./test-builds.service";
import type { TestRunService } from "./test-run.service";
import type { ContinuationTarget } from "./test-continuation.github";
import type { TestRunClaim } from "../types/test-run-claim.types";
import { TestFailureIncidentService, type IncidentReportStore } from "./test-failure-incident.service";
const occurrenceId = "tfo_" + "a".repeat(64), headSha = "b".repeat(40), archiveSha256 = "c".repeat(64);
const secret = "continuation-test-only-".repeat(3);
const grant: ContinuationGrant = { purpose: "mentra-routine-fixer-continuation-v1", environment: "dev", occurrenceId,
  agentRunId: "run_123", executionAttempt: 1, leaseGeneration: 1, leaseTokenSha256: "e".repeat(64), candidate: { repository: "Mentra-Community/MentraOS", pullRequest: 44, headSha },
  routineIds: ["no-glasses"], actions: ["request-routine", "read-results"], expires: Math.floor(Date.now() / 1000) + 600 };
const input = { source: { channel: "pr" as const, prNumber: 44, buildRunId: 80, publicationAttempt: 1 }, routineId: "no-glasses" as const, archiveSha256 };
function fixture(incidents?: IncidentReportStore) {
  const packet = { schemaVersion: 1, occurrenceId, sourceStatus: "recorded", source: { repository: "Mentra-Community/MentraOS", headSha },
    delivery: { state: "acknowledged", agentRunId: "run_123" }, evidence: { complete: true, assets: [{ assetId: "asset" }] } } as unknown as Awaited<ReturnType<TestRunService["failureDetail"]>>;
  let sentHarness: string | undefined;
  let sends = 0, since = "", existing: { requestRunId: number; requestUrl: string } | null = null;
  let target: ContinuationTarget = { query: { channel: "pr", pr: 44 }, expectedHeadSha: headSha, automaticExpected: false };
  let claim: { state: string; resultRunId?: string } | null = null;
  const result = { runId: "routine-90-1-44-no-glasses", requestId: "routine-90-1-44-no-glasses", routineId: "no-glasses", source: { headSha },
    outcome: "failed", outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "complete" },
    fixture: { alias: "glasses-03be" },
    provenance: { archiveSha256, requestSha256: "9".repeat(64), executionMode: "ci-registered", requestRelationship: "consumed",
      resultGeneration: "1", terminalSnapshotSha256: "8".repeat(64), returnVerification: "passed" } as Record<string, string>,
    failureOccurrences: [{ occurrenceId: "tfo_" + "d".repeat(64) }] };
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
    dispatch: async (_, pin) => { sentHarness = pin; sends++; return { requestRunId: 90, requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/90" }; },
    progress: async () => ({ state: "running", requestId: "routine-90-1-44-no-glasses", message: "Running" }),
    findExisting: async (_, value) => { since = value; return existing; },
    // The original request's immutable selection (the real gateway reads it from GitHub).
    originalSelection: async () => ({ source: input.source, archiveSha256, headSha }),
  };
  let ids: string[] = [], extraResults: typeof result[] = [];
  // Core acknowledges each linked occurrence to its stable branch anchor.
  const anchors = new Map<string, string>();
  const runs = { failureDetail: async (id: string) => id === occurrenceId ? packet : { ...packet, occurrenceId: id,
      ...(anchors.has(id) ? { delivery: { state: "acknowledged", agentRunId: anchors.get(id) } } : {}) },
    detail: async (id: string) => extraResults.find(item => item.runId === id) ?? result, failureMedia: async () => new Response("assigned") } as unknown as TestRunService;
  const dispatch = new TestDispatchService(repository, builds);
  let leaseValid = true;
  const leaseChecks: ContinuationGrant[] = [], targets: ContinuationGrant[] = [];
  const service = new TestContinuationService(runs, dispatch, builds, { target: async (_, value) => { targets.push(value); return target; } }, {
    // Mirrors the Mongo query: occurrence, anchor and exact candidate.
    list: async value => [...rows.values()].map(row => row.receipt).filter(receipt => receipt.continuation?.occurrenceId === value.occurrenceId
      && receipt.continuation.agentRunId === value.agentRunId && JSON.stringify(receipt.continuation.candidate) === JSON.stringify(value.candidate)),
    results: async () => ids,
    claim: async () => claim ? ({ requestId: result.requestId, requestSha256: "9".repeat(64), fixtureId: result.fixture.alias,
      workerId: "mini", executionId: "execution", claimedAt: "2026-09-25T08:00:00Z", settledAt: "2026-09-25T08:00:00Z",
      state: claim.state, settlement: claim.resultRunId ? { state: "terminal", resultRunId: claim.resultRunId }
        : { state: "recovery-required", reason: "Retained for recovery" } } as TestRunClaim) : null,
  }, async value => { leaseChecks.push(value); if (!leaseValid) throw new Error("Stale lease"); }, incidents ? new TestFailureIncidentService(runs, incidents) : undefined);
  return { packet, rows, builds, runs, service, result, leaseChecks, targets, anchor: (id: string, agentRunId: string) => { anchors.set(id, agentRunId); },
    loseLease: () => { leaseValid = false; }, sends: () => sends, sentHarness: () => sentHarness, since: () => since,
    target: (value: Partial<ContinuationTarget>) => { target = { ...target, ...value }; },
    claim: (value: typeof claim) => { claim = value; }, results: (additional: typeof result[] = []) => { extraResults = additional; ids = [result.runId, ...additional.map(item => item.runId)]; },
    existing: () => { existing = { requestRunId: 90, requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/90" }; } };
}
test.each(["22222222-2222-4222-8222-222222222222", "run_linked_123"])("a signed continuation retains the original %s ACK distinct from the editor", async acknowledgedAgentRunId => {
  const f = fixture();
  f.packet.delivery = { state: "acknowledged", agentRunId: acknowledgedAgentRunId, acknowledgedAt: new Date().toISOString() };
  const linked = { ...grant, acknowledgedAgentRunId };
  expect(verifyTestContinuationGrant(signTestContinuationGrant(linked, secret), occurrenceId, secret, "dev")).toEqual(linked);
  expect(() => signTestContinuationGrant({ ...linked, acknowledgedAgentRunId: "invalid/id" }, secret)).toThrow();
  expect((await acknowledgedCase(f.runs, linked)).delivery).toMatchObject({ state: "acknowledged", agentRunId: acknowledgedAgentRunId });
  await expect(acknowledgedCase(f.runs, grant)).rejects.toThrow("acknowledged case");
  await expect(acknowledgedCase(f.runs, { ...linked, acknowledgedAgentRunId: "33333333-3333-4333-8333-333333333333" }))
    .rejects.toThrow("acknowledged case");
  await f.service.request(linked, input);
  expect(f.sends()).toBe(1);
  expect(f.leaseChecks.every(value => value.agentRunId === grant.agentRunId && value.acknowledgedAgentRunId === acknowledgedAgentRunId)).toBe(true);
  const stopped = fixture(); stopped.packet.delivery = f.packet.delivery; stopped.loseLease();
  await expect(stopped.service.request(linked, input)).rejects.toThrow("Stale lease");
  expect(stopped.sends()).toBe(0);
});
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
  expect(await f.service.request(grant, input)).toMatchObject({ adopted: true, sendState: "accepted" }); expect(f.sends()).toBe(0);
});
test("harness candidate never adopts an automatic request lacking its revision fence", async () => {
  const f = fixture(); f.target({ expectedHarnessSha: "e".repeat(40), requestNotBefore: "2026-09-25T09:00:00Z" });
  f.existing();
  await f.service.request(grant, input); expect(f.since()).toBe(""); expect(f.sends()).toBe(1);
  expect(f.sentHarness()).toBe("e".repeat(40));
  expect([...f.rows.values()][0]!.receipt.adopted).not.toBe(true);
  await f.service.request(grant, input); expect(f.sends()).toBe(1);
});

function localNotesFixture() {
  const f = fixture(), appHead = "d6c74c857015fac95fbc6195dbf009acfab65eeb", harness = "f".repeat(40);
  const candidateGrant: ContinuationGrant = { ...grant, routineIds: ["notes-phone"],
    candidate: { repository: "Mentra-Community/Mentra-Automated-Testing", pullRequest: 217,
      headSha: "f9a7d7bfd6d7e764866d367120338dd93000259f" } };
  const publication = { channel: "dev" as const, producerRunId: 36496912774,
    executableSha256: "3cd22e5a9ec9b62c55d0cf79df0aec71c721c3110e712127b3c131a46b4f1842",
    javascriptSha256: "f3bd02020c7b5d4d44d7768888be90e549ebdf15526e14c65532dcc990a8c423" };
  const selected: TestBuild = { source: { channel: "dev", buildRunId: publication.producerRunId, publicationAttempt: 1 },
    headSha: appHead, title: "dev468", buildUrl: `https://github.com/Mentra-Community/MentraOS/actions/runs/${publication.producerRunId}`,
    createdAt: "2026-09-28T23:14:20Z", availability: "available", platform: "ios-on-mac",
    archive: { name: "mentraos-3.3.0-dev.468-mac.zip", sha256: "3da1733469e7e298907db294397dd7a7b41f3b73735cb5b517513ef3e6cfadd5", size: 121702007 },
    app: { executableSha256: publication.executableSha256, javascriptSha256: publication.javascriptSha256 },
    routines: [{ id: "notes-phone", available: true }] };
  f.packet.source = { schemaVersion: 1, trigger: "local", channel: "local", repository: "Mentra-Community/MentraOS", branch: "dev", headSha: appHead };
  f.packet.requestId = "notes-phone-22c2da8c-b863-4a03-b37f-4780f49d7fa0";
  f.target({ query: { channel: "dev" }, expectedHeadSha: appHead, expectedHarnessSha: harness,
    localPublication: publication, requestNotBefore: "2026-09-29T13:00:00Z" });
  f.builds.inventory = async () => { throw new Error("Local replay must not search latest builds"); };
  f.builds.originalSelection = async () => { throw new Error("Local replay has no consumed original CI request"); };
  f.builds.resolveRecordedApp = async (value, routine) => {
    expect(value).toEqual({ ...publication, headSha: appHead }); expect(routine).toBe("notes-phone"); return selected;
  };
  f.builds.resolve = async source => { expect(source).toEqual(selected.source); return selected; };
  f.builds.progress = async () => ({ state: "running", requestId: "routine-90-1-dev-notes-phone", message: "Running" });
  return { ...f, selected, candidateGrant, harness, request: { source: selected.source, routineId: "notes-phone" as const, archiveSha256: selected.archive!.sha256 } };
}
test("local Notes selects its old exact publication and uses the same case-bound one-send/result path", async () => {
  const f = localNotesFixture(), original = structuredClone(f.packet);
  expect((await f.service.inventory(f.candidateGrant, "notes-phone")).builds).toEqual([f.selected]);
  await Promise.all([f.service.request(f.candidateGrant, f.request), f.service.request(f.candidateGrant, f.request)]);
  expect(f.sends()).toBe(1); expect(f.rows.size).toBe(1); expect(f.since()).toBe(""); expect(f.sentHarness()).toBe(f.harness);
  const stored = [...f.rows.values()][0]!.receipt;
  expect(stored.input).not.toHaveProperty("originalRequestRunId");
  expect(stored.continuation).toMatchObject({ occurrenceId, agentRunId: grant.agentRunId, expectedHeadSha: f.selected.headSha, expectedHarnessSha: f.harness });
  expect(f.packet).toEqual(original); expect(f.packet.source!.channel).toBe("local");
  f.result.requestId = "routine-90-1-dev-notes-phone"; f.result.routineId = "notes-phone";
  f.result.source.headSha = f.selected.headSha; f.result.provenance.archiveSha256 = f.selected.archive!.sha256;
  f.result.provenance.harnessSha = "0".repeat(40); f.results();
  const id = continuationOperationId(f.candidateGrant, "notes-phone");
  await expect(f.service.detail(f.candidateGrant, id)).rejects.toThrow("worker revision");
  f.result.provenance.harnessSha = f.harness;
  expect((await f.service.detail(f.candidateGrant, id)).recordedResults[0]!.provenance.harnessSha).toBe(f.harness);
});
test("local publication cannot be exchanged for a newer build, attempt, channel or archive", async () => {
  for (const changed of [
    { source: { channel: "dev", buildRunId: 36496912775, publicationAttempt: 1 } },
    { source: { channel: "dev", buildRunId: 36496912774, publicationAttempt: 2 } },
    { source: { channel: "staging", buildRunId: 36496912774, publicationAttempt: 1 } },
    { archiveSha256: "0".repeat(64) },
  ]) {
    const f = localNotesFixture();
    await expect(f.service.request(f.candidateGrant, { ...f.request, ...changed })).rejects.toThrow();
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
  }
});
test("unavailable local publication, disabled routine and stale custody refuse without consuming the send identity", async () => {
  for (const state of ["archive", "routine", "lease", "resolver"] as const) {
    const f = localNotesFixture();
    if (state === "archive") { f.selected.availability = "unavailable"; f.selected.reason = "Published app archive is missing"; }
    if (state === "routine") f.selected.routines = [{ id: "notes-phone", available: false, reason: "This routine is not enabled on the test workers yet" }];
    if (state === "lease") f.loseLease();
    if (state === "resolver") delete f.builds.resolveRecordedApp;
    await expect(f.service.request(f.candidateGrant, f.request)).rejects.toThrow(state === "archive" ? "archive is missing"
      : state === "routine" ? "not enabled" : state === "resolver" ? "verification is unavailable" : "Stale lease");
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
  }
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

test("POST replay only acknowledges dispatch even after results exist; reads require read-results", async () => {
  const f = fixture(); process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  const app = createTestFailureAgentApi(f.runs, f.service), base = `/${occurrenceId}/reruns`;
  const token = signTestContinuationGrant({ ...grant, actions: ["request-routine"] }, secret);
  const headers = { authorization: `Bearer ${token}` };
  const post = () => app.request(base, { method: "POST", headers, body: JSON.stringify(input) });
  const first = await post(); expect(first.status).toBe(202);
  const acknowledgement = await first.json() as Record<string, unknown>;
  expect(Object.keys(acknowledgement).sort()).toEqual(["dispatchId", "requestRunId", "requestUrl", "sendState"]);
  f.results(); f.claim({ state: "terminal", resultRunId: f.result.runId });
  const replay = await post(); expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(acknowledgement); expect(f.sends()).toBe(1);
  expect((await app.request(`${base}/${continuationOperationId(grant, input.routineId)}`, { headers })).status).toBe(401);
  const read = await app.request(`${base}/${continuationOperationId(grant, input.routineId)}`, {
    headers: { authorization: `Bearer ${signTestContinuationGrant(grant, secret)}` },
  });
  expect(read.status).toBe(200); expect((await read.json() as { recordedResults: unknown[] }).recordedResults).toHaveLength(1);
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
  f.claim({ state: "terminal", resultRunId: f.result.runId }); f.results();
  const request = { ...input, executionAttempt: 2, retryReason: "Recovered fixture infrastructure" };
  const second = await f.service.request(retryGrant, request);
  expect(second.dispatchId).not.toBe(continuationOperationId(grant, input.routineId)); expect(f.sends()).toBe(2);
  await f.service.request(retryGrant, request); expect(f.sends()).toBe(2); expect(f.rows.size).toBe(2);
});

test("verified linked recovery permits a deliberate retry while retaining the original failure and hold", async () => {
  for (const mismatch of ["valid", "fixture", "snapshot", "evidence", "newer-failure"]) {
    const f = fixture(); await f.service.request(grant, input);
    f.result.outcomes.fixture = "unknown"; f.result.outcomes.teardown = "failed";
    f.claim({ state: "recovery-required" });
    const recovery = structuredClone(f.result); recovery.runId = "recovery-2";
    recovery.outcomes = { ...recovery.outcomes, fixture: "ready", teardown: "passed" };
    recovery.provenance = { ...recovery.provenance, resultGeneration: "2", originalRunId: f.result.runId,
      originalTerminalSnapshotSha256: f.result.provenance.terminalSnapshotSha256!, terminalSnapshotSha256: "7".repeat(64), returnVerification: "passed" };
    if (mismatch === "fixture") recovery.fixture.alias = "different-glasses";
    if (mismatch === "snapshot") recovery.provenance.originalTerminalSnapshotSha256 = "6".repeat(64);
    if (mismatch === "evidence") recovery.outcomes.evidence = "incomplete";
    const newer = structuredClone(recovery); newer.runId = "recovery-3"; newer.provenance.resultGeneration = "3";
    newer.outcomes.fixture = "unknown"; newer.outcomes.teardown = "failed";
    f.results(mismatch === "newer-failure" ? [recovery, newer] : [recovery]);
    const id = continuationOperationId(grant, input.routineId), previous = await f.service.detail(grant, id);
    expect(previous.state).toBe("recovery-required"); expect(previous.recordedResults[0]?.outcome).toBe("failed");
    const request = { ...input, executionAttempt: 2, retryReason: "Verified retained fixture recovery" };
    const retryGrant = { ...grant, executionAttempt: 2 };
    if (mismatch === "valid") {
      expect(previous.verifiedRecovery?.recoveryRunId).toBe(recovery.runId);
      await f.service.request(retryGrant, request); await f.service.request(retryGrant, request);
      expect(f.sends()).toBe(2); expect(f.rows.size).toBe(2);
    } else {
      expect(previous.verifiedRecovery).toBeNull();
      await expect(f.service.request(retryGrant, request)).rejects.toThrow("verified fixture cleanup");
      expect(f.sends()).toBe(1);
    }
    expect((await f.service.detail(grant, id)).state).toBe("recovery-required");
    expect(f.result.outcome).toBe("failed"); expect(f.result.outcomes.teardown).toBe("failed");
  }
});

test("terminal claims cannot bypass failed verification, newer failed cleanup or ambiguous generations", async () => {
  for (const condition of ["missing-verification", "failed-verification", "newer-failure", "duplicate-generation"]) {
    const f = fixture(); await f.service.request(grant, input);
    f.claim({ state: "terminal", resultRunId: f.result.runId });
    const newer = structuredClone(f.result); newer.runId = "recovery-new";
    newer.provenance = { ...newer.provenance, resultGeneration: "2", originalRunId: f.result.runId,
      originalTerminalSnapshotSha256: f.result.provenance.terminalSnapshotSha256!, terminalSnapshotSha256: "7".repeat(64) };
    newer.outcomes.fixture = "unknown"; newer.outcomes.teardown = "failed";
    if (condition === "missing-verification") delete f.result.provenance.returnVerification;
    if (condition === "failed-verification") f.result.provenance.returnVerification = "failed";
    if (condition === "duplicate-generation") newer.provenance.resultGeneration = "1";
    f.results(condition === "newer-failure" || condition === "duplicate-generation" ? [newer] : []);
    const view = await f.service.detail(grant, continuationOperationId(grant, input.routineId));
    expect(view.state).toBe("finished"); expect(view.verifiedRecovery).toBeNull();
    await expect(f.service.request({ ...grant, executionAttempt: 2 }, { ...input, executionAttempt: 2,
      retryReason: "Infrastructure retry" })).rejects.toThrow("verified fixture cleanup");
    expect(f.sends()).toBe(1);
  }
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

const HARNESS = "Mentra-Community/Mentra-Automated-Testing" as const;
const caseId = "mfc_" + "5".repeat(64), devOccurrence = "tfo_" + "1".repeat(64), stagingOccurrence = "tfo_" + "2".repeat(64);
const shared = { repository: HARNESS, pullRequest: 7, headSha: "7".repeat(40) };
const adopted = (occurrence: string, agentRunId: string, owner = "run_owner"): ContinuationGrant => ({ ...grant, occurrenceId: occurrence, agentRunId,
  candidate: shared, caseBinding: { caseId, candidateOwnerRunId: owner } });

test("same-case branches adopting one shared harness head keep separate operations, receipts and verdicts", async () => {
  const f = fixture(); f.anchor(devOccurrence, "run_dev"); f.anchor(stagingOccurrence, "run_staging");
  f.target({ expectedHarnessSha: "e".repeat(40), requestNotBefore: "2026-09-25T09:00:00Z" });
  const dev = adopted(devOccurrence, "run_dev"), staging = adopted(stagingOccurrence, "run_staging");
  const stagingInput = { ...input, source: { channel: "staging" as const, buildRunId: 81, publicationAttempt: 1 } };
  const one = await f.service.request(dev, input);
  // Each branch selects its own recorded original app build (Core resolves it from that occurrence's source).
  f.target({ query: { channel: "staging" } });
  const two = await f.service.request(staging, stagingInput);
  expect(f.rows.get(two.dispatchId)!.receipt.input.source).toEqual(stagingInput.source);
  expect(f.rows.get(one.dispatchId)!.receipt.input.source).toEqual(input.source);
  expect(one.dispatchId).toBe(continuationOperationId(dev, "no-glasses"));
  expect(two.dispatchId).not.toBe(one.dispatchId); expect(f.sends()).toBe(2);
  // The signed binding reaches the lease callback before the owner-branch lookup and again at the send fence.
  expect(f.leaseChecks.map(item => item.caseBinding)).toEqual([dev.caseBinding, dev.caseBinding, staging.caseBinding, staging.caseBinding]);
  expect(f.targets.every(item => item.caseBinding?.candidateOwnerRunId === "run_owner")).toBe(true);
  expect(f.rows.get(one.dispatchId)!.receipt.continuation).toMatchObject({ occurrenceId: devOccurrence, agentRunId: "run_dev",
    candidate: shared, caseBinding: dev.caseBinding, expectedHarnessSha: "e".repeat(40) });
  expect(f.rows.get(two.dispatchId)!.receipt.continuation).toMatchObject({ occurrenceId: stagingOccurrence, agentRunId: "run_staging" });
  // Neither branch can read, list or replay the other's operation, so a pass is never borrowed.
  await expect(f.service.detail(staging, one.dispatchId)).rejects.toThrow("not found");
  await expect(f.service.detail(dev, two.dispatchId)).rejects.toThrow("not found");
  expect((await f.service.list(staging)).reruns.map(item => [item.dispatchId, item.recordedResults.length])).toEqual([[two.dispatchId, 0]]);
  f.results();
  // The dev result must carry the exact merged worker revision; otherwise it is refused, never adopted.
  await expect(f.service.detail(dev, one.dispatchId)).rejects.toThrow("worker revision");
  f.result.provenance.harnessSha = "e".repeat(40);
  const devView = await f.service.list(dev);
  expect(devView.reruns.map(item => [item.dispatchId, item.recordedResults[0]?.outcome])).toEqual([[one.dispatchId, "failed"]]);
});

test("historical reads and replays refuse a missing, different-owner or different-case binding", async () => {
  const f = fixture(); f.anchor(devOccurrence, "run_dev");
  const dev = adopted(devOccurrence, "run_dev"), id = (await f.service.request(dev, input)).dispatchId; f.results();
  const { caseBinding: _, ...unbound } = dev;
  for (const other of [unbound, adopted(devOccurrence, "run_dev", "run_intruder"), { ...dev, caseBinding: { ...dev.caseBinding!, caseId: "mfc_" + "6".repeat(64) } }]) {
    await expect(f.service.detail(other, id)).rejects.toThrow("not found");
    await expect(f.service.request(other, input)).rejects.toThrow("not found");
    expect((await f.service.list(other)).reruns).toEqual([]);
  }
  expect(f.sends()).toBe(1);
  expect((await f.service.detail(dev, id)).recordedResults).toHaveLength(1);
});

test("a same-head recurrence needs its own occurrence-bound operation; the old one stays readable", async () => {
  const f = fixture(), recurrence = "tfo_" + "3".repeat(64); f.anchor(recurrence, grant.agentRunId);
  const first = await f.service.request(grant, input); f.results(); f.claim({ state: "terminal", resultRunId: f.result.runId });
  const later = { ...grant, occurrenceId: recurrence }, second = await f.service.request(later, input);
  expect(second.dispatchId).not.toBe(first.dispatchId); expect(f.sends()).toBe(2);
  expect(second.dispatchId).toBe(continuationOperationId(later, "no-glasses"));
  await expect(f.service.detail(later, first.dispatchId)).rejects.toThrow("not found");
  expect((await f.service.detail(grant, first.dispatchId)).recordedResults[0]?.outcome).toBe("failed");
  // Duplicate delivery of the recurrence request reuses its receipt; no extra send.
  await f.service.request(later, input); expect(f.sends()).toBe(2);
});

test("an adopted binding cannot dispatch after its lease is lost", async () => {
  const f = fixture(); f.anchor(devOccurrence, "run_dev"); f.loseLease();
  await expect(f.service.request(adopted(devOccurrence, "run_dev"), input)).rejects.toThrow("Stale lease");
  expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
});

test("signed grants carry the optional case binding and reject malformed ones", () => {
  const value = adopted(devOccurrence, "run_dev"), token = signTestContinuationGrant(value, secret);
  expect(verifyTestContinuationGrant(token, devOccurrence, secret, "dev")).toEqual(value);
  expect(() => signTestContinuationGrant({ ...value, caseBinding: { caseId: "case", candidateOwnerRunId: "run_owner" } }, secret)).toThrow();
  expect(() => signTestContinuationGrant({ ...value, caseBinding: { ...value.caseBinding!, extra: true } as never }, secret)).toThrow();
});

const original: ContinuationGrant = { ...grant, candidate: { repository: "Mentra-Community/MentraOS", headSha, target: "original" } };
const uuid = (parts: unknown[]) => { const d = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-a${d.slice(17, 20)}-${d.slice(20, 32)}`; };

test("existing PR operation IDs are unchanged; the original target has its own attempt-bound ID", () => {
  expect(continuationOperationId(grant, "no-glasses")).toBe(uuid([occurrenceId, "run_123", "Mentra-Community/MentraOS", 44, headSha, "no-glasses", 1]));
  expect(continuationOperationId(original, "no-glasses")).toBe(uuid([occurrenceId, "run_123", "Mentra-Community/MentraOS", "original", headSha, "no-glasses", 1]));
  expect(continuationOperationId({ ...original, executionAttempt: 2 }, "no-glasses")).not.toBe(continuationOperationId(original, "no-glasses"));
});

test("an original-target diagnostic rerun sends the recorded artifact once, needs no repair and adopts no earlier request", async () => {
  const f = fixture(); f.target({ original: { archiveSha256, requestRunId: 70 } }); f.existing();
  const sent = await f.service.request(original, input);
  expect(sent).toMatchObject({ dispatchId: continuationOperationId(original, "no-glasses"), sendState: "accepted" });
  expect(sent.adopted).toBeUndefined(); expect(f.sends()).toBe(1); expect(f.since()).toBe("");
  expect(f.rows.get(sent.dispatchId)!.receipt.continuation).toMatchObject({ candidate: original.candidate, expectedHeadSha: headSha, executionAttempt: 1 });
  expect(f.leaseChecks).toEqual([original, original]);
  await f.service.request(original, input); expect(f.sends()).toBe(1);
  // The original target and a PR candidate never list or read each other's operations.
  expect((await f.service.list(original)).reruns.map(item => item.dispatchId)).toEqual([sent.dispatchId]);
  expect((await f.service.list(grant)).reruns).toEqual([]);
  await expect(f.service.detail(grant, sent.dispatchId)).rejects.toThrow("not found");
  // Results stay bound to the recorded head and archive.
  f.results(); f.result.provenance.archiveSha256 = "e".repeat(64);
  await expect(f.service.detail(original, sent.dispatchId)).rejects.toThrow("differs");
});

test("an original-target request with another artifact, head, channel, attempt, routine or lease sends nothing", async () => {
  const expected: Record<string, string> = { archive: "original recorded artifact", head: "differs from the recorded result", channel: "outside the candidate source",
    attempt: "Execution attempt differs", routine: "outside this capability", lease: "Stale lease" };
  for (const mismatch of Object.keys(expected)) {
    const f = fixture(); f.target({ original: { archiveSha256, requestRunId: 70 } });
    let request: Record<string, unknown> = input;
    if (mismatch === "archive") request = { ...input, archiveSha256: "e".repeat(64) };
    if (mismatch === "head") f.target({ expectedHeadSha: "f".repeat(40) });
    if (mismatch === "channel") request = { ...input, source: { channel: "dev", buildRunId: 80, publicationAttempt: 1 } };
    if (mismatch === "attempt") request = { ...input, executionAttempt: 2, retryReason: "Reproduce the failure" };
    if (mismatch === "routine") request = { ...input, routineId: "day1-ota" };
    if (mismatch === "lease") f.loseLease();
    await expect(f.service.request(original, request)).rejects.toThrow(expected[mismatch]);
    expect(f.sends()).toBe(0); expect(f.rows.size).toBe(0);
  }
});

test("signed grants admit the original target and repair action, never a hybrid or unknown target", () => {
  const value: ContinuationGrant = { ...original, actions: ["repair-state", "read-results"] };
  expect(verifyTestContinuationGrant(signTestContinuationGrant(value, secret), occurrenceId, secret, "dev")).toEqual(value);
  expect(() => signTestContinuationGrant({ ...grant, candidate: { ...grant.candidate, target: "original" } } as never, secret)).toThrow();
  expect(() => signTestContinuationGrant({ ...original, candidate: { repository: "Mentra-Community/MentraOS", headSha, target: "latest" } } as never, secret)).toThrow();
});

test("registered rerun incidents require the exact result binding before the incident membership guard", async () => {
  process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET = secret; process.env.CLOUD_CORE_ENVIRONMENT = "dev";
  // Synthetic reports: the rerun failure owns rep_01RERUN; the original occurrence owns rep_01ORIGINAL.
  const bytes = Buffer.from(JSON.stringify({ entries: [{ timestamp: 1, level: "info", message: "synthetic rerun frame" }] }));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const calls: string[] = [];
  const report = (reportId: string) => ({ report: { reportId, kind: "automatic", status: "ready", mentraUserId: "mu_synthetic", trigger: null,
    report: null, feedback: null, context: {}, createdAt: null, updatedAt: null, artifacts: [{ artifactId: `art_${reportId.slice(4)}`,
      type: "logs", source: "phone", filename: null, contentType: "application/json", sizeBytes: bytes.byteLength, createdAt: null }] },
  assets: [{ artifactId: `art_${reportId.slice(4)}`, storageKey: `reports/${reportId}`, fileName: null, contentType: "application/json",
    sizeBytes: bytes.byteLength, sha256, createdAt: null }] }) as never;
  const store: IncidentReportStore = {
    getReport: async id => { calls.push(id); return report(id); },
    readReportArtifactPayload: async (id, artifactId) => { calls.push(`${id}/${artifactId}`);
      return artifactId === `art_${id.slice(4)}` ? { bytes, contentType: "application/json", fileName: null, sha256 } : null; },
  };
  const f = fixture(store), failureId = f.result.failureOccurrences[0]!.occurrenceId;
  const byOccurrence: Record<string, string[]> = { [occurrenceId]: ["rep_01ORIGINAL"], [failureId]: ["rep_01RERUN"] };
  (f.runs as { failureDetail: unknown }).failureDetail = async (id: string) =>
    ({ ...f.packet, occurrenceId: id, failure: { incidentIds: byOccurrence[id] ?? [] } });
  await f.service.request(grant, input);
  const app = createTestFailureAgentApi(f.runs, f.service, new TestFailureIncidentService(f.runs, store));
  const id = continuationOperationId(grant, input.routineId), rerun = `/${occurrenceId}/reruns/${id}/failures/${failureId}/incidents`;
  const headers = { authorization: `Bearer ${signTestContinuationGrant(grant, secret)}` };
  // No recorded result yet: the failure is not part of the registered request, so storage is never queried.
  expect((await app.request(`${rerun}/rep_01RERUN`, { headers })).status).toBe(404);
  expect(calls).toEqual([]);
  f.results();
  const response = await app.request(`${rerun}/rep_01RERUN`, { headers });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  const meta = await response.json() as { occurrenceId: string; logs: { state: string; artifacts: Array<{ representation: { path: string; sha256: string } }> } };
  expect(meta.occurrenceId).toBe(failureId); expect(meta.logs.state).toBe("usable");
  const path = meta.logs.artifacts[0]!.representation.path;
  expect(path).toBe(`/api/agent/test-failures${rerun}/rep_01RERUN/artifacts/art_01RERUN`);
  const artifact = await app.request(path.replace("/api/agent/test-failures", ""), { headers });
  expect(artifact.status).toBe(200);
  expect(createHash("sha256").update(new Uint8Array(await artifact.arrayBuffer())).digest("hex")).toBe(meta.logs.artifacts[0]!.representation.sha256);
  calls.length = 0;
  // The original occurrence's incident, another failure, another candidate and other credentials are all denied.
  expect((await app.request(`${rerun}/rep_01ORIGINAL`, { headers })).status).toBe(404);
  expect((await app.request(`${rerun}/rep_01RERUN/artifacts/art_01ORIGINAL`, { headers })).status).toBe(404);
  expect((await app.request(`/${occurrenceId}/reruns/${id}/failures/tfo_${"0".repeat(64)}/incidents/rep_01RERUN`, { headers })).status).toBe(404);
  const otherCandidate = signTestContinuationGrant({ ...grant, candidate: { ...grant.candidate, headSha: "f".repeat(40) } }, secret);
  expect((await app.request(`${rerun}/rep_01RERUN`, { headers: { authorization: `Bearer ${otherCandidate}` } })).status).toBe(404);
  const writeOnly = signTestContinuationGrant({ ...grant, actions: ["request-routine"] }, secret);
  expect((await app.request(`${rerun}/rep_01RERUN`, { headers: { authorization: `Bearer ${writeOnly}` } })).status).toBe(401);
  const originalRead = { authorization: `Bearer ${signTestFailureReadGrant(occurrenceId, "dev", grant.expires, secret)}` };
  expect((await app.request(`${rerun}/rep_01RERUN`, { headers: originalRead })).status).toBe(401);
  expect((await app.request(`${rerun}/rep_01RERUN`)).status).toBe(401);
  // Only the assigned report was consulted (to see the artifact is not listed); nothing else was read.
  expect(calls).toEqual(["rep_01RERUN"]);
  // The original read grant reaches only the original occurrence's incident on the original route.
  expect((await app.request(`/${occurrenceId}/incidents/rep_01RERUN`, { headers: originalRead })).status).toBe(404);
  expect((await app.request(`/${occurrenceId}/incidents/rep_01ORIGINAL`, { headers: originalRead })).status).toBe(200);
  expect((await app.request(`/${occurrenceId}/incidents/rep_01ORIGINAL`, { headers })).status).toBe(401);
  process.env.CLOUD_CORE_ENVIRONMENT = "staging";
  expect((await app.request(`${rerun}/rep_01RERUN`, { headers })).status).toBe(401);
});

test("a reviewed corrected source admits continuation only for the same acknowledged anchor; missing source still refuses", async () => {
  const packet = (sourceStatus: string, source: unknown, agentRunId = "run_123") => ({ failureDetail: async () => ({ occurrenceId, sourceStatus, source,
    delivery: { state: "acknowledged", agentRunId } }) }) as unknown as Pick<TestRunService, "failureDetail">;
  const source = { repository: "Mentra-Community/MentraOS", headSha };
  expect((await acknowledgedCase(packet("corrected", source), grant)).source).toMatchObject(source);
  for (const runs of [packet("missing", null), packet("corrected", null), packet("corrected", source, "other_run")])
    await expect(acknowledgedCase(runs, grant)).rejects.toMatchObject({ status: 409 });
});
