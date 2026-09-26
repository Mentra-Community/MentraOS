import { TestDispatchModel } from "../models/test-dispatch.model";
import { TestRunClaimModel } from "../models/test-run-claim.model";
import { TestRunModel } from "../models/test-run.model";
import type { TestRunClaim, TestRunClaimClosureRecord, TestRunProgressCheckpoint } from "../types/test-run-claim.types";
import type { TestRun } from "../types/test-run.types";
import type { OverviewClaim, OverviewFixtureSummary, OverviewJob, OverviewRecordedFailure, OverviewRequest, OverviewResolution, TestRunFollowUpCancellation, TestRunOverview } from "../types/test-run-overview.types";
import { completeGithubActivity, GithubTestRunOverview, type TestRunOverviewGateway } from "./test-run-overview.github";

export interface OverviewClaimRecord {
  claim: TestRunClaim; progress?: TestRunProgressCheckpoint; followUpCancellation?: TestRunFollowUpCancellation;
  /** The original owner's closure: resolved history, never a pass or a ready fixture. */
  closure?: TestRunClaimClosureRecord;
}
export interface FixtureIdentity { workerId: string; fixtureId: string }
/** Fixture summaries check at most this many worker/fixture identities per overview. */
export const FIXTURE_SUMMARY_LIMIT = 100;
/** Display bounds for recorded failure text, in code points. */
const RECORDED_TEXT = 240, RECORDED_LABEL = 160;
export interface TestRunOverviewRepository {
  claims(activeRequestIds: string[]): Promise<{ claims: OverviewClaimRecord[]; truncated: boolean }>;
  /** The newest stored claim, in any state, for each exact worker + fixture identity. */
  latestFixtureClaims(identities: FixtureIdentity[]): Promise<TestRunClaim[]>;
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
        .select({ _id: 0, claim: 1, progress: 1, followUpCancellation: 1, closure: 1 }).sort({ createdAt: 1 }).limit(501).lean(),
      included.length ? TestRunClaimModel.find({ requestId: { $in: included } })
        .select({ _id: 0, claim: 1, progress: 1, followUpCancellation: 1, closure: 1 }).lean() : Promise.resolve([]),
    ]);
    // Active claims (including a just-settled checkpoint) are never displaced by
    // old immutable recovery settlements that still occupy historical storage.
    const claims = new Map<string, OverviewClaimRecord>();
    for (const row of [...rows.slice(0, 500), ...active] as unknown as OverviewClaimRecord[]) claims.set(row.claim.requestId, row);
    return { claims: [...claims.values()], truncated: rows.length > 500 || unsafe.length > 500 };
  }
  async latestFixtureClaims(identities: FixtureIdentity[]) {
    if (!identities.length) return [];
    if (identities.length > FIXTURE_SUMMARY_LIMIT) throw new Error("Fixture summary exceeds overview limit");
    // Claims include normal terminal passes, which `claims()` deliberately omits.
    // claimedAt is always written with toISOString(), so string order is time order.
    const rows = await TestRunClaimModel.aggregate<{ claim: TestRunClaim }>([
      { $match: { $or: identities.map(({ workerId, fixtureId }) => ({ "claim.workerId": workerId, "claim.fixtureId": fixtureId })) } },
      { $sort: { "claim.claimedAt": -1, requestId: 1 } },
      { $group: { _id: { workerId: "$claim.workerId", fixtureId: "$claim.fixtureId" }, claim: { $first: "$claim" } } },
      { $project: { _id: 0, claim: 1 } },
    ]);
    return rows.map(row => row.claim);
  }
  async results(requestIds: string[]) {
    if (!requestIds.length) return [];
    // Metadata only. The service returns explicit display fields, never notes, logs or asset paths.
    // Failure detail is bounded here: the first failure and at most two same-phase chapter
    // candidates, clipped text, and no stacks, reasons, asset or incident references.
    const clip = (path: string, max: number) => ({ $cond: [{ $eq: [{ $type: path }, "string"] }, { $substrCP: [path, 0, max + 1] }, "$$REMOVE"] });
    const phase = { $arrayElemAt: [{ $ifNull: ["$payload.failures.phase", []] }, 0] };
    const firstChapter = (status: "failed" | "blocked") => ({ $slice: [{ $filter: { input: { $ifNull: ["$payload.chapters", []] }, as: "c",
      cond: { $and: [{ $eq: ["$$c.status", status] }, { $eq: ["$$c.phase", phase] }] } } }, 1] });
    const rows = await TestRunModel.aggregate<{ payload: TestRun }>([
      { $match: { requestId: { $in: requestIds } } }, { $limit: 5001 },
      { $project: { _id: 0, payload: { runId: 1, requestId: 1, channel: 1, release: 1, provenance: 1, fixture: 1, outcomes: 1, platform: 1, outcome: 1,
        failures: { $map: { input: { $slice: [{ $ifNull: ["$payload.failures", []] }, 1] }, as: "f", in: {
          phase: "$$f.phase", message: clip("$$f.message", RECORDED_TEXT), expected: clip("$$f.expected", RECORDED_TEXT),
          step: { $cond: [{ $eq: [{ $type: "$$f.step" }, "object"] },
            { id: clip("$$f.step.id", RECORDED_LABEL), label: clip("$$f.step.label", RECORDED_LABEL) }, null] },
          missingEvidence: { $map: { input: { $slice: [{ $filter: { input: { $ifNull: ["$$f.missingEvidence", []] }, as: "m",
            cond: { $eq: ["$$m.kind", "failure-details"] } } }, 1] }, as: "m", in: { kind: "$$m.kind" } } },
        } } },
        chapters: { $map: { input: { $concatArrays: [firstChapter("failed"), firstChapter("blocked")] }, as: "c", in: {
          id: clip("$$c.id", RECORDED_LABEL), phase: "$$c.phase", status: "$$c.status",
          instruction: clip("$$c.instruction", RECORDED_TEXT), expected: clip("$$c.expected", RECORDED_TEXT) } } },
      } } },
    ]);
    if (rows.length > 5000) throw new Error("Recovery metadata exceeds overview limit");
    return rows.map(row => row.payload);
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
const clipText = (value: string, max: number) => {
  const points = Array.from(value);
  return points.length > max ? points.slice(0, max - 1).join("") + "…" : value;
};
/** Failure phases whose authored chapters use the same phase name. */
const chapterPhases = new Set<string>(["setup", "test", "teardown"]);
/**
 * The first failure one result lists, plus the first failed (else blocked) authored
 * chapter in that exact phase. Only reviewed fields are read; nothing is inferred
 * about who must act or which comparison failed.
 */
export function recordedFailure(run: Pick<TestRun, "runId" | "outcome" | "failures" | "chapters">): OverviewRecordedFailure | undefined {
  if (run.outcome === "passed") return undefined;
  const failure = run.failures?.[0];
  if (!failure) return { resultRunId: run.runId, failure: null, detailUnpublished: true };
  const step = failure.step ? { id: clipText(failure.step.id, RECORDED_LABEL), label: clipText(failure.step.label, RECORDED_LABEL) } : undefined;
  const candidates = chapterPhases.has(failure.phase) ? (run.chapters ?? []).filter(chapter => chapter.phase === failure.phase) : [];
  const chapter = candidates.find(item => item.status === "failed") ?? candidates.find(item => item.status === "blocked");
  const instruction = chapter && clipText(chapter.instruction, RECORDED_TEXT);
  return { resultRunId: run.runId,
    failure: { phase: failure.phase, ...(step ? { step } : {}), message: clipText(failure.message, RECORDED_TEXT),
      ...(failure.expected ? { expected: clipText(failure.expected, RECORDED_TEXT) } : {}) },
    // A chapter that only repeats the step label adds no action.
    ...(chapter && instruction !== step?.label ? { chapter: { id: clipText(chapter.id, RECORDED_LABEL), status: chapter.status as "failed" | "blocked",
      instruction: instruction!, ...(chapter.expected ? { expected: clipText(chapter.expected, RECORDED_TEXT) } : {}) } } : {}),
    detailUnpublished: (failure.missingEvidence ?? []).some(item => item.kind === "failure-details") };
}
/** One evidence decision controls reconciliation, active blocking and inactive visibility. */
function classifyEvidence(claim: TestRunClaim, results: TestRun[], available: boolean) {
  const same = sameResults(claim, results), latest = same[0];
  const resolution = recoveredClaim(claim, results);
  if (resolution) return { resolution, latest, recorded: undefined, needsAttention: false, blocked: false, reason: "Verified return evidence is published.", nextAction: "No recovery follow-up needed." };
  const ambiguous = latest && same.some(run => run.runId !== latest.runId && generation(run) === generation(latest));
  // Only the newest generation, and only when no other result claims that generation.
  const recorded = latest && !ambiguous ? recordedFailure(latest) : undefined;
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
  return { resolution: null, latest, recorded, reason, nextAction, needsAttention: Boolean(latest) || !available || claim.state !== "terminal",
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
        if (state.needsAttention && state.blocked && !row.closure) {
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
      // A closure resolves the request; like a cancellation, it moves to fixture history.
      const cancelled = row.followUpCancellation || row.closure;
      const job: OverviewJob = { id: "claim-" + row.claim.requestId, kind: cancelled ? "fixture" : "claim",
        state: row.closure ? "finished" : blocked ? "blocked" : "unknown",
        title: row.closure ? "Closed without a test" : blocked ? "Fixture recovery required" : "Unsettled routine claim", createdAt: row.claim.claimedAt,
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
    // `assigned` holds claims inside GitHub jobs; claim-only blocker rows report their own result instead.
    const fixtureSummary = await this.summarizeFixtures(fixtureAttention, assigned,
      resultsAvailable ? { results, requestIds: new Set(claims.map(row => row.claim.requestId)) } : null, warnings);
    return { observedAt: this.now().toISOString(), jobs, warnings, resolvedRecoveries, fixtureAttention, fixtureSummary,
      recentMaintenance: githubResult.status === "fulfilled" ? githubResult.value.recentMaintenance ?? [] : [] };
  }

  /**
   * Groups cancelled attempts by exact worker + fixture and decides each group only
   * from the newest stored claim on that identity and that claim's own results. A
   * matching alias on another worker, an older return, or a lookup that failed never
   * establishes the fixture's state. Nothing here writes claims, results or verdicts.
   */
  private async summarizeFixtures(history: OverviewJob[], live: Set<string>,
    loaded: { results: TestRun[]; requestIds: Set<string> } | null, warnings: string[]): Promise<OverviewFixtureSummary[]> {
    const groups = new Map<string, OverviewClaim[]>();
    for (const claim of history.flatMap(job => job.claims)) groups.set(identity(claim), [...groups.get(identity(claim)) ?? [], claim]);
    if (!groups.size) return [];
    const checked = [...groups.values()].slice(0, FIXTURE_SUMMARY_LIMIT).map(attempts => attempts[0]!);
    if (groups.size > FIXTURE_SUMMARY_LIMIT) warnings.push(`Only ${FIXTURE_SUMMARY_LIMIT} fixtures with cancelled attempts are checked for newer claims.`);
    let latest: Map<string, TestRunClaim> | null = null, results: TestRun[] = [], resultsChecked = false;
    try {
      latest = new Map((await this.repository.latestFixtureClaims(checked.map(({ workerId, fixtureId }) => ({ workerId, fixtureId }))))
        .map(claim => [identity(claim), claim]));
      const missing = [...latest.values()].map(claim => claim.requestId).filter(id => !loaded?.requestIds.has(id));
      if (loaded) { results = [...loaded.results, ...await this.repository.results(missing)]; resultsChecked = true; }
    } catch {
      // Reported per fixture as not-checked; an older return is never substituted.
      warnings.push("Newer claims on fixtures with cancelled attempts could not be checked.");
    }
    const checkedKeys = new Set(checked.map(identity));
    const order = { "current-work": 0, "not-checked": 1, unverified: 2, "latest-return-verified": 3 } as const;
    return [...groups.values()].map((attempts): OverviewFixtureSummary => {
      attempts.sort(newestFirst);
      const { workerId, fixtureId, claimedAt } = attempts[0]!;
      const base = { workerId, fixtureId, cancelledRequestIds: attempts.map(claim => claim.requestId), latestCancelledClaimAt: claimedAt };
      if (!checkedKeys.has(identity(attempts[0]!)) || !latest) return { ...base, status: "not-checked" };
      const newest = latest.get(identity(attempts[0]!));
      // The newest claim is one of these cancelled attempts (or the lookup saw nothing newer).
      if (!newest || attempts.some(claim => claim.requestId === newest.requestId) || Date.parse(newest.claimedAt) <= Date.parse(claimedAt))
        return { ...base, status: "unverified" };
      const recorded = { requestId: newest.requestId, claimedAt: newest.claimedAt };
      if (newest.state === "claimed" || live.has(newest.requestId))
        return { ...base, status: "current-work", latest: { ...recorded, reason: "This newer claim still owns the fixture; follow it in Live activity." } };
      if (!resultsChecked) return { ...base, status: "not-checked", latest: { ...recorded, reason: "Published return evidence could not be checked." } };
      const state = classifyEvidence(newest, results, true);
      const resultRunId = state.resolution?.recoveryRunId ?? state.latest?.runId;
      return { ...base, status: state.resolution ? "latest-return-verified" : "unverified",
        latest: { ...recorded, reason: state.reason, ...(resultRunId ? { resultRunId } : {}) } };
    }).sort((a, b) => order[a.status] - order[b.status] || newestFirst({ claimedAt: a.latestCancelledClaimAt }, { claimedAt: b.latestCancelledClaimAt })
      || a.workerId.localeCompare(b.workerId) || a.fixtureId.localeCompare(b.fixtureId));
  }
}

/** Why the original owner could close the claim; never a pass or a ready fixture. */
const closureReason: Record<TestRunClaimClosureRecord["kind"], string> = {
  "android-refused-install-released": "Android refused the selected app update. The original worker released the phone without installing it, testing or recording.",
  "preflight-abandoned-released": "Preflight failed before setup. The original worker released the fixture without installing the selected build, testing or recording.",
};
function attention(row: OverviewClaimRecord, state: ReturnType<typeof classifyEvidence>, canCancel: boolean): NonNullable<OverviewJob["attention"]> {
  if (row.closure) return { reason: closureReason[row.closure.kind] ?? "The original worker closed this request without a test.",
    responsible: "Test runner / operator", closedAt: row.closure.closedAt,
    nextAction: "Commission this fixture before another request. It was left uncommissioned; the failed result is unchanged and is not a pass." };
  const cancellation = row.followUpCancellation;
  const recorded = state.recorded;
  return { reason: state.reason, responsible: "Test runner / operator",
    nextAction: state.nextAction,
    ...(cancellation ? { cancelledAt: cancellation.cancelledAt }
      : canCancel ? { cancelRequestId: row.claim.requestId } : {}),
    // Live rows only; resolved history keeps its result link. Responsibility is unchanged.
    ...(!cancellation && recorded ? { recordedFailure: recorded } : {}),
  };
}

const identity = (claim: { workerId: string; fixtureId: string }) => JSON.stringify([claim.workerId, claim.fixtureId]);
const newestFirst = (a: { claimedAt: string }, b: { claimedAt: string }) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt);
