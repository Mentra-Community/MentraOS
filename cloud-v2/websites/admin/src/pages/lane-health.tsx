import {ReservableStatusBadge} from '../components/reservable-status';
import {useClock} from '../lib/use-clock';
import {LaneControls} from './lane-controls'
import {TESTING_PANEL, TESTING_LINK, TestingButton} from "../components/testing-ui";
import {useQuery} from "@tanstack/react-query"
import {LoadingIndicator} from '../components/loading-indicator'
import {
  restorationHostIsFresh,
  type LaneRestorationHost,
  type LaneOverviewHost,
  type LaneOverviewList,
} from "../../../../packages/core/src/types/lane-restoration.types"
import {laneDisplayLabel, laneHistoryHref, readableLaneIdentity} from "../lib/lane-links"
import {api} from "../lib/api"
import {repairActivityLabel} from "../lib/repair-status"
import type {ResourceLifecycleSubject} from '../../../../packages/core/src/types/resource-lifecycle.types'
import {resourceOverviewQuery} from './resource-health'
import {ResourceConditionStatus, resourceReportHref} from './resource-checklist'

const states: Record<string, {label: string; style: string}> = {
  "idle": {label: "Idle", style: "bg-[#e6f5ed] text-[#087d50]"},
  "running": {label: "Running", style: "bg-blue-50 text-blue-700"},
  "reserved": {label: "Reserved", style: "bg-blue-50 text-blue-700"},
  "in-repair": {label: "In repair", style: "bg-amber-50 text-amber-800"},
  "out-of-service": {label: "Out of service", style: "bg-red-50 text-red-700"},
  "offline": {label: "Offline", style: "bg-[#f0f2ef] text-[#59655e]"},
}
const modes: Record<string, string> = {automatic: "Automatic", authoring: "Authoring", paused: "Paused"}
const time = (value: string) => new Date(value).toLocaleString()

