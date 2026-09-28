import { ReportModel } from "../models/report.model";
import { TestRunModel } from "../models/test-run.model";
import type { FixFlow, FixFlowList } from "../types/fix-flow.types";
import type { TestFailureOccurrence } from "../types/test-failure.types";
import type { TestRun } from "../types/test-run.types";
import { testFailureEnvironment } from "./test-failure-auth";
import { HttpFixActivityReader, type FixActivity, type FixActivityReader } from "./fix-flow-activity";
import { MongoTestRunRepository, TestRunError, type StoredTestRun } from "./test-run.service";

export interface FixFlowRepository {
  recent(): Promise<StoredTestRun[]>;
  failure(id: string): Promise<StoredTestRun | null>;
  run(id: string): Promise<StoredTestRun | null>;
  incidents(ids: string[]): Promise<Array<{ reportId: string; status: string }>>;
}
class MongoFixFlowRepository implements FixFlowRepository {
  private runs = new MongoTestRunRepository();
  async recent() {
    // Pending deliveries remain visible even when newer successful runs have arrived.
    const [pending, recent] = await Promise.all([
      TestRunModel.find({ "failureOccurrences.delivery.state": "pending" }).sort({ startedAt: -1 }).limit(100).lean(),
      TestRunModel.find({ "failureOccurrences.0": { $exists: true } }).sort({ startedAt: -1 }).limit(100).lean(),
    ]);
    return [...new Map([...pending, ...recent].map(row => [row.runId, { run: row.payload as TestRun,
      payloadSha256: row.payloadSha256, failureOccurrences: row.failureOccurrences as TestFailureOccurrence[] }])).values()];
  }
  failure(id: string) { return this.runs.failure(id); }
  run(id: string) { return this.runs.get(id); }
  async incidents(ids: string[]) {
    return ReportModel.find({ reportId: { $in: ids } }).select({ _id: 0, reportId: 1, status: 1 }).lean();
  }
}

const words = (value: string) => value.replaceAll("-", " ").replaceAll("_", " ");
const prUrl = (repository: string, number: number) => `https://github.com/${repository}/pull/${number}`;
const completedStatuses = new Set(["cancelled", "no_fix_needed", "third_party_out_of_scope"]);
const attentionStatuses = new Set(["mini_needs_input", "needs_more_info", "needs_product_decision", "needs_human_engineer", "ready_for_human_test", "failed"]);
const executionActions: Record<string, string> = {
  "source-investigation": "The fixer is investigating the recorded source and evidence.",
  "review-pending": "Waiting for a reviewer to assess the recorded PR head.",
  "build-pending": "Waiting for the build system to publish the reviewed fix.",
  "routine-pending": "Waiting for the routine worker to publish its verification result.",
  "missing-evidence": "More evidence is required. The record does not identify who must supply it.",
  "source-unavailable": "The required source is unavailable. The responsible owner is not recorded.",
  "budget-exhausted": "The execution budget is exhausted. A recovery owner and next action have not been recorded.",
  "access-required": "Required access is missing. The record does not identify who can restore it.",
  infrastructure: "An infrastructure issue stopped progress. A recovery owner and next action have not been recorded.",
  "repository-policy": "Repository routing needs clarification. The responsible owner is not recorded.",
  "occurrence-verification-required": "Waiting for verification bound to this exact failure occurrence.",
};
const executionStages: Record<string, string> = { continue: "Investigating", "waiting-for-review": "Waiting for review",
  "waiting-for-build": "Waiting for a build", "waiting-for-routine": "Waiting for routine verification",
  "needs-input": "Needs input", "ready-for-policy": "Ready for merge policy" };

/** The delivery receipt identifies the executor. A matching signature/case alone never identifies this occurrence. */
export function matchingFixActivity(stored: StoredTestRun, occurrence: TestFailureOccurrence, activity: FixActivity | null,
  environment: string | null): FixActivity | null {
  if (!activity || !environment || activity.environment !== environment || occurrence.delivery.state !== "acknowledged"
    || activity.routineFailure.intake.occurrenceId !== occurrence.occurrenceId
    || activity.routineFailure.intake.testRunId !== stored.run.runId) return null;
  const acknowledged = activity.acknowledgedAgentRunId ?? activity.runId;
  if (acknowledged !== occurrence.delivery.agentRunId) return null;
  // Linked rows keep their own intake identity. Only the controller's durable observation proof can attach the acknowledged owner.
  if (!activity.executionOwnerRunId && (activity.executionOwnerStatus || activity.executionOwnerStatusLabel
    || activity.executionOwnerUpdatedAt || activity.executionOwnerHeartbeatAt || activity.executionOwnerTriage
    || activity.executionOwnerWorkerLease || activity.executionOwnerProgressPhase)) return null;
  if (activity.executionOwnerRunId && (activity.executionOwnerRunId !== acknowledged || !activity.executionOwnerStatus)) return null;
  if (activity.runId !== acknowledged && (!activity.executionOwnerRunId || !activity.routineCase
    || activity.routineCase.anchorRunId !== acknowledged)) return null;
  return activity;
}

