import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { HOST_COMPONENTS, hostIsFresh, type CleanupHealthEvent, type HostComponent, type HostDiskPoint,
  type HostReason, type TestHostHistory, type TestHostLatest, type TestHostList } from "../../../../packages/core/src/types/test-host-health.types";
import type { TestRunOverview } from "../../../../packages/core/src/types/test-run-overview.types";
import type { FixFlowList } from "../../../../packages/core/src/types/fix-flow.types";
import { api } from "../lib/api";
import { elapsed, laneCards, LaneOverview } from "./test-lanes";
import { laneFailureRun } from "./test-lane-failure";

const GiB = 1024 ** 3;
const componentNames = { "general-worker": "General worker", "triage-worker": "Dedicated triage worker", "disk-cleanup": "Scheduled cleanup" };
const reasonText: Record<HostReason, { summary: string; next: string }> = {
  none: { summary: "The service was observed on this host.", next: "No intervention reported." },
  "operator-drained": { summary: "An operator intentionally paused this service.", next: "The service owner can resume it when ready." },
  disabled: { summary: "This service is intentionally disabled.", next: "The service owner can enable it when needed." },
  "not-configured": { summary: "This service has not been configured on this host.", next: "The host owner can configure it if this host should run it." },
  "not-installed": { summary: "No installation was reported for this service.", next: "The host owner can install it if this host should run it." },
  "process-missing": { summary: "The enabled service's expected process was not found.", next: "The service owner should inspect its startup error and restore it." },
  "permission-denied": { summary: "The service could not access a required folder or resource.", next: "The host operator should repair its permissions, then verify the next scheduled run." },
  "budget-limited": { summary: "The last pass reached its time limit before completing the pass.", next: "The next scheduled pass may continue. The cleanup owner should inspect remaining work if space stays low." },
  "held-custody": { summary: "Unfinished work is holding this worker.", next: "The owning agent must finish or reconcile that work before new jobs can start." },
  unsettled: { summary: "The previous worker operation has not settled.", next: "The owning agent must finish its recovery before admitting new work." },
  "startup-failed": { summary: "The service failed to start.", next: "The service owner should inspect its startup error and repair it." },
  "inspection-unavailable": { summary: "The monitor could not inspect this service.", next: "The host owner should restore monitoring before relying on its status." },
  unknown: { summary: "The service's state was not established.", next: "A fresh service observation is needed." },
};

export function componentHealth(host: TestHostLatest, component: HostComponent | undefined, now: number, unavailable = false) {
  if (unavailable || !hostIsFresh(host, now)) return { label: "No recent report", tone: "unknown", summary: "Current service status is unknown.",
    next: "Check the host's connection and independent monitor. This does not prove the computer is offline." };
  if (!component) return { label: "Not reported", tone: "unknown", summary: "This host has not reported this service.", next: "The host owner can add its service observation." };
  if (component.component === "triage-worker" && ["not-configured", "not-installed"].includes(component.reason))
    return { label: "Not configured", tone: "unknown", summary: "There is no separate triage worker on this host. Shared triage belongs to the general worker.",
      next: "Install this service when independent triage capacity is needed." };
  if (component.component === "disk-cleanup" && component.reason === "budget-limited")
    return { label: "Pass time limit reached", tone: "blocked", ...reasonText["budget-limited"] };
  return { label: { running: "Service running", scheduled: "Scheduled", stopped: "Intentionally stopped", blocked: "Blocked", unknown: "Unknown" }[component.state],
    tone: component.state === "blocked" ? "blocked" : component.state === "running" || component.state === "scheduled" ? "healthy" : "unknown",
    ...reasonText[component.reason] };
}
const tones: Record<string, string> = { healthy: "bg-[#e6f5ed] text-[#087d50]", blocked: "bg-[#fff0e9] text-[#a64235]", unknown: "bg-[#f0f2ef] text-[#59655e]" };
const size = (bytes: number | null) => bytes === null ? "Unavailable" : (bytes / GiB).toFixed(1) + " GiB";
const time = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const cleanupReason = (event: CleanupHealthEvent) => event.reason === "budget-limited" ? "Pass time limit reached; remaining work was deferred."
  : event.reason === "none" ? "" : event.reason === "unknown" ? "Reason unavailable." : reasonText[event.reason].summary;
