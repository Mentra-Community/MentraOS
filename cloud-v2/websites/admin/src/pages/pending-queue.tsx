import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {PendingQueuePage, PendingQueueLane} from '../../../../packages/core/src/types/test-pending-queue.types';
import {TESTING_PANEL, TESTING_LINK, TestingButton} from '../components/testing-ui';
import {LoadingIndicator} from '../components/loading-indicator';
import {api} from '../lib/api';
import {laneDisplayLabel, laneHistoryHref, readableLaneIdentity} from '../lib/lane-links';

function LaneLabel({lane}: {lane: PendingQueueLane}) {
  return <a className={`${TESTING_LINK} rounded-lg border border-[#dfe5dd] px-2 py-1 text-xs`} href={laneHistoryHref(lane.hostId, lane.laneId)}>
    {laneDisplayLabel(lane.hostId, lane)} · {readableLaneIdentity(lane.laneId)} · {lane.fresh ? readableLaneIdentity(lane.state) : 'Stale report'} · {readableLaneIdentity(lane.dispatchMode)}
  </a>;
}
export function PendingQueueSection() {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery({queryKey: ['test-pending-queue', cursor], refetchInterval: 15_000,
    queryFn: () => api<PendingQueuePage>(`/api/admin/test-runs/pending-queue${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)});
  const data = query.data;
  return <section className={TESTING_PANEL}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Pending queue{data ? ` · ${data.total}` : ''}</h2>
      <TestingButton onClick={() => {void query.refetch();}}>Refresh queue</TestingButton></div>
    <p className="mt-2 text-sm text-[#68746d]">Waiting to start.</p>
    {query.isError ? <p className="mt-4 text-sm text-[#a64235]">Pending queue could not refresh. Lane availability is unknown.</p> : query.isPending ?
      <LoadingIndicator label="Loading pending queue" className="mt-4" /> : <>
      {!data?.items.length ? <p className="mt-4 text-sm text-[#68746d]">{cursor ? 'No requests remain on this page.' : 'No pending requests.'}</p> :
        <div className="mt-4 divide-y divide-[#e0e4de]">{data.items.map(item => <article key={item.requestId} className="py-4">
          <div className="flex flex-wrap items-center gap-2"><a className={TESTING_LINK} href={`/?testRun=${encodeURIComponent(item.requestId)}`}>{item.routineId ?? item.requestId}</a>
            <span className="text-sm">{readableLaneIdentity(item.state)}{item.platform ? ` · ${item.platform === 'android' ? 'Android' : 'iOS on Mac'}` : ''}</span>
            {item.build && <span className="text-xs text-[#68746d]">{item.build.prNumber ? `PR #${item.build.prNumber}` : item.build.channel} · {item.build.headSha.slice(0, 10)}</span>}
          </div>
          {item.createdAt && <p className="mt-1 text-xs text-[#68746d]">Submitted {new Date(item.createdAt).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</p>}
          {item.reason && <p className="mt-1 text-sm text-[#68746d]">{item.reason}</p>}
          {item.assignment && <p className="mt-2 text-sm">Assigned lane: <a className={TESTING_LINK} href={laneHistoryHref(item.assignment.hostId, item.assignment.laneId)}>{readableLaneIdentity(item.assignment.hostId)} · {readableLaneIdentity(item.assignment.laneId)}</a></p>}
          <p className="mt-2 text-xs font-medium">{item.compatibilityKnown ? 'Compatible lanes' : 'Compatibility pending source preparation'}</p>
          <div className="mt-2 flex flex-wrap gap-2">{item.compatibilityKnown ? item.compatibleLanes.length ? item.compatibleLanes.map(lane => <LaneLabel key={`${lane.hostId}/${lane.laneId}`} lane={lane} />) :
            <span className="text-sm text-[#68746d]">No compatible lanes reported.</span> : <>
              <span className="text-sm text-[#68746d]">{item.platformCandidates.length ? 'Platform candidates (requirements not yet verified):' : 'Compatible lanes will appear when exact requirements are available.'}</span>
              {item.platformCandidates.map(lane => <LaneLabel key={`${lane.hostId}/${lane.laneId}`} lane={lane} />)}
            </>}</div>
        </article>)}</div>}
      <div className="mt-3 flex gap-2">{cursor && <TestingButton onClick={() => setCursor(undefined)}>First page</TestingButton>}
        {data?.nextCursor && <TestingButton onClick={() => setCursor(data.nextCursor)}>Next page</TestingButton>}</div>
    </>}
  </section>;
}
