import {TESTING_PANEL, TESTING_LINK, TestingButton} from "../components/testing-ui";
import {useQuery} from "@tanstack/react-query"
import {Loader2} from 'lucide-react'
import {
  restorationHostIsFresh,
  type LaneRestorationHost,
  type LaneOverviewHost,
  type LaneOverviewList,
} from "../../../../packages/core/src/types/lane-restoration.types"
import {laneDisplayLabel, laneHistoryHref, readableLaneIdentity} from "../lib/lane-links"
import {api} from "../lib/api"

const states: Record<string, {label: string; style: string}> = {
  "idle": {label: "Idle", style: "bg-[#e6f5ed] text-[#087d50]"},
  "running": {label: "Running", style: "bg-blue-50 text-blue-700"},
  "reserved": {label: "Reserved", style: "bg-blue-50 text-blue-700"},
  "in-repair": {label: "In repair", style: "bg-amber-50 text-amber-800"},
  "out-of-service": {label: "Out of service", style: "bg-red-50 text-red-700"},
  "offline": {label: "Offline", style: "bg-[#f0f2ef] text-[#59655e]"},
}
const unknown = {label: "Unknown", style: "bg-[#f0f2ef] text-[#59655e]"}
const modes: Record<string, string> = {automatic: "Automatic", authoring: "Authoring", paused: "Paused"}
const time = (value: string) => new Date(value).toLocaleString()