const cleanupStatus = (event: CleanupHealthEvent) => event.status === "already-running"
  ? "Skipped: another cleanup was running" : event.status.replaceAll("-", " ");
function useClock() { const [now, setNow] = useState(Date.now); useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(id); }, []); return now; }
function useHostHealth() { return useQuery({ queryKey: ["test-host-health"], queryFn: () => api<TestHostList>("/api/admin/test-runs/health"), refetchInterval: 60_000 }); }

/** Shared query powers both page and prominent entry links; a fetch failure never keeps an old healthy badge. */
export function SystemHealthSummary() {
  const query = useHostHealth(), now = useClock(), hosts = query.data?.hosts ?? [];
  const problems = hosts.flatMap(host => !hostIsFresh(host, now) ? [`${host.hostId}: no recent report`]
    : [...(host.freeBytes !== null && host.freeBytes < 20 * GiB ? [`${host.hostId}: ${size(host.freeBytes)} free (below 20 GiB)`] : []),
      ...host.components.filter(item => ["blocked", "stopped"].includes(item.state)).map(item => `${componentNames[item.component]}: ${item.state === "stopped" ? "paused" : "blocked"}`)]);
  const text = query.isError ? "System health could not refresh. Current service status is unknown."
    : query.isPending ? "Loading system health…" : !hosts.length ? "Host monitoring has not reported yet."
    : problems.length ? problems.slice(0, 3).join(" · ") : `${hosts.length} ${hosts.length === 1 ? "host is" : "hosts are"} reporting. Open service and disk details.`;
  return <aside className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#dfe5dd] bg-white px-4 py-3 text-sm" aria-label="System health summary">
    <p className="text-[#59655e]"><strong className="text-[#202820]">System health</strong> · {text}</p>
    <a href="/?systemHealth=1" className="font-medium text-[#087d50] underline">View health &amp; disk space</a>
  </aside>;
}

