import {LoadingIndicator} from "../components/loading-indicator";
import {TESTING_PANEL, TestingButton} from "../components/testing-ui";
import {elapsedDuration} from "../lib/run-duration";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { DISK_FLOOR_BYTES, HOST_COMPONENTS, hostIsFresh, type CleanupHealthEvent, type HostComponent, type HostDiskPoint,
  type HostReason, type TestHostHistory, type TestHostLatest, type TestHostList } from "../../../../packages/core/src/types/test-host-health.types";
import { api } from "../lib/api";
import {LaneRestorationPage} from "./lane-restoration";
import {LaneHistoryPage} from "./lane-history";
import type {LaneSelection} from "../lib/lane-links";
import {PendingQueueSection} from "./pending-queue";
import {LaneHealthSection} from "./lane-health";
import {FrameworkHealthSection} from "./framework-health";
import {SystemHealthTabs} from "./system-health-tabs";
import type {SystemHealthTab} from "../lib/system-health-links";

const elapsed = (at: string, now: number) => elapsedDuration(Math.max(0, now - Date.parse(at))) ?? "unknown";
const GiB = 1024 ** 3;
const recordingFloorGiB = DISK_FLOOR_BYTES / GiB;
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
const size = (bytes: number | null | undefined) => bytes == null ? "Unavailable" : (bytes / GiB).toFixed(1) + " GiB";
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
    : [...(host.freeBytes !== null && host.freeBytes < DISK_FLOOR_BYTES ? [`${host.hostId}: ${size(host.freeBytes)} free (below ${recordingFloorGiB} GiB recorder minimum)`] : []),
      ...(host.memory?.pressure === "warning" || host.memory?.pressure === "critical" ? [`${host.hostId}: ${host.memory.pressure} memory pressure`] : []),
      ...host.components.filter(item => ["blocked", "stopped"].includes(item.state)).map(item => `${componentNames[item.component]}: ${item.state === "stopped" ? "paused" : "blocked"}`)]);
  const text = query.isError ? "System health could not refresh. Current service status is unknown."
    : query.isPending ? <LoadingIndicator inline label="Loading system health" /> : !hosts.length ? "Host monitoring has not reported yet."
    : problems.length ? problems.slice(0, 3).join(" · ") : `${hosts.length} ${hosts.length === 1 ? "host is" : "hosts are"} reporting.`;
  return <aside className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#dfe5dd] bg-white px-4 py-3 text-sm" aria-label="System health summary">
    <p className="text-[#59655e]"><strong className="text-[#202820]">System health</strong> · {text}</p>
    <a href="/?systemHealth=1" className="font-medium text-[#087d50] hover:underline">View system health</a>
  </aside>;
}