export function projectFixFlow(stored: StoredTestRun, occurrence: TestFailureOccurrence, activity: FixActivity | null,
  activityState: FixFlow["activity"], incidents: FixFlow["incidents"], now = Date.now()): FixFlow {
  const run = stored.run, failure = occurrence.failure;
  const turn = activity?.miniExecution?.stage ?? activity?.miniLastTurn;
  const status = activity?.executionOwnerStatus ?? activity?.status;
  const linked = !!activity?.executionOwnerRunId && activity.executionOwnerRunId !== activity.runId;
  const triage = activity?.executionOwnerTriage ?? activity?.miniTriage;
  const cancelled = triage?.state === "cancelled";
  const lease = activity?.executionOwnerRunId ? activity.executionOwnerWorkerLease : activity?.workerLease;
  const currentlyLeased = status === "mini_running" && lease?.state === "active"
    && !!lease.expiresAt && Date.parse(lease.expiresAt) > now;
  let state: FixFlow["state"] = occurrence.delivery.state === "pending" ? "waiting" : "unknown";
  let stage = occurrence.delivery.state === "pending" ? "Awaiting fixer intake" : "Fixer status unavailable";
  let nextAction = occurrence.delivery.state === "pending"
    ? "Core has recorded this failure. Waiting for the controller to acknowledge this exact occurrence."
    : "The failure was accepted. Current agent progress could not be verified; refresh to try again.";
  if (activity) {
    state = completedStatuses.has(status!) ? "completed" : attentionStatuses.has(status!) ? "attention"
      : ["awaiting_executor", "queued", "mini_waiting"].includes(status!) ? "waiting" : "unknown";
    stage = activity.executionOwnerStatusLabel ?? activity.statusLabel ?? words(status!);
    // Admission is historical once the case has started; its old nextAction cannot mask a later review or input wait.
    nextAction = triage?.state !== "admitted" && triage?.nextAction
      ? triage.nextAction : turn ? executionActions[turn.reason] ?? "The next action is not recorded."
        : "Waiting for the next recorded agent update.";
    if (turn) stage = executionStages[turn.stage] ?? words(turn.stage);
    if (activity.miniTurnFailure && !cancelled && !currentlyLeased) {
      state = "attention";
      stage = `Agent stopped during ${activity.miniTurnFailure.phase}`;
      nextAction = `Recorded ${words(activity.miniTurnFailure.kind)}. A recovery owner and next action have not been recorded.`;
    }
    if (!completedStatuses.has(status!) && !cancelled) {
      if (triage?.state === "needs-evidence" || triage?.state === "held") state = "attention";
      if (turn?.stage === "needs-input" && !currentlyLeased) state = "attention";
      if (turn?.stage === "continue" && state === "waiting") stage = "Awaiting next agent turn";
      if (status === "mini_running") {
        if (currentlyLeased) {
          state = "running";
          stage = "Mini worker active";
          nextAction = "The Mini worker holds a current execution lease. It may be preparing or executing; the recorded lifecycle stage is shown below.";
        } else if (lease) {
          state = "attention";
          stage = "Worker ownership needs reconciliation";
          nextAction = "The recorded execution lease is absent or expired. Worker execution is not confirmed; the retained owner needs reconciliation.";
        } else {
          state = "unknown";
          stage = "Worker execution unconfirmed";
          nextAction = "This controller response does not include current execution-lease evidence. A running status or an old heartbeat alone does not confirm execution.";
        }
      }
    }
    if (cancelled) {
      state = "completed";
      stage = "Cancelled before execution";
      nextAction = triage.nextAction ?? "The controller cancelled this pre-execution intake. No fix or verification is implied.";
    }
  }
  const prs = new Map<string, FixFlow["pullRequests"][number]>();
  for (const cp of activity?.miniExecution?.checkpoints ?? []) {
    if (cp.action === "record-pr" && cp.repository && cp.pullRequest && cp.headSha)
      prs.set(`${cp.repository}/${cp.pullRequest}`, { repository: cp.repository, number: cp.pullRequest, headSha: cp.headSha,
        url: prUrl(cp.repository, cp.pullRequest), state: "unknown", mergedAt: null });
  }
  for (const pr of [...activity?.result?.pullRequests ?? [], ...activity?.pullRequests ?? []]) {
    const key = `${pr.repository}/${pr.pullRequestNumber}`;
    const recorded = prs.get(key);
    // Old-result decoration cannot overwrite the newer checkpoint head.
    if (recorded && recorded.headSha !== pr.headSha) continue;
    prs.set(key, { repository: pr.repository, number: pr.pullRequestNumber, headSha: pr.headSha,
      url: prUrl(pr.repository, pr.pullRequestNumber), state: pr.pullRequestLifecycle?.state ?? "unknown",
      mergedAt: pr.pullRequestLifecycle?.mergedAt ?? null });
  }
  if (prs.size && [...prs.values()].every(pr => pr.state === "merged") && !activity?.miniTurnFailure && !cancelled) {
    stage = "Fix merged";
    // A merged PR is not proof the routine passed; keep outstanding verification visible.
    if (state === "attention") {
      stage = "Fix merged · action required";
      // Preserve an actual controller stop instead of hiding it behind the GitHub merge.
    } else if (["running", "waiting", "unknown"].includes(state) || turn?.stage === "waiting-for-routine" || turn?.reason === "occurrence-verification-required") {
      if (state !== "running" && state !== "unknown") state = "waiting";
      nextAction = "Fix merged; verification of this occurrence is still pending.";
    } else { state = "completed"; nextAction = "All recorded fix PRs are merged. See the recorded rerun outcomes below; merge alone does not prove a routine pass."; }
  }
  const timeline: FixFlow["timeline"] = [{ id: "failure", stage: "test", title: "Routine failed", detail: failure.message,
    at: run.finishedAt, url: `/?testRun=${encodeURIComponent(run.runId)}${failure.step ? `&step=${encodeURIComponent(failure.step.id)}` : ""}` }];
  for (const incident of incidents) timeline.push({ id: incident.reportId, stage: "incident", title: `Incident ${incident.status}`,
    detail: incident.reportId, at: null, url: `/?report=${incident.reportId}` });
  if (occurrence.delivery.state === "acknowledged") timeline.push({ id: "intake", stage: "intake", title: "Fixer accepted this failure",
    detail: occurrence.delivery.agentRunId, at: occurrence.delivery.acknowledgedAt, url: null });
  const dispatchOwners = new Map<string, boolean>();
  for (const [index, cp] of (activity?.miniExecution?.checkpoints ?? []).entries()) {
    if (cp.action === "reserve-dispatch" && cp.intentId) dispatchOwners.set(cp.intentId,
      cp.occurrence ? cp.occurrence.occurrenceId === occurrence.occurrenceId && cp.occurrence.agentRunId === activity?.runId
        : !activity?.routineCase || activity.routineCase.anchorRunId === activity.runId);
    // Shared case checkpoints may include another occurrence's rerun. Its result cannot verify this failure.
    if (["record-dispatch", "consume-result"].includes(cp.action) && (!cp.intentId || dispatchOwners.get(cp.intentId) !== true)) continue;
    const url = cp.repository && cp.pullRequest ? prUrl(cp.repository, cp.pullRequest) : null;
    let title: string | null = null, detail: string | null = null, link = url;
    switch (cp.action) {
      case "record-diagnosis": title = `Diagnosis: ${cp.components?.map(words).join(", ") || "not yet classified"}`; detail = cp.summary ?? null; break;
      case "route-harness": title = "Investigation continued in the harness"; break;
      case "record-pr": title = `Fix PR #${cp.pullRequest}`; detail = cp.headSha ?? null; break;
      case "start-review": title = `Review started for #${cp.pullRequest}`; detail = cp.headSha ?? null; break;
      case "record-review": title = cp.verdict === "changes-requested" ? "Review requested changes" : cp.verdict === "approved" ? "Review approved" : "Review unavailable";
        detail = cp.headSha ?? null; if (url && cp.reviewId && /^\d+$/.test(cp.reviewId)) link = `${url}#pullrequestreview-${cp.reviewId}`; break;
      case "record-dispatch": title = "Verification rerun requested"; detail = `Request ${cp.requestRunId}, attempt ${cp.requestAttempt}`;
        link = cp.requestRunId ? `https://github.com/Mentra-Community/MentraOS/actions/runs/${cp.requestRunId}` : null; break;
      case "consume-result": title = `Verification result: ${words(cp.outcome ?? "unknown")}`; detail = cp.resultId ?? null; break;
      case "record-repair": title = `Machine state repair: ${words(cp.state ?? "unknown")}`; break;
    }
    if (title) timeline.push({ id: `checkpoint-${index}`, stage: cp.action, title, detail,
      at: cp.verification?.submittedAt ?? cp.recordedAt ?? cp.startedAt ?? null, url: link });
  }
  for (const pr of prs.values()) if (pr.state === "merged") timeline.push({ id: `merged-${pr.repository}-${pr.number}`, stage: "merged",
    title: `PR #${pr.number} merged`, detail: pr.repository, at: pr.mergedAt, url: pr.url });
  if (activity?.miniTurnFailure) timeline.push({ id: "last-stop", stage: "agent-stop", title: "Last recorded agent stop",
    detail: `${words(activity.miniTurnFailure.kind)} during ${activity.miniTurnFailure.phase}`, at: activity.miniTurnFailure.at, url: null });
  if (linked) {
    stage = `Linked case · ${stage}`;
    nextAction = `This failure is linked to the recorded case. ${nextAction}`;
  }
  return { occurrenceId: occurrence.occurrenceId, runId: run.runId, routineId: run.routineId, channel: run.channel,
    build: run.prNumber ? `PR #${run.prNumber}` : run.release ?? run.provenance.buildSha?.slice(0, 10) ?? "Build not recorded",
    step: failure.step, failure: { code: failure.code, message: failure.message, ...(failure.expected ? { expected: failure.expected } : {}) },
    startedAt: run.finishedAt, updatedAt: activity ? [activity.updatedAt, activity.executionOwnerUpdatedAt ?? activity.updatedAt].sort().at(-1)!
      : occurrence.delivery.state === "acknowledged" ? occurrence.delivery.acknowledgedAt : run.finishedAt,
    state, pipelineStage: fixFlowPipelineStage(activity, state, [...prs.values()]), stage, nextAction, activity: occurrence.delivery.state === "pending" ? "pending" : activity ? "available" : activityState,
    agent: activity ? { runId: activity.runId, executor: activity.executor, status: activity.status,
      caseId: activity.routineCase?.caseId ?? null, anchorRunId: activity.routineCase?.anchorRunId ?? null,
      repository: activity.miniExecution?.route.repository ?? null, branch: activity.miniExecution?.route.branch ?? null,
      heartbeatAt: activity.executionOwnerHeartbeatAt ?? activity.heartbeatAt ?? null,
      executionOwner: linked ? { runId: activity.executionOwnerRunId!, status: activity.executionOwnerStatus! } : null } : null,
    incidents, pullRequests: [...prs.values()], timeline };
}

