import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, ExternalLink, GitPullRequest, Loader2, RefreshCcw } from "lucide-react";
import { useState } from "react";
import type { FixFlow, FixFlowList } from "../../../../packages/core/src/types/fix-flow.types";
import { FixFlowBot } from "../components/fix-flow-bot";
import { FLOW_STAGES, FLOW_CURRENT_STATES, currentStateInfo, filterFixFlowGroups, flowStatus, groupFixFlows, type FixFlowGroup, type FlowFilter } from "../lib/fix-flow-groups";
import "./fix-flows.css";
import { Button } from "../components/ui/button";
import { api } from "../lib/api";
import { fixFlowApiPath, fixFlowHref, type FixFlowLink } from "../lib/fix-flow-links";

const PANEL = "rounded-[24px] border border-[#e0e4de] bg-white shadow-sm";
const LINK = "font-medium text-[#087d50] underline underline-offset-2";
type PendingFlow = { pending: true; runId: string; chapterId: string; message: string };
type FlowChoices = { runId: string; chapterId: string; choices: Array<{ occurrenceId: string; phase: string; code: string; message: string }> };
const date = (value: string) => new Date(value).toLocaleString();
const stateColors = { active: "bg-[#fff7da] text-[#80651a]", running: "bg-[#e8f4eb] text-[#087d50]", waiting: "bg-[#eef0f3] text-[#4f5965]", attention: "bg-[#fff0e9] text-[#a64235]",
  completed: "bg-[#eef0f3] text-[#4f5965]", unknown: "bg-[#fff7da] text-[#80651a]" };

export function FixFlowsPage({ selection, onSelect }: { selection: FixFlowLink | null; onSelect: (value: FixFlowLink | null) => void }) {
  const [filter, setFilter] = useState<FlowFilter>(null);
  const list = useQuery({ queryKey: ["admin-fix-flows"], queryFn: () => api<FixFlowList>("/api/admin/fix-flows"),
    enabled: !selection, refetchInterval: 15_000 });
  const detail = useQuery({ queryKey: ["admin-fix-flow", selection],
    queryFn: () => api<FixFlow | PendingFlow | FlowChoices>(fixFlowApiPath(selection!)), enabled: !!selection, refetchInterval: 15_000 });
  const current = selection ? detail : list;
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3">
      {selection ? <Button variant="ghost" onClick={() => onSelect(null)}><ArrowLeft className="size-4" /> All fix flows</Button>
        : <p className="text-sm text-[#68746d]">Needs attention first · refreshes every 15 seconds</p>}
      <Button variant="outline" onClick={() => current.refetch()} disabled={current.isFetching}>
        <RefreshCcw className={`size-4 ${current.isFetching ? "animate-spin" : ""}`} /> Refresh
      </Button>
    </div>
    {current.isError ? <p role="alert" className={`${PANEL} p-5 text-[#a64235]`}>{current.error.message} Current activity is unverified until refresh succeeds.</p> : null}
    {current.isLoading ? <div role="status" className={`${PANEL} flex items-center gap-2 p-8`}><Loader2 className="size-5 animate-spin" /> Loading fix flows</div>
      : selection && detail.data ? "pending" in detail.data ? <section className={`${PANEL} p-6`}>
        <h2 className="text-lg font-semibold">Failure recorded, fix flow pending</h2><p className="mt-2 text-sm text-[#68746d]">{detail.data.message}</p>
        <a className={`${LINK} mt-4 inline-block text-sm`} href={`/?testRun=${encodeURIComponent(detail.data.runId)}&step=${encodeURIComponent(detail.data.chapterId)}`}>Return to this failed step and recording</a>
      </section> : "choices" in detail.data ? <section className={`${PANEL} p-6`}>
        <h2 className="text-lg font-semibold">Failures recorded for {detail.data.chapterId}</h2>
        <p className="mt-2 text-sm text-[#68746d]">This step has more than one failure occurrence. Select the recorded failure to follow its own fix flow.</p>
        <ul className="mt-4 space-y-3">{detail.data.choices.map(choice => <li key={choice.occurrenceId}><a className={LINK}
          href={fixFlowHref({ occurrenceId: choice.occurrenceId })} onClick={event => { event.preventDefault(); onSelect({ occurrenceId: choice.occurrenceId }); }}>
          {choice.phase} · {choice.code}</a><p className="mt-1 text-sm">{choice.message}</p></li>)}</ul>
      </section> : <FixFlowDetail flow={detail.isError ? { ...detail.data, currentState: "unknown" } : detail.data} />
      : !selection && list.data ? <>
        {list.data.activity !== "available" ? <p role="status" className="rounded-xl bg-[#fff7da] p-4 text-sm text-[#80651a]">
          {list.data.activity === "not-configured" ? "Agent activity is not configured for this environment." : "Agent activity could not refresh."}
          {" "}Recorded failures and delivery receipts remain visible; an accepted failure does not prove the agent is running.
        </p> : null}
        <FixFlowOverview data={list.isError ? { ...list.data, activity: "unavailable", flows: list.data.flows.map(flow => ({ ...flow, currentState: "unknown" })) } : list.data} filter={filter} onFilter={setFilter} onSelect={onSelect} />
        {list.data.limited ? <p className="text-xs text-[#68746d]">This view includes a bounded recent history. Open a failed step to look up its exact flow even when it is not listed here.</p> : null}
      </> : null}
  </div>;
}

