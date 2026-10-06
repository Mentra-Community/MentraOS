import {frameworkRunHref} from "./routine-catalog";
import {useState} from "react";
import {AttemptHistory, AttemptLine, ChildReruns, RerunForm} from "./test-reruns";
import type {RerunAttempt} from "../../../../packages/core/src/types/test-rerun.types";
import {useQuery} from "@tanstack/react-query";
import {api} from "../lib/api";
import {runDuration} from "../lib/run-duration";
import {frameworkIdentitySchema} from "../../../../packages/core/src/types/framework-request.types";

export interface TestSuiteResult {
  suiteId: string; channel: string; trigger: string; startedAt: string; finishedAt?: string;
  build: {headSha: string; release?: string; producerUrl?: string};
  outcome: "running" | "passed" | "failed"; passed: number; failedRoutines: string[];
  members: {memberId: string; requestId?: string; routineId: string; platform: string; status: string; publicationComplete?: boolean; runId?: string; startedAt?: string; finishedAt?: string; unavailableReason?: string; rejectedAt?: string}[];
}
export function readSuiteId(search: string) {
  const query = new URLSearchParams(search);
  const id = query.get("testSuite");
  return query.getAll("testSuite").length === 1 && id && frameworkIdentitySchema.safeParse(id).success ? id : null;
}
const panel = "rounded-2xl border border-[#e0e4de] bg-white p-6";
const isFailure = (status: string) => ["failed", "setup-failed", "teardown-failed"].includes(status);
const resultColor = (status: string) => status === "pass" ? "text-green-700" : isFailure(status) ? "text-red-700" : "text-[#68746d]";
function suitePresentation(suite: TestSuiteResult) {
  if (suite.outcome === "passed") return {label: "All passed", color: "bg-green-100 text-green-800"};
  if (suite.members.some(member => isFailure(member.status))) return {label: "Failures", color: "bg-red-100 text-red-800"};
  if (suite.outcome === "running") return {label: "In progress", color: "bg-blue-100 text-blue-800"};
  return {label: "Incomplete", color: "bg-gray-100 text-[#68746d]"};
}
export function TestSuitePage({suiteId}: {suiteId: string}) {
  const result = useQuery({queryKey: ["test-suite", suiteId],
    queryFn: () => api<TestSuiteResult>(`/api/admin/test-runs/suites/${encodeURIComponent(suiteId)}`),
    refetchInterval: query => query.state.data?.outcome === "running" ? 15000 : false});
  const [selected,setSelected] = useState<string[]>([]);
  const [dispatchMembers,setDispatchMembers] = useState<string[] | null>(null);
  const progress = useQuery({queryKey:["rerun-progress",suiteId],
    queryFn:()=>api<{members:{memberId:string;latest:RerunAttempt|null}[];children:{rerunId:string;reason:string}[]}>(`/api/admin/test-runs/reruns/suite/${encodeURIComponent(suiteId)}/progress`),refetchInterval:15000});
  if (result.isPending) return <p role="status">Loading test suite…</p>;
  if (result.error) return <div role="alert" className={panel}><p>Could not load the test suite: {result.error.message}</p><button onClick={() => result.refetch()}>Try again</button></div>;
  const suite = result.data!;
  const presentation = suitePresentation(suite);
  const members = [...suite.members].sort((a, b) => {
    const aTime = a.startedAt ? Date.parse(a.startedAt) : NaN;
    const bTime = b.startedAt ? Date.parse(b.startedAt) : NaN;
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
    if (!Number.isFinite(bTime)) return -1;
    return aTime - bTime;
  });
  const failedRoutines = [...new Set(members.filter(member => isFailure(member.status)).map(member => member.routineId))];
  const incompleteRoutines = suite.failedRoutines.filter(id => !failedRoutines.includes(id));
  if (suite.members.length < 2) {
    const member = suite.members[0];
    return <section className={panel}>
      <a className="text-sm underline" href="/?testRuns=1">All test runs</a>
      <h2 className="mt-4 text-xl font-bold">Individual routine run</h2>
      <p className="mt-2">This job contains {suite.members.length} routine{suite.members.length === 1 ? "" : "s"} and is not a test suite.</p>
      {member && <p className="mt-3">{member.routineId} · {member.status}{member.runId && <> · <a className="underline" href={frameworkRunHref(member.runId)}>View run</a></>}</p>}
    </section>;
  }
  return <section className={panel}>
    <a className="text-sm underline" href="/?testRuns=1">All test runs</a>
    <div className="mt-4 flex items-start justify-between gap-4">
      <div><h2 className="text-xl font-bold">{suite.channel === "dev" ? "Dev" : suite.channel} {suite.trigger} test suite</h2>
        <p className="mt-1 text-sm text-[#68746d]">{suite.build.release ?? suite.build.headSha.slice(0, 10)} · {suite.build.headSha.slice(0, 10)}</p></div>
      <span className={`rounded-lg px-3 py-2 text-sm font-semibold ${presentation.color}`}>
        {presentation.label} · {suite.passed}/{suite.members.length} passed</span>
    </div>
    <p className="my-4 text-sm">Started {new Date(suite.startedAt).toLocaleString()}{suite.finishedAt ? ` · Finished ${new Date(suite.finishedAt).toLocaleString()} · ${runDuration(suite.startedAt, suite.finishedAt)}` : " · Refreshes every 15 seconds"}</p>
    {suite.build.producerUrl ? <a className="text-sm underline" href={suite.build.producerUrl} target="_blank" rel="noreferrer">Dispatched job / build in GitHub</a> : null}
    <div className="my-4 flex gap-4"><button className="underline" disabled={!failedRoutines.length} onClick={()=>setDispatchMembers(members.filter(m=>isFailure(m.status)).map(m=>m.memberId))}>Rerun failures</button>
      <button className="underline" disabled={!selected.length} onClick={()=>setDispatchMembers(selected)}>Rerun selected ({selected.length})</button></div>
    {dispatchMembers && <RerunForm key={dispatchMembers.join(",")} suiteId={suiteId} memberIds={dispatchMembers} onClose={()=>setDispatchMembers(null)}/>}
    {progress.data && <p className="my-3 text-sm">Repair progress: {members.filter(m=>isFailure(m.status)).length} originally failed · {members.filter(m=>isFailure(m.status)&&progress.data.members.some(p=>p.memberId===m.memberId&&p.latest?.status==="pass"&&p.latest.publicationComplete)).length} passed on rerun · {members.filter(m=>isFailure(m.status)&&progress.data.members.some(p=>p.memberId===m.memberId&&["queued","accepted","running","admission-pending"].includes(p.latest?.status??""))).length} pending · {members.filter(m=>isFailure(m.status)&&!progress.data.members.some(p=>p.memberId===m.memberId&&((p.latest?.status==="pass"&&p.latest.publicationComplete)||["queued","accepted","running","admission-pending"].includes(p.latest?.status??"")))).length} unresolved. Original verdict remains {suite.outcome}.</p>}
    {progress.error && <p role="alert">Rerun progress unavailable. <button onClick={()=>progress.refetch()}>Retry</button></p>}
    <ChildReruns suiteId={suiteId}/>
    <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm [&_th]:pr-4 [&_td]:pr-4 [&_td]:py-3 [&_td]:align-top"><thead><tr className="border-b text-[#68746d]"><th className="py-3">Routine</th><th>Lane</th><th>Original result</th><th className="min-w-[320px]">Latest rerun</th><th>Started</th><th>Duration</th><th>Recording & steps</th></tr></thead>
      <tbody>{members.map(member => <tr key={member.memberId} className="border-b last:border-0"><td className="py-4 font-medium">{member.routineId}</td><td>{member.platform === "ios-on-mac" ? "Mac" : member.platform === "android" ? "Android" : "iOS"}</td>
        <td className={resultColor(member.status)}>{member.status === "not-run" ? "Did not run" : member.status === "waiting" ? "Awaiting result" : member.status}<label><input type="checkbox" aria-label={`Select ${member.memberId}`} disabled={!["pass","failed","setup-failed","teardown-failed","not-run","cancelled","incomplete"].includes(member.status)} checked={selected.includes(member.memberId)} onChange={e=>setSelected(old=>e.target.checked?[...old,member.memberId]:old.filter(id=>id!==member.memberId))}/> </label>
          {member.unavailableReason && <p className="mt-1 max-w-sm text-xs">{member.unavailableReason}</p>}</td>
        <td>{progress.data?.members.find(m=>m.memberId===member.memberId)?.latest ? <AttemptLine attempt={progress.data.members.find(m=>m.memberId===member.memberId)!.latest!}/> : "No reruns"}<AttemptHistory suiteId={suiteId} memberId={member.memberId}/></td>
        <td className="whitespace-nowrap">{member.startedAt ? <time dateTime={member.startedAt}>{new Date(member.startedAt).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true})}</time> : "—"}</td>
        <td>{runDuration(member.startedAt, member.finishedAt) ?? "—"}</td><td>{member.runId ? <a className="underline" href={frameworkRunHref(member.runId)}>View run</a> : "Not available yet"}</td></tr>)}</tbody></table></div>
    {failedRoutines.length ? <p className="mt-4 text-sm text-red-700">Failed: {failedRoutines.join(", ")}</p> : null}
    {incompleteRoutines.length ? <p className="mt-4 text-sm text-[#68746d]">Incomplete: {incompleteRoutines.join(", ")}</p> : null}
  </section>;
}
export function RecentTestSuites() {
  const result = useQuery({queryKey: ["test-suites"], queryFn: () => api<{suites: TestSuiteResult[]}>("/api/admin/test-runs/suite-index/list"), refetchInterval: 30000});
  if (result.isPending) return null;
  if (result.error) return <p className="text-sm text-red-700">Test suites could not refresh. <button className="underline" onClick={() => result.refetch()}>Retry</button></p>;
  if (!result.data?.suites.length) return null;
  return <section className={panel}><h2 className="text-xl font-bold">Recent test suites</h2><p className="my-2 text-sm text-[#68746d]">One dispatched job, with all of its routine results.</p>
    {result.data.suites.map(suite => <a key={suite.suiteId} className="flex justify-between gap-4 border-b py-3 last:border-0" href={`/?testSuite=${encodeURIComponent(suite.suiteId)}`}>
      <span>{suite.channel} · {suite.trigger} · {suite.build.release ?? suite.build.headSha.slice(0, 10)}<span className="ml-3 text-xs text-[#68746d]">{new Date(suite.startedAt).toLocaleString()}</span></span>
      <span className={`rounded-lg px-2 py-1 ${suitePresentation(suite).color}`}>{suitePresentation(suite).label} · {suite.passed}/{suite.members.length}</span></a>)}
  </section>;
}