/** Current recorded phase only. Neither prose labels nor earlier steps imply later progress. */
function fixFlowPipelineStage(activity: FixActivity | null, state: FixFlow["state"], prs: FixFlow["pullRequests"]): NonNullable<FixFlow["pipelineStage"]> {
  if ((activity?.executionOwnerTriage ?? activity?.miniTriage)?.state === "cancelled"
    || (activity?.executionOwnerStatus ?? activity?.status) === "cancelled") return "closed";
  if (state === "completed") return prs.length && prs.every(pr => pr.state === "merged") ? "merged" : "closed";
  if (!activity) return state === "waiting" ? "intake" : "unknown";
  const phase = activity.executionOwnerRunId ? activity.executionOwnerProgressPhase : activity.progressPhase;
  const phases = { collecting_report: "intake", inspecting_code: "investigation", implementing_fix: "fix",
    running_tests: "verification", reviewing_pr: "review", addressing_feedback: "fix" } as const;
  if (phase && state === "running") return phases[phase];
  const turn = activity.miniExecution?.stage ?? activity.miniLastTurn;
  if (turn?.stage === "waiting-for-routine" || turn?.reason === "occurrence-verification-required") return "verification";
  if (["waiting-for-review", "waiting-for-build", "ready-for-policy"].includes(turn?.stage ?? "")) return "review";
  if (turn?.reason === "source-investigation") return "investigation";
  for (const checkpoint of [...activity.miniExecution?.checkpoints ?? []].reverse()) {
    if (["record-dispatch", "consume-result", "reserve-dispatch"].includes(checkpoint.action)) return "verification";
    if (["record-pr", "start-review", "record-review"].includes(checkpoint.action)) return "review";
    if (checkpoint.action === "record-repair") return "fix";
    if (["record-diagnosis", "route-harness"].includes(checkpoint.action)) return "investigation";
  }
  if (phase) return phases[phase];
  if (prs.length) return prs.every(pr => pr.state === "merged") ? "merged" : "review";
  if (activity.miniTurnFailure?.phase === "model") return "investigation";
  return "intake";
}

