import {useQuery} from "@tanstack/react-query";
import {restorationHostIsFresh, type LaneRestorationHost, type LaneRestorationList} from "../../../../packages/core/src/types/lane-restoration.types";
import {api} from "../lib/api";

const states: Record<string, {label: string; style: string}> = {
  idle: {label: "Idle", style: "bg-[#e6f5ed] text-[#087d50]"},
  running: {label: "Running", style: "bg-blue-50 text-blue-700"},
  reserved: {label: "Reserved", style: "bg-blue-50 text-blue-700"},
  "in-repair": {label: "In repair", style: "bg-amber-50 text-amber-800"},
  "out-of-service": {label: "Out of service", style: "bg-red-50 text-red-700"},
  offline: {label: "Offline", style: "bg-[#f0f2ef] text-[#59655e]"},
};
const unknown = {label: "Unknown", style: "bg-[#f0f2ef] text-[#59655e]"};
const modes: Record<string, string> = {automatic: "Automatic", authoring: "Authoring", paused: "Paused"};
const time = (value: string) => new Date(value).toLocaleString();

export function LaneHealthHost({host, fresh}: {host: LaneRestorationHost; fresh: boolean}) {
  return <div className="mt-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-[#14151b]">{host.hostId}</h3>
      <p className="text-xs text-[#747780]">{fresh ? "Controller reporting" : "No recent controller report"} · Last observed {time(host.observedAt)} · Received {time(host.receivedAt)}</p>
    </div>
    {!host.lanes.length ? <p className="mt-3 text-sm text-[#747780]">No lanes were reported by this controller.</p> :
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{host.lanes.map(lane => {
        const state = fresh ? states[lane.state] ?? unknown : unknown;
        return <article key={lane.id} className="rounded-xl border border-[#e0e4de] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-[#14151b]">{lane.id}</h4>
            <span className={`rounded-md px-2 py-1 text-xs font-semibold ${state.style}`}>{state.label}</span></div>
          <p className="mt-2 text-sm text-[#5d6068]">{lane.platform === "android" ? "Android" : "iOS on Mac"}</p>
          <p className="mt-2 text-sm text-[#5d6068]">{fresh ? "Scheduling" : "Last reported scheduling"}: {modes[lane.dispatchMode] ?? "Unknown"}</p>
          {!fresh && <p className="mt-2 text-sm text-[#747780]">Last reported state: {states[lane.state]?.label ?? "Unknown"}. Current lane status is unknown.</p>}
          <a className="mt-3 inline-block text-sm font-medium text-blue-700 underline" href={`/?systemHealth=1&restoration=1#${encodeURIComponent(`lane-${host.hostId}-${lane.id}`)}`}>Restoration history &amp; resume decisions</a>
        </article>;
      })}</div>}
  </div>;
}

export function LaneHealthSection({now}: {now: number}) {
  const query = useQuery({queryKey: ["lane-restoration"], queryFn: () => api<LaneRestorationList>("/api/admin/test-runs/restoration/list"), refetchInterval: 30_000});
  return <section aria-label="Device lanes" className="rounded-2xl border border-[#dfe5dd] bg-white p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Device lanes</h2>
      <p className="mt-1 text-sm text-[#747780]">Live controller reports of each lane's state and scheduling mode. Idle means no routine is executing; resource readiness is checked when a job is admitted.</p></div>
      <button className="text-sm font-medium text-blue-700 underline" onClick={() => void query.refetch()}>Refresh lanes</button></div>
    {query.isError && <p role="alert" className="mt-3 text-sm text-red-700">Lane reports could not refresh. Current lane status is unknown; displayed values are the last received report.</p>}
    {query.data?.hosts.map(host => <LaneHealthHost key={host.hostId} host={host} fresh={!query.isError && restorationHostIsFresh(host, now, query.data!.freshForMs)} />)}
    {!query.data?.hosts.length && <p className="mt-4 text-sm text-[#747780]">{query.isPending ? "Loading lane reports…" : "No controller lane report is available. Current lane status is unknown."}</p>}
    {query.data?.truncated && <p className="mt-3 text-sm text-amber-800">Only the first 32 reporting controllers are shown. Additional lanes may be omitted.</p>}
  </section>;
}
