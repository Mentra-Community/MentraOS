import { expect, test } from "bun:test";
import { createTestRunAdminApi } from "../api/admin/test-runs.api";
import type { TestRunClaim } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import type { OverviewJob } from "../types/test-run-overview.types";
import { recoveredClaim, TestRunOverviewService, type OverviewClaimRecord, type TestRunOverviewRepository } from "./test-run-overview.service";

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
  async claims() { return { claims: this.rows, truncated: false }; }
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
  expect(view.resolvedRecoveries).toEqual([{ requestId: claim().requestId, originalRunId: "original", recoveryRunId: "recovery-2", fixtureId: claim().fixtureId }]);
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
