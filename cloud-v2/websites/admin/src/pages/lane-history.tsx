import {TestHistoryTable} from "../components/test-history-table";
import {TESTING_PANEL, TESTING_LINK, TestingButton} from "../components/testing-ui";
import {useInfiniteQuery, useQuery} from "@tanstack/react-query";
import {Loader2} from 'lucide-react';
import {laneDisplayLabel, type LaneSelection} from "../lib/lane-links";
import {restorationHostIsFresh, type LaneRestorationList} from "../../../../packages/core/src/types/lane-restoration.types";
import type {FrameworkRunPage} from "../../../../packages/core/src/types/test-history.types";
import {api} from "../lib/api";
import {FrameworkHealth, LaneHealthHost, laneOverviewQuery} from "./lane-health";
import {RestorationHost} from "./lane-restoration";
const loading = (label: string) => <span role="status" className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="size-4 animate-spin" />{label}</span>;

export function LaneHistoryPage({selection, now}: {selection: LaneSelection; now: number}) {
  const {hostId, laneId} = selection;
  const controllers = useQuery(laneOverviewQuery);
  const details = useQuery({queryKey: ['lane-restoration', hostId],
    queryFn: () => api<LaneRestorationList>(`/api/admin/test-runs/restoration/list?hostId=${encodeURIComponent(hostId)}`), refetchInterval: 30_000});
  const runs = useInfiniteQuery({queryKey: ["lane-runs", hostId, laneId], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => api<FrameworkRunPage>(`/api/admin/test-runs?hostId=${encodeURIComponent(hostId)}&laneId=${encodeURIComponent(laneId)}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 30_000});
  const host = controllers.data?.hosts.find(host => host.hostId === hostId);
  const detailedHost = details.data?.hosts.find(host => host.hostId === hostId);
  const historyLane = detailedHost?.lanes.find(lane => lane.id === laneId);
  const lane = host?.lanes.find(lane => lane.id === laneId);
  const fresh = Boolean(host && !controllers.isError && restorationHostIsFresh(host, now, controllers.data!.freshForMs));
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><a href="/?systemHealth=1" className="text-sm font-medium text-blue-700 hover:underline">Back to System health</a>
      <h2 className="mt-3 text-xl font-semibold">{lane ? laneDisplayLabel(hostId, lane) : laneId} history</h2><p className="mt-1 text-sm text-[#747780]">Controller: {hostId} · Lane: {laneId}</p></div>
      <TestingButton className="text-sm" disabled={controllers.isFetching || runs.isFetching || details.isFetching} onClick={() => {void controllers.refetch(); void runs.refetch(); void details.refetch();}}>
        {(controllers.isFetching || runs.isFetching || details.isFetching) && <Loader2 aria-label="Refreshing lane" className="size-4 animate-spin" />}Refresh lane</TestingButton></div>
    <section className={TESTING_PANEL}><h3 className="font-semibold">Current lane status</h3>
      {controllers.isError && <p role="alert" className="mt-3 text-sm text-red-700">Controller reports could not refresh. Current lane status is unknown.</p>}
      {host && lane ? <LaneHealthHost host={{...host, lanes: [lane]}} fresh={fresh} linkHistory={false} /> : <p className="mt-3 text-sm text-[#747780]">{controllers.isPending ? loading('Loading lane report') : "No controller report is available for this lane. Current status is unknown."}</p>}
      {controllers.data?.truncated && <p className="mt-3 text-sm text-amber-800">Controller reports are truncated; this lane may be omitted.</p>}
    </section>
    {detailedHost && <section className={TESTING_PANEL}><h3 className="font-semibold">Framework installation history</h3><FrameworkHealth host={detailedHost} fresh={!details.isError && restorationHostIsFresh(detailedHost, now, details.data!.freshForMs)} /></section>}
    <section className={TESTING_PANEL}><h3 className="text-lg font-semibold">Routine run history</h3>
      <p className="mt-1 text-sm text-[#747780]">Published runs for this controller and lane, newest first. Open a run for its steps, recording and evidence.</p>
      {runs.isError && <p role="alert" className="mt-3 text-sm text-red-700">Run history could not refresh. Displayed runs are previously loaded history.</p>}
      {!!runs.data?.pages.some(page => page.runs.length) && <TestHistoryTable entries={runs.data.pages.flatMap(page => page.runs).map(run => ({kind: "run" as const, ...run}))} routines={[]}/>}
      {!runs.data?.pages.some(page => page.runs.length) && <p className="mt-3 text-sm text-[#747780]">{runs.isPending ? loading('Loading run history') : runs.isError ? "Run history is unavailable." : "No published runs for this lane."}</p>}
      {runs.hasNextPage && <TestingButton className="mt-4 text-sm    disabled:opacity-60" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>{runs.isFetchingNextPage ? loading('Loading runs') : "More runs"}</TestingButton>}
    </section>
    <section className={TESTING_PANEL}><h3 className="mb-4 text-lg font-semibold">Restoration history &amp; resume decisions</h3>
      {details.isError && <p role="alert" className="text-sm text-red-700">Restoration history could not refresh.</p>}
      {detailedHost && historyLane ? <RestorationHost host={detailedHost} fresh={!details.isError && restorationHostIsFresh(detailedHost, now, details.data!.freshForMs)} laneId={laneId} /> : <p className="text-sm text-[#747780]">{details.isPending ? loading('Loading restoration history') : "Restoration history is unavailable for this lane."}</p>}
    </section>
  </div>;
}
