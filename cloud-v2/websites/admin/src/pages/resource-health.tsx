import {ReservableStatusBadge} from '../components/reservable-status';
import {useQuery} from '@tanstack/react-query';
import {useClock} from '../lib/use-clock';
import {api} from '../lib/api';
import type {ResourceLifecycleList} from '../../../../packages/core/src/types/resource-lifecycle.types';

export function ResourceHealthSection() {
  const query=useQuery({queryKey:['resource-lifecycle'],queryFn:()=>api<ResourceLifecycleList>('/api/admin/test-runs/resources/overview'),refetchInterval:30_000});
  const now=useClock();
  return <section aria-label="Reservable resources"><h2 className="text-lg font-semibold">Resources</h2>
    <p className="mt-2 text-sm text-[#59655e]">Shared capacity and its accepted idle checks. Placement and current borrower are reported separately.</p>
    {query.isPending?<p>Loading resources…</p>:query.isError?<p role="alert">Resources could not refresh. Current resource status is unknown.</p>:null}
    {!query.isPending && !query.isError && !query.data?.subjects.length?<p className="mt-4">No resource lifecycle observations have been reported.</p>:null}
    <div className="mt-4 grid gap-3 md:grid-cols-2">{query.data?.subjects.map(value=>{
      const current=!query.isError && value.current && value.observedAt!==null && now-Date.parse(value.observedAt)<=180_000 && value.receivedAt!==null && now-Date.parse(value.receivedAt)<=180_000;
      const events=query.data.history.filter(event=>event.resourceId===value.subject.id);
      return <article key={value.subject.id} className="rounded-xl border border-[#e0e4de] p-4">
        <h3 className="font-semibold">{value.subject.id}</h3><ReservableStatusBadge status={value.status} current={current} />
        <p className="text-sm">{value.resource.kind} · {value.resource.placement==='fleet'?'Fleet resource':`Installed: ${value.resource.memberships.map(v=>`${v.hostId}/${v.laneId}`).join(', ') || 'placement not reported'}`}</p>
        <p className="mt-2 text-sm">{current?'Owner':'Last reported owner'}: {value.owner?`${value.owner.kind} ${value.owner.id}, owner generation ${value.owner.generation??'unknown'} (${value.owner.hostId}${value.owner.laneId?`/${value.owner.laneId}`:''})`:'None'}</p>
        <p className="text-sm">Idle check: {value.idle.outcome} · contract {value.idle.contractVersion || 'not configured'} · scope {value.idle.qualifiedScope.kind}</p>
        <p className="text-sm">Repair: {value.repair.configured?value.repair.state:'Not configured'}</p>
        {value.reason?<p className="mt-2 text-sm">{value.reason.message}</p>:null}
        <p className="mt-2 text-xs">Observed {value.observedAt?new Date(value.observedAt).toLocaleString():'unknown'} · generation {value.generation}</p>
        <details className="mt-3"><summary>Use history ({events.length})</summary>
          {!events.length?<p className="text-sm">No use history reported.</p>:<ol className="mt-2 space-y-2 text-sm">{events.map(event=><li key={event.id}>{new Date(event.at).toLocaleString()} · {event.event.replaceAll('-',' ')}{event.ownerId?` · ${event.ownerId}${event.ownerGeneration!==undefined?` (owner generation ${event.ownerGeneration})`:''}`:''}{event.hostId?` · ${event.hostId}${event.laneId?`/${event.laneId}`:''}`:''} · generation {event.subjectGeneration??'unknown'}</li>)}</ol>}
          <p className="mt-2 text-xs">Recent journal events reported by the authority; this is a bounded history.</p>
        </details>
      </article>;
    })}</div>{query.data?.truncated?<p>Resource observations were truncated.</p>:null}
  </section>;
}
