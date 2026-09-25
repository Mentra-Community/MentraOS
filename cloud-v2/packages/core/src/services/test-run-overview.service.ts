import { TestDispatchModel } from "../models/test-dispatch.model";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { TestRunModel } from "../models/test-run.model";
import type { TestRunClaim, TestRunProgressCheckpoint } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import type { OverviewClaim, OverviewJob, OverviewRequest, OverviewResolution, TestRunFollowUpCancellation, TestRunOverview } from "../types/test-run-overview.types";
import { completeGithubActivity, GithubTestRunOverview, type TestRunOverviewGateway } from "./test-run-overview.github";

export interface OverviewClaimRecord { claim: TestRunClaim; progress?: TestRunProgressCheckpoint; followUpCancellation?: TestRunFollowUpCancellation }
export interface TestRunOverviewRepository {
  claims(activeRequestIds: string[]): Promise<{ claims: OverviewClaimRecord[]; truncated: boolean }>;
  results(requestIds: string[]): Promise<TestRun[]>;
  adminRequests(requestRunIds: number[]): Promise<number[]>;
}
export class MongoTestRunOverviewRepository implements TestRunOverviewRepository {
  async claims(activeRequestIds: string[]) {
    // Older workers settled valid exports as terminal even when physical return
    // failed. Include those requests, then check their latest correlated result.
    const unsafe = await TestRunModel.aggregate<{ _id: string }>([
      { $match: { "payload.provenance.executionMode": "ci-registered", "payload.provenance.requestRelationship": "consumed",
        $or: [{ "payload.outcomes.fixture": { $ne: "ready" } }, { "payload.outcomes.teardown": { $ne: "passed" } },
          { "payload.provenance.returnVerification": { $ne: "passed" } }] } },
      { $group: { _id: "$requestId", latest: { $max: "$startedAt" } } },
      { $sort: { latest: -1, _id: 1 } }, { $limit: 501 },
    ]);
    const included = [...new Set([...activeRequestIds, ...unsafe.slice(0, 500).map(row => row._id)])];
    const [rows, active] = await Promise.all([
      TestRunClaimModel.find({ "claim.state": { $ne: "terminal" } })
        .select({ _id: 0, claim: 1, progress: 1, followUpCancellation: 1 }).sort({ createdAt: 1 }).limit(501).lean(),
      included.length ? TestRunClaimModel.find({ requestId: { $in: included } })
        .select({ _id: 0, claim: 1, progress: 1, followUpCancellation: 1 }).lean() : Promise.resolve([]),
    ]);
    // Active claims (including a just-settled checkpoint) are never displaced by
    // old immutable recovery settlements that still occupy historical storage.
    const claims = new Map<string, OverviewClaimRecord>();
    for (const row of [...rows.slice(0, 500), ...active] as unknown as OverviewClaimRecord[]) claims.set(row.claim.requestId, row);
    return { claims: [...claims.values()], truncated: rows.length > 500 || unsafe.length > 500 };
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
function sameResults(claim: TestRunClaim, results: TestRun[]) {
  return results.filter(run => correlated(run, claim)).sort((a, b) => generation(b) - generation(a) || a.runId.localeCompare(b.runId));
}
const digest = (value?: string) => /^[a-f0-9]{64}$/.test(value ?? "");
const ready = (run: TestRun) => run.outcomes.fixture === "ready" && run.outcomes.teardown === "passed"
  && run.provenance.returnVerification === "passed";
export function recoveredClaim(claim: TestRunClaim, results: TestRun[]): OverviewResolution | null {
  const same = sameResults(claim, results);
  const latest = same[0];
  if (!latest || !ready(latest) || !digest(latest.provenance.terminalSnapshotSha256)
    || !digest(latest.provenance.archiveSha256) || generation(latest) === 0
    || same.some(run => run.runId !== latest.runId && generation(run) === generation(latest))) return null;
  // A failed upload can be completed later without creating another lifecycle
  // generation. Its verified return closes follow-up; its test verdict is unchanged.
  if (generation(latest) === 1) return latest.runId === claim.requestId ? {
    requestId: claim.requestId, originalRunId: latest.runId, recoveryRunId: latest.runId,
    fixtureId: claim.fixtureId, kind: "late-result", originalAvailable: true,
  } : null;
  const original = latest?.provenance.originalRunId && same.find(run => run.runId === latest.provenance.originalRunId);
  if (!digest(latest.provenance.originalTerminalSnapshotSha256)) return null;
  if (original) {
    if (generation(original) !== 1 || latest.runId === original.runId
      || latest.provenance.originalTerminalSnapshotSha256 !== original.provenance.terminalSnapshotSha256
      || latest.provenance.archiveSha256 !== original.provenance.archiveSha256) return null;
  } else {
    // The trusted recovery exporter binds the original request and frozen terminal
    // snapshot even if the original upload never reached Core. Do not fabricate it.
    if (latest.provenance.originalRunId !== claim.requestId
      || !new RegExp("^recovery-[a-f0-9]{32}-" + generation(latest) + "$").test(latest.runId)
      || !digest(latest.provenance.recoveryHistorySha256)) return null;
  }
  return { requestId: claim.requestId, originalRunId: latest.provenance.originalRunId!, recoveryRunId: latest.runId,
    fixtureId: claim.fixtureId, kind: "recovery", originalAvailable: Boolean(original) };
}
/** One evidence decision controls reconciliation, active blocking and inactive visibility. */
function classifyEvidence(claim: TestRunClaim, results: TestRun[], available: boolean) {
  const same = sameResults(claim, results), latest = same[0];
  const resolution = recoveredClaim(claim, results);
  if (resolution) return { resolution, latest, needsAttention: false, blocked: false, reason: "Verified return evidence is published.", nextAction: "No recovery follow-up needed." };
  const ambiguous = latest && same.some(run => run.runId !== latest.runId && generation(run) === generation(latest));
  const reason = !available ? "Published return evidence could not be checked."
    : ambiguous ? "Conflicting results report the same generation; physical return is unverified."
    : latest && ready(latest) ? "The reported ready state could not be verified against this request's result history."
    : latest ? latest.outcomes.fixture === "unavailable" ? "The recorded run left the fixture unavailable."
      : latest.outcomes.teardown !== "passed" ? "Cleanup did not pass; physical return is unverified."
      : "The recorded return verification did not pass."
    : "No published result proves the fixture's return state.";
  const nextAction = !available ? "Refresh the evidence lookup before deciding whether recovery is needed."
    : ambiguous || latest && ready(latest) ? "Check the result's request and recovery links, then publish verified return evidence."
    : latest ? "Complete recovery for this request and publish its verified return evidence."
    : "Locate and publish this request's retained result or complete its verified recovery.";
  return { resolution: null, latest, reason, nextAction, needsAttention: Boolean(latest) || !available || claim.state !== "terminal",
    blocked: Boolean(latest) || claim.state === "recovery-required" };
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
    const [githubResult] = await Promise.allSettled([this.github.activity()]);
    const activeRequests = githubResult!.status === "fulfilled"
      ? [...new Set(githubResult.value.jobs.flatMap(job => job.requests.map(request => request.requestId)))] : [];
    const [claimsResult] = await Promise.allSettled([this.repository.claims(activeRequests)]);
    const warnings = githubResult.status === "fulfilled" ? [...githubResult.value.warnings] : ["GitHub activity is unavailable. The saved checkpoints below are not proof of a running job."];
    const claims = claimsResult.status === "fulfilled" ? claimsResult.value.claims : [];
    if (claimsResult.status === "rejected") warnings.push("Saved claims and progress could not be refreshed.");
    else if (claimsResult.value.truncated) warnings.push("Claim history exceeds the view limit; the oldest 500 unsettled and latest 500 unsafe-result requests are checked, plus active jobs.");
    let results: TestRun[] = [];
    let resultsAvailable = true;
    try { results = await this.repository.results(claims.map(row => row.claim.requestId)); }
    catch { resultsAvailable = false; warnings.push("Recovery results could not be checked; saved recovery blockers are retained."); }
    const evidence = new Map(claims.map(row => [row.claim.requestId, classifyEvidence(row.claim, results, resultsAvailable)]));
    const resolvedRecoveries = [...evidence.values()].flatMap(value => value.resolution ? [value.resolution] : []);
    const canCancel = githubResult.status === "fulfilled" && completeGithubActivity(githubResult.value);
    const jobs = githubResult.status === "fulfilled" ? structuredClone(githubResult.value.jobs) : [];
    const fixtureAttention: OverviewJob[] = [];
    const assigned = new Set<string>();
    for (const job of jobs) {
      for (const row of claims) if (job.requests.some(request => request.requestId === row.claim.requestId)) {
        job.claims.push(project(row)); assigned.add(row.claim.requestId);
        const state = evidence.get(row.claim.requestId)!;
        if (state.needsAttention && state.blocked) {
          job.state = "blocked";
          job.attention = attention(row, state, false);
          if (state.latest) job.resultRunId = state.latest.runId;
        }
      }
    }
    for (const row of claims) if (!assigned.has(row.claim.requestId)) {
      const state = evidence.get(row.claim.requestId)!;
      if (!state.needsAttention) continue;
      const blocked = state.blocked;
      const cancelled = row.followUpCancellation;
      const job: OverviewJob = { id: "claim-" + row.claim.requestId, kind: cancelled ? "fixture" : "claim", state: blocked ? "blocked" : "unknown",
        title: blocked ? "Fixture recovery required" : "Unsettled routine claim", createdAt: row.claim.claimedAt,
        startedAt: row.claim.claimedAt, claims: [project(row)], requests: requestFromClaim(row.claim, results),
        attention: attention(row, state, canCancel),
        ...(state.latest ? { resultRunId: state.latest.runId } : {}) };
      (cancelled ? fixtureAttention : jobs).push(job);
    }
    for (const job of jobs) if (["queued", "waiting"].includes(job.state) && !job.attention) job.attention = {
      reason: "GitHub has not started this job; runner availability has not been verified.",
      responsible: "GitHub / runner operator", nextAction: "Check the GitHub job's required labels and the runner's status.",
    };
    const requestIds = [...new Set(jobs.flatMap(job => job.requests.map(request => request.requestRunId)))];
    try {
      const admin = new Set(await this.repository.adminRequests(requestIds));
      for (const job of jobs) for (const request of job.requests) if (admin.has(request.requestRunId)) request.trigger = "admin";
    } catch { warnings.push("Admin-origin labels could not be checked; GitHub request origins remain visible."); }
    // Activity first; the waiting group is oldest-first, not a scheduling promise.
    const priority = (job: OverviewJob) => job.state === "running" ? 0 : ["blocked", "unknown"].includes(job.state) ? 1 : 2;
    jobs.sort((a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { observedAt: this.now().toISOString(), jobs, warnings, resolvedRecoveries, fixtureAttention,
      recentMaintenance: githubResult.status === "fulfilled" ? githubResult.value.recentMaintenance ?? [] : [] };
  }
}

function attention(row: OverviewClaimRecord, state: ReturnType<typeof classifyEvidence>, canCancel: boolean): NonNullable<OverviewJob["attention"]> {
  const cancellation = row.followUpCancellation;
  return { reason: state.reason, responsible: "Test runner / operator",
    nextAction: state.nextAction,
    ...(cancellation ? { cancelledAt: cancellation.cancelledAt }
      : canCancel ? { cancelRequestId: row.claim.requestId } : {}),
  };
}
