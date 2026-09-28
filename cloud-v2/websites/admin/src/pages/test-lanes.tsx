import type { ReactNode } from "react";
import { CHECKPOINT_FRESH_MS, type OverviewClaim, type OverviewJob, type OverviewRequest, type OverviewResourceObservation,
  type TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import type { TestResourceProgressCheckpoint, TestResourceReason } from "../../../../packages/core/src/types/test-resource-observation.types";

/**
 * One card per host lane (a reported guard), built only from the overview Core already returns: the latest
 * host observation and its Core receipt time, plus CI jobs and claims matched by the exact run ID the guard
 * owner reserved. Nothing here admits, reserves, releases or recovers anything, and nothing is inferred from
 * a fixture alias, a completed CI job or the absence of a GitHub job.
 */

export const phaseNames = { preflight: "Checking prerequisites", setup: "Setting up", test: "Testing", "final-assertions": "Final checks",
  teardown: "Cleaning up", "return-verification": "Verifying return state", evidence: "Saving evidence" };
export const checkpointIsFresh = (receivedAt: string, now: number) => now - Date.parse(receivedAt) <= CHECKPOINT_FRESH_MS;
/**
 * Core shows a GitHub-queued job as running only from a fresh worker checkpoint.
 * The view keeps aging that checkpoint between refreshes: once it is no longer
 * recent, the activity is unconfirmed rather than running.
 */
export function displayState(job: OverviewJob, now: number): OverviewJob["state"] {
  return job.reportedActivity && !checkpointIsFresh(job.reportedActivity.receivedAt, now) ? "unknown" : job.state;
}
export function elapsed(since: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(seconds)) return "Unknown";
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + seconds % 60 + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor(seconds % 3600 / 60) + "m";
}

/** Core receipt age after which a host observation is no longer current. A host heartbeat must report more often. */
export const RESOURCE_FRESH_MS = 120_000;
export const resourceIsFresh = (item: OverviewResourceObservation, now: number) => now - Date.parse(item.receivedAt) <= RESOURCE_FRESH_MS;
export type ResourceGuidance = { summary: string; responsible: "Owning test runner" | "Test runner / operator" | "Operator"; next: string };
/** Fixed wording per reported reason. Observations carry no free text; only progress has bounded step/action labels. */
export const resourceGuidance: Record<TestResourceReason, ResourceGuidance> = {
  "owner-process-alive": { summary: "The guard owner's PID answered a liveness probe.", responsible: "Owning test runner",
    next: "Follow the owning run. A live PID is an observation, not proof of the owner's identity." },
  "owner-liveness-unknown": { summary: "The guard owner's liveness could not be determined.", responsible: "Test runner / operator",
    next: "Refresh this observation from the host. Do not assume the owner stopped." },
  "owner-unverifiable": { summary: "A guard exists, but its owner record could not be read or validated.", responsible: "Test runner / operator",
    next: "Inspect the guard with the host's read-only lane status. Only the owner's recovery or the normal acquisition may change it." },
  "dead-retained-reservation": { summary: "The owner process is gone and the guard is retained for its run.", responsible: "Test runner / operator",
    next: "Resume this run's recovery through its original owner and publish verified return evidence. A dead PID or completed checkpoint does not release this hold." },
  "dead-retained-unclassified-installation": { summary: "The owner process is gone and the guard is retained without a lifecycle reservation.", responsible: "Test runner / operator",
    next: "Identify the retained installation and recover it through its original owner. This view cannot release it." },
  "dead-unretained-owner": { summary: "The owner process is gone and did not retain the guard.", responsible: "Test runner / operator",
    next: "Only the next normal acquisition may reclaim this guard. Nothing here removes it." },
  "reclaim-marker-present": { summary: "A reclaim was in progress during observation.", responsible: "Test runner / operator",
    next: "Refresh this observation after the reclaim settles." },
  "guard-changed-during-observation": { summary: "The guard changed while it was being observed.", responsible: "Test runner / operator",
    next: "Refresh this observation." },
  "reclaim-marker-unreadable": { summary: "The reclaim marker could not be read.", responsible: "Operator",
    next: "Check the host's guard folder permissions with the read-only lane status, then refresh." },
  "no-guard-fixture-not-supplied": { summary: "No owner observed. The fixture record was not checked.", responsible: "Test runner / operator",
    next: "Nothing to recover from this observation. It checks no prerequisites and admits no routine." },
  "no-guard-recorded-fixture-ready": { summary: "No owner observed.", responsible: "Test runner / operator",
    next: "Nothing to recover from this observation. Recorded fixture state is context; a routine still needs the normal acquisition and prerequisite checks." },
  "recorded-fixture-busy": { summary: "No owner observed, but the fixture record says busy.", responsible: "Test runner / operator",
    next: "Reconcile the fixture record through its last run's recovery before routines use it." },
  "recorded-fixture-recovery-required": { summary: "No owner observed; the fixture record requires recovery.", responsible: "Test runner / operator",
    next: "Recover the fixture and publish verified return evidence before routines use it." },
  "recorded-fixture-uncommissioned": { summary: "No owner observed; the fixture is recorded as uncommissioned.", responsible: "Operator",
    next: "Commission this fixture before routines use it." },
  "fixture-record-absent": { summary: "No owner observed; no fixture record exists.", responsible: "Operator",
    next: "Commission this fixture before routines use it." },
  "fixture-record-malformed": { summary: "No owner observed; the fixture record is malformed.", responsible: "Operator",
    next: "Recommission this fixture before routines use it." },
  "fixture-record-unreadable": { summary: "No owner observed; the fixture record could not be read.", responsible: "Operator",
    next: "Check the fixture record's permissions on the host, then refresh." },
};

