import { describe, expect, spyOn, test } from "bun:test";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import type { TestRunClaim } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import type { OverviewJob } from "../types/test-run-overview.types";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { TestRunModel } from "../models/test-run.model";
import { recoveredClaim, recordedFailure, MongoTestRunOverviewRepository, TestRunOverviewService, type FixtureIdentity, type OverviewClaimRecord,
  type TestRunOverviewRepository } from "./test-run-overview.service";
import type { StoredTestResourceObservation } from "./test-resource-observation.service";
import { TestResourceObservationModel } from "../models/test-resource-observation.model";
import { aliveObservation, noOwnerObservation, resourceProgress, retainedObservation } from "../types/test-resource-observation.examples";
import type { TestResourceObservation } from "../types/test-resource-observation.types";

const stamp = "2026-09-24T20:00:00.000Z";
const claim = (id = "routine-500-1-dev-day1-ota"): TestRunClaim => ({ requestId: id, requestSha256: "a".repeat(64),
  workerId: "mini-1", fixtureId: "glasses-03be", executionId: "execution-1", claimedAt: stamp, state: "recovery-required",
  settledAt: stamp, settlement: { state: "recovery-required", reason: "Private error must not be projected" } });
const original = (): TestRun => ({ runId: "original", requestId: claim().requestId, routineId: "day1-ota", routineVersion: "test",
  platform: "ios-mac", channel: "dev", startedAt: stamp, finishedAt: stamp, outcome: "failed",
  outcomes: { test: "failed", teardown: "failed", fixture: "unknown", evidence: "incomplete" },
  provenance: { repository: "Mentra-Community/MentraOS", requestSha256: claim().requestSha256, executionMode: "ci-registered",
    requestRelationship: "consumed", resultGeneration: "1", terminalSnapshotSha256: "b".repeat(64), archiveSha256: "c".repeat(64) },
  fixture: { alias: claim().fixtureId }, firmwareAssertions: [], chapters: [], assets: [] });
const recovery = (): TestRun => ({ ...original(), runId: "recovery-2", outcomes: { ...original().outcomes, teardown: "passed", fixture: "ready" },
  provenance: { ...original().provenance, resultGeneration: "2", originalRunId: "original",
    originalTerminalSnapshotSha256: original().provenance.terminalSnapshotSha256!, terminalSnapshotSha256: "d".repeat(64), returnVerification: "passed" } });
const queued = (): OverviewJob => ({ id: "github-1", kind: "routine", state: "queued", title: "Routine request", createdAt: stamp,
  requests: [{ requestId: claim().requestId, requestRunId: 500, requestAttempt: 1, channel: "dev", routineId: "day1-ota", trigger: "workflow-dispatch" }], claims: [],
  workflow: { runId: 1, url: "https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/1", status: "queued", updatedAt: stamp } });
