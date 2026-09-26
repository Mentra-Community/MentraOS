import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { OverviewClaim, OverviewFixtureSummary, OverviewJob, OverviewRecordedFailure, OverviewRequest, OverviewResourceObservation,
  TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import type { TestResourceReason } from "../../../../packages/core/src/types/test-resource-observation.types";
import { api } from "../lib/api";

const triggerNames: Record<OverviewRequest["trigger"], string> = {
  "pr-label": "PR label", "successful-build": "Automatic build", "workflow-dispatch": "Workflow dispatch",
  nightly: "Nightly", admin: "Admin", unknown: "Origin unavailable",
};
const platformName = (value?: OverviewRequest["platform"]) => value === "ios-on-mac" ? "iOS on Mac" : value === "ios" ? "iPhone" : value === "android" ? "Android" : "Platform not reported";
const phaseNames = { preflight: "Checking prerequisites", setup: "Setting up", test: "Testing", "final-assertions": "Final checks",
  teardown: "Cleaning up", "return-verification": "Verifying return state", evidence: "Saving evidence" };
const checkpointIsFresh = (receivedAt: string, now: number) => now - Date.parse(receivedAt) <= 120_000;
export function elapsed(since: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(seconds)) return "Unknown";
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + seconds % 60 + "s";
  return Math.floor(seconds / 3600) + "h " + Math.floor(seconds % 3600 / 60) + "m";
}
function RequestLabel({ request }: { request: OverviewRequest }) {
  return <div className="mb-2 last:mb-0">
    <div className="font-medium">{request.channel === "pr" ? "PR #" + request.prNumber : request.release ?? request.channel + " build"} · {request.routineId}</div>
    <div className="mt-0.5 text-[11px] text-[#68746d]">{platformName(request.platform)} · {triggerNames[request.trigger]}{request.headSha ? " · " + request.headSha.slice(0, 10) : ""}</div>
    {request.buildRunId ? <a className="text-[11px] text-[#087d50] underline" target="_blank" rel="noreferrer"
      href={"https://github.com/Mentra-Community/MentraOS/actions/runs/" + request.buildRunId}>Build {request.buildRunId} / {request.publicationAttempt}</a> : null}
  </div>;
}
function Checkpoint({ claim, now }: { claim: OverviewClaim; now: number }) {
  const progress = claim.progress;
  if (!progress) return <p className="text-[#68746d]">No routine checkpoint reported.</p>;
  const stale = !checkpointIsFresh(progress.receivedAt, now);
  return <div className="mb-2 last:mb-0" aria-label="Recorded routine checkpoint">
    <p className="font-medium">{progress.action?.label ?? progress.step?.label ?? "No step reported"}</p>
    <p className="mt-0.5 text-[11px] text-[#68746d]">{progress.mode === "recovering" ? "Recovery · " : progress.mode === "complete" ? "Completed checkpoint · " : ""}
      {phaseNames[progress.phase]}{!progress.action ? <> · Lifecycle steps {progress.completedSteps}/{progress.totalSteps} in this phase</> : null}</p>
    {progress.action ? <p className="text-[11px] text-[#68746d]">{progress.action.totalActions === null
      ? progress.action.completedActions + " actions completed; total unknown"
      : progress.action.completedActions + " of " + progress.action.totalActions + " actions completed"}</p> : null}
    <p className={"mt-1 text-[11px] " + (stale ? "text-[#94631b]" : "text-[#68746d]")}>Last checkpoint {elapsed(progress.receivedAt, now)} ago{stale ? " · No recent checkpoint; activity is unconfirmed" : ""}</p>
  </div>;
}
const failurePhaseNames: Record<NonNullable<OverviewRecordedFailure["failure"]>["phase"], string> = { preflight: "Preflight", setup: "Setup",
  test: "Test", "final-assertions": "Final checks", teardown: "Cleanup", "return-verification": "Return verification", evidence: "Evidence", unknown: "Phase not reported" };