export function FixFlowOverview({ data, filter, onFilter, onSelect }: {
  data: FixFlowList; filter: FlowFilter; onFilter: (filter: FlowFilter) => void; onSelect: (value: FixFlowLink) => void;
}) {
  const groups = groupFixFlows(data.flows), visible = filterFixFlowGroups(groups, filter);
  const selected = filter?.kind === "current" ? FLOW_CURRENT_STATES.find(item => item.id === filter.value) : undefined;
  const filterLabel = selected?.label ?? "All flows";
  const states = (branch: "main" | "waiting" | "stopped") => FLOW_CURRENT_STATES.filter(item => item.branch === branch).map(item => {
    const count = groups.filter(group => group.currentState === item.id).length;
    return <li key={item.id}><button aria-label={`${item.label}: ${count} flow groups`} aria-pressed={filter?.kind === "current" && filter.value === item.id}
      onClick={() => onFilter({ kind: "current", value: item.id })}><span className="fix-flow-node">{count}</span><span>{item.label}</span></button></li>;
  });
  return <>
    <section className={`${PANEL} overflow-hidden`} aria-label="Current fix flow states">
      <div className="flex items-center gap-5 bg-gradient-to-r from-[#edf6ef] to-white p-5"><FixFlowBot /><div>
        <h2 className="text-xl font-semibold">What is happening now</h2>
        <p className="mt-1 text-sm text-[#4f5d54]">{groups.length} flows · {data.flows.length} failures</p>
        <p className="mt-1 text-xs text-[#68746d]">Each flow is counted once. Select a state to see what it means and which flows are there.</p>
      </div></div>
      <ol className="fix-flow-track" aria-label="Current work and result states">{states("main")}</ol>
      <div className="fix-flow-branch"><h3>Waiting for a result, decision or input</h3>
        <ol className="fix-flow-track fix-flow-track-branch" aria-label="Waiting branches">{states("waiting")}</ol></div>
      <div className="fix-flow-branch fix-flow-branch-stopped"><h3>Stopped or unresolved</h3>
        <ol className="fix-flow-track fix-flow-track-branch" aria-label="Stopped branches">{states("stopped")}</ol></div>
      <p className="border-t border-[#eceeeb] px-5 py-3 text-xs text-[#68746d]">Last recorded progress stays in each flow's history. A stopped flow is never counted as actively diagnosing or fixing.</p>
    </section>
    <Button className="self-start" variant={filter === null ? "default" : "outline"} aria-pressed={filter === null} onClick={() => onFilter(null)}>All flows · {groups.length}</Button>
    <section className={PANEL} aria-label="Filtered fix flows">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eceeeb] p-5"><h2 className="text-lg font-bold">{filterLabel} <span className="ml-2 text-[#68746d]">{visible.length}</span></h2>
        <span className="text-xs text-[#68746d]">{visible.reduce((n, group) => n + group.occurrences.length, 0)} failure occurrences · Updated {date(data.refreshedAt)}</span></div>
      {selected ? <div className="border-b border-[#eceeeb] bg-[#f8faf7] px-5 py-4" aria-label={`${selected.label} meaning`}>
        <p className="text-sm text-[#4f5d54]">{selected.description}</p>
      </div> : null}
      {visible.length ? <div className="divide-y divide-[#eceeeb]">{visible.map(group => <FixFlowGroupCard key={group.key} group={group} onSelect={onSelect} />)}</div>
        : <p className="p-6 text-sm text-[#68746d]">No flow groups match this filter.</p>}
    </section>
  </>;
}

