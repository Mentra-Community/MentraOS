import { TestDispatchModel } from "../models/test-dispatch.model";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { TestRunModel } from "../models/test-run.model";
import type { TestRunClaim, TestRunProgressCheckpoint } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import type { OverviewClaim, OverviewJob, OverviewRequest, TestRunOverview } from "../types/test-run-overview.types";
import { GithubTestRunOverview, type TestRunOverviewGateway } from "./test-run-overview.github";

export interface OverviewClaimRecord { claim: TestRunClaim; progress?: TestRunProgressCheckpoint }
export interface TestRunOverviewRepository {
  claims(): Promise<{ claims: OverviewClaimRecord[]; truncated: boolean }>;
  results(requestIds: string[]): Promise<TestRun[]>;
  adminRequests(requestRunIds: number[]): Promise<number[]>;
}
export class MongoTestRunOverviewRepository implements TestRunOverviewRepository {
  async claims() {
    const rows = await TestRunClaimModel.find({ "claim.state": { $ne: "terminal" } })
      .select({ _id: 0, claim: 1, progress: 1 }).sort({ createdAt: 1 }).limit(501).lean();
    return { claims: rows.slice(0, 500) as unknown as OverviewClaimRecord[], truncated: rows.length > 500 };
  }
  async results(requestIds: string[]) {
    if (!requestIds.length) return [];
    // Metadata only. The service returns explicit display fields, never notes, logs or asset paths.
    const rows = await TestRunModel.find({ requestId: { $in: requestIds } }).select({ "payload.runId": 1,
      "payload.requestId": 1, "payload.channel": 1, "payload.release": 1, "payload.provenance": 1,
      "payload.fixture": 1, "payload.outcomes": 1, "payload.platform": 1 }).limit(5001).lean();
    if (rows.length > 5000) throw new Error("Recovery metadata exceeds overview limit");
    return rows.map(row => row.payload as TestRun);
  }
  async adminRequests(requestRunIds: number[]) {
    if (!requestRunIds.length) return [];
    const rows = await TestDispatchModel.find({ "receipt.requestRunId": { $in: requestRunIds } })
      .select({ "receipt.requestRunId": 1 }).lean();
    return rows.map(row => (row.receipt as { requestRunId: number }).requestRunId);
  }
}
const project = (row: OverviewClaimRecord): OverviewClaim => ({ requestId: row.claim.requestId,
  workerId: row.claim.workerId, fixtureId: row.claim.fixtureId, claimedAt: row.claim.claimedAt,
  ...(row.progress ? { progress: row.progress } : {}) });
