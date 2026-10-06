import {frameworkRunHref} from "./routine-catalog";
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
export function TestSuitePage({suiteId}: {suiteId: string}) {
  const result = useQuery({queryKey: ["test-suite", suiteId],
    queryFn: () => api<TestSuiteResult>(`/api/admin/test-runs/suites/${encodeURIComponent(suiteId)}`),
    refetchInterval: query => query.state.data?.outcome === "running" ? 15000 : false});
  if (result.isPending) return <p role="status">Loading test suite…</p>;
  if (result.error) return <div role="alert" className={panel}><p>Could not load the test suite: {result.error.message}</p><button onClick={() => result.refetch()}>Try again</button></div>;
  const suite = result.data!;
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
      <span className={`rounded-lg px-3 py-2 text-sm font-semibold ${suite.outcome === "passed" ? "bg-green-100 text-green-800" : suite.outcome === "failed" ? "bg-red-100 text-red-800" : "bg-blue-100 text-blue-800"}`}>
        {suite.outcome === "passed" ? "All passed" : suite.outcome === "failed" ? "Failures" : "In progress"} · {suite.passed}/{suite.members.length} passed</span>
    </div>
    <p className="my-4 text-sm">Started {new Date(suite.startedAt).toLocaleString()}{suite.finishedAt ? ` · Finished ${new Date(suite.finishedAt).toLocaleString()} · ${runDuration(suite.startedAt, suite.finishedAt)}` : " · Refreshes every 15 seconds"}</p>
    {suite.build.producerUrl ? <a className="text-sm underline" href={suite.build.producerUrl} target="_blank" rel="noreferrer">Dispatched job / build in GitHub</a> : null}
    <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-[#68746d]"><th className="py-3">Routine</th><th>Lane</th><th>Result</th><th>Duration</th><th>Recording & steps</th></tr></thead>
      <tbody>{suite.members.map(member => <tr key={member.memberId} className="border-b last:border-0"><td className="py-4 font-medium">{member.routineId}</td><td>{member.platform === "ios-on-mac" ? "Mac" : member.platform === "android" ? "Android" : "iOS"}</td>
        <td className={member.status === "pass" ? "text-green-700" : member.status === "waiting" ? "text-[#68746d]" : "text-red-700"}>{member.status === "not-run" ? "Did not run" : member.status === "waiting" ? "Awaiting result" : member.status}
          {member.unavailableReason && <p className="mt-1 max-w-sm text-xs">{member.unavailableReason}</p>}</td>
        <td>{runDuration(member.startedAt, member.finishedAt) ?? "—"}</td><td>{member.runId ? <a className="underline" href={frameworkRunHref(member.runId)}>View run</a> : "Not available yet"}</td></tr>)}</tbody></table></div>
    {suite.failedRoutines.length ? <p className="mt-4 text-sm text-red-700">Failed or incomplete: {suite.failedRoutines.join(", ")}</p> : null}
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
      <span className={suite.outcome === "passed" ? "text-green-700" : suite.outcome === "failed" ? "text-red-700" : "text-blue-700"}>{suite.outcome} · {suite.passed}/{suite.members.length}</span></a>)}
  </section>;
}