function FixFlowGroupCard({ group, onSelect }: { group: FixFlowGroup; onSelect: (value: FixFlowLink) => void }) {
  return <div><FixFlowCard flow={group.flow} onSelect={onSelect} />
    {group.occurrences.length > 1 ? <details className="mx-5 mb-5 rounded-xl border border-[#e0e4de] bg-[#f8faf7] p-4">
      <summary className="cursor-pointer text-sm font-semibold text-[#087d50]">{group.occurrences.length} related failure occurrences · show each run</summary>
      <p className="mt-2 text-xs text-[#68746d]">Repeated failures handled together. Each link keeps its own incident, recording and verification results.</p>
      <ul className="mt-3 space-y-3">{group.occurrences.map(flow => <li key={flow.occurrenceId ?? flow.runId}>
        <a className={`${LINK} text-sm`} href={fixFlowHref({ occurrenceId: flow.occurrenceId! })} onClick={event => {
          if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); onSelect({ occurrenceId: flow.occurrenceId! }); }
        }}>{flow.routineId} · {flow.step?.id ?? flow.failure.code} · {flow.build}</a>
        <p className="mt-1 break-all text-xs text-[#68746d]">{flow.runId} · {currentStateInfo(flow).label} · {date(flow.startedAt)}</p>
      </li>)}</ul>
    </details> : null}
  </div>;
}

