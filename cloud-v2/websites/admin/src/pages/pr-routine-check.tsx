import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {api} from '../lib/api'
import {LoadingIndicator} from '../components/loading-indicator'
import {TESTING_PANEL, TESTING_LINK, TestingButton} from '../components/testing-ui'
import type {PrLinkedTarget} from '../../../../packages/core/src/types/pr-rerun-label.types'

export function readPrCheckId(search: string) {
  const query = new URLSearchParams(search), value = query.get('prCheck')
  return query.getAll('prCheck').length === 1 && /^pr-check-[a-f0-9]{64}$/.test(value ?? '') ? value : null
}
export interface PrCheckView {
  gateId: string; coverageGeneration: number; attemptGeneration: number; canCancel: boolean; cancelling: boolean;
  check: {status: string; output: {title: string}}; resultsUrl: string;
  members: Array<{id: string; title: string; lane: string; status: string; activity: string; resultsUrl?: string; original?: PrLinkedTarget; fixingPrUrl?: string}>;
  delivery: {pending: boolean; error?: string}
}
export function PrRoutineCheckPage({gateId}: {gateId: string}) {
  const result = useQuery({queryKey: ['pr-routine-check', gateId], queryFn: () => api<PrCheckView>(`/api/admin/test-runs/pr-checks/${gateId}`), refetchInterval: 15000})
  const [operationId] = useState(() => crypto.randomUUID())
  const cancel = useMutation({mutationFn: () => api(`/api/admin/test-runs/pr-checks/${gateId}/cancel`, {method: 'POST', body: {
    operationId, coverageGeneration: result.data!.coverageGeneration, attemptGeneration: result.data!.attemptGeneration}}),
    onSuccess: () => {void result.refetch()}})
  if (result.isPending) return <LoadingIndicator label="Loading routine check" />
  if (result.error || !result.data) return <section className={TESTING_PANEL} role="alert">Routine check unavailable. Refresh to retry.</section>
  const gate = result.data
  return <section className={TESTING_PANEL}>
    <h2 className="text-lg font-semibold">{gate.check.output.title}</h2>
    <p className="mt-2 text-sm">{gate.cancelling ? 'Cancellation requested; ordinary cleanup is still settling.' : gate.check.status} · Refreshes every 15 seconds</p>
    {gate.delivery.error && <p role="alert" className="mt-2">{gate.delivery.error}</p>}
    <table className="mt-4 w-full text-left text-sm"><thead><tr><th>Routine</th><th>Lane</th><th>Result</th><th>Current activity</th></tr></thead>
      <tbody>{gate.members.map(member => <tr key={member.id}><td>{member.resultsUrl ? <a className={TESTING_LINK} href={member.resultsUrl}>{member.title}</a> : member.title}
        {member.original && <div className="mt-1 flex gap-3 text-xs"><a className={TESTING_LINK} href={`/?${'suiteId' in member.original.parent ? 'testSuite=' + encodeURIComponent(member.original.parent.suiteId) : 'testRun=' + encodeURIComponent(member.original.parent.requestId)}`}>Original</a>
          <a className={TESTING_LINK} href={member.fixingPrUrl}>Fix PR</a></div>}</td><td>{member.lane}</td><td>{member.status}</td><td>{member.activity}</td></tr>)}</tbody></table>
    <div className="mt-4 flex gap-4 items-center"><a className={TESTING_LINK} href={gate.resultsUrl}>Results and diagnostics</a>
      {gate.canCancel && <TestingButton disabled={cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? 'Requesting cancellation…' : 'Cancel routine tests'}</TestingButton>}</div>
    {cancel.error && <p role="alert" className="mt-2">Cancellation unavailable. Refresh the check and retry the same operation.</p>}
  </section>
}