export type LaneState = "running" | "reserved" | "blocked" | "recovery" | "available" | "not-ready" | "unknown";
const laneStateText: Record<LaneState, { badge: string; colors: string }> = {
  running: { badge: "Running", colors: "bg-[#e6f5ed] text-[#087d50]" },
  reserved: { badge: "Reserved, idle", colors: "bg-[#fff5df] text-[#805619]" },
  blocked: { badge: "Blocked", colors: "bg-[#fff5df] text-[#805619]" },
  recovery: { badge: "Recovery required", colors: "bg-[#fff0e9] text-[#a64235]" },
  available: { badge: "Available", colors: "bg-[#e6f5ed] text-[#087d50]" },
  "not-ready": { badge: "Not ready", colors: "bg-[#fff5df] text-[#805619]" },
  unknown: { badge: "Offline or unknown", colors: "bg-[#f0f2ef] text-[#59655e]" },
};
const laneStateOrder: LaneState[] = ["running", "reserved", "blocked", "recovery", "not-ready", "unknown", "available"];
/** A CI request ID, the only run ID form a CI claim or GitHub request carries. Anything else is a local run. */
const ciRequestId = /^routine-([1-9]\d*)-([1-9]\d*)-(dev|staging|[1-9]\d*)-([a-z0-9-]+)$/;
type Progress = Omit<TestResourceProgressCheckpoint, "runId">;
type Matched = { job: OverviewJob; request?: OverviewRequest; claim?: OverviewClaim };
/** One lane card: a plain-language summary, with guard mechanics kept for its details. */
export interface LaneCard {
  item: OverviewResourceObservation;
  state: LaneState;
  fresh: boolean;
  runId?: string;
  matched?: Matched;
  progress?: Progress;
  /** The run's latest step (by journal sequence) is unfinished and was received recently. Shown as the lane's current
   * step only when the lane is running, which also needs a current host report. */
  active: boolean;
  summary: string;
  responsible: string;
  next: string;
  /** Guard wording and host commands for the lane's details. */
  technical: string[];
  /** Queued or waiting CI requests for this lane's platform. Undefined when no CI routine was observed on the lane. */
  queue?: { job: OverviewJob; request: OverviewRequest }[];
  /** Phone and glasses lanes: what the current reports say about this lane's counterpart, set by `laneCards`. */
  pairing?: string;
}