/** What the result recorded, kept apart from the current recovery reason above it. */
function RecordedFailure({ value }: { value: OverviewRecordedFailure }) {
  const { failure, chapter } = value;
  return <div className="mt-2 rounded border border-[#e0e4de] p-2" aria-label="Recorded failure">
    <p className="font-medium">Recorded failure</p>
    {failure ? <>
      <p className="mt-1">{failurePhaseNames[failure.phase] ?? failure.phase} · {!failure.step ? "Step not reported" : failure.step.label === failure.step.id ? failure.step.id : failure.step.label + " (" + failure.step.id + ")"}</p>
      <p className="mt-1">{failure.message}</p>
      {failure.expected ? <p className="mt-1">Expected: {failure.expected}</p> : null}
      {chapter ? <><p className="mt-1">Chapter {chapter.id} {chapter.status}: {chapter.instruction}</p>
        {chapter.expected ? <p className="mt-1">Chapter expected: {chapter.expected}</p> : null}</> : null}
      {value.detailUnpublished ? <p className="mt-1 text-[#805619]">The detailed cause was not published with this result.</p> : null}
    </> : <p className="mt-1 text-[#805619]">This result published no failure step or cause.</p>}
    <p className="mt-1 text-[#68746d]">As recorded by the result; not a diagnosis of the current recovery state.</p>
  </div>;
}
function JobRow({ job, now, onResult, onCancel }: { job: OverviewJob; now: number; onResult: (id: string) => void; onCancel?: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const colors = job.state === "blocked" ? "bg-[#fff0e9] text-[#a64235]" : job.state === "running"
    ? "bg-[#e6f5ed] text-[#087d50]" : "bg-[#f0f2ef] text-[#59655e]";
  const label = job.kind === "maintenance" ? "Host maintenance / recovery" : job.kind === "nightly" ? "Nightly sequence" : null;
  return <tr className="border-t border-[#eceeeb] align-top">
    <td className="px-4 py-3"><span className={"inline-block rounded-md px-2 py-1 text-[11px] font-medium " + colors}>{job.state}</span>
      {label ? <p className="mt-1 text-[11px] text-[#68746d]">{label}</p> : null}
      {job.workflow ? <a className="mt-1 inline-block text-[11px] text-[#087d50] underline" href={job.workflow.url} target="_blank" rel="noreferrer">GitHub job</a> : null}</td>
    <td className="max-w-[250px] px-4 py-3">{job.requests.length ? job.requests.map(request => <RequestLabel key={request.requestId} request={request} />)
      : <><p className="font-medium">{job.title}</p><p className="mt-1 text-[11px] text-[#68746d]">{job.kind === "maintenance" ? "Reviewed host operation; build and fixture are not published by this workflow." : "Build details unavailable"}</p></>}
      {job.message ? <p className="mt-2 text-[11px] text-[#68746d]">{job.message}</p> : null}</td>
    <td className="max-w-[190px] break-words px-4 py-3"><p>{job.workerName ?? (job.claims[0]?.workerId || "Not assigned")}</p>
      {job.claims.length ? [...new Set(job.claims.map(claim => claim.fixtureId))].map(fixture => <p key={fixture} className="mt-1 text-[11px] text-[#68746d]">Fixture: {fixture}</p>)
        : <p className="mt-1 text-[11px] text-[#68746d]">Fixture not reported</p>}</td>
    <td className="min-w-[250px] max-w-[340px] px-4 py-3">
      {job.attention ? <div className="mb-3 text-[11px]">
        <p className="font-medium">{job.attention.reason}</p>
        <p className="mt-1">Responsible: {job.attention.responsible}</p>
        <p className="mt-1">Next: {job.attention.nextAction}</p>
        {job.resultRunId ? <button className="mt-1 text-[#087d50] underline" onClick={() => onResult(job.resultRunId!)}>Recorded result</button> : null}
        {job.attention.recordedFailure ? <RecordedFailure value={job.attention.recordedFailure} /> : null}
        {job.attention.cancelledAt ? <p className="mt-2 text-[#68746d]">Follow-up cancelled {elapsed(job.attention.cancelledAt, now)} ago. Fixture readiness remains unverified.</p> : null}
        {job.attention.cancelRequestId && onCancel ? confirming ? <div className="mt-2 rounded border border-[#e0e4de] p-2">
          <p>Cancel further work on this inactive request? This preserves its result and does not stop a writer, release a device, or repair the fixture.</p>
          <button disabled={cancelling} className="mr-3 mt-2 text-[#a64235] underline" onClick={async () => {
            setCancelling(true); setCancelError(undefined);
            try { await onCancel(job.attention!.cancelRequestId!); setConfirming(false); }
            catch (error) { setCancelError(error instanceof Error ? error.message : "Cancellation failed. Refresh and try again."); }
            finally { setCancelling(false); }
          }}>{cancelling ? "Cancelling…" : "Confirm cancellation"}</button>
          <button disabled={cancelling} className="underline" onClick={() => setConfirming(false)}>Keep open</button>
        </div> : <button className="mt-2 block text-[#a64235] underline" onClick={() => setConfirming(true)}>Cancel further work</button> : null}
        {cancelError ? <p role="alert" className="mt-2 text-[#a64235]">{cancelError}</p> : null}
      </div> : null}
      {job.claims.length ? job.claims.map(claim => <div key={claim.requestId}>
      {job.claims.length > 1 ? <p className="mt-2 text-[11px] font-semibold">{job.requests.find(request => request.requestId === claim.requestId)?.routineId ?? claim.requestId}
        {" · "}{platformName(job.requests.find(request => request.requestId === claim.requestId)?.platform)}</p> : null}
      <Checkpoint claim={claim} now={now} /></div>)
      : <p className="text-[#68746d]">No routine checkpoint reported.</p>}
      {job.workflow?.step && !job.claims.some(claim => claim.progress && claim.progress.mode !== "complete" && checkpointIsFresh(claim.progress.receivedAt, now))
        ? <p className="mt-2 text-[11px] text-[#68746d]">GitHub step: {job.workflow.step}</p> : null}</td>
    <td className="whitespace-nowrap px-4 py-3"><p>{elapsed(job.startedAt ?? job.createdAt, now)}</p>
      <p className="mt-0.5 text-[11px] text-[#68746d]">{["claim", "fixture"].includes(job.kind) ? "Since recorded claim" : job.startedAt ? "Job elapsed" : "Waiting"}</p>
      {job.workflow ? <p className="mt-2 text-[11px] text-[#68746d]">GitHub update {elapsed(job.workflow.updatedAt, now)} ago</p> : null}</td>
  </tr>;
}

const summaryText: Record<OverviewFixtureSummary["status"], { badge: string; colors: string; next: string }> = {
  "current-work": { badge: "in use", colors: "bg-[#fff0e9] text-[#a64235]", next: "Follow the newer claim in Live activity above." },
  "not-checked": { badge: "not checked", colors: "bg-[#fff5df] text-[#805619]", next: "Refresh this view. Do not treat the fixture as ready until it is checked." },
  unverified: { badge: "unverified", colors: "bg-[#fff5df] text-[#805619]",
    next: "Confirm this fixture's state. If it is not ready, recover it once and publish verified return evidence." },
  "latest-return-verified": { badge: "returned", colors: "bg-[#e6f5ed] text-[#087d50]",
    next: "No recovery is needed for the resolved requests. Use outside routine claims is not observed here; see Local resource observations." },
};
const statusOrder = ["current-work", "not-checked", "unverified", "latest-return-verified"] as const;
const unverifiedFixtures = (data: TestRunOverview) => (data.fixtureSummary ?? []).filter(item => item.status !== "latest-return-verified");
function LatestClaim({ item, now, onResult }: { item: OverviewFixtureSummary; now: number; onResult: (id: string) => void }) {
  const latest = item.latest;
  if (!latest) return <p>{item.status === "not-checked" ? "Newer claims on this worker and fixture could not be checked."
    : "No newer claim on this worker and fixture since the newest resolved request."}</p>;
  return <p>Latest claim {latest.requestId}, {elapsed(latest.claimedAt, now)} ago: {item.status === "latest-return-verified"
    ? "cleanup and return were verified." : latest.reason}{latest.resultRunId ? <>{" "}
      <button className="text-[#087d50] underline" onClick={() => onResult(latest.resultRunId!)}>Result</button></> : null}</p>;
}
function FixtureHistory({ data, now, onResult }: { data: TestRunOverview; now: number; onResult: (id: string) => void }) {
  const items = data.fixtureSummary ?? [], attempts = data.fixtureAttention ?? [];
  const count = (status: OverviewFixtureSummary["status"]) => items.filter(item => item.status === status).length;
  return <section className="mt-5" aria-label="Latest CI return evidence after resolved follow-up">
    <h4 className="text-sm font-semibold">Latest CI return evidence after resolved follow-up</h4>
    <p className="mt-1 text-xs text-[#68746d]">History: one row per worker and fixture, judged only by its newest CI routine claim and that claim's published results. It does not observe local ownership since then. Cancelled and closed requests keep their original results.</p>
    {items.length ? <>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">{statusOrder.filter(status => count(status)).map(status =>
        <span key={status} className="rounded-md bg-[#f1f4ef] px-2 py-1"><strong>{count(status)}</strong> {summaryText[status].badge}</span>)}</div>
      <div className="mt-2 overflow-x-auto rounded-xl border border-[#e0e4de]"><table className="w-full text-left text-xs">
        <thead className="bg-[#f7f9f5] text-[11px] text-[#68746d]"><tr>{["CI return evidence", "Worker / fixture", "Latest evidence", "Next action"].map(title => <th key={title} className="px-4 py-2 font-medium">{title}</th>)}</tr></thead>
        <tbody>{items.map(item => <tr key={item.workerId + "/" + item.fixtureId} className="border-t border-[#eceeeb] align-top">
          <td className="px-4 py-3"><span className={"inline-block rounded-md px-2 py-1 text-[11px] font-medium " + summaryText[item.status].colors}>{summaryText[item.status].badge}</span></td>
          <td className="max-w-[190px] break-words px-4 py-3"><p>{item.workerId}</p><p className="mt-1 text-[11px] text-[#68746d]">Fixture: {item.fixtureId}</p></td>
          <td className="min-w-[250px] max-w-[340px] px-4 py-3 text-[11px]"><LatestClaim item={item} now={now} onResult={onResult} />
            <p className="mt-1 text-[#68746d]">{item.cancelledRequestIds.length} resolved {item.cancelledRequestIds.length === 1 ? "request" : "requests"} before it; newest {elapsed(item.latestCancelledClaimAt, now)} ago.</p></td>
          <td className="min-w-[220px] max-w-[300px] px-4 py-3 text-[11px]"><p>{summaryText[item.status].next}</p>
            {item.status !== "latest-return-verified" ? <p className="mt-1">Responsible: Test runner / operator</p> : null}</td>
        </tr>)}</tbody>
      </table></div></> : <p className="mt-2 text-xs text-[#805619]">CI return evidence was not reported by Core. Treat these fixtures as unverified.</p>}
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-[#68746d]">Resolved follow-up history ({attempts.length})</summary>
      <ul className="mt-2 space-y-2">{attempts.map(job => <li key={job.id}>
        {job.requests.length ? job.requests.map(request => <RequestLabel key={request.requestId} request={request} />) : <p className="font-medium">{job.claims[0]?.requestId ?? job.title}</p>}
        <p className="text-[11px] text-[#68746d]">{job.claims[0] ? job.claims[0].workerId + " · Fixture: " + job.claims[0].fixtureId : "Fixture not reported"}
          {job.attention?.cancelledAt ? " · Follow-up cancelled " + elapsed(job.attention.cancelledAt, now) + " ago" : ""}
          {job.attention?.closedAt ? " · Closed by its original worker " + elapsed(job.attention.closedAt, now) + " ago; no test ran and the fixture was left uncommissioned" : ""}</p>
        {job.attention ? <p className="text-[11px]">{job.attention.reason}</p> : null}
        {job.resultRunId ? <button className="text-[11px] text-[#087d50] underline" onClick={() => onResult(job.resultRunId!)}>Recorded result</button> : null}
      </li>)}</ul></details>
  </section>;
}