/** Real points only. Null measurements and missed ticks break the path instead of joining a fictional history. */
const historyMetrics = {
  disk: { label: "Available disk space", percent: false, value: (point: HostDiskPoint) => point.freeBytes },
  used: { label: "Used RAM", percent: false, value: (point: HostDiskPoint) => point.memory?.usedBytes ?? null },
  compressed: { label: "Compressed RAM", percent: false, value: (point: HostDiskPoint) => point.memory?.compressedBytes ?? null },
  swap: { label: "Swap used", percent: false, value: (point: HostDiskPoint) => point.memory?.swapUsedBytes ?? null },
  availability: { label: "OS memory availability", percent: true, value: (point: HostDiskPoint) => point.memory?.pressureFreePercent ?? null },
};
export type HistoryMetric = keyof typeof historyMetrics;
export function diskSegments(points: HostDiskPoint[], gapAfterMs: number, metric: HistoryMetric = "disk") {
  const segments: HostDiskPoint[][] = []; let current: HostDiskPoint[] = [];
  for (const point of points) {
    const measured = historyMetrics[metric].value(point);
    if (measured === null || current.length && Date.parse(point.sampledAt) - Date.parse(current[current.length - 1].sampledAt) > gapAfterMs) {
      if (current.length) segments.push(current); current = [];
    }
    if (measured !== null) current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
export function DiskHistoryChart({ history, metric = "disk" }: { history: TestHostHistory; metric?: HistoryMetric }) {
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(880);
  useEffect(() => {
    const node = container.current; if (!node) return;
    const measure = () => setWidth(Math.max(240, Math.round(node.getBoundingClientRect().width)));
    measure(); const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
  }, []);
  const from = Date.parse(history.from), to = Date.parse(history.to), height = 225, left = 58, top = 15, bottom = 38;
  const selected = historyMetrics[metric], unit = selected.percent ? 1 : GiB;
  const display = (value: number) => selected.percent ? value.toFixed(0) + "%" : size(value);
  const yMax = selected.percent ? 100 : Math.ceil(Math.max(metric === "disk" ? 25 : 5, ...history.points.map(point => (selected.value(point) ?? 0) / GiB)) / 5) * 5;
  const x = (at: string) => left + (Date.parse(at) - from) / Math.max(1, to - from) * (width - left - 16);
  const y = (value: number) => height - bottom - (value / unit / yMax) * (height - top - bottom);
  const segments = diskSegments(history.points, history.gapAfterMs, metric);
  return <div ref={container}>
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={`${selected.label} over time. Gaps mean no measurement.${metric === "disk" ? ` Dashed line marks the ${recordingFloorGiB} GiB recorder minimum.` : ""}`}>
      {[0, yMax / 2, yMax].map(tick => <g key={tick}><line x1={left} x2={width - 16} y1={y(tick * unit)} y2={y(tick * unit)} stroke="#e4e9e2" />
        <text x={left - 9} y={y(tick * unit) + 4} textAnchor="end" fontSize="11" fill="#68746d">{tick}{selected.percent ? "%" : " GiB"}</text></g>)}
      {metric === "disk" ? <><line x1={left} x2={width - 16} y1={y(DISK_FLOOR_BYTES)} y2={y(DISK_FLOOR_BYTES)} stroke="#b57729" strokeDasharray="5 4" />
      <text x={width - 20} y={y(DISK_FLOOR_BYTES) - 5} textAnchor="end" fontSize="11" fill="#946024">{recordingFloorGiB} GiB recorder minimum</text></> : null}
      {(width < 500 ? [0, 1] : [0, 0.5, 1]).map(ratio => <text key={ratio} x={left + ratio * (width - left - 16)} y={height - 10} textAnchor={ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"} fontSize="11" fill="#68746d">{time(new Date(from + ratio * (to - from)).toISOString())}</text>)}
      {segments.map((segment, index) => <g key={index}><polyline points={segment.map(point => `${x(point.sampledAt)},${y(selected.value(point)!)}`).join(" ")} fill="none" stroke="#0c9667" strokeWidth="2" />
        {(segment.length === 1 ? segment : segment.filter((_, index) => index % Math.ceil(history.points.length / 64) === 0 || index === segment.length - 1)).map(point => <circle key={point.sampleId} cx={x(point.sampledAt)} cy={y(selected.value(point)!)} r={segment.length === 1 ? 3 : 2} fill="#0c9667"><title>{`${time(point.sampledAt)} · ${display(selected.value(point)!)}${metric !== "disk" ? ` · Pressure: ${point.memory?.pressure ?? "unavailable"}` : ""}`}</title></circle>)}</g>)}
      {(metric === "disk" ? history.cleanupEvents : []).map(event => <g key={event.receiptId}><line x1={x(event.startedAt)} x2={x(event.startedAt)} y1={top} y2={height - bottom} stroke={event.status === "refused" || event.status === "error" ? "#bb5944" : "#87968c"} strokeDasharray="2 5" />
        <circle cx={x(event.startedAt)} cy={top + 4} r="4" fill={event.status === "refused" || event.status === "error" ? "#bb5944" : "#87968c"}><title>{`${time(event.startedAt)} · ${event.origin} cleanup · ${cleanupStatus(event)} · ${event.removedCount} removed. ${cleanupReason(event)}`}</title></circle></g>)}
      {!segments.length ? <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="14" fill="#68746d">{metric === "disk" ? "No disk measurements in this period" : `No ${selected.label.toLowerCase()} measurements in this period`}</text> : null}
    </svg>
    {metric === "disk" ? <><p className="text-xs text-[#68746d]">Available space on the host's Data volume. Gaps are missing measurements; dotted markers are cleanup attempts. The dashed line marks the {recordingFloorGiB} GiB recorder minimum. Free space alone does not establish routine readiness.</p>
    <p className="mt-1 text-xs text-[#68746d]">Default cleanup policy is separate: trigger below 30 GiB, target 35 GiB.</p></> : <p className="text-xs text-[#68746d]">{selected.label} from actual host reports. Gaps are missing measurements; hover a point for its observed pressure. Memory usage and swap do not determine OS pressure.</p>}
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

export function MemoryHealth({ host, now, unavailable = false }: { host: TestHostLatest; now: number; unavailable?: boolean }) {
  const fresh = !unavailable && hostIsFresh(host, now), memory = host.memory;
  const pressure = memory?.pressure, tone = fresh && pressure ? pressure === "normal" ? "healthy" : "blocked" : "unknown";
  const label = !fresh ? `${unavailable ? "Refresh unavailable" : "Stale report"} · current pressure unavailable` : pressure ? `${pressure[0].toUpperCase()}${pressure.slice(1)} pressure` : "Pressure unavailable";
  return <section className="mt-6 border-t border-[#e4e9e2] pt-4" aria-label="Host memory">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-semibold">Memory</h3>
      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${tones[tone]}`}>{label}</span></div>
    <p className="mt-2 text-xs text-[#68746d]">{fresh ? "Latest measurement" : `${unavailable ? "Refresh unavailable" : "Stale"} · last reported ${time(host.sampledAt)}, not current`}</p>
    <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div><dt className="text-xs text-[#68746d]">Used / physical RAM</dt><dd className="mt-1 font-semibold">{size(memory?.usedBytes)} / {size(memory?.totalBytes)}</dd></div>
      <div><dt className="text-xs text-[#68746d]">Compressed RAM</dt><dd className="mt-1 font-semibold">{size(memory?.compressedBytes)}</dd></div>
      <div><dt className="text-xs text-[#68746d]">Swap used</dt><dd className="mt-1 font-semibold">{size(memory?.swapUsedBytes)}</dd></div>
      <div><dt className="text-xs text-[#68746d]">OS memory availability</dt><dd className="mt-1 font-semibold">{memory?.pressureFreePercent == null ? "Unavailable" : `${memory.pressureFreePercent.toFixed(0)}%`}</dd></div>
    </dl>
    <details className="mt-3 text-xs text-[#747780]"><summary className="cursor-pointer">About these measurements</summary><p className="mt-2">Used RAM excludes file cache and includes the compressor's physical size. Availability and pressure are reported by macOS, not inferred from raw free pages. Swap can remain used after pressure subsides.</p></details>
  </section>;
}

export function SystemHealthPage({tab = 'lanes', lane = null, onTabChange = () => {}}: {
  tab?: SystemHealthTab; lane?: LaneSelection | null; onTabChange?: (tab: SystemHealthTab) => void;
}) {
  const now = useClock(), selected = lane ? 'lanes' : tab;
  return <SystemHealthTabs selected={selected} onSelect={onTabChange}>
    {selected === 'lanes' ? lane ? <LaneHistoryPage key={`${lane.hostId}/${lane.laneId}`} selection={lane} now={now} /> : <LaneHealthSection now={now} />
      : selected === 'pending' ? <PendingQueueSection />
      : selected === 'framework' ? <FrameworkHealthSection now={now} />
      : selected === 'repair' ? <LaneRestorationPage />
      : <HostHealthSection key={selected} section={selected} now={now} />}
  </SystemHealthTabs>;
}

function HostServices({host, now, unavailable}: {host: TestHostLatest; now: number; unavailable: boolean}) {
  const fresh = !unavailable && hostIsFresh(host, now);
  return <div className="mt-4 grid gap-3 lg:grid-cols-3">{HOST_COMPONENTS.map(role => {
    const component = host.components.find(value => value.component === role), state = componentHealth(host, component, now, unavailable);
    return <article key={role} className="rounded-xl border border-[#e0e6de] p-4">
      <h3 className="font-semibold">{componentNames[role]}</h3>
      <span className={`mt-2 inline-block rounded-md px-2 py-1 text-xs font-semibold ${tones[state.tone]}`}>{state.label}</span>
      <details className="mt-3 text-xs text-[#747780]"><summary className="cursor-pointer font-medium">Service details</summary>
        <p className="mt-2">{state.summary}</p><p className="mt-2"><strong>Next:</strong> {state.next}</p>
        {component?.state === 'running' && fresh ? <p className="mt-2">The service is alive; this does not say a model or routine is working.</p> : null}
      </details>
    </article>;
  })}</div>;
}

function HostHealthSection({section, now}: {section: 'services' | 'memory' | 'disk'; now: number}) {
  const query = useHostHealth(), client = useQueryClient(), [hostId, setHostId] = useState<string | null>(null);
  const hosts = query.data?.hosts ?? [], host = hosts.find(value => value.hostId === hostId) ?? hosts[0];
  const fresh = Boolean(host && !query.isError && hostIsFresh(host, now));
  const title = section === 'services' ? 'Services' : section === 'memory' ? 'Memory' : 'Disk & cleanup';
  return <section className={TESTING_PANEL}>
    <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-xl font-semibold">{title}</h2>
      <TestingButton className="text-sm" busy={query.isFetching} onClick={() => {
        void query.refetch();
        if (host && section !== 'services') void client.refetchQueries({queryKey: ['test-host-history', host.hostId], type: 'active'});
      }}>Refresh</TestingButton></div>
    {query.isError ? <p className="mt-4 text-sm text-[#a64235]">Host reports could not refresh. Current status is unknown.</p> : null}
    {!host ? query.isPending ? <LoadingIndicator label="Loading host reports" className="mt-4" />
      : <p className="mt-4 text-sm text-[#68746d]">No independent host monitor has reported yet.</p> : <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <select aria-label="Host" value={host.hostId} onChange={event => setHostId(event.target.value)} className="rounded-lg border border-[#dfe5dd] bg-white px-3 py-2 text-sm">
          {hosts.map(value => <option key={value.hostId}>{value.hostId}</option>)}
        </select>
        <p className="text-xs text-[#68746d]">{fresh ? 'Host reporting' : 'Stale · no recent report'} · Last observed {elapsed(host.sampledAt, now)} ago ({time(host.sampledAt)})</p>
      </div>
      {section === 'services' ? <HostServices host={host} now={now} unavailable={query.isError} /> : <>
        {section === 'memory' ? <MemoryHealth host={host} now={now} unavailable={query.isError} /> : <div className="mt-6">
          <h3 className="text-base font-semibold">Available disk space</h3>
          <p className={`mt-1 text-2xl font-semibold ${fresh && host.freeBytes !== null && host.freeBytes < DISK_FLOOR_BYTES ? 'text-[#a64235]' : 'text-[#202820]'}`}>
            {size(host.freeBytes)}<span className="ml-2 text-xs font-normal text-[#68746d]">{fresh ? 'latest measurement' : 'stale · last reported, not current'}</span>
          </p>
        </div>}
        <HostMeasurementHistory key={`${host.hostId}/${section}`} hostId={host.hostId} section={section} />
      </>}
      {query.data?.truncated ? <p className="mt-3 text-xs text-[#a64235]">Only the first 32 reporting hosts are shown.</p> : null}
    </>}
  </section>;
}

function HostMeasurementHistory({hostId, section}: {hostId: string; section: 'memory' | 'disk'}) {
  const [days, setDays] = useState<1 | 7>(1), [metric, setMetric] = useState<HistoryMetric>(section === 'disk' ? 'disk' : 'used');
  const history = useQuery({queryKey: ['test-host-history', hostId, days], refetchInterval: 60_000,
    queryFn: () => api<TestHostHistory>(`/api/admin/test-runs/health/${encodeURIComponent(hostId)}?days=${days}`)});
  return <>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      {section === 'memory' ? <label className="text-sm">History metric <select aria-label="History metric" value={metric} onChange={event => setMetric(event.target.value as HistoryMetric)} className="ml-2 rounded-lg border border-[#dfe5dd] bg-white px-3 py-2 text-sm">
        {Object.entries(historyMetrics).filter(([id]) => id !== 'disk').map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}
      </select></label> : <h3 className="text-base font-semibold">Disk history</h3>}
      <div className="flex gap-1 rounded-lg bg-[#f0f3ee] p-1">{([1, 7] as const).map(value => <TestingButton variant="ghost" key={value} aria-pressed={days === value} onClick={() => setDays(value)} className={`rounded-md px-3 py-1 text-sm ${days === value ? 'bg-white font-semibold shadow-sm' : 'text-[#68746d]'}`}>
        {value === 1 ? '24 hours' : '7 days'}
      </TestingButton>)}</div>
    </div>
    {history.isError ? <p className="mt-3 text-sm text-[#a64235]">History could not refresh. {history.data ? 'Showing the last fetched history.' : ''}</p> : null}
    {history.data ? <div className="mt-4"><DiskHistoryChart history={history.data} metric={metric} />{section === 'disk' ? <CleanupEvents events={history.data.cleanupEvents} /> : null}</div>
      : history.isError ? <p className="mt-4 text-sm text-[#68746d]">Historical measurements unavailable.</p> : <LoadingIndicator label="Loading recorded measurements" className="mt-4" />}
  </>;
}