export type LaneKind = "shared" | "android" | "glasses";
export const laneKind = (resourceKey: string): LaneKind =>
  resourceKey === "shared" ? "shared" : resourceKey.startsWith("glasses-") ? "glasses" : "android";
const platformOf = (kind: LaneKind): NonNullable<OverviewRequest["platform"]> => kind === "shared" ? "ios-on-mac" : "android";
const plural = (count: number, one: string, many: string) => count + " " + (count === 1 ? one : many);
/** The CI job or claim-only row for this exact request ID, active work first. Never matched by fixture alias. */
function matchRun(data: TestRunOverview, runId: string): Matched | undefined {
  for (const job of [...data.jobs, ...data.fixtureAttention ?? []]) {
    const request = job.requests.find(value => value.requestId === runId), claim = job.claims.find(value => value.requestId === runId);
    if (request || claim) return { job, ...(request ? { request } : {}), ...(claim ? { claim } : {}) };
  }
  return undefined;
}
/**
 * The latest step of this exact run from the host's checkpoint and the CI claim's. The committed journal sequence
 * orders them, never arrival time. The same sequence delivered twice keeps its first receipt time, so a duplicate
 * never makes an old step look recent.
 */
function currentProgress(item: OverviewResourceObservation, runId: string | undefined, claim?: OverviewClaim): Progress | undefined {
  const candidates = [item.progress?.runId === runId ? item.progress : undefined, claim?.progress].filter((value): value is Progress => Boolean(value));
  return candidates.sort((a, b) => b.sequence - a.sequence || Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0];
}
function heartbeatCommand(item: OverviewResourceObservation) {
  const resource = { shared: "shared --fixture-directory <lane fixture>", android: "android --serial <this phone's serial> --fixture-directory <lane fixture>",
    glasses: "glasses --cid <enrolled eMMC CID> --bluetooth <enrolled MAC>" }[laneKind(item.resourceKey)];
  return "Host heartbeat: bun tools/mentra-e2e/lane-status.ts --resource " + resource + " --publish --interval-seconds 60, with the host's existing reporting settings.";
}