class Repository implements TestRunOverviewRepository {
  rows: OverviewClaimRecord[] = [];
  resultRows: TestRun[] = [];
  admin: number[] = [];
  async claims(_activeRequestIds: string[] = []) { return { claims: this.rows, truncated: false }; }
  /** Claims `claims()` does not return, such as normal terminal passes. */
  stored: TestRunClaim[] = [];
  latestLookups: FixtureIdentity[][] = [];
  resultLookups: string[][] = [];
  async latestFixtureClaims(identities: FixtureIdentity[]) {
    this.latestLookups.push(identities);
    const all = [...this.rows.map(row => row.claim), ...this.stored];
    return identities.flatMap(({ workerId, fixtureId }) => all.filter(item => item.workerId === workerId && item.fixtureId === fixtureId)
      .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt)).slice(0, 1));
  }
  async results(requestIds: string[]) {
    this.resultLookups.push(requestIds);
    return this.resultRows.filter(run => requestIds.includes(run.requestId));
  }
  async adminRequests() { return this.admin; }
  observations: StoredTestResourceObservation[] = [];
  published: string[] = [];
  publishedLookups: string[][] = [];
  async resourceObservations(_limit: number) { return { rows: this.observations, truncated: false }; }
  async publishedRunIds(runIds: string[]) { this.publishedLookups.push(runIds); return runIds.filter(id => this.published.includes(id)); }
}
test("all GitHub triggers remain visible; only matched send receipts get Admin origin", async () => {
  const repository = new Repository(); repository.admin = [500];
  const jobs = [queued(), { ...queued(), id: "github-2", requests: [{ ...queued().requests[0]!, requestRunId: 501, trigger: "successful-build" as const }] },
    { ...queued(), id: "nightly", kind: "nightly" as const, requests: [{ ...queued().requests[0]!, requestRunId: 502, trigger: "nightly" as const }] },
    { ...queued(), id: "pr", requests: [{ ...queued().requests[0]!, requestRunId: 503, channel: "pr" as const, prNumber: 1, trigger: "pr-label" as const }] }];
  const service = new TestRunOverviewService(repository, { activity: async () => ({ jobs, warnings: [] }) });
  const response = await createTestRunAdminApi(undefined, service).request("/overview");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const value = await response.json() as { jobs: OverviewJob[] };
  expect(value.jobs.map((job: OverviewJob) => job.requests[0]!.trigger)).toEqual(["admin", "successful-build", "nightly", "pr-label"]);
  expect(jobs[0]!.requests[0]!.trigger).toBe("workflow-dispatch"); // Cached gateway value was not mutated.
});
test("partial GitHub failure retains claims with explicit unknown activity and no private reason", async () => {
  const repository = new Repository(); repository.rows = [{ claim: claim() }];
  const view = await new TestRunOverviewService(repository, { activity: async () => { throw Error("private credential"); } }).overview();
  expect(view.jobs[0]?.state).toBe("blocked");
  expect(view.jobs[0]?.requests[0]?.routineId).toBe("day1-ota");
  expect(view.warnings).toHaveLength(1);
  expect(JSON.stringify(view)).not.toContain("private credential");
  expect(JSON.stringify(view)).not.toContain("Private error");
});
test("saved blocker wins over a running job; phase-complete alone cannot resolve it", async () => {
  const repository = new Repository(); repository.rows = [{ claim: claim(), progress: {
    sequence: 8, receivedAt: stamp, phase: "evidence", mode: "complete", step: null, completedSteps: 1, totalSteps: 1 } }];
  const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [{ ...queued(), state: "running" }], warnings: [] }) }).overview();
  expect(view.jobs).toHaveLength(1); expect(view.jobs[0]?.state).toBe("blocked");
  expect(view.jobs[0]?.claims[0]?.progress?.sequence).toBe(8); expect(view.resolvedRecoveries).toHaveLength(0);
});
test("correlated recovery preserves original verdict but removes only its recovered blocker", async () => {
  const repository = new Repository(); repository.rows = [{ claim: claim() }]; repository.resultRows = [original(), recovery()];
  const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.jobs).toHaveLength(0);
  expect(view.resolvedRecoveries).toEqual([{ requestId: claim().requestId, originalRunId: "original", recoveryRunId: "recovery-2", fixtureId: claim().fixtureId, kind: "recovery", originalAvailable: true }]);
  expect(repository.rows[0]?.claim.state).toBe("recovery-required"); expect(repository.resultRows[0]?.outcome).toBe("failed");
});
test("unrelated result, missing original, wrong fixture/build/hash and newer failed recovery cannot clear a blocker", () => {
  for (const patch of [{ requestId: "unrelated" }, { fixture: { alias: "other" } },
    { provenance: { ...recovery().provenance, archiveSha256: "e".repeat(64) } },
    { provenance: { ...recovery().provenance, requestSha256: "e".repeat(64) } },
    { provenance: { ...recovery().provenance, returnVerification: "failed" } }])
    expect(recoveredClaim(claim(), [original(), { ...recovery(), ...patch }])).toBeNull();
  expect(recoveredClaim(claim(), [recovery()])).toBeNull();
  expect(recoveredClaim(claim(), [original(), recovery(), { ...recovery(), runId: "recovery-3", outcomes: original().outcomes,
    provenance: { ...recovery().provenance, resultGeneration: "3" } }])).toBeNull();
});
test("maintenance remains visible and queue is oldest-first display order without rank or ETA", async () => {
  const repository = new Repository();
  const maintenance = { ...queued(), id: "maintenance", kind: "maintenance" as const, state: "running" as const,
    createdAt: "2026-09-24T19:00:00.000Z", requests: [] };
  const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [queued(), maintenance], warnings: [] }) }).overview();
  expect(view.jobs.map(job => job.id)).toEqual(["maintenance", "github-1"]);
  expect(JSON.stringify(view)).not.toContain("rank"); expect(JSON.stringify(view)).not.toContain("eta");
});
test("new running work is above old unresolved claims, followed by oldest waiting requests", async () => {
  const repository = new Repository(); repository.rows = [{ claim: claim() }];
  const active = { ...queued(), id: "active", state: "running" as const, requests: [], createdAt: "2026-09-24T23:00:00.000Z" };
  const waiting = { ...queued(), requests: [], id: "waiting", createdAt: "2026-09-24T21:00:00.000Z" };
  const older = { ...waiting, id: "older", createdAt: "2026-09-24T19:00:00.000Z" };
  const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [waiting, older, active], warnings: [] }) }).overview();
  expect(view.jobs.map(job => job.id)).toEqual(["active", "claim-" + claim().requestId, "older", "waiting"]);
});
test("active request claims bypass the historical cap and retain a just-settled checkpoint", async () => {
  const unsafe = spyOn(TestRunModel, "aggregate").mockResolvedValue([]);
  const history = Array.from({ length: 501 }, (_, index) => ({ claim: claim("old-" + index) }));
  const active = { claim: { ...claim(), state: "terminal", settlement: { state: "terminal", resultRunId: "result" } },
    progress: { sequence: 4, mode: "complete", phase: "evidence", step: null, completedSteps: 1, totalSteps: 1, receivedAt: stamp } };
  const queries: unknown[] = [];
  const find = spyOn(TestRunClaimModel, "find").mockImplementation(((query: { requestId?: unknown }) => {
    queries.push(query);
    return { select: () => query.requestId
      ? { lean: async () => [active] } : { sort: () => ({ limit: (limit: number) => {
        expect(limit).toBe(501); return { lean: async () => history };
      } }) } };
  }) as unknown as typeof TestRunClaimModel.find);
  try {
    const repository = new MongoTestRunOverviewRepository();
    const result = await repository.claims([claim().requestId]);
    expect(result.truncated).toBe(true); expect(result.claims).toHaveLength(501);
    expect(result.claims.find(row => row.claim.requestId === claim().requestId)?.progress?.sequence).toBe(4);
    expect(queries[1]).toEqual({ requestId: { $in: [claim().requestId] } });
  } finally { find.mockRestore(); unsafe.mockRestore(); }
});
test("the overview requests exact active claims after reading the queue", async () => {
  const repository = new Repository();
  const lookup = spyOn(repository, "claims");
  await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [queued()], warnings: [] }) }).overview();
  expect(lookup.mock.calls[0]).toEqual([[claim().requestId]]);
});