function correlated(run: TestRun, claim: TestRunClaim) {
  return run.requestId === claim.requestId && run.fixture.alias === claim.fixtureId
    && run.provenance.requestSha256 === claim.requestSha256 && run.provenance.executionMode === "ci-registered"
    && run.provenance.requestRelationship === "consumed";
}
function generation(run: TestRun) {
  const value = Number(run.provenance.resultGeneration);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
export function recoveredClaim(claim: TestRunClaim, results: TestRun[]) {
  const same = results.filter(run => correlated(run, claim)).sort((a, b) => generation(b) - generation(a));
  const latest = same[0];
  const original = latest?.provenance.originalRunId && same.find(run => run.runId === latest.provenance.originalRunId);
  if (claim.state !== "recovery-required" || !latest || !original || generation(latest) <= 1 || generation(original) !== 1
    || latest.runId === original.runId || latest.provenance.originalTerminalSnapshotSha256 !== original.provenance.terminalSnapshotSha256
    || !original.provenance.terminalSnapshotSha256 || latest.provenance.archiveSha256 !== original.provenance.archiveSha256
    || !original.provenance.archiveSha256 || latest.outcomes.fixture !== "ready" || latest.outcomes.teardown !== "passed"
    || latest.provenance.returnVerification !== "passed") return null;
  return { requestId: claim.requestId, originalRunId: original.runId, recoveryRunId: latest.runId, fixtureId: claim.fixtureId };
}
function requestFromClaim(claim: TestRunClaim, results: TestRun[]): OverviewRequest[] {
  const match = /^routine-([1-9]\d*)-([1-9]\d*)-(dev|staging|[1-9]\d*)-([a-z0-9-]+)$/.exec(claim.requestId);
  if (!match) return [];
  const source = match[3]!;
  if (![Number(match[1]), Number(match[2]), ...(source === "dev" || source === "staging" ? [] : [Number(source)])]
    .every(value => Number.isSafeInteger(value) && value > 0)) return [];
  const result = results.find(run => correlated(run, claim));
  return [{ requestId: claim.requestId, requestRunId: Number(match[1]), requestAttempt: Number(match[2]),
    routineId: match[4]!, channel: source === "dev" || source === "staging" ? source : "pr",
    // The origin is not encoded in a claim ID; omit an origin badge for this fallback.
    trigger: "unknown", ...(source !== "dev" && source !== "staging" ? { prNumber: Number(source) } : {}),
    ...(result ? { platform: result.platform === "ios-mac" ? "ios-on-mac" as const : result.platform } : {}),
    ...(result?.release || result?.provenance.releaseIdentity ? { release: result.release ?? result.provenance.releaseIdentity } : {}),
    ...(result?.provenance.headSha ? { headSha: result.provenance.headSha } : {}) }];
}

export class TestRunOverviewService {
  constructor(private readonly repository: TestRunOverviewRepository = new MongoTestRunOverviewRepository(),
    private readonly github: TestRunOverviewGateway = new GithubTestRunOverview(), private readonly now = () => new Date()) {}
  async overview(): Promise<TestRunOverview> {
    const [claimsResult, githubResult] = await Promise.allSettled([this.repository.claims(), this.github.activity()]);
    const warnings = githubResult.status === "fulfilled" ? [...githubResult.value.warnings] : ["GitHub activity is unavailable. The saved checkpoints below are not proof of a running job."];
    const claims = claimsResult.status === "fulfilled" ? claimsResult.value.claims : [];
    if (claimsResult.status === "rejected") warnings.push("Saved claims and progress could not be refreshed.");
    else if (claimsResult.value.truncated) warnings.push("Only the oldest 500 unsettled claims are shown.");
    let results: TestRun[] = [];
    try { results = await this.repository.results(claims.map(row => row.claim.requestId)); }
    catch { warnings.push("Recovery results could not be checked; saved recovery blockers are retained."); }
    const resolvedRecoveries = claims.flatMap(row => { const result = recoveredClaim(row.claim, results); return result ? [result] : []; });
    const resolved = new Set(resolvedRecoveries.map(value => value.requestId));
    const jobs = githubResult.status === "fulfilled" ? structuredClone(githubResult.value.jobs) : [];
    const assigned = new Set<string>();
    for (const job of jobs) {
      for (const row of claims) if (job.requests.some(request => request.requestId === row.claim.requestId)) {
        job.claims.push(project(row)); assigned.add(row.claim.requestId);
        if (row.claim.state === "recovery-required" && !resolved.has(row.claim.requestId)) {
          job.state = "blocked"; job.message = "Fixture recovery is required. GitHub activity does not clear this saved blocker.";
        }
      }
    }
    for (const row of claims) if (!assigned.has(row.claim.requestId) && !resolved.has(row.claim.requestId)) {
      const blocked = row.claim.state === "recovery-required";
      jobs.push({ id: "claim-" + row.claim.requestId, kind: "claim", state: blocked ? "blocked" : "unknown",
        title: blocked ? "Fixture recovery required" : "Unsettled routine claim", createdAt: row.claim.claimedAt,
        startedAt: row.claim.claimedAt, claims: [project(row)], requests: requestFromClaim(row.claim, results),
        message: blocked ? "The original claim requires verified recovery; its last checkpoint is retained."
          : "No matching active GitHub job was observed. This claim is not proof that the routine is still running." });
    }
    const requestIds = [...new Set(jobs.flatMap(job => job.requests.map(request => request.requestRunId)))];
    try {
      const admin = new Set(await this.repository.adminRequests(requestIds));
      for (const job of jobs) for (const request of job.requests) if (admin.has(request.requestRunId)) request.trigger = "admin";
    } catch { warnings.push("Admin-origin labels could not be checked; GitHub request origins remain visible."); }
    // Activity first; the waiting group is oldest-first, not a scheduling promise.
    const priority = (job: OverviewJob) => job.state === "running" ? 0 : ["blocked", "unknown"].includes(job.state) ? 1 : 2;
    jobs.sort((a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { observedAt: this.now().toISOString(), jobs, warnings, resolvedRecoveries,
      recentMaintenance: githubResult.status === "fulfilled" ? githubResult.value.recentMaintenance ?? [] : [] };
  }
}
