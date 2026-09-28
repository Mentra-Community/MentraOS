import { ArrowRight, CheckCircle2, Clock3, Glasses, Monitor, Smartphone } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { OverviewJob, OverviewRequest, TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import { displayState, elapsed, laneCards, laneKind, phaseNames, type LaneCard, type LaneState } from "./test-lanes";
import { runDuration, type TestRunSummary } from "./test-runs-data";

const BOX = "rounded-xl border border-[#e0e4de] bg-white p-3";
const MUTED = "text-[11px] text-[#68746d]";
const LINK = "text-[#087d50] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087d50]";
const laneLabels: Record<LaneState, string> = { running: "Running", reserved: "Reserved", blocked: "Blocked", recovery: "Recovery needed",
  available: "Available", "not-ready": "Not ready", unknown: "Status unknown" };
const phaseGroups = ["Setup", "Test", "Return", "Evidence"];
const phaseGroup = { preflight: 0, setup: 0, test: 1, "final-assertions": 1, teardown: 2, "return-verification": 2, evidence: 3 };
const build = (request: Pick<OverviewRequest, "channel" | "release" | "prNumber" | "headSha">) =>
  (request.channel === "pr" ? `PR #${request.prNumber}` : request.release ?? `${request.channel} build`)
  + (request.headSha ? ` · ${request.headSha.slice(0, 7)}` : "");
const platform = (value?: string) => value === "ios-on-mac" || value === "ios-mac" ? "Mac" : value === "android" ? "Android" : value === "ios" ? "iPhone" : "Platform not reported";

/** Uses the existing exact-run ownership projection. Queued jobs are never assigned to a free-looking lane. */
export function testFlowItems(data: TestRunOverview, now: number) {
  const cards = data.resourceObservations?.available ? laneCards(data, now) : [];
  const lanes = cards.filter(card => laneKind(card.item.resourceKey) !== "glasses");
  const resources = cards.filter(card => laneKind(card.item.resourceKey) === "glasses");
  const waiting = data.jobs.filter(job => job.kind !== "maintenance" && ["queued", "waiting"].includes(displayState(job, now)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const observedRuns = new Set(lanes.flatMap(card => card.runId ? [card.runId] : []));
  const other = data.jobs.filter(job => {
    const state = displayState(job, now);
    if (job.kind === "maintenance" || ["queued", "waiting", "finished"].includes(state)) return false;
    if (state !== "running") return true;
    const ids = new Set([...job.requests.map(request => request.requestId), ...job.claims.map(claim => claim.requestId)]);
    return !ids.size || [...ids].some(id => !observedRuns.has(id));
  });
  return { lanes, resources, waiting, other };
}

function Badge({ state }: { state: LaneState }) {
  const colors = state === "running" || state === "available" ? "bg-[#e6f5ed] text-[#087d50]"
    : state === "unknown" ? "bg-[#eef0ee] text-[#59655e]" : "bg-[#fff2dc] text-[#805619]";
  return <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold ${colors}`}>{laneLabels[state]}</span>;
}

function LaneProgress({ card }: { card: LaneCard }) {
  const { progress } = card;
  if (!progress) return card.runId ? <p className="mt-3 text-xs text-[#68746d]">No step reported yet.</p> : null;
  const current = phaseGroup[progress.phase];
  const live = card.state === "running" && card.active;
  return <div className="mt-3" aria-label={live ? "Current lane progress" : "Last reported lane progress"}>
    <div className="flex items-center gap-1" aria-label={`Last reported phase: ${phaseNames[progress.phase]}`}>
      {phaseGroups.map((label, index) => <div key={label} className="flex min-w-0 flex-1 items-center gap-1">
        <span className={`flex-1 rounded px-1 py-1.5 text-center text-[10px] ${index === current
          ? live ? "bg-[#dff3e7] font-semibold text-[#087d50]" : "bg-[#eef0ee] font-semibold text-[#59655e]"
          : "bg-[#f7f8f6] text-[#86918a]"}`}>{label}</span>
        {index < phaseGroups.length - 1 ? <ArrowRight className="size-3 shrink-0 text-[#bec7c0]" aria-hidden="true" /> : null}
      </div>)}
    </div>
    <p className="mt-2 text-xs font-medium">{live ? "Now: " : "Last step: "}{progress.action?.label ?? progress.step?.label ?? "Step not named"}</p>
    <p className={`mt-1 ${MUTED}`}>{progress.action
      ? progress.action.totalActions === null ? `${progress.action.completedActions} actions completed; total unknown`
        : `${progress.action.completedActions} / ${progress.action.totalActions} actions in this step`
      : `${progress.completedSteps} / ${progress.totalSteps} steps in this phase`}</p>
  </div>;
}

function FlowLane({ card, now, onResult }: { card: LaneCard; now: number; onResult: (id: string) => void }) {
  const mac = laneKind(card.item.resourceKey) === "shared", Icon = mac ? Monitor : Smartphone;
  const request = card.matched?.request;
  const fixture = card.item.observation.fixture;
  const startedAt = card.matched?.claim?.claimedAt ?? card.matched?.job.startedAt;
  return <article className={`${BOX} ${card.state === "running" ? "border-[#a6d6bb] shadow-[0_0_0_1px_#e6f5ed]" : ""}`}
    aria-label={`Execution lane ${card.item.hostId} ${card.item.resourceKey}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2"><Icon className="mt-0.5 size-4 shrink-0 text-[#49765c]" aria-hidden="true" />
        <div className="min-w-0"><h5 className="text-xs font-semibold">{mac ? "Mac lane" : "Android lane"}</h5>
          <p className={`mt-0.5 break-all ${MUTED}`}>{card.item.hostId}</p></div></div>
      <Badge state={card.state} />
    </div>
    {card.runId ? <div className="mt-3 rounded-lg bg-[#f5f8f4] p-2.5">
      <p className="break-words text-xs font-semibold">{request?.routineId ?? "Local / unreported routine"}</p>
      <p className={`mt-1 ${MUTED}`}>{request ? build(request) : "Build not reported by this session"}</p>
      {startedAt ? <p className={`mt-1 ${MUTED}`}>Elapsed {elapsed(startedAt, now)}</p> : null}
      {card.item.publishedRunIds.includes(card.runId) ? <button className={`mt-1 text-xs ${LINK}`} onClick={() => onResult(card.runId!)}>Open run</button> : null}
    </div> : null}
    <LaneProgress card={card} />
    <p className="mt-3 text-xs">{card.summary}</p>
    {card.state !== "available" && card.state !== "running" ? <div className="mt-2 border-l-2 border-[#dec694] pl-2 text-[11px]">
      <p>{card.responsible}</p><p className="mt-1">{card.next}</p></div> : null}
    {card.pairing ? <p className={`mt-2 ${MUTED}`}>{card.pairing}</p> : null}
    <p className={`mt-2 ${MUTED}`}>{fixture.checked && fixture.record === "valid" ? `${fixture.fixtureID} · ` : ""}
      Reported {elapsed(card.item.receivedAt, now)} ago{card.fresh ? "" : " · stale"}</p>
  </article>;
}

function JobCard({ job, now }: { job: OverviewJob; now: number }) {
  return <article className={BOX}>
    {job.requests.length ? job.requests.map(request => <div key={request.requestId} className="mb-2 last:mb-0">
      <p className="break-words text-xs font-semibold">{request.routineId}</p>
      <p className={`mt-1 ${MUTED}`}>{build(request)}</p>
      <p className={MUTED}>{platform(request.platform)}</p>
    </div>) : <p className="text-xs font-semibold">{job.title}</p>}
    <p className={`mt-2 ${MUTED}`}>{["queued", "waiting"].includes(displayState(job, now)) ? "Waiting " : "Created "}
      {elapsed(job.createdAt, now)}{["queued", "waiting"].includes(displayState(job, now)) ? "" : " ago"}</p>
    <p className="mt-2 text-[11px]">{job.attention?.reason ?? job.message ?? (job.state === "waiting" ? "Waiting for workflow prerequisites." : job.state === "queued" ? "Waiting for an available compatible runner." : "Current lane activity is unconfirmed.")}</p>
    {job.attention ? <p className={`mt-1 ${MUTED}`}>{job.attention.responsible}: {job.attention.nextAction}</p> : null}
    {job.workflow ? <a className={`mt-2 inline-block text-[11px] ${LINK}`} href={job.workflow.url} target="_blank" rel="noreferrer">GitHub job</a> : null}
  </article>;
}

function FinishedCard({ run, now, onResult }: { run: TestRunSummary; now: number; onResult: (id: string) => void }) {
  const passed = run.outcome === "passed";
  return <article className={BOX}>
    <div className="flex items-start justify-between gap-2"><p className="break-words text-xs font-semibold">{run.routineId}</p>
      <span className={`rounded px-1.5 py-1 text-[10px] font-semibold ${passed ? "bg-[#e6f5ed] text-[#087d50]" : "bg-[#fff0e9] text-[#a64235]"}`}>{run.outcome}</span></div>
    <p className={`mt-1 ${MUTED}`}>{run.channel === "pr" ? `PR #${run.prNumber}` : run.release ?? `${run.channel} build`} · {platform(run.platform)}</p>
    <p className={`mt-1 ${MUTED}`}>{run.fixture.alias}</p>
    <p className={`mt-2 ${MUTED}`}>Finished {elapsed(run.finishedAt, now)} ago · {runDuration(run.startedAt, run.finishedAt) ?? "Duration unknown"}</p>
    <p className={`mt-1 ${MUTED}`}>Fixture: {run.outcomes.fixture} · Evidence: {run.outcomes.evidence}</p>
    <button className={`mt-2 text-xs ${LINK}`} onClick={() => onResult(run.runId)}>View result & recording</button>
  </article>;
}

type Segment = "all" | "waiting" | "lanes" | "finished";
export function TestRunFlow({ data, now, recentRuns = [], recentState = "loading", onResult }: {
  data: TestRunOverview; now: number; recentRuns?: TestRunSummary[]; recentState?: "loading" | "ready" | "error";
  onResult: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Segment>("all");
  const { waiting, lanes, resources, other } = testFlowItems(data, now);
  const stages = [
    { id: "waiting" as const, title: "Waiting", count: waiting.length, Icon: Clock3 },
    { id: "lanes" as const, title: "Execution lanes", count: data.resourceObservations?.available ? lanes.length : null, Icon: Monitor },
    { id: "finished" as const, title: "Recently finished", count: recentState === "ready" ? recentRuns.length : null, Icon: CheckCircle2 },
  ];
  const panel = (id: Segment, children: ReactNode) => selected === "all" || selected === id ? <section key={id} className="min-w-0" aria-label={id === "lanes" ? "Execution lanes" : id === "waiting" ? "Waiting jobs" : "Recently finished runs"}>{children}</section> : null;
  return <section className="mt-4" aria-label="Routine execution flow">
    <div className="flex items-center gap-2 rounded-xl border border-[#e0e4de] bg-[#f5f8f4] p-2">
      {stages.map(({ id, title, count, Icon }, index) => <div key={id} className="flex min-w-0 flex-1 items-center gap-2">
        <button aria-pressed={selected === id} onClick={() => setSelected(selected === id ? "all" : id)}
          className={`flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg px-2 py-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087d50] ${selected === id ? "bg-[#284e3a] text-white" : "hover:bg-[#e4eee5]"}`}>
          <Icon className="size-4 shrink-0" aria-hidden="true" /><span>{title}</span><strong className="text-base">{count ?? "—"}</strong>
        </button>{index < stages.length - 1 ? <ArrowRight className="size-4 shrink-0 text-[#82a88e]" aria-hidden="true" /> : null}
      </div>)}
    </div>
    <div className="my-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#68746d]">
      <p>Waiting jobs are oldest first. Compatible runners decide where they run.</p>
      <button className={LINK} aria-pressed={selected === "all"} onClick={() => setSelected("all")}>Show full flow</button>
    </div>
    <div className={selected === "all" ? "grid items-start gap-4 lg:grid-cols-[minmax(150px,1fr)_minmax(240px,1.6fr)_minmax(160px,1fr)]" : "grid gap-3"}>
      {panel("waiting", <><h4 className="mb-2 text-xs font-semibold">Waiting for a runner or prerequisite</h4>
        <div className="max-h-[620px] space-y-2 overflow-y-auto">{waiting.length ? waiting.map(job => <JobCard key={job.id} job={job} now={now} />)
          : <p className={`${BOX} text-xs text-[#68746d]`}>No waiting jobs in the latest report.</p>}</div></>)}
      {panel("lanes", <><h4 className="mb-2 text-xs font-semibold">What each lane is doing</h4>
        {!data.resourceObservations?.available ? <p className={`${BOX} text-xs text-[#805619]`}>Lane reports are unavailable. Current ownership is unknown.</p>
          : !lanes.length ? <p className={`${BOX} text-xs text-[#68746d]`}>No execution lanes have reported yet.</p>
          : <div className="space-y-3">{lanes.map(card => <FlowLane key={`${card.item.hostId}/${card.item.resourceKey}`} card={card} now={now} onResult={onResult} />)}</div>}
        {resources.length ? <div className="mt-3 rounded-lg border border-dashed border-[#d4dfd5] p-3"><h5 className="flex items-center gap-2 text-[11px] font-semibold"><Glasses className="size-4" aria-hidden="true" />Glasses resources</h5>
          <p className={`mt-1 ${MUTED}`}>Shared equipment, separate from execution lanes.</p>
          {resources.map(card => <div key={`${card.item.hostId}/${card.item.resourceKey}`} className="mt-2 border-t border-[#e0e4de] pt-2 text-[11px]">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{card.item.hostId} · {card.item.resourceKey}</span><Badge state={card.state} /></div>
            <p className={`mt-1 ${MUTED}`}>{card.pairing ?? card.summary}</p>
          </div>)}</div> : null}
        {data.resourceObservations?.truncated ? <p className="mt-2 text-[11px] text-[#805619]">More resources exist than are shown.</p> : null}</>)}
      {panel("finished", <><h4 className="mb-2 text-xs font-semibold">Latest published results · all channels</h4>
        {recentState !== "ready" ? <p className={`mb-2 ${BOX} text-xs text-[#805619]`}>{recentState === "error" ? "Recent results could not refresh. Any saved results below may be out of date." : "Loading recent results…"}</p> : null}
        <div className="max-h-[620px] space-y-2 overflow-y-auto">{recentRuns.map(run => <FinishedCard key={run.runId} run={run} now={now} onResult={onResult} />)}
          {recentState === "ready" && !recentRuns.length ? <p className={`${BOX} text-xs text-[#68746d]`}>No results published yet.</p> : null}</div></>)}
    </div>
    {other.length ? <div className="mt-4 rounded-xl border border-[#ebd9b6] bg-[#fffaf0] p-3" aria-label="Jobs needing attention or a lane report">
      <h4 className="text-xs font-semibold">{other.length} {other.length === 1 ? "job needs" : "jobs need"} attention or a lane report</h4>
      <p className={`mt-1 ${MUTED}`}>These jobs are not confirmed inside a reported lane. Open CI request details below for progress and available actions.</p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">{other.map(job => <JobCard key={job.id} job={job} now={now} />)}</div>
    </div> : null}
  </section>;
}
