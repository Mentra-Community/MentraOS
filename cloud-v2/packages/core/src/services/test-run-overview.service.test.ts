import { expect, spyOn, test } from "bun:test";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import type { TestRunClaim } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import type { OverviewJob } from "../types/test-run-overview.types";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { TestRunModel } from "../models/test-run.model";
import { recoveredClaim, MongoTestRunOverviewRepository, TestRunOverviewService, type OverviewClaimRecord, type TestRunOverviewRepository } from "./test-run-overview.service";

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
  async results() { return this.resultRows; }
  async adminRequests() { return this.admin; }
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
test("another request on the same fixture and duplicate generation cannot certify this claim", () => {
  const readyRun = { ...original(), runId: claim().requestId, outcomes: recovery().outcomes,
    provenance: { ...original().provenance, returnVerification: "passed" } };
  expect(recoveredClaim(claim(), [{ ...readyRun, requestId: "other" }])).toBeNull();
  expect(recoveredClaim(claim(), [readyRun, { ...readyRun, runId: "duplicate-generation" }])).toBeNull();
});
test("the query includes terminal claims with unsafe metadata, not just active and unsettled claims", async () => {
  const unsafe = spyOn(TestRunModel, "aggregate").mockResolvedValue([{ _id: "terminal-unsafe" }]);
  const queries: unknown[] = [];
  const find = spyOn(TestRunClaimModel, "find").mockImplementation(((query: unknown) => {
    queries.push(query);
    const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: async () => [] }; return chain;
  }) as unknown as typeof TestRunClaimModel.find);
  try {
    await new MongoTestRunOverviewRepository().claims(["active"]);
    expect(queries[1]).toEqual({ requestId: { $in: ["active", "terminal-unsafe"] } });
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