test("a late original export closes abandoned follow-up without changing the test verdict or settlement", async () => {
  for (const testOutcome of ["passed", "failed", "not-run"] as const) {
    const repository = new Repository(); repository.rows = [{ claim: claim() }];
    repository.resultRows = [{ ...original(), runId: claim().requestId,
      outcomes: { ...original().outcomes, test: testOutcome, teardown: "passed", fixture: "ready" },
      provenance: { ...original().provenance, returnVerification: "passed" } }];
    const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
    expect(view.jobs).toHaveLength(0); expect(view.resolvedRecoveries[0]?.kind).toBe("late-result");
    expect(repository.resultRows[0]?.outcomes.test).toBe(testOutcome);
    expect(repository.rows[0]?.claim.state).toBe("recovery-required");
  }
});
test("bound recovery can establish return when the original upload is missing, and says so explicitly", () => {
  const run = { ...recovery(), runId: "recovery-" + "a".repeat(32) + "-5", provenance: {
    ...recovery().provenance, resultGeneration: "5", originalRunId: claim().requestId, recoveryHistorySha256: "e".repeat(64) } };
  expect(recoveredClaim(claim(), [run])).toMatchObject({ kind: "recovery", originalAvailable: false, recoveryRunId: run.runId });
  for (const provenance of [{ ...run.provenance, originalRunId: "other" },
    { ...run.provenance, originalTerminalSnapshotSha256: "" }, { ...run.provenance, recoveryHistorySha256: "" }])
    expect(recoveredClaim(claim(), [{ ...run, provenance }])).toBeNull();
  expect(recoveredClaim(claim(), [{ ...run, runId: "unrelated" }])).toBeNull();
});
test("a terminal export with unsafe return is actionable; progress completion is not physical recovery", async () => {
  const repository = new Repository();
  repository.rows = [{ claim: { ...claim(), state: "terminal", settledAt: stamp, settlement: { state: "terminal", resultRunId: "original" } } }];
  repository.resultRows = [{ ...original(), outcomes: { ...original().outcomes, fixture: "unavailable", teardown: "blocked" } }];
  let view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.jobs[0]).toMatchObject({ state: "blocked", resultRunId: "original", attention: {
    reason: "The recorded run left the fixture unavailable.", responsible: "Test runner / operator", cancelRequestId: claim().requestId } });
  repository.resultRows.push(recovery());
  view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.jobs).toHaveLength(0);
});
test("cancelled follow-up leaves only a separate physical-readiness item until bound evidence arrives", async () => {
  const repository = new Repository(); repository.rows = [{ claim: claim(), followUpCancellation: { cancelledAt: stamp, cancelledBy: "admin-1" } }];
  repository.resultRows = [original()];
  let view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.jobs).toHaveLength(0); expect(view.fixtureAttention).toHaveLength(1);
  expect(view.fixtureAttention?.[0]).toMatchObject({ kind: "fixture", resultRunId: "original", attention: { cancelledAt: stamp } });
  expect(view.fixtureAttention?.[0]?.attention?.cancelRequestId).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain("admin-1");
  repository.resultRows.push(recovery());
  view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.fixtureAttention).toHaveLength(0); expect(repository.rows[0]?.claim.state).toBe("recovery-required");
});
test("an original-owner closure leaves active/blocked work but keeps its failed history and unverified fixture", async () => {
  const closure = { kind: "android-refused-install-released" as const, originalTerminal: { sequence: 26, sha256: "b".repeat(64) },
    journalPrefix: { bytes: 4096, sha256: "c".repeat(64) }, release: { type: "setup-abandoned-after-refusal" as const, sequence: 27,
      eventSha256: "d".repeat(64), revision: "1".repeat(40), implementationSha256: "e".repeat(64) }, fixture: "uncommissioned" as const,
    selectedCandidateInstalled: false as const, candidateTestRun: false as const, recordingStarted: false as const, closedAt: stamp };
  const failed: TestRun = { ...original(), runId: claim().requestId, outcomes: { ...original().outcomes, test: "not-run", fixture: "unknown" } };
  for (const active of [false, true]) {
    const repository = new Repository(); repository.rows = [{ claim: claim(), closure }]; repository.resultRows = [failed];
    const view = await new TestRunOverviewService(repository, { activity: async () => ({
      jobs: active ? [{ ...queued(), state: "running" }] : [], warnings: [] }) }).overview();
    expect(view.jobs.filter(job => job.state === "blocked")).toHaveLength(0);
    expect(view.resolvedRecoveries).toHaveLength(0);
    if (active) { expect(view.jobs[0]?.attention).toBeUndefined(); continue; }
    expect(view.jobs).toHaveLength(0);
    expect(view.fixtureAttention).toEqual([expect.objectContaining({ kind: "fixture", state: "finished", title: "Closed without a test",
      resultRunId: claim().requestId, attention: expect.objectContaining({ closedAt: stamp }) })]);
    expect(view.fixtureAttention?.[0]?.attention?.cancelRequestId).toBeUndefined();
    expect(view.fixtureAttention?.[0]?.attention?.nextAction).toContain("not a pass");
    expect(view.fixtureSummary).toEqual([expect.objectContaining({ fixtureId: claim().fixtureId, status: "unverified" })]);
    expect(repository.rows[0]?.claim.settlement).toEqual(claim().settlement);
    expect(repository.resultRows[0]?.outcome).toBe("failed");
    expect(JSON.stringify(view)).not.toContain("Private error");
  }
  // Without the closure the same claim is still an active blocker.
  const open = new Repository(); open.rows = [{ claim: claim() }]; open.resultRows = [failed];
  expect((await new TestRunOverviewService(open, { activity: async () => ({ jobs: [], warnings: [] }) }).overview()).jobs[0]?.state).toBe("blocked");
});
test("a released preflight closure is closed failed history with an uncommissioned fixture, not active, blocked, passed or ready", async () => {
  const closure = { kind: "preflight-abandoned-released" as const, originalTerminal: { sequence: 20, sha256: "b".repeat(64) },
    journalPrefix: { bytes: 4096, sha256: "c".repeat(64) }, release: { type: "preflight-abandoned" as const, sequence: 21,
      eventSha256: "d".repeat(64), revision: "3".repeat(40), implementationSha256: "e".repeat(64) }, operations: 0 as const,
    fixture: "uncommissioned" as const, selectedCandidateInstalled: false as const, candidateTestRun: false as const,
    recordingStarted: false as const, closedAt: stamp };
  const failed: TestRun = { ...original(), runId: claim().requestId, outcomes: { ...original().outcomes, test: "not-run", fixture: "unknown" } };
  const repository = new Repository(); repository.rows = [{ claim: claim(), closure }]; repository.resultRows = [failed];
  const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.jobs).toHaveLength(0);
  expect(view.resolvedRecoveries).toHaveLength(0);
  expect(view.fixtureAttention).toEqual([expect.objectContaining({ kind: "fixture", state: "finished", title: "Closed without a test",
    resultRunId: claim().requestId, attention: expect.objectContaining({ closedAt: stamp }) })]);
  const attention = view.fixtureAttention?.[0]?.attention;
  expect(attention?.reason).toContain("Preflight failed before setup");
  expect(attention?.reason).not.toContain("Android");
  expect(attention?.nextAction).toContain("uncommissioned"); expect(attention?.nextAction).toContain("not a pass");
  expect(attention?.cancelRequestId).toBeUndefined();
  expect(view.fixtureSummary).toEqual([expect.objectContaining({ fixtureId: claim().fixtureId, status: "unverified" })]);
  expect(repository.rows[0]?.claim.settlement).toEqual(claim().settlement);
  expect(repository.resultRows[0]?.outcome).toBe("failed");
});
test("another request on the same fixture and duplicate generation cannot certify this claim", () => {
  const readyRun = { ...original(), runId: claim().requestId, outcomes: recovery().outcomes,
    provenance: { ...original().provenance, returnVerification: "passed" } };
  expect(recoveredClaim(claim(), [{ ...readyRun, requestId: "other" }])).toBeNull();
  expect(recoveredClaim(claim(), [readyRun, { ...readyRun, runId: "duplicate-generation" }])).toBeNull();
});
test("the query includes terminal claims with unsafe metadata, not just active and unsettled claims", async () => {
  const unsafe = spyOn(TestRunModel, "aggregate").mockResolvedValue([{ _id: "terminal-unsafe" }]);
  const queries: unknown[] = [], selections: unknown[] = [];
  const find = spyOn(TestRunClaimModel, "find").mockImplementation(((query: unknown) => {
    queries.push(query);
    const chain = { select: (value: unknown) => { selections.push(value); return chain; }, sort: () => chain, limit: () => chain, lean: async () => [] }; return chain;
  }) as unknown as typeof TestRunClaimModel.find);
  try {
    await new MongoTestRunOverviewRepository().claims(["active"]);
    expect(queries[1]).toEqual({ requestId: { $in: ["active", "terminal-unsafe"] } });
    expect(selections).toEqual([{ _id: 0, claim: 1, progress: 1, followUpCancellation: 1, closure: 1 }, { _id: 0, claim: 1, progress: 1, followUpCancellation: 1, closure: 1 }]);
    expect(unsafe.mock.calls[0]?.[0]?.[0]).toMatchObject({ $match: { "payload.provenance.executionMode": "ci-registered" } });
  } finally { find.mockRestore(); unsafe.mockRestore(); }
});
test("a result lookup outage cannot make an unsafe terminal candidate disappear", async () => {
  const repository = new Repository(); repository.rows = [{ claim: { ...claim(), state: "terminal", settledAt: stamp,
    settlement: { state: "terminal", resultRunId: "original" } } }];
  repository.results = async () => { throw Error("Private DB context"); };
  const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
  expect(view.jobs).toHaveLength(1); expect(view.jobs[0]?.state).toBe("unknown");
  expect(view.warnings.join(" ")).toContain("could not be checked"); expect(JSON.stringify(view)).not.toContain("Private DB context");
});
test("terminal and cancelled claims retain their blocker when ready recovery lineage is rejected", async () => {
  const badBinding = { ...recovery(), provenance: { ...recovery().provenance, originalTerminalSnapshotSha256: "f".repeat(64) } };
  for (const cancelled of [false, true]) for (const state of ["terminal", "recovery-required"] as const) {
    const repository = new Repository(); repository.rows = [{ claim: { ...claim(), state, settledAt: stamp,
      settlement: state === "terminal" ? { state: "terminal", resultRunId: "original" } : claim().settlement! },
      ...(cancelled ? { followUpCancellation: { cancelledAt: stamp, cancelledBy: "admin" } } : {}) }];
    repository.resultRows = [original(), badBinding];
    const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [], warnings: [] }) }).overview();
    const rows = cancelled ? view.fixtureAttention! : view.jobs;
    expect(rows).toHaveLength(1); expect(rows[0]?.state).toBe("blocked"); expect(view.resolvedRecoveries).toHaveLength(0);
    expect(rows[0]?.attention?.reason).toContain("could not be verified against this request's result history");
    expect(rows[0]?.attention?.reason).not.toContain("return verification did not pass");
    expect(rows[0]?.attention?.nextAction).toContain("Check the result's request and recovery links");
  }
});
test("both duplicate-generation orders block terminal/cancelled claims and active jobs identically", async () => {
  const unsafeDuplicate = { ...recovery(), runId: "unsafe-recovery-2", outcomes: original().outcomes };
  for (const ordered of [[recovery(), unsafeDuplicate], [unsafeDuplicate, recovery()]])
    for (const location of ["inactive", "cancelled", "active"] as const) {
      const repository = new Repository(); repository.rows = [{ claim: { ...claim(), state: "terminal", settledAt: stamp,
        settlement: { state: "terminal", resultRunId: "original" } },
        ...(location === "cancelled" ? { followUpCancellation: { cancelledAt: stamp, cancelledBy: "admin" } } : {}) }];
      repository.resultRows = [original(), ...ordered];
      const view = await new TestRunOverviewService(repository, { activity: async () => ({
        jobs: location === "active" ? [{ ...queued(), state: "running" }] : [], warnings: [] }) }).overview();
      const rows = location === "cancelled" ? view.fixtureAttention! : view.jobs;
      expect(rows).toHaveLength(1); expect(rows[0]?.state).toBe("blocked"); expect(view.resolvedRecoveries).toHaveLength(0);
      expect(rows[0]?.attention?.reason).toContain("Conflicting results");
    }
});
test("Cancel is not offered when unrelated GitHub request metadata is incomplete", async () => {
  for (const missing of [{ ...queued(), requests: [] }, { ...queued(), kind: "nightly" as const }]) {
    const repository = new Repository(); repository.rows = [{ claim: claim("routine-999-1-dev-day1-ota") }];
    const view = await new TestRunOverviewService(repository, { activity: async () => ({ jobs: [missing], warnings: [] }) }).overview();
    const row = view.jobs.find(job => job.kind === "claim")!;
    expect(row.attention?.cancelRequestId).toBeUndefined(); expect(row.attention?.responsible).toBe("Test runner / operator");
  }
});