export function FixFlowCard({ flow, onSelect }: { flow: FixFlow; onSelect: (value: FixFlowLink) => void }) {
  const selection: FixFlowLink = flow.occurrenceId ? { occurrenceId: flow.occurrenceId } : { runId: flow.runId, stepId: flow.step?.id ?? "unknown" };
  return <article className="grid gap-4 p-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
    <div className="min-w-0"><div className="mb-2 flex flex-wrap items-center gap-2"><StateBadge flow={flow} /><span className="text-xs text-[#68746d]">{flow.channel} · {flow.build}</span></div>
      <a className="text-base font-semibold text-[#17231c] hover:underline" href={fixFlowHref(selection)} onClick={event => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); onSelect(selection); } }}>
        {flow.routineId} <ArrowRight className="ml-1 inline size-4" /></a>
      <p className="mt-1 text-sm text-[#4f5d54]">{flow.step ? `${flow.step.id} · ${flow.step.label}` : flow.failure.code}</p>
      <p className="mt-2 line-clamp-2 text-sm text-[#747780]">{flow.failure.message}</p>
    </div>
    <div className="min-w-0"><p className="text-sm font-semibold">Last recorded progress: {FLOW_STAGES.find(item => item.id === flow.pipelineStage)?.label ?? "Unavailable"}</p><p className="mt-1 text-sm text-[#68746d]">{flow.nextAction}</p>
      <p className="mt-3 text-xs text-[#747780]">{flow.agent ? `${flow.agent.executor} · ${flow.agent.runId.slice(0, 8)}` : "Agent not confirmed"} · {date(flow.updatedAt)}</p>
      {flow.pullRequests.length ? <div className="mt-2 flex flex-wrap gap-3">{flow.pullRequests.map(pr => <a key={`${pr.repository}/${pr.number}`} href={pr.url} target="_blank" rel="noreferrer" className={`${LINK} text-xs`}>
        <GitPullRequest className="mr-1 inline size-3" /> #{pr.number} · {pr.state}</a>)}</div> : null}
    </div>
  </article>;
}

function StateBadge({ flow }: { flow: FixFlow }) {
  return <span className={`rounded-md px-2 py-1 text-xs font-semibold ${stateColors[flowStatus(flow)]}`}>{currentStateInfo(flow).label}</span>;
}

export function FixFlowDetail({ flow }: { flow: FixFlow }) {
  return <>
    <section className={`${PANEL} p-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><StateBadge flow={flow} /><span className="text-xs text-[#68746d]">Last agent / delivery update {date(flow.updatedAt)}</span></div>
      <h2 className="mt-4 text-xl font-bold">{flow.routineId} · {flow.step?.id ?? flow.failure.code}</h2>
      {flow.step ? <p className="mt-1 text-sm text-[#4f5d54]">{flow.step.label}</p> : null}
      <div className="mt-5 rounded-xl bg-[#f5f7f4] p-4"><h3 className="font-semibold">{currentStateInfo(flow).label}</h3><p className="mt-1 text-sm text-[#4f5d54]">{currentStateInfo(flow).description}</p><p className="mt-3 text-sm text-[#4f5d54]">{flow.nextAction}</p><p className="mt-2 text-xs text-[#68746d]">Last recorded progress: {FLOW_STAGES.find(item => item.id === flow.pipelineStage)?.label ?? "Unavailable"}</p></div>
      <div className="mt-5 flex flex-wrap gap-4 text-sm"><a className={LINK} href={`/?testRun=${encodeURIComponent(flow.runId)}${flow.step ? `&step=${encodeURIComponent(flow.step.id)}` : ""}`}>Failed step and recording</a>
        {flow.incidents.map(incident => <a key={incident.reportId} className={LINK} href={`/?report=${incident.reportId}`}>Incident · {incident.status}</a>)}
      </div>
      {!flow.incidents.length ? <p className="mt-3 text-sm text-[#68746d]">No incident is recorded for this failure yet. The routine evidence remains available above.</p> : null}
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-[#68746d]">Tested build</dt><dd>{flow.channel} · {flow.build}</dd></div>
        <div><dt className="text-[#68746d]">Agent</dt><dd>{flow.agent ? `${flow.agent.executor} · ${flow.agent.status}` : "Not confirmed"}</dd>
          {flow.agent?.executionOwner ? <dd className="mt-1 text-[#68746d]">Linked case owner: {flow.agent.executionOwner.status}</dd> : null}</div>
        {flow.agent?.repository ? <div><dt className="text-[#68746d]">Fix destination</dt><dd className="break-all">{flow.agent.repository} · {flow.agent.branch}</dd></div> : null}
        {flow.agent?.caseId ? <div><dt className="text-[#68746d]">Recorded case</dt><dd className="break-all font-mono text-xs">{flow.agent.caseId}</dd></div> : null}
      </dl>
      <details className="mt-5 text-sm"><summary className="cursor-pointer text-[#68746d]">Exact failure and identity</summary><p className="mt-2 whitespace-pre-wrap">{flow.failure.message}</p>
        {flow.failure.expected ? <p className="mt-2">Expected: {flow.failure.expected}</p> : null}<p className="mt-2 break-all font-mono text-xs">{flow.occurrenceId}</p></details>
    </section>
    <section className={`${PANEL} p-6`}><h3 className="text-lg font-bold">Recorded progress</h3>
      <p className="mt-1 text-sm text-[#68746d]">Test → incident → diagnosis → implement fix → review → verification → merge. Only recorded steps appear below.</p>
      <ol className="mt-6 space-y-0">{flow.timeline.map((event, index) => <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
        {index < flow.timeline.length - 1 ? <span className="absolute top-6 bottom-0 left-[9px] w-px bg-[#dce5de]" /> : null}
        {event.stage === "merged" ? <CheckCircle2 className="relative mt-0.5 size-5 shrink-0 text-[#087d50]" /> : <Circle className="relative mt-0.5 size-5 shrink-0 fill-white text-[#98aa9e]" />}
        <div className="min-w-0"><p className="text-sm font-semibold">{event.url ? <a className="hover:text-[#087d50] hover:underline" href={event.url} target={event.url.startsWith("https:") ? "_blank" : undefined} rel="noreferrer">{event.title} <ExternalLink className="ml-1 inline size-3" /></a> : event.title}</p>
          {event.detail ? <p className="mt-1 break-words whitespace-pre-wrap text-sm text-[#68746d]">{event.detail}</p> : null}
          {event.at ? <p className="mt-1 text-xs text-[#747780]">{date(event.at)}</p> : null}</div>
      </li>)}</ol>
    </section>
  </>;
}
