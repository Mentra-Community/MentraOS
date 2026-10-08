import {LoadingIndicator} from "../components/loading-indicator";
import {HistoryStatus} from "../components/test-history-table";
import {TESTING_PANEL, TESTING_LINK, TestingButton} from "../components/testing-ui";
import {frameworkRunHref} from "./routine-catalog";
import {useState} from "react";
import {AttemptHistory, AttemptLine, ChildReruns, RerunForm} from "./test-reruns";
import {rerunTerminalStatuses, type RerunAttempt} from "../../../../packages/core/src/types/test-rerun.types";
import {RefreshCw} from "lucide-react";
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
const panel = TESTING_PANEL;
const isFailure = (status: string) => ["failed", "setup-failed", "teardown-failed"].includes(status);
const pendingPassCount = (suite: TestSuiteResult) => suite.members.filter(member => member.status === "pass" && member.publicationComplete !== true).length;
const memberStatus = (member: TestSuiteResult["members"][number]) => member.status === "pass" ? member.publicationComplete === true ? "Passed" : "Passed · evidence pending"
  : member.status === "not-run" ? "Did not run" : member.status === "waiting" ? "Awaiting result" : member.status;
function suitePresentation(suite: TestSuiteResult) {
  if (suite.outcome === "passed") return {label: "All passed", color: "bg-green-100 text-green-800"};
  if (suite.members.some(member => isFailure(member.status))) return {label: "Failures", color: "bg-red-100 text-red-800"};
  if (suite.outcome === "running") return {label: "In progress", color: "bg-blue-100 text-blue-800"};
  return {label: "Incomplete", color: "bg-gray-100 text-[#68746d]"};
}
export function TestSuitePage({suiteId}: {suiteId: string}) {
  const result = useQuery({queryKey: ["test-suite-summary", suiteId],
    queryFn: () => api<TestSuiteResult>(`/api/admin/test-runs/suites/${encodeURIComponent(suiteId)}/summary`),
    refetchInterval: query => query.state.data?.outcome === "running" ? 15000 : false});
  const [dispatchMembers,setDispatchMembers] = useState<string[] | null>(null);
  const progress = useQuery({queryKey:["rerun-progress",suiteId],
    queryFn:()=>api<{members:{memberId:string;latest:RerunAttempt|null}[];children:{rerunId:string;reason:string}[]}>(`/api/admin/test-runs/reruns/suite/${encodeURIComponent(suiteId)}/progress`),refetchInterval:15000});
  if (result.isPending) return <LoadingIndicator label="Loading test suite" />;
  if (result.error) return <div role="alert" className={panel}><p>Could not load the test suite: {result.error.message}</p><TestingButton onClick={() => result.refetch()}>Try again</TestingButton></div>;
  const suite = result.data!;
  const presentation = suitePresentation(suite);
  const members = [...suite.members].sort((a, b) => {
    const aTime = a.startedAt ? Date.parse(a.startedAt) : NaN;
    const bTime = b.startedAt ? Date.parse(b.startedAt) : NaN;
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
    if (!Number.isFinite(bTime)) return -1;
    return aTime - bTime;
  });
  const latestAttempt = (memberId: string) => progress.data?.members.find(member => member.memberId === memberId)?.latest;
  const canRerun = (member: TestSuiteResult["members"][number]) => {
    const observed = progress.data?.members.find(value => value.memberId === member.memberId);
    return !!observed && (rerunTerminalStatuses as readonly string[]).includes(member.status) &&
      (!observed.latest || (rerunTerminalStatuses as readonly string[]).includes(observed.latest.status));
  };
  const rerunnableFailures = members.filter(member => isFailure(member.status) && canRerun(member));
  const failedRoutines = [...new Set(members.filter(member => isFailure(member.status)).map(member => member.routineId))];
  const incompleteRoutines = suite.failedRoutines.filter(id => !failedRoutines.includes(id));
  if (suite.members.length < 2) {
    const member = suite.members[0];
    return <section className={panel}>
      <a className={`${TESTING_LINK} text-sm`} href="/?testRuns=1">All test runs</a>
      <h2 className="mt-4 text-xl font-bold">Individual routine run</h2>
      <p className="mt-2">This job contains {suite.members.length} routine{suite.members.length === 1 ? "" : "s"} and is not a test suite.</p>
      {member && <p className="mt-3">{member.routineId} · {memberStatus(member)}{member.runId && <> · <a className={TESTING_LINK} href={frameworkRunHref(member.runId)}>View run</a></>}</p>}
    </section>;
  }
  return <section className={panel}>
    <a className={`${TESTING_LINK} text-sm`} href="/?testRuns=1">All test runs</a>
    <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-xl font-bold">{suite.channel === "dev" ? "Dev" : suite.channel} {suite.trigger} test suite</h2>
        <p className="mt-1 text-sm text-[#68746d]">{suite.build.release ?? suite.build.headSha.slice(0, 10)} · {suite.build.headSha.slice(0, 10)}</p></div>
      <span className={`rounded-full px-3 py-1 text-xs font-medium ${presentation.color}`}>
        {presentation.label} · {suite.passed}/{suite.members.length} passed with complete evidence</span>
    </div>
    <p className="mt-3 text-xs text-[#747780]">{pendingPassCount(suite) > 0 && `${pendingPassCount(suite)} passed · evidence pending`}</p>
    <p className="my-4 text-sm">Started {new Date(suite.startedAt).toLocaleString()}{suite.finishedAt ? ` · Finished ${new Date(suite.finishedAt).toLocaleString()} · ${runDuration(suite.startedAt, suite.finishedAt)}` : " · Refreshes every 15 seconds"}</p>
    {suite.build.producerUrl ? <a className={`${TESTING_LINK} text-sm`} href={suite.build.producerUrl} target="_blank" rel="noreferrer">Dispatched job / build in GitHub</a> : null}
    <div className="my-4"><TestingButton disabled={!rerunnableFailures.length} onClick={()=>setDispatchMembers(rerunnableFailures.map(member=>member.memberId))}>Rerun failures</TestingButton></div>
    {dispatchMembers && <RerunForm key={dispatchMembers.join(",")} suiteId={suiteId} memberIds={dispatchMembers} onClose={()=>setDispatchMembers(null)}/>}
    {progress.data && <p className="my-3 text-sm">Repair progress: {members.filter(m=>isFailure(m.status)).length} originally failed · {members.filter(m=>isFailure(m.status)&&progress.data.members.some(p=>p.memberId===m.memberId&&p.latest?.status==="pass"&&p.latest.publicationComplete)).length} passed on rerun · {members.filter(m=>isFailure(m.status)&&progress.data.members.some(p=>p.memberId===m.memberId&&["queued","accepted","running","admission-pending"].includes(p.latest?.status??""))).length} pending · {members.filter(m=>isFailure(m.status)&&!progress.data.members.some(p=>p.memberId===m.memberId&&((p.latest?.status==="pass"&&p.latest.publicationComplete)||["queued","accepted","running","admission-pending"].includes(p.latest?.status??"")))).length} unresolved. Original verdict remains {suite.outcome}.</p>}
    {progress.error && <p role="alert">Rerun progress unavailable. <TestingButton onClick={()=>progress.refetch()}>Retry</TestingButton></p>}
    <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Rerun batches{progress.data ? ` (${progress.data.children.length})` : ""}</summary><ChildReruns suiteId={suiteId}/></details>
    <div className="mt-4 overflow-x-auto rounded-xl border border-[#e0e4de]">
      <table aria-label="Suite routines" className="w-full text-left text-sm [&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 [&_td]:align-top">
        <thead className="bg-[#f6f8fa]"><tr className="border-b text-xs font-medium text-[#747780]"><th>Started</th><th>Name</th><th>Duration</th><th>Lane</th><th>Tested build</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{members.map(member => <tr key={member.memberId} className="border-b last:border-0 hover:bg-[#fafbfa]">
          <td className="whitespace-nowrap tabular-nums">{member.startedAt ? <time dateTime={member.startedAt}>{new Date(member.startedAt).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true})}</time> : "—"}</td>
          <td className="min-w-48">{member.runId || member.requestId
            ? <a className={TESTING_LINK} href={frameworkRunHref(member.runId ?? member.requestId!)}>{member.routineId.replace(/[-_]+/g, " ")}</a>
            : <><span className="font-medium">{member.routineId.replace(/[-_]+/g, " ")}</span><p className="mt-1 text-xs text-[#747780]">Not available yet</p></>}
            {latestAttempt(member.memberId) && <details className="mt-2 text-xs text-[#747780]"><summary className="cursor-pointer">Latest rerun · {memberStatus({...member, ...latestAttempt(member.memberId)!}).replaceAll("-", " ")}</summary>
              <AttemptLine attempt={latestAttempt(member.memberId)!}/><AttemptHistory suiteId={suiteId} memberId={member.memberId}/>
            </details>}
          </td>
          <td className="whitespace-nowrap tabular-nums">{runDuration(member.startedAt, member.finishedAt) ?? "—"}</td>
          <td className="whitespace-nowrap text-xs text-[#747780]">{member.platform === "ios-on-mac" ? "Mac" : member.platform === "android" ? "Android" : "iOS"}</td>
          <td className="whitespace-nowrap text-xs" title={suite.build.headSha}>{suite.build.release ?? suite.build.headSha.slice(0, 10)}</td>
          <td><HistoryStatus outcome={member.status === "pass" && member.publicationComplete !== true ? "evidence pending" : member.status}/>
            {member.status === "not-run" && <span className="sr-only">Did not run</span>}
            {member.unavailableReason && <details className="mt-2 min-w-40 max-w-xs text-xs text-[#747780]"><summary className="cursor-pointer">Failure reason</summary><p className="mt-2 break-words">{member.unavailableReason}</p></details>}
          </td>
          <td><TestingButton variant="ghost" size="icon-sm" title="Rerun" aria-label={`Rerun ${member.routineId} (${member.platform})`} disabled={!canRerun(member)}
            onClick={()=>setDispatchMembers([member.memberId])}><RefreshCw size={16} aria-hidden="true"/></TestingButton></td>
        </tr>)}</tbody>
      </table>
    </div>
    {failedRoutines.length ? <p className="mt-4 text-sm text-red-700">Failed: {failedRoutines.join(", ")}</p> : null}
    {incompleteRoutines.length ? <p className="mt-4 text-sm text-[#68746d]">Incomplete: {incompleteRoutines.join(", ")}</p> : null}
  </section>;
}
export function RecentTestSuites() {
  const result = useQuery({queryKey: ["test-suites"], queryFn: () => api<{suites: TestSuiteResult[]}>("/api/admin/test-runs/suite-index/list"), refetchInterval: 30000});
  if (result.isPending) return null;
  if (result.error) return <p className="text-sm text-red-700">Test suites could not refresh. <TestingButton onClick={() => result.refetch()}>Retry</TestingButton></p>;
  if (!result.data?.suites.length) return null;
  return <section className={panel}><h2 className="text-xl font-bold">Recent test suites</h2><p className="my-2 text-sm text-[#68746d]">One dispatched job, with all of its routine results.</p>
    {result.data.suites.map(suite => <a key={suite.suiteId} className="flex justify-between gap-4 border-b py-3 last:border-0" href={`/?testSuite=${encodeURIComponent(suite.suiteId)}`}>
      <span>{suite.channel} · {suite.trigger} · {suite.build.release ?? suite.build.headSha.slice(0, 10)}<span className="ml-3 text-xs text-[#68746d]">{new Date(suite.startedAt).toLocaleString()}</span></span>
      <span className={`rounded-lg px-2 py-1 ${suitePresentation(suite).color}`}>{suitePresentation(suite).label} · {suite.passed}/{suite.members.length} passed with complete evidence
        {pendingPassCount(suite) > 0 && ` · ${pendingPassCount(suite)} passed with pending evidence`}</span></a>)}
  </section>;
}
