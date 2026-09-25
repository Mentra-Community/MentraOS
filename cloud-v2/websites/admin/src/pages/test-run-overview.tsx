import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { OverviewClaim, OverviewFixtureSummary, OverviewJob, OverviewRequest, TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
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
  "current-work": { badge: "current work", colors: "bg-[#fff0e9] text-[#a64235]", next: "Follow the newer work on this fixture in Live activity above." },
  unverified: { badge: "unverified", colors: "bg-[#fff5df] text-[#805619]",
    next: "Confirm this fixture's present state. If it is not ready, recover it once and publish verified return evidence." },
  "later-return-verified": { badge: "returned later", colors: "bg-[#e6f5ed] text-[#087d50]",
    next: "No recovery is needed for these cancelled attempts. Activity after that return is not checked here." },
};
/** Summaries from Core; an older response without them is treated as unverified per worker/fixture, never as ready. */
function summaries(data: TestRunOverview): OverviewFixtureSummary[] {
  if (data.fixtureSummary) return data.fixtureSummary;
  const groups = new Map<string, OverviewClaim[]>();
  for (const claim of (data.fixtureAttention ?? []).flatMap(job => job.claims)) {
    const key = JSON.stringify([claim.workerId, claim.fixtureId]);
    groups.set(key, [...groups.get(key) ?? [], claim]);
  }
  return [...groups.values()].map(claims => {
    claims.sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
    return { workerId: claims[0]!.workerId, fixtureId: claims[0]!.fixtureId, status: "unverified",
      cancelledRequestIds: claims.map(claim => claim.requestId), latestCancelledClaimAt: claims[0]!.claimedAt };
  });
}
const unverifiedFixtures = (data: TestRunOverview) => summaries(data).filter(item => item.status !== "later-return-verified");
function FixtureHistory({ data, now, onResult }: { data: TestRunOverview; now: number; onResult: (id: string) => void }) {
  const items = summaries(data), attempts = data.fixtureAttention ?? [];
  const count = (status: OverviewFixtureSummary["status"]) => items.filter(item => item.status === status).length;
  return <section className="mt-5" aria-label="Fixture readiness after cancelled follow-up">
    <h4 className="text-sm font-semibold">Fixture readiness after cancelled follow-up</h4>
    <p className="mt-1 text-xs text-[#68746d]">One row per worker and fixture. Cancelled attempts are history, not running jobs; their results are unchanged.
      Only newer claims on the same worker and fixture are compared.</p>
    <div className="mt-2 flex flex-wrap gap-2 text-xs">{(["current-work", "unverified", "later-return-verified"] as const).map(status =>
      <span key={status} className="rounded-md bg-[#f1f4ef] px-2 py-1"><strong>{count(status)}</strong> {summaryText[status].badge}</span>)}</div>
    <div className="mt-2 overflow-x-auto rounded-xl border border-[#e0e4de]"><table className="w-full text-left text-xs">
      <thead className="bg-[#f7f9f5] text-[11px] text-[#68746d]"><tr>{["Readiness", "Worker / fixture", "Latest evidence", "Next action"].map(title => <th key={title} className="px-4 py-2 font-medium">{title}</th>)}</tr></thead>
      <tbody>{items.map(item => <tr key={item.workerId + "/" + item.fixtureId} className="border-t border-[#eceeeb] align-top">
        <td className="px-4 py-3"><span className={"inline-block rounded-md px-2 py-1 text-[11px] font-medium " + summaryText[item.status].colors}>{summaryText[item.status].badge}</span></td>
        <td className="max-w-[190px] break-words px-4 py-3"><p>{item.workerId}</p><p className="mt-1 text-[11px] text-[#68746d]">Fixture: {item.fixtureId}</p></td>
        <td className="min-w-[250px] max-w-[340px] px-4 py-3 text-[11px]">
          <p>{item.cancelledRequestIds.length} cancelled {item.cancelledRequestIds.length === 1 ? "attempt" : "attempts"} without their own verified return; newest claimed {elapsed(item.latestCancelledClaimAt, now)} ago.</p>
          {item.status === "current-work" ? <p className="mt-1">Newer work on this fixture is in Live activity: {item.currentRequestIds?.join(", ")}.</p> : null}
          {item.laterReturn ? <p className="mt-1">A newer request, {item.laterReturn.requestId}, published verified return evidence.{" "}
            <button className="text-[#087d50] underline" onClick={() => onResult(item.laterReturn!.recoveryRunId)}>Return result</button></p> : null}
          {item.status === "unverified" ? <p className="mt-1">This view has no newer claim or verified return for this worker and fixture, so it cannot prove the fixture's present state.</p> : null}
        </td>
        <td className="min-w-[220px] max-w-[300px] px-4 py-3 text-[11px]"><p>{summaryText[item.status].next}</p>
          {item.status !== "later-return-verified" ? <p className="mt-1">Responsible: Test runner / operator</p> : null}</td>
      </tr>)}</tbody>
    </table></div>
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-[#68746d]">Cancelled attempt history ({attempts.length})</summary>
      <ul className="mt-2 space-y-2">{attempts.map(job => <li key={job.id}>
        {job.requests.length ? job.requests.map(request => <RequestLabel key={request.requestId} request={request} />) : <p className="font-medium">{job.claims[0]?.requestId ?? job.title}</p>}
        <p className="text-[11px] text-[#68746d]">{job.claims[0] ? job.claims[0].workerId + " · Fixture: " + job.claims[0].fixtureId : "Fixture not reported"}
          {job.attention?.cancelledAt ? " · Follow-up cancelled " + elapsed(job.attention.cancelledAt, now) + " ago" : ""}</p>
        {job.attention ? <p className="text-[11px]">{job.attention.reason}</p> : null}
        {job.resultRunId ? <button className="text-[11px] text-[#087d50] underline" onClick={() => onResult(job.resultRunId!)}>Recorded result</button> : null}
      </li>)}</ul></details>
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
      : data.fixtureAttention?.length ? unverifiedFixtures(data).length ? "No active jobs. Fixture readiness below is unverified."
        : "No active jobs. Cancelled attempt history is below." : "No active jobs or unresolved claims were observed."}</p>}
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