/** Real points only. Null measurements and missed ticks break the path instead of joining a fictional history. */
export function diskSegments(points: HostDiskPoint[], gapAfterMs: number) {
  const segments: HostDiskPoint[][] = []; let current: HostDiskPoint[] = [];
  for (const point of points) {
    if (point.freeBytes === null || current.length && Date.parse(point.sampledAt) - Date.parse(current[current.length - 1].sampledAt) > gapAfterMs) {
      if (current.length) segments.push(current); current = [];
    }
    if (point.freeBytes !== null) current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
export function DiskHistoryChart({ history }: { history: TestHostHistory }) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(880);
  useEffect(() => {
    const node = container.current; if (!node) return;
    const measure = () => setWidth(Math.max(240, Math.round(node.getBoundingClientRect().width)));
    measure(); const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
  }, []);
  const from = Date.parse(history.from), to = Date.parse(history.to), height = 225, left = 58, top = 15, bottom = 38;
  const yMax = Math.ceil(Math.max(25, ...history.points.map(point => (point.freeBytes ?? 0) / GiB)) / 5) * 5;
  const x = (at: string) => left + (Date.parse(at) - from) / Math.max(1, to - from) * (width - left - 16);
  const y = (bytes: number) => height - bottom - (bytes / GiB / yMax) * (height - top - bottom);
  const segments = diskSegments(history.points, history.gapAfterMs);
  return <div ref={container}>
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Available disk space over time. Gaps mean no measurement. Dashed line marks 20 GiB.">
      {[0, yMax / 2, yMax].map(tick => <g key={tick}><line x1={left} x2={width - 16} y1={y(tick * GiB)} y2={y(tick * GiB)} stroke="#e4e9e2" />
        <text x={left - 9} y={y(tick * GiB) + 4} textAnchor="end" fontSize="11" fill="#68746d">{tick} GiB</text></g>)}
      <line x1={left} x2={width - 16} y1={y(history.thresholdBytes)} y2={y(history.thresholdBytes)} stroke="#b57729" strokeDasharray="5 4" />
      <text x={width - 20} y={y(history.thresholdBytes) - 5} textAnchor="end" fontSize="11" fill="#946024">20 GiB recording margin</text>
      {(width < 500 ? [0, 1] : [0, 0.5, 1]).map(ratio => <text key={ratio} x={left + ratio * (width - left - 16)} y={height - 10} textAnchor={ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"} fontSize="11" fill="#68746d">{time(new Date(from + ratio * (to - from)).toISOString())}</text>)}
      {segments.map((segment, index) => <g key={index}><polyline points={segment.map(point => `${x(point.sampledAt)},${y(point.freeBytes!)}`).join(" ")} fill="none" stroke="#0c9667" strokeWidth="2" />
        {segment.length === 1 ? <circle cx={x(segment[0].sampledAt)} cy={y(segment[0].freeBytes!)} r="3" fill="#0c9667"><title>{`${time(segment[0].sampledAt)} · ${size(segment[0].freeBytes)}`}</title></circle> : null}</g>)}
      {history.cleanupEvents.map(event => <g key={event.receiptId}><line x1={x(event.startedAt)} x2={x(event.startedAt)} y1={top} y2={height - bottom} stroke={event.status === "refused" || event.status === "error" ? "#bb5944" : "#87968c"} strokeDasharray="2 5" />
        <circle cx={x(event.startedAt)} cy={top + 4} r="4" fill={event.status === "refused" || event.status === "error" ? "#bb5944" : "#87968c"}><title>{`${time(event.startedAt)} · ${event.origin} cleanup · ${cleanupStatus(event)} · ${event.removedCount} removed. ${cleanupReason(event)}`}</title></circle></g>)}
      {!segments.length ? <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="14" fill="#68746d">No disk measurements in this period</text> : null}
    </svg>
    <p className="text-xs text-[#68746d]">Available space on the host's Data volume. Gaps are missing measurements; dotted markers are cleanup attempts. The threshold is a recording margin, not a readiness check.</p>
    {history.truncated ? <p className="mt-1 text-xs text-[#a64235]">Only the newest {history.points.length.toLocaleString()} measurements are shown.</p> : null}
  </div>;
}

export function CleanupEvents({ events }: { events: CleanupHealthEvent[] }) {
  const recent = [...events].reverse().slice(0, 8);
  return <details className="mt-4 border-t border-[#e4e9e2] pt-3"><summary className="cursor-pointer text-sm font-medium">Recent cleanup attempts ({events.length})</summary>
    {!recent.length ? <p className="mt-2 text-xs text-[#68746d]">No cleanup receipt was reported for this period.</p> : <div className="mt-2 space-y-2">{recent.map(event => <div key={event.receiptId} className="flex flex-wrap justify-between gap-2 text-xs">
      <div><strong>{event.origin === "pre-job" ? "Before a job" : event.origin} · {cleanupStatus(event)}</strong><p className="text-[#68746d]">{time(event.startedAt)} · {event.removedCount} items removed</p>{cleanupReason(event) ? <p className="mt-1 text-[#68746d]">{cleanupReason(event)}</p> : null}</div>
      <div className="text-right text-[#68746d]">{size(event.freeBefore)} → {size(event.freeAfter)}<p>{event.freeAfterSampledAt ? `After measured ${time(event.freeAfterSampledAt)}` : "After measurement time unavailable"}</p></div>
    </div>)}</div>}
    <p className="mt-2 text-xs text-[#68746d]">Space changes also include other host activity. A skipped, refused or dry run is not a successful cleanup.</p>
  </details>;
}

export function SystemHealthPage() {
  const query = useHostHealth(), now = useClock(), [hostId, setHostId] = useState<string | null>(null), [days, setDays] = useState<1 | 7>(1);
  const hosts = query.data?.hosts ?? [], host = hosts.find(value => value.hostId === hostId) ?? hosts[0];
  const history = useQuery({ queryKey: ["test-host-history", host?.hostId, days], enabled: Boolean(host), refetchInterval: 60_000,
    queryFn: () => api<TestHostHistory>(`/api/admin/test-runs/health/${encodeURIComponent(host!.hostId)}?days=${days}`) });
  const overview = useQuery({ queryKey: ["test-run-overview"], queryFn: () => api<TestRunOverview>("/api/admin/test-runs/overview"), refetchInterval: 30_000 });
  const fixFlows = useQuery({ queryKey: ["admin-fix-flows"], queryFn: () => api<FixFlowList>("/api/admin/fix-flows"),
    enabled: Boolean(overview.data && laneCards(overview.data, now).some(card => laneFailureRun(card))), refetchInterval: 15_000, retry: false });
  const fresh = Boolean(host && !query.isError && hostIsFresh(host, now));
  return <div className="space-y-5">
    <section className="rounded-2xl border border-[#dfe5dd] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Workers &amp; disk space</h2><p className="mt-1 text-sm text-[#68746d]">Service status is separate from a job's progress and a device lane's availability.</p></div>
        <button className="text-sm font-medium text-[#087d50] underline" onClick={() => { void query.refetch(); if (host) void history.refetch(); void overview.refetch(); if (fixFlows.isEnabled) void fixFlows.refetch(); }}>Refresh</button></div>
      {query.isError ? <p className="mt-4 text-sm text-[#a64235]">Health could not refresh. Current service status is unknown.</p> : null}
      {!hosts.length ? <p className="mt-4 text-sm text-[#68746d]">{query.isPending ? "Loading host reports…" : "No independent host monitor has reported yet. Historical disk measurements will appear as they are collected."}</p> : <>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><select aria-label="Host" value={host?.hostId} onChange={event => setHostId(event.target.value)} className="rounded-lg border border-[#dfe5dd] bg-white px-3 py-2 text-sm">{hosts.map(value => <option key={value.hostId}>{value.hostId}</option>)}</select>
          <p className="text-xs text-[#68746d]">{fresh ? "Host reporting" : "No recent report"} · Last observed {host ? elapsed(host.sampledAt, now) : "unknown"} ago{host ? ` (${time(host.sampledAt)})` : ""}</p></div>
        {host ? <div className="mt-4 grid gap-3 lg:grid-cols-3">{HOST_COMPONENTS.map(role => { const component = host.components.find(value => value.component === role), state = componentHealth(host, component, now, query.isError);
          return <article key={role} className="rounded-xl border border-[#e0e6de] p-4"><h3 className="font-semibold">{componentNames[role]}</h3>{role === "general-worker" ? <p className="mt-1 text-xs text-[#68746d]">Fixes and shared triage</p> : null}<span className={`mt-2 inline-block rounded-md px-2 py-1 text-xs font-semibold ${tones[state.tone]}`}>{state.label}</span>
            <p className="mt-3 text-sm text-[#59655e]">{state.summary}</p><p className="mt-2 text-xs text-[#68746d]"><strong>Next:</strong> {state.next}</p>
            {component?.state === "running" && fresh ? <p className="mt-2 text-xs text-[#68746d]">The service is alive; this does not say a model or routine is working.</p> : null}</article>; })}</div> : null}
        <div className="mt-6 flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-base font-semibold">Available disk space</h3><p className={`mt-1 text-2xl font-semibold ${fresh && host?.freeBytes !== null && host!.freeBytes < 20 * GiB ? "text-[#a64235]" : "text-[#202820]"}`}>{host ? size(host.freeBytes) : "Unavailable"}<span className="ml-2 text-xs font-normal text-[#68746d]">{fresh ? "latest measurement" : "last reported, not current"}</span></p></div>
          <div className="flex gap-1 rounded-lg bg-[#f0f3ee] p-1">{([1, 7] as const).map(value => <button key={value} aria-pressed={days === value} onClick={() => setDays(value)} className={`rounded-md px-3 py-1 text-sm ${days === value ? "bg-white font-semibold shadow-sm" : "text-[#68746d]"}`}>{value === 1 ? "24 hours" : "7 days"}</button>)}</div></div>
        {history.isError ? <p className="mt-3 text-sm text-[#a64235]">Disk history could not refresh.</p> : null}
        {history.data ? <div className="mt-4"><DiskHistoryChart history={history.data} /><CleanupEvents events={history.data.cleanupEvents} /></div> : <p className="mt-4 text-sm text-[#68746d]">Loading recorded measurements…</p>}
        {query.data?.truncated ? <p className="mt-3 text-xs text-[#a64235]">Only the first 32 reporting hosts are shown.</p> : null}
      </>}
    </section>
    <section className="rounded-2xl border border-[#dfe5dd] bg-white p-5"><h2 className="text-lg font-semibold">Device lanes</h2>
      {overview.isError ? <p className="mt-3 text-sm text-[#a64235]">Lane activity could not refresh. Open Test runs to retry.</p> : overview.data ? <LaneOverview data={overview.data} now={now}
        fixFlows={fixFlows.isError && fixFlows.data ? { ...fixFlows.data, activity: "unavailable" } : fixFlows.data}
        onResult={id => { window.location.href = `/?testRun=${encodeURIComponent(id)}`; }} /> : <p className="mt-3 text-sm text-[#68746d]">Loading lane reports…</p>}
    </section>
  </div>;
}