describe("fixture summaries follow the newest claim on each exact worker and fixture", () => {
  const at = (minute: number) => new Date(Date.parse(stamp) + minute * 60_000).toISOString();
  const id = (minute: number, routine: string) => "routine-" + (36_076_273_000 + minute) + "-1-dev-" + routine;
  const identityOf = (minute: number, fixtureId: string, workerId: string, routine: string) => ({ requestId: id(minute, routine),
    requestSha256: "a".repeat(64), workerId, fixtureId, executionId: "execution-" + minute, claimedAt: at(minute) });
  const settled = (minute: number, fixtureId: string, workerId = "mini-1", routine = "no-glasses"): TestRunClaim => ({
    ...identityOf(minute, fixtureId, workerId, routine), state: "terminal", settledAt: at(minute + 1),
    settlement: { state: "terminal", resultRunId: id(minute, routine) } });
  const active = (minute: number, fixtureId: string, workerId = "mini-1"): TestRunClaim => ({
    ...identityOf(minute, fixtureId, workerId, "no-glasses"), state: "claimed" });
  const cancelled = (minute: number, fixtureId: string, workerId = "mini-1"): OverviewClaimRecord => ({
    claim: { ...claim(id(minute, "ui-unpaired")), workerId, fixtureId, claimedAt: at(minute) },
    followUpCancellation: { cancelledAt: at(minute + 1), cancelledBy: "admin" } });
  const result = (item: TestRunClaim, outcomes: TestRun["outcomes"], returnVerification: string): TestRun => ({ ...original(),
    runId: item.requestId, requestId: item.requestId, fixture: { alias: item.fixtureId }, outcome: outcomes.test === "passed" && outcomes.fixture === "ready" ? "passed" : "failed",
    outcomes, provenance: { ...original().provenance, returnVerification } });
  const pass = (item: TestRunClaim) => result(item, { test: "passed", teardown: "passed", fixture: "ready", evidence: "complete" }, "passed");
  const unsafe = (item: TestRunClaim) => result(item, { test: "failed", teardown: "blocked", fixture: "unavailable", evidence: "complete" }, "deferred");
  const failedCancelled = (row: OverviewClaimRecord) => ({ ...original(), runId: "original-" + row.claim.requestId,
    requestId: row.claim.requestId, fixture: { alias: row.claim.fixtureId } });
  const scenario = () => {
    const repository = new Repository();
    // mini-ui-unpaired on mini-1 mirrors dev.358 and dev.362: ordinary passes after cancelled attempts.
    const unpaired = [0, 1, 2].map(minute => cancelled(minute, "mini-ui-unpaired"));
    const dev358 = settled(10, "mini-ui-unpaired"), dev362 = settled(12, "mini-ui-unpaired");
    // A newer failure after a pass is the latest evidence; the older pass is not presented as readiness.
    const glasses = cancelled(3, "glasses-03be"), glassesPass = settled(11, "glasses-03be"), glassesFailure = settled(13, "glasses-03be");
    // The same alias on another worker is a different fixture.
    const otherWorker = cancelled(4, "mini-ui-unpaired", "mini-2");
    // An active newer claim after a pass owns the fixture.
    const phone = cancelled(5, "android-phone"), phonePass = settled(14, "android-phone"), phoneActive = active(15, "android-phone");
    // A settled newer claim without a published result proves nothing.
    const tablet = cancelled(6, "tablet"), tabletMissing = settled(16, "tablet");
    // Only claims() rows are loaded by the base overview: unsettled, unsafe-result and active.
    repository.rows = [...unpaired, glasses, otherWorker, phone, tablet, { claim: glassesFailure }, { claim: phoneActive }];
    repository.stored = [dev358, dev362, glassesPass, phonePass, tabletMissing];
    repository.resultRows = [...[...unpaired, glasses, otherWorker, phone, tablet].map(failedCancelled),
      pass(dev358), pass(dev362), pass(glassesPass), unsafe(glassesFailure), pass(phonePass)];
    return { repository, unpaired, dev358, dev362, glassesPass, glassesFailure, otherWorker, phoneActive, tabletMissing };
  };
  const idle = { activity: async () => ({ jobs: [], warnings: [] }) };
  const summary = (view: Awaited<ReturnType<TestRunOverviewService["overview"]>>, workerId: string, fixtureId: string) =>
    view.fixtureSummary.find(item => item.workerId === workerId && item.fixtureId === fixtureId);

  test("ordinary terminal passes after historical cancellations are the latest known return; history is unchanged", async () => {
    const { repository, unpaired, dev358, dev362 } = scenario();
    const view = await new TestRunOverviewService(repository, idle).overview();
    expect(summary(view, "mini-1", "mini-ui-unpaired")).toEqual({ workerId: "mini-1", fixtureId: "mini-ui-unpaired",
      status: "latest-return-verified", latestCancelledClaimAt: at(2), cancelledRequestIds: [...unpaired].reverse().map(row => row.claim.requestId),
      latest: { requestId: dev362.requestId, claimedAt: dev362.claimedAt, reason: "Verified return evidence is published.", resultRunId: dev362.requestId } });
    // One bounded lookup per identity, then results only for newest claims the overview had not loaded.
    expect(repository.latestLookups).toHaveLength(1); expect(repository.latestLookups[0]).toHaveLength(5);
    expect(repository.resultLookups[1]).toEqual(expect.arrayContaining([dev362.requestId]));
    expect(repository.resultLookups[1]).not.toContain(dev358.requestId);
    // Every cancelled attempt and its original failed result stay in history; passes are not recovery resolutions.
    expect(view.fixtureAttention?.map(job => job.claims[0]!.requestId)).toEqual(expect.arrayContaining(unpaired.map(row => row.claim.requestId)));
    expect(view.fixtureAttention?.every(job => job.state === "blocked" && job.attention?.cancelledAt && job.resultRunId?.startsWith("original-"))).toBe(true);
    expect(view.fixtureAttention).toHaveLength(7); expect(view.resolvedRecoveries).toHaveLength(0);
    expect(repository.rows.filter(row => row.followUpCancellation).every(row => row.claim.state === "recovery-required")).toBe(true);
    expect(repository.resultRows.filter(run => run.runId.startsWith("original-")).every(run => run.outcome === "failed")).toBe(true);
  });
  test("a newer unsafe result after a success keeps the fixture unverified and remains a live blocker", async () => {
    const { repository, glassesFailure } = scenario();
    const view = await new TestRunOverviewService(repository, idle).overview();
    expect(summary(view, "mini-1", "glasses-03be")).toMatchObject({ status: "unverified", latest: { requestId: glassesFailure.requestId,
      reason: "The recorded run left the fixture unavailable.", resultRunId: glassesFailure.requestId } });
    expect(view.jobs.find(job => job.id === "claim-" + glassesFailure.requestId)?.state).toBe("blocked");
  });
  test("separate workers, active latest claims and missing results are never replaced by another return", async () => {
    const { repository, phoneActive, tabletMissing } = scenario();
    let view = await new TestRunOverviewService(repository, idle).overview();
    expect(summary(view, "mini-2", "mini-ui-unpaired")).toEqual(expect.objectContaining({ status: "unverified" }));
    expect(summary(view, "mini-2", "mini-ui-unpaired")?.latest).toBeUndefined();
    expect(summary(view, "mini-1", "android-phone")).toMatchObject({ status: "current-work", latest: { requestId: phoneActive.requestId } });
    expect(summary(view, "mini-1", "tablet")).toMatchObject({ status: "unverified", latest: { requestId: tabletMissing.requestId,
      reason: "No published result proves the fixture's return state." } });
    expect(view.fixtureSummary.map(item => item.status)).toEqual(["current-work", "unverified", "unverified", "unverified", "latest-return-verified"]);
    // A settled pass that is still inside a live GitHub job is current work, not readiness.
    const { repository: again, dev362 } = scenario();
    const running = { ...queued(), state: "running" as const, requests: [{ ...queued().requests[0]!, requestId: dev362.requestId }] };
    again.rows.push({ claim: dev362 });
    view = await new TestRunOverviewService(again, { activity: async () => ({ jobs: [running], warnings: [] }) }).overview();
    expect(summary(view, "mini-1", "mini-ui-unpaired")).toMatchObject({ status: "current-work", latest: { requestId: dev362.requestId } });
  });
  test("claim or result lookup failures are not-checked and never fall back to an older return", async () => {
    const statuses = (view: Awaited<ReturnType<TestRunOverviewService["overview"]>>) => new Set(view.fixtureSummary.map(item => item.status));
    let { repository } = scenario();
    repository.latestFixtureClaims = async () => { throw Error("Private DB context"); };
    let view = await new TestRunOverviewService(repository, idle).overview();
    expect(statuses(view)).toEqual(new Set(["not-checked"])); expect(view.fixtureSummary.every(item => !item.latest)).toBe(true);
    expect(view.warnings.join(" ")).toContain("Newer claims on fixtures with cancelled attempts could not be checked.");
    expect(JSON.stringify(view)).not.toContain("Private DB context");
    ({ repository } = scenario());
    const loadedOnly = repository.results.bind(repository);
    repository.results = async ids => { if (repository.resultLookups.length) throw Error("offline"); return loadedOnly(ids); };
    view = await new TestRunOverviewService(repository, idle).overview();
    expect(summary(view, "mini-1", "mini-ui-unpaired")?.status).toBe("not-checked");
    expect(summary(view, "mini-1", "android-phone")?.status).toBe("current-work");
    expect(statuses(view).has("latest-return-verified")).toBe(false);
    ({ repository } = scenario());
    repository.results = async () => { throw Error("offline"); };
    view = await new TestRunOverviewService(repository, idle).overview();
    // Only mini-2 is unverified: its newest claim is its own cancelled attempt.
    expect(statuses(view)).toEqual(new Set(["current-work", "not-checked", "unverified"]));
    expect(view.fixtureSummary.filter(item => item.status === "unverified").map(item => item.workerId)).toEqual(["mini-2"]);
  });
  const observed = (hostId: string, observation: TestResourceObservation, extra: Partial<StoredTestResourceObservation> = {}): StoredTestResourceObservation =>
    ({ hostId, resourceKey: "shared", revision: 3, receivedAt: at(30), observation, requestSha256: "e".repeat(64), ...extra });
  test("a newer local retained hold is a separate feed: CI return evidence is unchanged and aliases never correlate hosts", async () => {
    const { repository, dev362 } = scenario();
    const discovery = "discovery-46e1b113-108e-4769-8678-3bd2b8d10777";
    repository.observations = [
      // The same fixture alias (03BE) on two hosts, plus an independent Android phone on the first host.
      observed("mini-1", retainedObservation(discovery), { progress: { ...resourceProgress(discovery, 12), mode: "complete", receivedAt: at(29) } }),
      observed("mini-2", noOwnerObservation(dev362.requestId)),
      observed("mini-1", aliveObservation("phone-run"), { resourceKey: "android-0123456789ab" }),
    ];
    repository.published = [dev362.requestId];
    const baseline = await new TestRunOverviewService(scenario().repository, idle).overview();
    const view = await new TestRunOverviewService(repository, idle).overview();
    // Jobs, CI return evidence and history are identical with or without local observations.
    expect(view.jobs).toEqual(baseline.jobs); expect(view.fixtureSummary).toEqual(baseline.fixtureSummary);
    expect(view.fixtureAttention).toEqual(baseline.fixtureAttention); expect(view.resolvedRecoveries).toEqual(baseline.resolvedRecoveries);
    expect(summary(view, "mini-1", "mini-ui-unpaired")?.status).toBe("latest-return-verified");
    expect(baseline.resourceObservations).toEqual({ available: true, truncated: false, items: [] });
    const items = view.resourceObservations!.items;
    expect(items.map(item => [item.hostId, item.resourceKey, item.observation.state])).toEqual([
      ["mini-1", "android-0123456789ab", "busy"], ["mini-1", "shared", "retained-recovery-required"], ["mini-2", "shared", "available-to-attempt"]]);
    // A dead PID and a complete checkpoint are reported as-is; nothing converts them into a release.
    expect(items[1]).toMatchObject({ receivedAt: at(30), progress: { mode: "complete", sequence: 12 },
      observation: { owner: { liveness: "dead", retainOnExit: true }, lastCheckpoint: { pendingOperation: { stepID: "stop-recording" } } } });
    // Only exact reported run IDs are looked up; an unpublished run stays text.
    expect(repository.publishedLookups).toEqual([expect.arrayContaining([discovery, dev362.requestId, "phone-run"])]);
    expect(items.map(item => item.publishedRunIds)).toEqual([[], [], [dev362.requestId]]);
    expect(JSON.stringify(view.resourceObservations)).not.toContain("requestSha256");
  });
  test("resource observation outages are explicit and never hide CI evidence or invent links", async () => {
    let { repository } = scenario();
    repository.resourceObservations = async () => { throw Error("Private DB context"); };
    let view = await new TestRunOverviewService(repository, idle).overview();
    expect(view.resourceObservations).toEqual({ available: false, truncated: false, items: [] });
    expect(view.warnings.join(" ")).toContain("Local resource observations could not be loaded");
    expect(summary(view, "mini-1", "mini-ui-unpaired")?.status).toBe("latest-return-verified");
    expect(JSON.stringify(view)).not.toContain("Private DB context");
    ({ repository } = scenario());
    repository.observations = [observed("mini-1", retainedObservation("run-a")),
      observed("mini-2", { ...noOwnerObservation(), reason: "operator free text" } as unknown as TestResourceObservation)];
    repository.publishedRunIds = async () => { throw Error("offline"); };
    repository.resourceObservations = async () => ({ rows: repository.observations, truncated: true });
    view = await new TestRunOverviewService(repository, idle).overview();
    expect(view.resourceObservations?.items.map(item => [item.hostId, item.publishedRunIds])).toEqual([["mini-1", []]]);
    expect(view.resourceObservations?.truncated).toBe(true);
    expect(view.warnings.join(" ")).toContain("their run IDs are shown as text");
    expect(view.warnings.join(" ")).toContain("unreadable and are not shown");
    expect(view.warnings.join(" ")).toContain("More local resource observations exist than shown");
  });
  test("the Mongo reader keeps owned observations beyond the recency bound and checks exact published run IDs", async () => {
    const row = (hostId: string, observation: TestResourceObservation) =>
      ({ hostId, resourceKey: "shared", revision: 1, receivedAt: new Date(at(1)), observation, requestSha256: "e".repeat(64) });
    const owned = [row("held", retainedObservation("run-a"))], recent = [row("idle-1", noOwnerObservation()), row("idle-2", noOwnerObservation()), row("idle-3", noOwnerObservation())];
    const limits: number[] = [];
    const query = (rows: unknown[]) => { const chain = { select: () => chain, sort: () => chain,
      limit: (value: number) => { limits.push(value); return chain; }, lean: async () => rows }; return chain; };
    const find = spyOn(TestResourceObservationModel, "find").mockImplementation(((filter: Record<string, unknown>) =>
      query(filter["observation.owner"] ? owned : recent)) as unknown as typeof TestResourceObservationModel.find);
    const runs = spyOn(TestRunModel, "find").mockImplementation((() => query([{ runId: "run-a" }])) as unknown as typeof TestRunModel.find);
    try {
      const mongo = new MongoTestRunOverviewRepository();
      const loaded = await mongo.resourceObservations(2);
      expect(limits).toEqual([3, 3]); expect(loaded.truncated).toBe(true);
      expect(loaded.rows.map(item => item.hostId)).toEqual(["held", "idle-1", "idle-2"]);
      expect(loaded.rows[0]!.receivedAt).toBe(at(1));
      expect((find.mock.calls as unknown[][]).map(call => call[0])).toEqual([{ "observation.owner": { $exists: true } }, {}]);
      expect(await mongo.publishedRunIds(["run-a", "run-b"])).toEqual(["run-a"]);
      expect((runs.mock.calls as unknown[][])[0]?.[0]).toEqual({ runId: { $in: ["run-a", "run-b"] } });
      expect(await mongo.publishedRunIds([])).toEqual([]); expect(runs).toHaveBeenCalledTimes(1);
    } finally { find.mockRestore(); runs.mockRestore(); }
  });
  test("identities beyond the bound are not-checked; the Mongo query matches exact worker and fixture pairs", async () => {
    const repository = new Repository();
    repository.rows = Array.from({ length: 101 }, (_, index) => cancelled(index, "fixture-" + index));
    const view = await new TestRunOverviewService(repository, idle).overview();
    expect(repository.latestLookups[0]).toHaveLength(100);
    expect(view.fixtureSummary.filter(item => item.status === "not-checked")).toHaveLength(1);
    expect(view.warnings.join(" ")).toContain("Only 100 fixtures");
    const aggregate = spyOn(TestRunClaimModel, "aggregate").mockResolvedValue([{ claim: settled(1, "a") }]);
    try {
      const mongo = new MongoTestRunOverviewRepository();
      expect(await mongo.latestFixtureClaims([{ workerId: "mini-1", fixtureId: "a" }, { workerId: "mini-2", fixtureId: "a" }])).toEqual([settled(1, "a")]);
      expect(aggregate.mock.calls[0]?.[0]?.[0]).toEqual({ $match: { $or: [{ "claim.workerId": "mini-1", "claim.fixtureId": "a" },
        { "claim.workerId": "mini-2", "claim.fixtureId": "a" }] } });
      await expect(mongo.latestFixtureClaims(Array.from({ length: 101 }, (_, index) => ({ workerId: "w", fixtureId: "f" + index }))))
        .rejects.toThrow("exceeds");
      expect(aggregate).toHaveBeenCalledTimes(1);
    } finally { aggregate.mockRestore(); }
  });
});