export class FixFlowService {
  constructor(private readonly repository: FixFlowRepository = new MongoFixFlowRepository(),
    private readonly reader: FixActivityReader = new HttpFixActivityReader(), private readonly environment = testFailureEnvironment()) {}
  private async project(stored: StoredTestRun, occurrence: TestFailureOccurrence, candidate: FixActivity | null, availability: FixFlow["activity"],
    knownReports?: Array<{ reportId: string; status: string }>) {
    const activity = matchingFixActivity(stored, occurrence, candidate, this.environment);
    const reports = knownReports ?? await this.repository.incidents(occurrence.failure.incidentIds);
    return projectFixFlow(stored, occurrence, activity, candidate && !activity ? "unmatched" : availability,
      occurrence.failure.incidentIds.map(reportId => ({ reportId, status: reports.find(report => report.reportId === reportId)?.status ?? "unavailable" })));
  }
  async list(): Promise<FixFlowList> {
    const [local, activity] = await Promise.all([this.repository.recent(), this.reader.list()]);
    const rows = new Map(local.map(row => [row.run.runId, row]));
    // Fetch each older active occurrence by identity, not a signature lookup.
    const candidates = activity.runs.filter(run => run.environment === this.environment);
    for (let start = 0; start < candidates.length; start += 8) {
      await Promise.all(candidates.slice(start, start + 8).map(async item => {
        if (!rows.has(item.routineFailure.intake.testRunId)) {
          const row = await this.repository.failure(item.routineFailure.intake.occurrenceId);
          if (row) rows.set(row.run.runId, row);
        }
      }));
    }
    const byOccurrence = new Map(candidates.map(row => [row.routineFailure.intake.occurrenceId, row]));
    const flows: FixFlow[] = [];
    const reports = await this.repository.incidents([...new Set([...rows.values()].flatMap(row =>
      (row.failureOccurrences ?? []).flatMap(occurrence => occurrence.failure.incidentIds)))]);
    for (const row of rows.values()) for (const occurrence of row.failureOccurrences ?? []) {
      const agent = occurrence.delivery.state === "acknowledged" ? byOccurrence.get(occurrence.occurrenceId) ?? null : null;
      flows.push(await this.project(row, occurrence, agent, activity.state === "available" ? "unavailable" : activity.state, reports));
    }
    const rank = { attention: 0, running: 1, waiting: 2, unknown: 3, active: 3, completed: 4 };
    flows.sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt.localeCompare(a.updatedAt));
    return { flows, activity: activity.state, limited: activity.limited || local.length >= 100,
      refreshedAt: new Date().toISOString() };
  }
  async detail(id: string) {
    if (!/^tfo_[a-f0-9]{64}$/.test(id)) throw new TestRunError(400, "invalid fix flow identifier");
    const stored = await this.repository.failure(id), occurrence = stored?.failureOccurrences?.find(item => item.occurrenceId === id);
    if (!stored || !occurrence) throw new TestRunError(404, "This failure occurrence has not been recorded.");
    const activity = occurrence.delivery.state === "acknowledged" ? await this.reader.detail(occurrence.delivery.agentRunId,
      { occurrenceId: id, testRunId: stored.run.runId }) : null;
    return this.project(stored, occurrence, activity, "unavailable");
  }
  async chapter(runId: string, chapterId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(runId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(chapterId))
      throw new TestRunError(400, "invalid failed step");
    const stored = await this.repository.run(runId), chapter = stored?.run.chapters.find(item => item.id === chapterId);
    if (!stored || !chapter || !["failed", "blocked"].includes(chapter.status)) throw new TestRunError(404, "Failed step not found in this run.");
    const occurrences = stored.failureOccurrences?.filter(item => item.failure.step?.id === chapterId) ?? [];
    if (occurrences.length === 1) return this.detail(occurrences[0].occurrenceId);
    if (occurrences.length > 1) return { runId, chapterId, choices: occurrences.map(item => ({ occurrenceId: item.occurrenceId,
      phase: item.failure.phase, code: item.failure.code, message: item.failure.message })) };
    // A real failed chapter may precede publication of structured failure metadata. Never substitute another step's case.
    return { runId, chapterId, pending: true as const,
      message: "This step failed, but its structured failure occurrence has not been published. No incident or fixer assignment can be confirmed for this step yet." };
  }
}