/** Server receipt age after which a reported observation is no longer treated as current. */
const RESOURCE_FRESH_MS = 120_000;
type ResourceGuidance = { summary: string; responsible: "Owning test runner" | "Test runner / operator" | "Operator"; next: string };
/** Fixed wording per reported reason. Observations carry no free text; only progress has bounded step/action labels. */
const resourceGuidance: Record<TestResourceReason, ResourceGuidance> = {
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
const noOwnerStates = new Set(["available-to-attempt", "idle-prerequisites-unchecked", "idle-prerequisite-blocked", "idle-prerequisite-unknown"]);
const amber = "bg-[#fff5df] text-[#805619]", red = "bg-[#fff0e9] text-[#a64235]", neutral = "bg-[#f0f2ef] text-[#59655e]";
/** Display state only. Age never clears a retained hold and never confirms a live owner. */
export function resourceStatus(item: OverviewResourceObservation, now: number) {
  const fresh = now - Date.parse(item.receivedAt) <= RESOURCE_FRESH_MS;
  const { state } = item.observation;
  if (state === "retained-recovery-required") return { badge: "retained hold", colors: red, fresh, priority: 0 };
  if (state === "busy") return fresh ? { badge: "owner alive", colors: neutral, fresh, priority: 2 } : { badge: "unconfirmed", colors: amber, fresh, priority: 1 };
  if (noOwnerStates.has(state)) return { badge: fresh ? "no owner observed" : "not current", colors: fresh ? neutral : amber, fresh, priority: 3 };
  return { badge: state === "ownership-changing" ? "changing" : state === "stale-unretained-owner" ? "stale owner" : "unknown", colors: amber, fresh, priority: 1 };
}
function resourceAttention(item: OverviewResourceObservation, fresh: boolean): ResourceGuidance {
  const guidance = resourceGuidance[item.observation.reason];
  if (fresh || item.observation.state === "retained-recovery-required") return guidance;
  if (item.observation.state === "busy") return { summary: "An owner PID was alive when last observed; current activity is unconfirmed.",
    responsible: "Test runner / operator", next: "Refresh this observation from the host. A stale live PID is not proof of a running job." };
  if (noOwnerStates.has(item.observation.state)) return { summary: "No owner was observed at that time; the current state is unconfirmed.",
    responsible: "Test runner / operator", next: "Refresh this observation from the host before relying on it." };
  return { ...guidance, next: "Refresh this observation from the host. " + guidance.next };
}
function RunReference({ id, item, onResult }: { id: string; item: OverviewResourceObservation; onResult: (id: string) => void }) {
  return item.publishedRunIds.includes(id) ? <button className="text-[#087d50] underline" onClick={() => onResult(id)}>{id}</button>
    : <span className="break-all">{id}</span>;
}
const fixtureStatusNames = { ready: "recorded ready", busy: "recorded busy", "recovery-required": "recorded recovery required", uncommissioned: "recorded uncommissioned" } as const;
function ResourceRow({ item, now, onResult }: { item: OverviewResourceObservation; now: number; onResult: (id: string) => void }) {
  const { observation: value, progress } = item;
  const status = resourceStatus(item, now), attention = resourceAttention(item, status.fresh);
  const owner = value.owner?.valid ? value.owner : undefined, checkpoint = value.lastCheckpoint?.available ? value.lastCheckpoint : undefined;
  const fixture = value.fixture;
  return <tr className="border-t border-[#eceeeb] align-top">
    <td className="px-4 py-3"><span className={"inline-block rounded-md px-2 py-1 text-[11px] font-medium " + status.colors}>{status.badge}</span></td>
    <td className="max-w-[210px] break-words px-4 py-3"><p>{item.hostId}</p>
      <p className="mt-1 text-[11px] text-[#68746d]">{item.resourceKey === "shared" ? "Shared guard: Mac UI, Mac audio and all glasses pairs"
        : "Android phone " + item.resourceKey.slice("android-".length) + " only; independent of the shared guard"}</p></td>
    <td className="max-w-[240px] break-words px-4 py-3 text-[11px]">
      {!value.owner ? <p>{value.guard.lock === "unreadable" ? "Guard unreadable" : "No guard owner"}</p>
        : !owner ? <p>Owner record invalid</p>
        : <><p>PID {owner.pid} · {owner.liveness === "alive" ? "alive" : owner.liveness === "dead" ? "not running" : "liveness unknown"} when observed</p>
          {owner.retainOnExit ? <p className="mt-1">{owner.reservation ? "Retains the guard for its run on exit" : "Retains the guard without a lifecycle reservation"}</p> : null}
          {owner.reservation ? <><p className="mt-1">Run: <RunReference id={owner.reservation.runID} item={item} onResult={onResult} /></p>
            <p className="mt-1 text-[#68746d]">Reserved fixture: {owner.reservation.fixtureID}</p></> : null}</>}
      {value.guard.reclaimMarker !== "absent" ? <p className="mt-1 text-[#805619]">Reclaim marker {value.guard.reclaimMarker}</p> : null}</td>
    <td className="min-w-[230px] max-w-[320px] px-4 py-3 text-[11px]">
      {checkpoint ? <><p>{checkpoint.mode === "complete" ? "Completed checkpoint" : checkpoint.mode === "recovering" ? "Recovery checkpoint" : "Running checkpoint"} · {checkpoint.phase}</p>
        {checkpoint.pendingOperation ? <p className="mt-1">Pending step: {checkpoint.pendingOperation.phase} / {checkpoint.pendingOperation.stepID}</p> : null}
        {checkpoint.pendingReconciliation ? <p className="mt-1">Pending reconciliation: {checkpoint.pendingReconciliation.phase} / {checkpoint.pendingReconciliation.stepID}</p> : null}</>
        : value.lastCheckpoint ? <p>Lifecycle checkpoint unavailable</p> : <p className="text-[#68746d]">No lifecycle checkpoint for this owner</p>}
      {progress ? <div className="mt-2">
        <p className="font-medium">{progress.action?.label ?? progress.step?.label ?? "No step reported"}</p>
        <p className="mt-0.5 text-[#68746d]">{progress.mode === "recovering" ? "Recovery · " : progress.mode === "complete" ? "Completed checkpoint · " : ""}{phaseNames[progress.phase]}
          {" · "}{progress.action ? progress.action.totalActions === null ? progress.action.completedActions + " actions completed; total unknown"
            : progress.action.completedActions + " of " + progress.action.totalActions + " actions completed" : "Lifecycle steps " + progress.completedSteps + "/" + progress.totalSteps + " in this phase"}</p>
        <p className="text-[#68746d]">Journal checkpoint {progress.sequence}, received {elapsed(progress.receivedAt, now)} ago</p></div> : null}
      {value.state === "retained-recovery-required" && (owner?.liveness === "dead" || checkpoint?.mode === "complete" || progress?.mode === "complete")
        ? <p className="mt-2 text-[#a64235]">A dead PID or completed checkpoint does not release this hold.</p> : null}
      <p className="mt-2 text-[#68746d]">{!fixture.checked ? "Fixture record not checked."
        : fixture.record !== "valid" ? "Fixture record " + fixture.record + "."
        : <>Fixture {fixture.fixtureID}: {fixtureStatusNames[fixture.status]} · last run <RunReference id={fixture.lastRunID} item={item} onResult={onResult} />. Context only, not admission.</>}</p></td>
    <td className="min-w-[230px] max-w-[320px] px-4 py-3 text-[11px]"><p className="font-medium">{attention.summary}</p>
      <p className="mt-1">Responsible: {attention.responsible}</p><p className="mt-1">Next: {attention.next}</p></td>
    <td className="whitespace-nowrap px-4 py-3 text-[11px]"><p>{elapsed(item.receivedAt, now)} ago</p>
      <p className="mt-0.5 text-[#68746d]">Revision {item.revision}</p>
      {!status.fresh ? <p className="mt-1 text-[#805619]">{value.state === "retained-recovery-required" ? "Kept until this host reports a newer observation" : "Not current"}</p> : null}</td>
  </tr>;
}
/** Latest reported host guards: never a CI job, readiness verdict, lock release or recovery control. */
function ResourceObservations({ data, now, onResult }: { data: TestRunOverview; now: number; onResult: (id: string) => void }) {
  const feed = data.resourceObservations;
  const items = [...feed?.items ?? []].map(item => ({ item, status: resourceStatus(item, now) }))
    .sort((a, b) => a.status.priority - b.status.priority || a.item.hostId.localeCompare(b.item.hostId) || a.item.resourceKey.localeCompare(b.item.resourceKey));
  const counts = new Map<string, number>();
  for (const { status } of items) counts.set(status.badge, (counts.get(status.badge) ?? 0) + 1);
  return <section className="mt-5" aria-label="Local resource observations">
    <h4 className="text-sm font-semibold">Local resource observations</h4>
    <p className="mt-1 text-xs text-[#68746d]">The latest guard observation each reporting host sent to Core. Reporting only: nothing here admits a routine, releases a guard or recovers a resource. Hosts and phones that do not report are not listed.</p>
    {!feed ? <p className="mt-2 text-xs text-[#805619]">Local resource observations were not reported by Core. Local ownership is not shown; do not treat any host or fixture as free.</p>
      : !feed.available ? <p className="mt-2 text-xs text-[#805619]">Local resource observations could not be loaded. Local ownership is unknown.</p>
      : !items.length ? <p className="mt-2 text-xs text-[#805619]">No host has reported a local resource observation. Local ownership is not covered by this view.</p>
      : <><div className="mt-2 flex flex-wrap gap-2 text-xs">{[...counts].map(([badge, count]) =>
          <span key={badge} className="rounded-md bg-[#f1f4ef] px-2 py-1"><strong>{count}</strong> {badge}</span>)}</div>
        <div className="mt-2 overflow-x-auto rounded-xl border border-[#e0e4de]"><table className="w-full text-left text-xs">
          <thead className="bg-[#f7f9f5] text-[11px] text-[#68746d]"><tr>{["Observed", "Host / resource", "Owner", "Checkpoint / fixture record", "Attention", "Received"].map(title =>
            <th key={title} className="px-4 py-2 font-medium">{title}</th>)}</tr></thead>
          <tbody>{items.map(({ item }) => <ResourceRow key={item.hostId + "/" + item.resourceKey} item={item} now={now} onResult={onResult} />)}</tbody>
        </table></div>
        {feed.truncated ? <p className="mt-2 text-xs text-[#805619]">More observations exist than shown. Only the newest observations and the newest with an observed owner are listed.</p> : null}</>}
  </section>;
}

export function TestRunOverviewView({ data, now, onResult, onCancel }: { data: TestRunOverview; now: number; onResult: (id: string) => void; onCancel?: (id: string) => Promise<void> }) {
  const states = ["running", "queued", "waiting", "blocked", "unknown"] as const;
  return <>
    <p className="mt-2 text-[11px] text-[#68746d]">View refreshed {elapsed(data.observedAt, now)} ago.</p>
    <div className="mt-3 flex flex-wrap gap-2 text-xs">{states.map(state => <span key={state} className="rounded-md bg-[#f1f4ef] px-2 py-1">
      <strong>{data.jobs.filter(job => job.state === state).length}</strong> {state}</span>)}</div>
    {data.warnings.length ? <div role="status" className="mt-3 space-y-1 rounded-lg bg-[#fff5df] p-3 text-xs text-[#805619]">{data.warnings.map(message => <p key={message}>{message}</p>)}</div> : null}
    {data.jobs.length ? <div className="mt-3 overflow-x-auto rounded-xl border border-[#e0e4de]"><table className="w-full text-left text-xs">
      <thead className="bg-[#f7f9f5] text-[11px] text-[#68746d]"><tr>{["Status", "Build / routine", "Worker / fixture", "Last recorded progress", "Elapsed / update"].map(title => <th key={title} className="px-4 py-2 font-medium">{title}</th>)}</tr></thead>
      <tbody>{data.jobs.map(job => <JobRow key={job.id} job={job} now={now} onResult={onResult} onCancel={onCancel} />)}</tbody>
    </table></div> : <p className="mt-3 text-sm text-[#68746d]">{data.warnings.length ? "No activity could be confirmed from the available sources."
      : data.fixtureAttention?.length ? unverifiedFixtures(data).length || !data.fixtureSummary?.length ? "No active jobs. Some CI return evidence below is not verified."
        : "No active jobs. Resolved follow-up history is below." : "No active jobs or unresolved claims were observed."}</p>}
    <ResourceObservations data={data} now={now} onResult={onResult} />
    {data.fixtureAttention?.length ? <FixtureHistory data={data} now={now} onResult={onResult} /> : null}
    {data.resolvedRecoveries.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-[#68746d]">Verified return evidence ({data.resolvedRecoveries.length})</summary>
      <ul className="mt-2 space-y-1">{data.resolvedRecoveries.map(item => <li key={item.requestId}>{item.fixtureId} · {item.kind === "late-result"
        ? <button className="text-[#087d50] underline" onClick={() => onResult(item.recoveryRunId)}>Completed result</button>
        : <>{item.originalAvailable === false ? <span>Original result not published</span> : <button className="text-[#087d50] underline" onClick={() => onResult(item.originalRunId)}>Original result</button>}
          {" · "}<button className="text-[#087d50] underline" onClick={() => onResult(item.recoveryRunId)}>Recovery result</button></>}</li>)}</ul></details> : null}
    {data.recentMaintenance.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-[#68746d]">Recent host maintenance (last 24 hours)</summary>
      <p className="mt-2 text-[#68746d]">These are host job outcomes, not routine test verdicts.</p>
      <ul className="mt-2 space-y-1">{data.recentMaintenance.map(job => <li key={job.id}>
        <a className="text-[#087d50] underline" href={job.workflow!.url} target="_blank" rel="noreferrer">Maintenance {job.workflow!.runId}</a>
        {" · "}{job.workflow!.conclusion ?? "unknown"}{" · "}{job.workerName ?? "Worker unavailable"}{" · "}{elapsed(job.workflow!.updatedAt, now)} ago
      </li>)}</ul></details> : null}
  </>;
}

export function TestRunOverviewPanel({ onResult }: { onResult: (id: string) => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ["admin-test-run-overview"], queryFn: () => api<TestRunOverview>("/api/admin/test-runs/overview"),
    refetchInterval: 15_000, retry: false });
  return <section className="border-b border-[#eceeeb] p-5" aria-label="Live test activity">
    <div className="flex items-start justify-between gap-4"><div><h3 className="font-semibold">Live activity</h3>
      <p className="mt-1 text-xs text-[#68746d]">All builds and triggers. Running jobs first; waiting requests oldest first. Execution order depends on GitHub and available workers.</p></div>
      <button className="text-xs text-[#087d50] underline" disabled={query.isFetching} onClick={() => query.refetch()}>{query.isFetching ? "Refreshing…" : "Refresh"}</button></div>
    {query.error ? <p role="alert" className="mt-3 text-xs text-[#a64235]">Live activity could not refresh. {query.data ? "The last view remains below." : "Try Refresh."}</p> : null}
    {query.data ? <TestRunOverviewView data={query.data} now={now} onResult={onResult} onCancel={async id => {
      await api("/api/admin/test-runs/claims/" + encodeURIComponent(id) + "/cancel-follow-up", { method: "POST", body: { confirmation: "cancel-follow-up" } });
      await query.refetch();
    }} /> : query.isPending ? <p className="mt-3 text-sm text-[#68746d]">Loading worker activity…</p> : null}
  </section>;
}