export function LaneHealthHost({
  host,
  fresh,
  linkHistory = true,
  controls = false,
  resources,
  resourceReportsCurrent = false,
}: {
  host: LaneOverviewHost | LaneRestorationHost
  fresh: boolean
  linkHistory?: boolean
  controls?: boolean
  resources?: ResourceLifecycleSubject[]
  resourceReportsCurrent?: boolean
}) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#14151b]">{readableLaneIdentity(host.hostId)} <span className="font-normal text-[#747780]">({host.hostId})</span></h3>
        <p className="text-xs text-[#747780]">
          {fresh ? "Controller reporting" : "No recent controller report"} · Last observed {time(host.observedAt)} ·
          Received {time(host.receivedAt)}
        </p>
      </div>
      {!host.lanes.length ? (
        <p className="mt-3 text-sm text-[#747780]">No lanes were reported by this controller.</p>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {host.lanes.map((lane) => {
            return (
              <article key={lane.id} className="rounded-xl border border-[#e0e4de] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-[#14151b]">
                    {linkHistory ? (
                      <a href={laneHistoryHref(host.hostId, lane.id)} className="hover:underline">
                        {laneDisplayLabel(host.hostId, lane)}
                      </a>
                    ) : (
                      laneDisplayLabel(host.hostId, lane)
                    )}
                  </h4>
                  <ReservableStatusBadge status={lane.state} current={fresh} />
                </div>
                <p className="mt-2 text-xs text-[#5d6068]">Lane: <span className="font-mono">{lane.id}</span></p>
                <p className="mt-2 text-sm text-[#5d6068]">
                  {fresh ? "Scheduling" : "Last reported scheduling"}: {modes[lane.dispatchMode] ?? "Unknown"}
                </p>
                {!fresh && (
                  <p className="mt-2 text-sm text-[#747780]">
                    Last reported state: {states[lane.state]?.label ?? "Unknown"}. Current lane status is unknown.
                  </p>
                )}
                {lane.reservedBy !== undefined && <p className="mt-2 break-all text-sm text-[#5d6068]">
                  {fresh ? 'Reserved by' : 'Last reported reserved by'}: {lane.reservedBy ?? 'User not recorded'}
                </p>}
                {lane.activity ? <div className="mt-2 text-sm text-[#5d6068]">
                  <p>{fresh ? 'Current owner' : 'Last reported owner'}: {lane.activity.owner.kind === 'run' ? 'Routine run'
                    : lane.activity.owner.kind === 'authoring' ? 'Authoring reservation'
                    : lane.activity.owner.kind === 'fixer' ? 'Repair custody' : 'Boundary cleanup'}</p>
                  {lane.activity.owner.kind === 'fixer' ? <p aria-label="Repair activity">
                    {fresh ? repairActivityLabel(lane.repair, lane) : 'Repair execution unknown · controller report is stale'}
                  </p> : null}
                  {fresh && lane.activity.owner.requestId ? <a className={TESTING_LINK}
                    href={`/?testRun=${encodeURIComponent(lane.activity.owner.requestId)}`}>{lane.activity.owner.id}</a>
                    : <p className="break-all font-mono text-xs">{lane.activity.owner.id}</p>}
                  <p className="text-xs">Generation {lane.activity.generation}</p>
                </div> : ['running', 'reserved', 'in-repair'].includes(lane.state)
                  ? <p className="mt-2 text-xs text-[#747780]">{fresh ? 'Owner not reported.' : 'Last reported owner unavailable.'}</p> : null}
                {controls && <LaneControls hostId={host.hostId} laneId={lane.id} mode={lane.dispatchMode} fresh={fresh} lane={lane} />}
                {resources && <LaneResourceChecklist hostId={host.hostId} laneId={lane.id} resources={resources} current={resourceReportsCurrent}/>}
                {linkHistory && (
                  <a
                    className="mt-3 inline-block text-sm font-medium text-blue-700 hover:underline"
                    href={laneHistoryHref(host.hostId, lane.id)}>
                    View lane history
                  </a>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function LaneResourceChecklist({hostId, laneId, resources, current, now = Date.now()}: {
  hostId: string; laneId: string; resources: ResourceLifecycleSubject[]; current: boolean; now?: number
}) {
  const required = resources.filter(resource => resource.resource.memberships.some(member => member.hostId === hostId && member.laneId === laneId)),
    included = new Map(required.map(resource => [resource.subject.id, resource])), pending = required.flatMap(resource => resource.resource.dependencies ?? []),
    dependencies = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!
    if (included.has(id) || dependencies.has(id)) continue
    dependencies.add(id)
    const resource = resources.find(resource => resource.subject.id === id)
    if (resource) {included.set(id, resource); pending.push(...resource.resource.dependencies ?? [])}
  }
  const ids = [...new Set([...required.map(resource => resource.subject.id), ...dependencies])]
  return <div className="mt-3 border-t border-[#e0e4de] pt-3 text-xs" aria-label="Physical resource conditions">
    <h5 className="font-medium">Physical resource conditions</h5>
    {!current && <p>Resource reports could not refresh. Displayed checklists retain their original observations.</p>}
    {!ids.length ? <p>{current ? 'Required resource membership not reported.' : 'Last reported inventory contained no matching resources for this lane. Current membership and physical conditions are unknown.'}</p> : <ul className="mt-2 space-y-2">{ids.map(id => {
      const resource = included.get(id), report = resource?.idle.report,
        fresh = current && resource?.current && resource.observedAt !== null && resource.receivedAt !== null &&
          Date.parse(resource.observedAt) <= now + 5_000 && Date.parse(resource.receivedAt) <= now + 5_000 &&
          now - Date.parse(resource.observedAt) <= 180_000 && now - Date.parse(resource.receivedAt) <= 180_000,
        failed = report?.conditions.filter(condition => condition.status === 'failed') ?? [],
        unreported = [...(report?.conditions.filter(condition => condition.status === 'unknown' || condition.status === 'not-checked') ?? [])
          .map(condition => ({...condition, contractVersion: report!.contractVersion})),
          ...(report?.currentContract?.conditions ?? []).map(condition => ({...condition, contractVersion: report!.currentContract!.contractVersion}))]
      return <li key={id}>
        <a href={resourceReportHref(id)} className="font-medium text-blue-700 hover:underline">{id}</a>{dependencies.has(id) ? ' · Dependency' : ' · Required resource'}
        {resource ? <>
          {!fresh && <p>Controller telemetry is not current. The physical checklist retains its accepted observations.</p>}
          <p>{fresh ? 'Physical check' : 'Last reported physical check'}: <ResourceConditionStatus status={report?.outcome ?? resource.idle.outcome}/></p>
          {report?.checkedAt && <p>Checked: <time dateTime={report.checkedAt} title={report.checkedAt}>{time(report.checkedAt)}</time></p>}
          {report?.currentContract && <p>Installed contract {report.currentContract.contractVersion}: Not checked. Retained results use {report.contractVersion}.</p>}
          {failed.length > 0 && <ul aria-label="Failed physical conditions" className="text-red-700">{failed.map(condition => <li key={condition.id}>{condition.label || condition.id}: {condition.explanation ?? 'Explanation not reported'}</li>)}</ul>}
          {unreported.length > 0 && <ul aria-label="Unknown physical conditions">{unreported.map(condition => <li key={`${condition.contractVersion}:${condition.id}`}>{condition.label || condition.id}: {condition.status === 'not-checked' ? 'Not checked' : 'Unknown'}{report?.currentContract ? ` (${condition.contractVersion})` : ''}</li>)}</ul>}
          {!report && <p>Condition checklist: Not reported</p>}
          {resource.owner && <p>{fresh ? 'Resource owner' : 'Last reported resource owner'}: {resource.owner.kind} {resource.owner.id}</p>}
          {resource.reason && <p>{resource.reason.code === 'resource-operator-out-of-service' ? 'Operator restriction' : 'Resource status'}: {resource.reason.message}</p>}
          {resource.repair.state !== 'none' && <p>Repair: {resource.repair.state}</p>}
        </> : <p>Physical resource observation: Not reported</p>}
      </li>
    })}</ul>}
  </div>
}

export const laneOverviewQuery = {
    queryKey: ['lane-overview'],
    queryFn: () => api<LaneOverviewList>('/api/admin/test-runs/lanes/overview'),
    refetchInterval: 30_000,
}
export function LaneHealthSection() {
  const now = useClock();
  const query = useQuery(laneOverviewQuery)
  const resourceQuery = useQuery(resourceOverviewQuery)
  return (
    <section aria-label="Device lanes" className={TESTING_PANEL}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Device lanes</h2>
          <details className="mt-2 text-xs text-[#747780]"><summary className="cursor-pointer">About lane status</summary><p className="mt-2">Live controller reports of each lane's state and scheduling mode. Idle means no routine is executing; resource readiness is checked when a job is admitted.</p></details>
        </div>
        <TestingButton className="text-sm" busy={query.isFetching} onClick={() => void query.refetch()}>
          Refresh lanes
        </TestingButton>
      </div>
      {query.isError && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          Lane reports could not refresh. Current lane status is unknown; displayed values are the last received report.
        </p>
      )}
      {resourceQuery.isPending && <p className="mt-3 text-xs">Loading physical resource reports…</p>}
      {resourceQuery.isError && <p role="alert" className="mt-3 text-xs">{resourceQuery.data
        ? 'Physical resource reports could not refresh. Displayed checklists retain their original observations.'
        : 'Physical resource inventory is unavailable. Required resource membership and physical conditions are unknown.'}</p>}
      {query.data?.hosts.map((host) => (
        <LaneHealthHost
          key={host.hostId}
          controls
          host={host}
          fresh={!query.isError && restorationHostIsFresh(host, now, query.data!.freshForMs)}
          resources={resourceQuery.isPending ? undefined : resourceQuery.data?.subjects}
          resourceReportsCurrent={!resourceQuery.isError && !resourceQuery.isPending}
        />
      ))}
      {!query.data?.hosts.length && (
        <p className="mt-4 text-sm text-[#747780]">
          {query.isPending
            ? <LoadingIndicator label="Loading lane reports" inline />
            : "No controller lane report is available. Current lane status is unknown."}
        </p>
      )}
      {query.data?.truncated && (
        <p className="mt-3 text-sm text-amber-800">
          Only the first 32 reporting controllers are shown. Additional lanes may be omitted.
        </p>
      )}
      {resourceQuery.data?.truncated && <p className="mt-3 text-xs">Resource observations were truncated; some required resources may be absent.</p>}
    </section>
  )
}
