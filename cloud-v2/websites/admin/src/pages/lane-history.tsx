import {useInfiniteQuery, useQuery} from "@tanstack/react-query";
import type {LaneSelection} from "../lib/lane-links";
import {restorationHostIsFresh, type LaneRestorationList} from "../../../../packages/core/src/types/lane-restoration.types";
import type {FrameworkRunPage} from "../../../../packages/core/src/types/test-history.types";
import {api} from "../lib/api";
import {LaneHealthHost} from "./lane-health";
import {RestorationHost} from "./lane-restoration";

export function LaneHistoryPage({selection, now}: {selection: LaneSelection; now: number}) {
  const {hostId, laneId} = selection;
  const controllers = useQuery({queryKey: ["lane-restoration"], queryFn: () => api<LaneRestorationList>("/api/admin/test-runs/restoration/list"), refetchInterval: 30_000});
  const runs = useInfiniteQuery({queryKey: ["lane-runs", hostId, laneId], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => api<FrameworkRunPage>(`/api/admin/test-runs/?hostId=${encodeURIComponent(hostId)}&laneId=${encodeURIComponent(laneId)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 30_000});
  const host = controllers.data?.hosts.find(host => host.hostId === hostId);
  const lane = host?.lanes.find(lane => lane.id === laneId);
  const fresh = Boolean(host && !controllers.isError && restorationHostIsFresh(host, now, controllers.data!.freshForMs));
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><a href="/?systemHealth=1" className="text-sm font-medium text-blue-700 underline">Back to System health</a>
      <h2 className="mt-3 text-xl font-semibold">{laneId} history</h2><p className="mt-1 text-sm text-[#747780]">Controller: {hostId}</p></div>
      <button className="text-sm font-medium text-blue-700 underline" onClick={() => {void controllers.refetch(); void runs.refetch();}}>Refresh lane</button></div>
    <section className="rounded-2xl border border-[#dfe5dd] bg-white p-5"><h3 className="font-semibold">Current lane status</h3>
      {controllers.isError && <p role="alert" className="mt-3 text-sm text-red-700">Controller reports could not refresh. Current lane status is unknown.</p>}
      {host && lane ? <LaneHealthHost host={{...host, lanes: [lane]}} fresh={fresh} linkHistory={false} /> : <p className="mt-3 text-sm text-[#747780]">{controllers.isPending ? "Loading lane report…" : "No controller report is available for this lane. Current status is unknown."}</p>}
      {controllers.data?.truncated && <p className="mt-3 text-sm text-amber-800">Controller reports are truncated; this lane may be omitted.</p>}
    </section>
    <section className="rounded-2xl border border-[#dfe5dd] bg-white p-5"><h3 className="text-lg font-semibold">Routine run history</h3>
      <p className="mt-1 text-sm text-[#747780]">Published runs for this controller and lane, newest first. Open a run for its steps, recording and evidence.</p>
      {runs.isError && <p role="alert" className="mt-3 text-sm text-red-700">Run history could not refresh. Displayed runs are previously loaded history.</p>}
      <ul className="mt-4 space-y-3">{runs.data?.pages.flatMap(page => page.runs).map(run => <li key={run.runId} className="rounded-xl border border-[#e0e4de] p-4">
        <div className="flex flex-wrap justify-between gap-2"><a className="font-medium text-blue-700 underline" href={`/?testRun=${encodeURIComponent(run.runId)}`}>{run.routineId}</a><span className="text-sm">{run.outcome}</span></div>
        <p className="mt-2 text-sm text-[#747780]">{new Date(run.startedAt).toLocaleString()} · {run.build.channel} · {run.build.release ?? run.build.headSha.slice(0, 10)}</p>
        {(!run.uploadsComplete || run.evidenceStatus === "failed") && <p className="mt-2 text-sm text-amber-800">{run.evidenceStatus === "failed" ? "Evidence failed" : "Evidence upload pending"}</p>}
      </li>)}</ul>
      {!runs.data?.pages.some(page => page.runs.length) && <p className="mt-3 text-sm text-[#747780]">{runs.isPending ? "Loading run history…" : runs.isError ? "Run history is unavailable." : "No published runs for this lane."}</p>}
      {runs.hasNextPage && <button className="mt-4 text-sm font-medium text-blue-700 underline disabled:opacity-60" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>{runs.isFetchingNextPage ? "Loading…" : "More runs"}</button>}
    </section>
    <section className="rounded-2xl border border-[#dfe5dd] bg-white p-5"><h3 className="mb-4 text-lg font-semibold">Restoration history &amp; resume decisions</h3>
      {host && lane ? <RestorationHost host={host} fresh={fresh} laneId={laneId} /> : <p className="text-sm text-[#747780]">Restoration history is unavailable for this lane.</p>}
    </section>
  </div>;
}
