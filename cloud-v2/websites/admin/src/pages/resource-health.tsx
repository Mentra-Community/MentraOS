import {ReservableStatusBadge} from '../components/reservable-status';
import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {useClock} from '../lib/use-clock';
import {api} from '../lib/api';
import type {ResourceLifecycleCurrentList, ResourceLifecycleHistory} from '../../../../packages/core/src/types/resource-lifecycle.types';
import {ResourceControls} from './resource-controls';
import {useEffect, useRef, useState} from 'react';
import {ResourceChecklist, resourceReportHref} from './resource-checklist';

export const resourceOverviewQuery = {
  queryKey: ['resource-lifecycle'],
  queryFn: () => api<ResourceLifecycleCurrentList>('/api/admin/test-runs/resources/overview'),
  refetchInterval: 30_000,
};

export function ResourceHealthSection() {
  const query=useQuery(resourceOverviewQuery);
  const focusedAnchor=useRef<string | null>(null);
  useEffect(()=>{
    if (!query.data || typeof window === 'undefined') return;
    let anchor: string;
    try {anchor=decodeURIComponent(window.location.hash.slice(1));} catch {return;}
    if (!anchor.startsWith('resource-') || focusedAnchor.current===anchor) return;
    const card=document.getElementById(anchor);
    if (card) {card.scrollIntoView({block:'start'});focusedAnchor.current=anchor;}
  },[query.data]);
  const now=useClock();
  return <section aria-label="Reservable resources"><h2 className="text-lg font-semibold">Resources</h2>
    <p className="mt-2 text-sm text-[#59655e]">Phones, glasses and other test resources. Readiness, current use and lane membership are reported for each resource.</p>
    {query.isPending?<p>Loading resources…</p>:query.isError?<p role="alert">Resources could not refresh. Current resource status is unknown.</p>:null}
    {!query.isPending && !query.isError && !query.data?.subjects.length?<p className="mt-4">No resource lifecycle observations have been reported.</p>:null}
    <div className="mt-4 grid gap-3 md:grid-cols-2">{query.data?.subjects.map(value=>{
      const current=!query.isError && value.current && value.receivedAt!==null &&
        Date.parse(value.receivedAt)<=now+5000 && now-Date.parse(value.receivedAt)<=180_000;
      return <article key={value.subject.id} id={`resource-${value.subject.id}`} className="scroll-mt-4 rounded-xl border border-[#e0e4de] p-4">
        <h3 className="font-semibold">{value.subject.id}</h3><ReservableStatusBadge status={value.status} current={current} />
        <p className="text-sm">{value.resource.kind} · {value.resource.placement==='fleet'?'Fleet resource':`Installed: ${value.resource.memberships.map(v=>`${v.hostId}/${v.laneId}`).join(', ') || 'placement not reported'}`}</p>
        <p className="mt-2 text-sm">{current?'Owner':'Last reported owner'}: {value.owner?`${value.owner.kind} ${value.owner.id}, owner generation ${value.owner.generation??'unknown'} (${value.owner.hostId}${value.owner.laneId?`/${value.owner.laneId}`:''})`:'None'}</p>
        <p className="text-sm">Readiness check: {value.idle.outcome} · contract {value.idle.contractVersion || 'not configured'} · scope {value.idle.qualifiedScope.kind}</p>
        <p className="text-sm">Repair: {value.repair.configured?value.repair.state:'Not configured'}</p>
        {value.reason?<p className="mt-2 text-sm">{value.reason.message}</p>:null}
        <p className="mt-2 text-xs">Observed {value.observedAt?new Date(value.observedAt).toLocaleString():'unknown'} · generation {value.generation}</p>
        <a href={resourceReportHref(value.subject.id)} className="mt-2 inline-block text-sm text-blue-700 hover:underline">Link to resource report</a>
        <ResourceChecklist report={value.idle.report}/>
        <ResourceControlDisclosure resource={value} fresh={current}/>
        <ResourceHistoryDisclosure resourceId={value.subject.id}/>
      </article>;
    })}</div>{query.data?.truncated?<p>Resource observations were truncated.</p>:null}
  </section>;
}

function ResourceControlDisclosure({resource,fresh}:{resource:ResourceLifecycleCurrentList['subjects'][number];fresh:boolean}) {
  const [opened,setOpened]=useState(false);
  return <details className="mt-3" onToggle={event=>setOpened(event.currentTarget.open)}><summary>Manage resource</summary>
    {opened?<ResourceControls resource={resource} fresh={fresh}/>:null}
  </details>;
}

function ResourceHistoryDisclosure({resourceId}:{resourceId:string}) {
  const [opened,setOpened]=useState(false);
  const query=useInfiniteQuery({queryKey:['resource-lifecycle-history',resourceId],initialPageParam:undefined as string|undefined,
    queryFn:({pageParam})=>api<{events:ResourceLifecycleHistory[];nextCursor:string|null;coverage:string}>(
      `/api/admin/test-runs/resources/${encodeURIComponent(resourceId)}/history${pageParam?`?cursor=${encodeURIComponent(pageParam)}`:''}`),
    getNextPageParam:page=>page.nextCursor??undefined,enabled:opened});
  const events=query.data?.pages.flatMap(page=>page.events)??[];
  return <details className="mt-3" onToggle={event=>setOpened(event.currentTarget.open)}><summary>Use history</summary>
    {opened?<>{query.isPending?<p>Loading use history…</p>:query.isError&&!query.data?<p role="alert">Use history is unavailable.</p>:
      !events.length?<p className="text-sm">No use history retained.</p>:
      <ol className="mt-2 space-y-2 text-sm">{events.map(event=><li key={event.id}>{new Date(event.at).toLocaleString()} · {event.event.replaceAll('-',' ')}{event.ownerId?` · ${event.ownerId}${event.ownerGeneration!==undefined?` (owner generation ${event.ownerGeneration})`:''}`:''}{event.hostId?` · ${event.hostId}${event.laneId?`/${event.laneId}`:''}`:''} · generation {event.subjectGeneration??'unknown'}</li>)}</ol>}
      {query.isFetchNextPageError?<><p role="alert">More history is unavailable. Refresh history or try again.</p>
        <button type="button" className="mt-2 text-sm text-blue-700 disabled:opacity-50" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh history</button></>:null}
      {query.hasNextPage?<button type="button" className="mt-2 text-sm text-blue-700 disabled:opacity-50" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?'Loading…':'More history'}</button>:null}
      {query.data?<p className="mt-2 text-xs">{query.data.pages[0]?.coverage}</p>:null}
    </>:null}
  </details>;
}