export function laneCard(data: TestRunOverview, item: OverviewResourceObservation, now: number): LaneCard {
  const { observation } = item, fresh = resourceIsFresh(item, now), kind = laneKind(item.resourceKey);
  const owner = observation.owner?.valid ? observation.owner : undefined;
  const runId = owner?.reservation?.runID;
  const matched = runId ? matchRun(data, runId) : undefined;
  const progress = currentProgress(item, runId, matched?.claim);
  const active = Boolean(progress && progress.mode !== "complete" && checkpointIsFresh(progress.receivedAt, now));
  const guidance = resourceGuidance[observation.reason], guard = [guidance.summary + " " + guidance.next];
  // A CI lane is one whose own guard or fixture record names a CI request; only those list the platform queue.
  const lastRun = observation.fixture.checked && observation.fixture.record === "valid" ? observation.fixture.lastRunID : undefined;
  const ci = kind !== "glasses" && [runId, lastRun].some(id => id && ciRequestId.test(id));
  // Who holds the lane, only as the owner reported it: a CI request, a local run, or no reported run at all.
  const holder: "ci" | "local" | "none" = !runId ? "none" : ciRequestId.test(runId) ? "ci" : "local";
  const holderName = { ci: "a CI run", local: "a local session", none: "a live process that reported no run" }[holder];
  const queue = ci ? data.jobs.filter(job => ["queued", "waiting"].includes(displayState(job, now))).flatMap(job => job.requests
    .filter(request => request.platform === platformOf(kind)).map(request => ({ job, request }))) : undefined;
  const base = { item, fresh, active, ...(runId ? { runId } : {}), ...(matched ? { matched } : {}), ...(progress ? { progress } : {}), ...(queue ? { queue } : {}) };
  const card = (state: LaneState, summary: string, responsible: string, next: string, technical = guard): LaneCard =>
    ({ ...base, state, summary, responsible, next, technical });
  const owning = { ci: "Owning test runner", local: "Session owner", none: "Host operator" }[holder];
  const offline = [...guard, heartbeatCommand(item)];
  // A retained hold is never cleared by age, a dead PID or a completed checkpoint.
  if (observation.state === "retained-recovery-required") {
    // The recorded pending lifecycle step is the only recovery detail the observation carries.
    const pending = observation.lastCheckpoint?.available ? observation.lastCheckpoint.pendingReconciliation ?? observation.lastCheckpoint.pendingOperation : null;
    if (holder === "none") return card("recovery", "A process that reported no run stopped while holding this lane. The lane stays held until it is recovered.",
      guidance.responsible, guidance.next);
    return card("recovery", "The run holding this lane stopped before its cleanup finished. The lane stays held until that run is recovered.",
      guidance.responsible, "Recover the original run through its owner" + (pending ? ", starting with its recorded pending step " + pending.phase + " / " + pending.stepID : "")
        + ", and publish its verified return before the lane takes new work.",
      [...guard, ...pending ? ["Pending lifecycle step: " + pending.phase + " / " + pending.stepID + "."] : []]);
  }
  if (observation.state === "busy") {
    // Only this host's current report shows who holds the lane; CI progress or GitHub state never refreshes it.
    if (!fresh) return card("unknown", "The last report, " + elapsed(item.receivedAt, now) + " ago, showed a live owner. Whether it is still running is unknown."
      + (active && progress ? " Its " + (holder === "local" ? "local session" : "CI run") + " reported a step " + elapsed(progress.receivedAt, now) + " ago; that does not confirm this host's lane." : ""),
      "Host operator", "Confirm the host is online and reporting. Until it reports, treat the lane as in use.", offline);
    // A completed latest step ends the lifecycle's activity even while GitHub still runs the job.
    if (active || progress?.mode !== "complete" && matched?.job.workflow?.status === "in_progress")
      return card("running", "Running " + (holder === "local" ? "a local session" : "this routine") + ".", owning, "Nothing needed; follow the run for its result.");
    if (holder === "none") return card("reserved", "Held by " + holderName + ".", owning,
      "Identify the process holding this lane on the host. The lane frees only when that process releases it.");
    return card("reserved", "Held by " + holderName + " with no step reported" + (progress ? " for " + elapsed(progress.receivedAt, now) : "") + ".",
      owning, holder === "local" ? "Ask the session owner to finish or stop the session." : "Wait for the run to continue, or ask its test runner to stop it.");
  }
  if (!fresh) return card("unknown", "No report for " + elapsed(item.receivedAt, now) + ", so the lane's current state is unknown.", "Host operator",
    "Confirm the host is online and reporting. Until it reports, do not treat the lane as free.", offline);
  // The shared guard can be absent while its own acquisition refuses: another owner holds a glasses pair lease.
  const leases = kind === "shared" && observation.guard.lock === "absent" ? observation.glassesLeases : undefined;
  if (leases?.state === "held") {
    const count = leases.pairs.length + leases.others;
    return card("blocked", "No Mac app owner, but " + plural(count, "glasses pair lease is", "glasses pair leases are") + " held. A Mac app routine cannot start until "
      + (count === 1 ? "it is" : "they are") + " released.", "Holder of the glasses pair", "See the glasses pair's card. This lane frees when that lease is released or recovered.",
      [...guard, "Held pair leases at this report: " + [...leases.pairs, ...leases.others ? [plural(leases.others, "other", "others")] : []].join(", ") + "."]);
  }
  if (leases?.state === "unreadable") return card("unknown", "The glasses pair leases could not be read, so whether a Mac app routine can start is unknown.",
    "Host operator", "Check the host's glasses lease folder with the read-only lane status, then refresh.");
  // A pair lease names only its run: with no lease held the pair is free at this report; its readiness is separate.
  if (kind === "glasses" && (observation.reason === "no-guard-fixture-not-supplied" || observation.state === "available-to-attempt"))
    return card("available", "No run held this pair at the last report.", "None", "Nothing needed.");
  if (observation.state === "available-to-attempt") return card("available", "Free at the last report. A routine still goes through normal admission.", "None", "Nothing needed.");
  if (observation.reason === "recorded-fixture-recovery-required" || observation.reason === "recorded-fixture-busy")
    return card("recovery", guidance.summary, guidance.responsible, guidance.next);
  if (observation.state.startsWith("idle-")) return card("not-ready", guidance.summary, guidance.responsible, guidance.next);
  return card("unknown", guidance.summary, guidance.responsible, guidance.next);
}