export function FrameworkHealth({host, fresh, showHistory = true}: {host: LaneOverviewHost | LaneRestorationHost; fresh: boolean; showHistory?: boolean}) {
  const history = 'restoration' in host ? host.frameworkHistory ?? [] : [],
    last = 'frameworkCurrentInterval' in host ? host.frameworkCurrentInterval : history.at(-1),
    binding = host.frameworkBinding ?? last?.binding
  const stopped = last?.endedAt && last.binding.installationId === binding?.installationId
  const current = !!host.frameworkBinding && fresh && !stopped
  const target = host.deployment?.desiredTarget
  const source = (revision: string) => `https://github.com/Mentra-Community/Mentra-Automated-Testing/commit/${revision}`
  return (
    <article className="mt-3 rounded-xl border border-[#e0e4de] p-4" aria-label="Framework deployment">
      <h4 className="font-semibold">{current ? "Running framework" : "Last confirmed framework"}</h4>
      {binding ? (
        <p className="mt-2 text-sm">
          Version {binding.version} · Routine API {binding.routineApiVersion} ·{" "}
          <a className={TESTING_LINK} href={source(binding.revision)}>
            {binding.revision.slice(0, 10)}
          </a>
        </p>
      ) : (
        <p className="mt-2 text-sm text-[#747780]">Installed framework has not been reported.</p>
      )}
      {!current && binding && (
        <p className="mt-2 text-sm text-[#747780]">
          {stopped
            ? "Controller stop was observed."
            : "Current framework status is unknown because the controller report is stale."}
        </p>
      )}
      {(host.frameworkAcceptedAt ?? last?.effectiveAt) && (
        <p className="mt-1 text-xs text-[#747780]">
          Startup accepted {time((host.frameworkAcceptedAt ?? last?.effectiveAt)!)}
        </p>
      )}
      {host.deployment && (
        <div className="mt-3 text-sm">
          <p className="font-medium">
            Pending framework update:{" "}
            {target ? (
              <>
                <a className={TESTING_LINK} href={source(target.revision)}>
                  Version {target.version} · Routine API {target.routineApiVersion} · {target.revision.slice(0, 10)}
                </a>
              </>
            ) : (
              "None reported"
            )}
          </p>
          {host.deployment.activeTarget && host.deployment.activeTarget.installationId !== target?.installationId && (
            <p className="mt-1">
              Activating version {host.deployment.activeTarget.version} ·{" "}
              {host.deployment.activeTarget.revision.slice(0, 10)}
            </p>
          )}
          <p className="mt-1">
            Waiting for:{" "}
            {host.deployment.reason ??
              (host.deployment.consumers.length
                ? host.deployment.consumers.map((value) => value.reason).join("; ")
                : host.deployment.nextAction)}
          </p>
          <p className="mt-1 text-xs text-[#747780]">
            Deployment {host.deployment.phase} · Observed {time(host.deployment.observedAt)}
          </p>
        </div>
      )}
      {showHistory && !!history.length && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">Installation history</summary>
          <ol className="mt-2 space-y-2 text-xs">
            {history.map((entry) => (
              <li key={`${entry.incarnation}:${entry.binding.installationId}`}>
                <a className={TESTING_LINK} href={source(entry.binding.revision)}>
                  Version {entry.binding.version} · Routine API {entry.binding.routineApiVersion} ·{" "}
                  {entry.binding.revision.slice(0, 10)}
                </a>
                <p className="text-[#747780]">
                  Accepted {time(entry.effectiveAt)}
                  {entry.endedAt
                    ? ` · Ended ${time(entry.endedAt)} (${entry.endReason === "observed-stop" ? "observed stop" : "accepted replacement"})`
                    : " · End not observed"}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  )
}

export function LaneHealthHost({
  host,
  fresh,
  linkHistory = true,
}: {
  host: LaneOverviewHost | LaneRestorationHost
  fresh: boolean
  linkHistory?: boolean
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
      <FrameworkHealth host={host} fresh={fresh} showHistory={linkHistory === false} />
      {!host.lanes.length ? (
        <p className="mt-3 text-sm text-[#747780]">No lanes were reported by this controller.</p>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {host.lanes.map((lane) => {
            const state = fresh ? (states[lane.state] ?? unknown) : unknown
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
                  <span className={`rounded-md px-2 py-1 text-xs font-semibold ${state.style}`}>{state.label}</span>
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
                {lane.activity ? <div className="mt-2 text-sm text-[#5d6068]">
                  <p>{fresh ? 'Current owner' : 'Last reported owner'}: {lane.activity.owner.kind === 'run' ? 'Routine run'
                    : lane.activity.owner.kind === 'authoring' ? 'Authoring reservation'
                    : lane.activity.owner.kind === 'fixer' ? 'State repair' : 'Boundary cleanup'}</p>
                  {fresh && lane.activity.owner.requestId ? <a className={TESTING_LINK}
                    href={`/?testRun=${encodeURIComponent(lane.activity.owner.requestId)}`}>{lane.activity.owner.id}</a>
                    : <p className="break-all font-mono text-xs">{lane.activity.owner.id}</p>}
                  <p className="text-xs">Generation {lane.activity.generation}</p>
                </div> : ['running', 'reserved', 'in-repair'].includes(lane.state)
                  ? <p className="mt-2 text-xs text-[#747780]">{fresh ? 'Owner not reported.' : 'Last reported owner unavailable.'}</p> : null}
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

export const laneOverviewQuery = {
    queryKey: ['lane-overview'],
    queryFn: () => api<LaneOverviewList>('/api/admin/test-runs/lanes/overview'),
    refetchInterval: 30_000,
}
export function LaneHealthSection({now}: {now: number}) {
  const query = useQuery(laneOverviewQuery)
  return (
    <section aria-label="Device lanes" className={TESTING_PANEL}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Device lanes</h2>
          <details className="mt-2 text-xs text-[#747780]"><summary className="cursor-pointer">About lane status</summary><p className="mt-2">Live controller reports of each lane's state and scheduling mode. Idle means no routine is executing; resource readiness is checked when a job is admitted.</p></details>
        </div>
        <TestingButton className="text-sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching && <Loader2 aria-label="Refreshing lanes" className="size-4 animate-spin" />}
          Refresh lanes
        </TestingButton>
      </div>
      {query.isError && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          Lane reports could not refresh. Current lane status is unknown; displayed values are the last received report.
        </p>
      )}
      {query.data?.hosts.map((host) => (
        <LaneHealthHost
          key={host.hostId}
          host={host}
          fresh={!query.isError && restorationHostIsFresh(host, now, query.data!.freshForMs)}
        />
      ))}
      {!query.data?.hosts.length && (
        <p className="mt-4 text-sm text-[#747780]">
          {query.isPending
            ? <span role="status" className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="size-4 animate-spin" />Loading lane reports</span>
            : "No controller lane report is available. Current lane status is unknown."}
        </p>
      )}
      {query.data?.truncated && (
        <p className="mt-3 text-sm text-amber-800">
          Only the first 32 reporting controllers are shown. Additional lanes may be omitted.
        </p>
      )}
    </section>
  )
}
