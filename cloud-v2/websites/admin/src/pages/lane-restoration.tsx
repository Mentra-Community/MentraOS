import {useQuery} from "@tanstack/react-query";
import {useEffect, useState} from "react";
import type {LaneRestorationAttempt, LaneRestorationHost, LaneRestorationList} from "../../../../packages/core/src/types/lane-restoration.types";
import {restorationHostIsFresh} from "../../../../packages/core/src/types/lane-restoration.types";
import {api} from "../lib/api";

const labels: Record<LaneRestorationAttempt["state"], string> = {
  "awaiting-fixer": "Awaiting agent", working: "Restoration in progress", "needs-input": "Needs human input",
  stopped: "Stopped before resumption", halted: "Halted · lane out of service", resumed: "Scheduling resumed", unknown: "Unknown outcome",
};
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Unknown";
export function restorationElapsed(attempt: LaneRestorationAttempt, observedAt: string) {
  const start = attempt.startedAt;
  const finish = attempt.finishedAt ?? observedAt;
  if (!start || !attempt.current && !attempt.finishedAt || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(finish)) || Date.parse(finish) < Date.parse(start)) return "Duration unknown";
  const seconds = Math.floor((Date.parse(finish) - Date.parse(start)) / 1000);
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return attempt.finishedAt ? duration : `${duration} at last observation`;
}
export function restorationOutcome(attempt: LaneRestorationAttempt) {
  return attempt.resume.status === "accepted" ? "Scheduling resumed" : labels[attempt.state];
}
function Attempt({attempt, observedAt}: {attempt: LaneRestorationAttempt; observedAt: string}) {
  const outcome = restorationOutcome(attempt), successful = attempt.resume.status === "accepted";
  return <article id={`restoration-${attempt.executionId}`} className="rounded-xl border border-[#dfe5dd] bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div>
      <h4 className="font-semibold text-[#202820]">{attempt.laneId}</h4>
      <span className={`mt-2 inline-block rounded-md px-2 py-1 text-xs font-semibold ${successful ? "bg-[#e6f5ed] text-[#087d50]" : ["stopped", "halted", "needs-input"].includes(attempt.state) ? "bg-[#fff0e9] text-[#a64235]" : "bg-[#f0f2ef] text-[#59655e]"}`}>{outcome}</span>
      <p className="mt-2 text-xs text-[#68746d]">{attempt.current ? "Current attempt" : "Historical attempt"} · {restorationElapsed(attempt, observedAt)}</p>
    </div><div className="text-xs text-[#68746d]">Started: {time(attempt.startedAt)}<br />Finished: {time(attempt.finishedAt)}</div></div>
    <p className="mt-3 text-sm text-[#59655e]">{attempt.report?.summary ?? "No restoration conclusion was recorded."}</p>
    {attempt.report?.question ? <p className="mt-2 text-sm text-[#a64235]"><strong>Human input:</strong> {attempt.report.question}</p> : null}
    {attempt.requiredAction ? <p className="mt-2 text-sm text-[#a64235]"><strong>Required action:</strong> {attempt.requiredAction}</p> : null}
    <div className="mt-3 rounded-lg bg-[#f5f7f3] p-3 text-xs text-[#59655e]">
      {attempt.resume.status === "accepted" ? <>Resume scheduling was called and accepted at {time(attempt.resume.calledAt)}.</>
        : attempt.resume.status === "refused" ? <>Resume scheduling was called and refused at {time(attempt.resume.calledAt)}. {attempt.resume.reason}</>
        : <>Resume call and acceptance: unknown. No controller receipt was recorded.</>}
      {attempt.report?.decision === "resume" && attempt.resume.status !== "accepted" ? <p className="mt-1">The agent reported an intention to resume; this does not establish scheduling resumption.</p> : null}
    </div>
    {attempt.actions.length || attempt.actionsTruncated ? <p className="mt-3 text-xs text-[#68746d]">Recorded cleanup operations: {attempt.actions.map(action => `${action.resourceId ?? "unknown resource"}: ${action.state}`).join(" · ")}{attempt.actionsTruncated ? " · additional operations omitted" : ""}</p> : null}
    <div className="mt-3 flex flex-wrap gap-3 text-xs font-medium text-[#087d50]">
      {attempt.runId ? <a className="underline" href={`/?testRun=${encodeURIComponent(attempt.runId)}`}>Open run</a>
        : attempt.requestId ? <a className="underline" href={`/?testRun=${encodeURIComponent(attempt.requestId)}`}>Open request</a> : <span className="font-normal text-[#68746d]">Run link unknown</span>}
      {attempt.incidentId ? <a className="underline" href={`/?report=${encodeURIComponent(attempt.incidentId)}`}>Open incident</a> : <span className="font-normal text-[#68746d]">Incident link unknown</span>}
    </div>
    <details className="mt-3 text-xs text-[#68746d]"><summary className="cursor-pointer">Recorded identities</summary>
      <dl className="mt-2 space-y-1 break-all"><div>Interruption: {attempt.interruptionId}</div><div>Agent execution: {attempt.executionId}</div>
        <div>Agent session: {attempt.sessionId ?? "Unknown"}</div><div>Generation: {attempt.generation ?? "Unknown"}</div><div>Lane handed to restoration: {time(attempt.handedOffAt)}</div>
        <div>Resume decision: {attempt.resume.decisionId ?? "Unknown"}</div><div>Report: {attempt.report?.reportId ?? "Unknown"}</div></dl>
    </details>
  </article>;
}
export function RestorationHost({host, fresh, laneId}: {host: LaneRestorationHost; fresh: boolean; laneId?: string}) {
  const lanes = host.lanes.filter(lane => !laneId || lane.id === laneId);
  return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{host.hostId}</h3>
    <p className="text-xs text-[#68746d]">{fresh ? "Controller reporting" : "Current controller state unknown"} · Last received {time(host.receivedAt)}</p></div>
    <div className="flex flex-wrap gap-2">{lanes.map(lane => <a key={lane.id} href={`#lane-${host.hostId}-${lane.id}`} className="rounded-lg border border-[#dfe5dd] px-3 py-2 text-xs text-[#59655e]">
      {lane.id} · {fresh ? lane.state.replaceAll("-", " ") : `last reported ${lane.state.replaceAll("-", " ")}`} · {lane.dispatchMode}</a>)}</div>
    {!host.restoration ? <p className="rounded-xl bg-[#f5f7f3] p-4 text-sm text-[#68746d]">Restoration attempts and resume receipts are unknown. This controller has not reported restoration records.</p>
      : !host.restoration.attempts.some(attempt => !laneId || attempt.laneId === laneId) ? <p className="text-sm text-[#68746d]">No restoration attempt is present in the controller's retained history for {laneId ? "this lane" : "these lanes"}.</p>
      : <>{lanes.map(lane => {const attempts = host.restoration!.attempts.filter(row => row.laneId === lane.id); return <div id={`lane-${host.hostId}-${lane.id}`} key={lane.id} className="space-y-3">
        {attempts.map(attempt => <Attempt key={attempt.executionId} attempt={attempt} observedAt={host.observedAt} />)}</div>;})}</>}
    {host.restoration?.truncated ? <p className="text-xs text-[#a64235]">The controller reports only a bounded portion of its restoration history. Older attempts may be absent.</p> : null}
  </section>;
}
export function LaneRestorationPage() {
  const query = useQuery({queryKey: ["lane-restoration"], queryFn: () => api<LaneRestorationList>("/api/admin/test-runs/restoration/list"), refetchInterval: 30_000});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {const id = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(id);}, []);
  return <div className="space-y-5"><div className="flex flex-wrap items-start justify-between gap-3"><div>
    <h2 className="text-xl font-semibold">Lane restoration</h2><p className="mt-1 text-sm text-[#68746d]">Controller-recorded agent attempts and scheduling decisions. A stopped agent or a request for help is not successful restoration.</p>
    <a href="/?systemHealth=1" className="mt-2 inline-block text-sm font-medium text-[#087d50] underline">Back to System health</a></div>
    <button className="text-sm font-medium text-[#087d50] underline" onClick={() => void query.refetch()}>Refresh</button></div>
    {query.isError ? <p className="text-sm text-[#a64235]">Restoration records could not refresh. Current status is unknown; any displayed history is the last received observation.</p> : null}
    {query.data?.hosts.map(host => <RestorationHost key={host.hostId} host={host} fresh={!query.isError && restorationHostIsFresh(host, now, query.data!.freshForMs)} />)}
    {!query.data?.hosts.length ? <p className="text-sm text-[#68746d]">{query.isPending ? "Loading restoration records…" : "No controller lane observation is available. Restoration status is unknown."}</p> : null}
    {query.data?.truncated ? <p className="text-xs text-[#a64235]">Only the first 32 reporting controllers are shown.</p> : null}
    <p className="text-xs text-[#68746d]">Agent elapsed time starts at the recorded invocation. The lane handoff time and its ten-minute alert are separate. Missing start, end or receipt data stays unknown. This page does not start agents, answer questions or resume a lane.</p>
  </div>;
}