/** A live owner in this lane's current report, with its reservation: the only input that can pair a phone with glasses. */
function liveReservation(card: LaneCard) {
  const owner = card.item.observation.owner?.valid ? card.item.observation.owner : undefined;
  return card.fresh && card.item.observation.state === "busy" && owner?.liveness === "alive" && owner.reservation ? owner.reservation : undefined;
}
const pairName = (card: LaneCard) => "glasses pair " + card.item.resourceKey.slice("glasses-".length);
const phoneName = (card: LaneCard) => {
  const fixture = card.item.observation.fixture;
  return "Android phone lane " + (fixture.checked && fixture.record === "valid" ? fixture.fixtureID : card.item.resourceKey.slice("android-".length));
};
/**
 * A phone and a glasses pair on the same host are shown together only when both current reports show live owners with
 * the identical reservation (run and fixture), as one lifecycle holds both. Nothing else binds them: a pair lease names
 * a run, never a phone, so a held pair beside an unbound phone is stated as unknown, never as the phone being in use.
 */
function describePairing(cards: LaneCard[]) {
  for (const host of new Set(cards.map(card => card.item.hostId))) {
    const lanes = cards.filter(card => card.item.hostId === host);
    const phones = lanes.filter(card => laneKind(card.item.resourceKey) === "android"), pairs = lanes.filter(card => laneKind(card.item.resourceKey) === "glasses");
    const same = (a: LaneCard, b: LaneCard) => {
      const x = liveReservation(a), y = liveReservation(b);
      return Boolean(x && y && x.runID === y.runID && x.fixtureID === y.fixtureID);
    };
    const held = pairs.filter(card => card.item.observation.guard.lock !== "absent" && (card.fresh || card.state === "recovery"));
    for (const pair of pairs) {
      const phone = phones.find(candidate => same(pair, candidate));
      if (phone) pair.pairing = "Held with " + phoneName(phone) + " by the same run at their last reports.";
      else if (held.includes(pair)) pair.pairing = "Not reported. A pair lease names its run, not a phone.";
    }
    for (const phone of phones) {
      const pair = pairs.find(candidate => same(candidate, phone));
      if (pair) phone.pairing = "Held with " + pairName(pair) + " by the same run at their last reports.";
      else if (held.some(candidate => !phones.some(other => same(candidate, other))))
        phone.pairing = "A glasses pair on this host is held; whether it is used with this phone is not reported.";
    }
  }
  return cards;
}

/** Lanes keep a stable inventory order: host, then its Mac lane, then its phones, then its glasses pairs. */
export function laneCards(data: TestRunOverview, now: number): LaneCard[] {
  const order = (key: string) => key === "shared" ? "" : key;
  return describePairing((data.resourceObservations?.items ?? []).map(item => laneCard(data, item, now))
    .sort((a, b) => a.item.hostId.localeCompare(b.item.hostId) || order(a.item.resourceKey).localeCompare(order(b.item.resourceKey))));
}

const buildText = (request: OverviewRequest) => (request.channel === "pr" ? "PR #" + request.prNumber : request.release ?? request.channel + " build")
  + (request.headSha ? " · " + request.headSha.slice(0, 10) : "");