describe("recorded failure detail is bounded history from the latest uniquely correlated result", () => {
  type Failure = NonNullable<TestRun["failures"]>[number];
  const lifecycleOnly = [{ kind: "failure-details" as const, reason: "Only lifecycle verdicts and IDs were exported." }];
  const failure = (phase: Failure["phase"], id: string, label: string, message: string, extra: Partial<Failure> = {}): Failure => ({
    phase, step: { id, label }, code: phase + "-failed", message, assetIds: [], incidentIds: [], redactionPolicy: "lifecycle-allowlist-v1",
    missingEvidence: lifecycleOnly, ...extra });
  const unavailable = { test: "failed", teardown: "failed", fixture: "unavailable", evidence: "incomplete" } as const;
  // Shape of the beta397 export: lifecycle IDs only, no chapters. The local cause is deliberately absent.
  const beta397 = (): TestRun => ({ ...original(), outcomes: unavailable, notes: "Private note: app was signed out at /Users/private/run",
    failures: [failure("setup", "recording-start", "Start recording", "Phase failed.", { stack: "Error: private stack at /Users/private/worker.ts" }),
      failure("teardown", "restore-unpaired-home", "Restore unpaired Home", "Phase failed."),
      failure("return-verification", "return-unpaired-home", "Verify unpaired Home", "Assertion failed."),
      failure("evidence", "recording-integrity", "Check recording integrity", "Phase failed.")] });
  // Shape of the Day1 export: a generic lifecycle failure with its authored failed chapter in the same phase.
  const chapter = (id: string, phase: TestRun["chapters"][number]["phase"], status: TestRun["chapters"][number]["status"], instruction: string,
    expected?: string): TestRun["chapters"][number] => ({ id, phase, status, instruction, ...(expected ? { expected } : {}),
    videoAssetId: "private-video", videoStart: 1, videoEnd: 2, screenshotAssetId: "private-screenshot" });
  const day1 = (): TestRun => ({ ...original(), outcomes: unavailable,
    failures: [{ ...failure("test", "customer-sequence", "Customer sequence", "Phase failed."), missingEvidence: [] }],
    chapters: [chapter("SETUP-01", "setup", "failed", "Unrelated setup chapter"),
      chapter("OTA-02", "test", "passed", "Open the device page"),
      chapter("OTA-03", "test", "failed", "Confirm the January device ID, ASG27 build and IP match", "Device ID, build 27 and IP match"),
      chapter("OTA-04", "test", "blocked", "Later blocked chapter"), chapter("TD-01", "teardown", "failed", "Unrelated teardown chapter")] });
  const view = async (repository: Repository, jobs: OverviewJob[] = []) =>
    new TestRunOverviewService(repository, { activity: async () => ({ jobs, warnings: [] }) }).overview();
  const blocker = (runs: TestRun[], extra: Partial<OverviewClaimRecord> = {}) => {
    const repository = new Repository(); repository.rows = [{ claim: claim(), ...extra }]; repository.resultRows = runs; return repository;
  };

  test("beta397: known phase/step and an explicit unpublished cause; the current recovery reason stays separate", async () => {
    const result = await view(blocker([beta397()]));
    const attention = result.jobs[0]?.attention;
    expect(attention?.reason).toBe("The recorded run left the fixture unavailable.");
    expect(attention?.responsible).toBe("Test runner / operator");
    expect(attention?.recordedFailure).toEqual({ resultRunId: "original",
      failure: { phase: "setup", step: { id: "recording-start", label: "Start recording" }, message: "Phase failed." }, detailUnpublished: true });
    const json = JSON.stringify(result);
    for (const forbidden of ["signed out", "/Users/", "private stack", "Private note", "lifecycle-allowlist", "Only lifecycle verdicts", "restore-unpaired-home"])
      expect(json).not.toContain(forbidden);
  });
  test("Day1: the failed chapter in the same phase supplies the authored action and expectation, nothing more", async () => {
    const recorded = (await view(blocker([day1()]))).jobs[0]?.attention?.recordedFailure;
    expect(recorded).toEqual({ resultRunId: "original",
      failure: { phase: "test", step: { id: "customer-sequence", label: "Customer sequence" }, message: "Phase failed." },
      chapter: { id: "OTA-03", status: "failed", instruction: "Confirm the January device ID, ASG27 build and IP match", expected: "Device ID, build 27 and IP match" },
      detailUnpublished: false });
    // A chapter whose instruction repeats the step label still carries its own ID, status and expectation.
    expect(recordedFailure({ ...day1(), failures: [{ ...failure("test", "identity", "Confirm device identity", "Phase failed."), missingEvidence: [] }],
      chapters: [chapter("OTA-03", "test", "failed", "Confirm device identity", "Device ID, build 27 and IP match")] })?.chapter)
      .toEqual({ id: "OTA-03", status: "failed", instruction: "Confirm device identity", expected: "Device ID, build 27 and IP match" });
    // A blocked chapter is used only without a failed one; other phases are never borrowed.
    const blockedOnly = day1(); blockedOnly.chapters = blockedOnly.chapters.filter(item => item.id !== "OTA-03");
    expect(recordedFailure(blockedOnly)?.chapter).toMatchObject({ id: "OTA-04", status: "blocked" });
    const unrelated = day1(); unrelated.chapters = unrelated.chapters.filter(item => item.phase !== "test");
    expect(recordedFailure(unrelated)?.chapter).toBeUndefined();
    expect(recordedFailure({ ...day1(), failures: [failure("final-assertions", "final", "Final checks", "Phase failed.")],
      chapters: [chapter("VERIFY-01", "verify", "failed", "Unmapped verify chapter")] })?.chapter).toBeUndefined();
  });
  test("the newest recovery generation is shown, never the stale original failure or an ambiguous generation", async () => {
    const failedRecovery = (): TestRun => ({ ...recovery(), outcomes: unavailable,
      provenance: { ...recovery().provenance, returnVerification: "failed" },
      failures: [{ ...failure("return-verification", "return-home", "Verify Home", "Assertion failed."), missingEvidence: [] }] });
    let recorded = (await view(blocker([day1(), failedRecovery()]))).jobs[0]?.attention?.recordedFailure;
    expect(recorded).toMatchObject({ resultRunId: "recovery-2", failure: { phase: "return-verification", step: { id: "return-home" } } });
    expect(recorded?.chapter).toBeUndefined();
    const { failures: _none, ...withoutFailures } = failedRecovery();
    recorded = (await view(blocker([day1(), withoutFailures]))).jobs[0]?.attention?.recordedFailure;
    expect(recorded).toEqual({ resultRunId: "recovery-2", failure: null, detailUnpublished: true });
    const duplicate = await view(blocker([day1(), failedRecovery(), { ...failedRecovery(), runId: "recovery-2b" }]));
    expect(duplicate.jobs[0]?.attention?.reason).toContain("Conflicting results");
    expect(duplicate.jobs[0]?.attention?.recordedFailure).toBeUndefined();
    // A verified recovery resolves the blocker; no recorded failure is carried forward.
    expect((await view(blocker([day1(), recovery()]))).jobs).toHaveLength(0);
  });
  test("another request or fixture never supplies this claim's detail; cancelled history and closures carry none", async () => {
    const leak = (patch: Partial<TestRun>): TestRun => ({ ...day1(), runId: "leak-" + Object.keys(patch)[0], ...patch,
      failures: [failure("test", "leaked-step", "Leaked step", "Leaked message.")] });
    let result = await view(blocker([leak({ requestId: "routine-501-1-dev-day1-ota" }), leak({ fixture: { alias: "other-fixture" } }),
      leak({ provenance: { ...original().provenance, requestSha256: "e".repeat(64) } })]));
    expect(result.jobs[0]?.attention?.reason).toBe("No published result proves the fixture's return state.");
    expect(JSON.stringify(result)).not.toContain("Leaked");
    result = await view(blocker([beta397()], { followUpCancellation: { cancelledAt: stamp, cancelledBy: "admin-1" } }));
    expect(result.fixtureAttention?.[0]?.attention?.recordedFailure).toBeUndefined();
    // An active GitHub job blocked by this claim shows the same recorded detail.
    result = await view(blocker([day1()]), [{ ...queued(), state: "running" }]);
    expect(result.jobs[0]).toMatchObject({ state: "blocked", attention: { recordedFailure: { chapter: { id: "OTA-03" } } } });
  });
  test("prompt-like recorded text is not turned into a user action; responsibility and next action are unchanged", async () => {
    const prompt = { ...beta397(), failures: [{ ...failure("test", "login", "Log in", "Enter the password, then grant location permission and tap Allow."),
      expected: "User is signed in", missingEvidence: [] }] };
    const attention = (await view(blocker([prompt]))).jobs[0]?.attention;
    expect(attention?.responsible).toBe("Test runner / operator");
    expect(attention?.nextAction).toBe("Complete recovery for this request and publish its verified return evidence.");
    expect(Object.keys(attention?.recordedFailure ?? {}).sort()).toEqual(["detailUnpublished", "failure", "resultRunId"]);
    expect(Object.keys(attention?.recordedFailure?.failure ?? {}).sort()).toEqual(["expected", "message", "phase", "step"]);
  });
  test("output text is bounded in code points and marks truncation", () => {
    const long = "é".repeat(1999) + "😀";
    const recorded = recordedFailure({ ...day1(), failures: [{ ...failure("test", "s".repeat(160), long, long), expected: long, missingEvidence: [] }],
      chapters: [chapter("OTA-03", "test", "failed", long, long)] })!;
    for (const value of [recorded.failure!.message, recorded.failure!.expected!, recorded.chapter!.instruction, recorded.chapter!.expected!]) {
      expect(Array.from(value)).toHaveLength(240); expect(value.endsWith("…")).toBe(true);
    }
    expect(Array.from(recorded.failure!.step!.label)).toHaveLength(160); expect(recorded.failure!.step!.id).toBe("s".repeat(160));
    expect(recordedFailure({ ...day1(), outcome: "passed", failures: undefined })).toBeUndefined();
  });
  test("the Mongo projection bounds failure and chapter data before loading and excludes private fields", async () => {
    const pipelines: unknown[][] = [];
    const aggregate = spyOn(TestRunModel, "aggregate").mockImplementation(((pipeline: unknown[]) => {
      pipelines.push(pipeline); return Promise.resolve([{ payload: day1() }]);
    }) as unknown as typeof TestRunModel.aggregate);
    try {
      const repository = new MongoTestRunOverviewRepository();
      expect(await repository.results([])).toEqual([]); expect(aggregate).not.toHaveBeenCalled();
      expect((await repository.results([claim().requestId]))[0]?.runId).toBe("original");
      const [match, limit, project] = pipelines[0] as [unknown, unknown, { $project: { _id: number; payload: Record<string, unknown> } }];
      expect(match).toEqual({ $match: { requestId: { $in: [claim().requestId] } } }); expect(limit).toEqual({ $limit: 5001 });
      expect(Object.keys(project.$project.payload).sort()).toEqual(["channel", "chapters", "failures", "fixture", "outcome", "outcomes",
        "platform", "provenance", "release", "requestId", "runId"]);
      const text = JSON.stringify(project);
      for (const forbidden of ["stack", "notes", "assets", "assetIds", "incidentIds", "redactionPolicy", "reason", "videoAssetId",
        "screenshotAssetId", "videoStart", "firmwareAssertions", "code"]) expect(text).not.toContain('"' + forbidden);
      expect(text).not.toContain("$$m.reason"); expect(text).not.toContain("$$f.code");
      // One failure; at most one failed and one blocked chapter in that failure's phase; text clipped in the database.
      expect(text).toContain('{"$slice":[{"$ifNull":["$payload.failures",[]]},1]}');
      expect(text.match(/"\$slice":\[\{"\$filter":\{"input":\{"\$ifNull":\["\$payload\.chapters",\[\]\]\}/g)).toHaveLength(2);
      expect(text).toContain('{"$substrCP":["$$f.message",0,241]}'); expect(text).toContain('{"$substrCP":["$$c.instruction",0,241]}');
      expect(text).toContain('{"$substrCP":["$$f.step.label",0,161]}');
      aggregate.mockImplementation((() => Promise.resolve(Array.from({ length: 5001 }, () => ({ payload: day1() })))) as unknown as typeof TestRunModel.aggregate);
      await expect(repository.results([claim().requestId])).rejects.toThrow("exceeds overview limit");
    } finally { aggregate.mockRestore(); }
  });
});