/** Routine and build of the run holding the lane, from its exact CI request; unknown parts stay explicit. */
function workText(card: LaneCard) {
  const { runId, matched } = card;
  if (!runId) return undefined;
  const parsed = ciRequestId.exec(runId), request = matched?.request;
  return request ? request.routineId + " · " + buildText(request)
    : parsed ? parsed[4] + " · " + (parsed[3] === "dev" || parsed[3] === "staging" ? parsed[3] + " build" : "PR #" + parsed[3]) + " · build details not reported"
    : "Local session, not a CI request";
}
function stepText(progress: Progress) {
  return (progress.action?.label ?? progress.step?.label ?? "Step not named") + " · " + (progress.mode === "recovering" ? "Recovery · " : "") + phaseNames[progress.phase];
}
function glassesText(owner: { glassesScope?: "none" | "identified" | "unknown" }) {
  if (owner.glassesScope === "none") return "Glasses scope at that report: verified none. Mac UI, audio and recorder stay held.";
  if (owner.glassesScope === "identified") return "Glasses scope at that report: one identified pair, under its own lease.";
  return "Glasses scope at that report: unknown, so every pair is excluded.";
}
function Lane({ card, now, onResult }: { card: LaneCard; now: number; onResult: (id: string) => void }) {
  const { item, state, runId, matched, progress } = card, value = item.observation;
  const owner = value.owner?.valid ? value.owner : undefined, checkpoint = value.lastCheckpoint?.available ? value.lastCheckpoint : undefined;
  const fixture = value.fixture.checked && value.fixture.record === "valid" ? value.fixture : undefined;
  const kind = laneKind(item.resourceKey), work = workText(card), platform = kind === "shared" ? "iOS-on-Mac" : "Android";
  const title = { shared: "Mac UI lane", android: "Android phone lane", glasses: "Glasses pair " + item.resourceKey.slice("glasses-".length) }[kind];
  const scope = { shared: " (Mac UI, audio and recorder)", android: " (this phone only)", glasses: " (this glasses pair only; it names a run, not a phone)" }[kind];
  const row = (label: string, content: ReactNode) => <div className="grid grid-cols-[76px_1fr] gap-2"><dt className="text-[#68746d]">{label}</dt><dd className="min-w-0 break-words">{content}</dd></div>;
  return <article className="rounded-xl border border-[#e0e4de] p-3 text-[11px]" aria-label={"Lane " + item.hostId + " " + item.resourceKey}>
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 break-words text-xs font-semibold">{item.hostId} · {title + (kind !== "shared" && fixture ? " (" + fixture.fixtureID + ")" : "")}</p>
      <span className={"shrink-0 rounded-md px-2 py-1 font-medium " + laneStateText[state].colors}>{laneStateText[state].badge}</span></div>
    <dl className="mt-2 space-y-1">
      {work ? row("Work", <>{work}{state === "running" && card.active && progress ? <span className="block">{stepText(progress)}</span> : null}</>) : null}
      {row("Status", card.summary)}
      {row("Last report", <span className={card.fresh ? "" : "text-[#805619]"}>{elapsed(item.receivedAt, now)} ago{card.fresh ? ""
        : value.state === "retained-recovery-required" ? "; not current. The lane stays held until its recovery is verified." : "; not current"}</span>)}
      {state !== "available" && state !== "running" ? <>{row("Responsible", card.responsible)}{row("Next", card.next)}</> : null}
      {card.pairing ? row(kind === "glasses" ? "Phone" : "Glasses", card.pairing) : null}
      {row("Queue", kind === "glasses" ? "CI requests are not queued per glasses pair."
        : !card.queue ? "No CI run was seen on this lane, so no CI queue is shown."
        : !card.queue.length ? "No queued " + platform + " requests."
        : card.queue.length + " queued " + platform + " " + (card.queue.length === 1 ? "request" : "requests") + ". GitHub assigns runners; this lane is not confirmed for them.")}
    </dl>
    <details className="mt-2"><summary className="cursor-pointer text-[#68746d]">Lane details</summary>
      <div className="mt-1 space-y-1 text-[#59655e]">
        <p>Resource {item.resourceKey}{scope}{fixture ? " · fixture " + fixture.fixtureID + ", recorded " + fixture.status : ""}</p>
        {kind === "shared" && !value.glassesLeases ? <p>Glasses pair leases were not reported by this host's version.</p> : null}
        {runId ? <p>Run {item.publishedRunIds.includes(runId) ? <button className="text-[#087d50] underline" onClick={() => onResult(runId)}>{runId}</button> : <span className="break-all">{runId}</span>}
          {matched?.job.workflow ? <>{" · "}<a className="text-[#087d50] underline" href={matched.job.workflow.url} target="_blank" rel="noreferrer">GitHub run</a></> : null}
          {ciRequestId.test(runId) ? " · Worker " + (matched?.job.workerName ?? matched?.claim?.workerId ?? "not reported") : ""}</p> : null}
        <p>{!value.owner ? "No guard owner" : !owner ? "Guard owner record invalid" : "Owner PID " + owner.pid + ", " + (owner.liveness === "alive" ? "alive" : owner.liveness === "dead" ? "not running" : "liveness unknown") + " at the last report"}</p>
        {owner && item.resourceKey === "shared" ? <p>{glassesText(owner)}</p> : null}
        {progress ? <p>Last reported step: {stepText(progress)}{progress.mode === "complete" ? " (completed)" : ""}, received {elapsed(progress.receivedAt, now)} ago</p> : null}
        {checkpoint ? <p>Last recorded lifecycle checkpoint (time not reported): {checkpoint.mode} · {checkpoint.phase}</p> : null}
        {card.technical.map(line => <p key={line}>{line}</p>)}
        {card.queue?.map(({ job, request }) => <p key={request.requestId}>Queued: {request.routineId} · {buildText(request)} · {elapsed(job.createdAt, now)} ago</p>)}
      </div></details>
  </article>;
}

/** Top-level lane inventory: one compact card per reporting host lane. */
export function LaneOverview({ data, now, onResult }: { data: TestRunOverview; now: number; onResult: (id: string) => void }) {
  const feed = data.resourceObservations, cards = laneCards(data, now);
  const unmatched = data.jobs.filter(job => ["queued", "waiting"].includes(displayState(job, now))).flatMap(job => job.requests.filter(request => !request.platform)).length;
  return <section className="mt-3" aria-label="Test lanes">
    <h4 className="text-sm font-semibold">Test lanes</h4>
    <p className="mt-1 text-xs text-[#68746d]">One card per lane a host has reported. Hosts that have not reported are not listed.</p>
    {!feed ? <p className="mt-2 text-xs text-[#805619]">Lane state was not reported by Core. Do not treat any lane as free.</p>
      : !feed.available ? <p className="mt-2 text-xs text-[#805619]">Lane state could not be loaded. Do not treat any lane as free.</p>
      : !cards.length ? <p className="mt-2 text-xs text-[#805619]">No host has reported a lane yet.</p>
      : <>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">{laneStateOrder.map(state => [state, cards.filter(card => card.state === state).length] as const).filter(([, count]) => count)
          .map(([state, count]) => <span key={state} className="rounded-md bg-[#f1f4ef] px-2 py-1"><strong>{count}</strong> {laneStateText[state].badge.toLowerCase()}</span>)}</div>
        <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{cards.map(card => <Lane key={card.item.hostId + "/" + card.item.resourceKey} card={card} now={now} onResult={onResult} />)}</div>
        {feed.truncated ? <p className="mt-2 text-xs text-[#805619]">More lanes reported than shown.</p> : null}</>}
    {unmatched ? <p className="mt-2 text-xs text-[#805619]">{unmatched} queued {unmatched === 1 ? "request does" : "requests do"} not report a platform and {unmatched === 1 ? "is" : "are"} not shown on a lane.</p> : null}
  </section>;
}
