import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import type {MatchCondition, MatchStatus, TestRequestMatchReport} from '../../../../packages/core/src/types/test-request-match.types'
import {api} from '../lib/api'

const status: Record<MatchStatus, string> = {match: '✅ Matches', blocked: '❌ Blocked', unknown: '❔ Unknown', deferred: '⏳ After installation'}
function Checklist({rows}: {rows: MatchCondition[]}) {
  return <ul className="space-y-2 text-sm">{rows.map(row => <li key={row.id}>
    <strong>{status[row.status]} · {row.label}</strong> <span className="text-[#68746d]">({row.category})</span>
    <div>Expected: {row.expected}</div><div>Observed: {row.observed}</div>
    {row.observedAt && <div className="text-xs text-[#68746d]">Observed at {row.observedAt}</div>}
    {row.nextAction && <div>{row.nextAction}</div>}
  </li>)}</ul>
}
/** The browser and AI use this identical current-only endpoint, fetched only when opened. */
export function RequestMatchReport({requestId}: {requestId: string}) {
  const [open, setOpen] = useState(false)
  const path = `/api/admin/test-runs/requests/${encodeURIComponent(requestId)}/matching`
  const query = useQuery({queryKey: ['request-matching', requestId], enabled: open,
    queryFn: () => api<TestRequestMatchReport>(path), refetchInterval: open ? 15000 : false})
  return <details className="mt-3" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">Why is this routine waiting? Requirements and lane checklist</summary>
    {open && query.isPending && <p className="mt-3 text-sm">Loading current lane conditions…</p>}
    {open && query.error && <p role="alert">Could not read current conditions: {query.error.message}</p>}
    {query.data && <RequestMatchDetails report={query.data} jsonPath={path} />}
  </details>
}
export function RequestMatchDetails({report, jsonPath}: {report: TestRequestMatchReport; jsonPath?: string}) {
  return <div className="mt-3 space-y-4 text-sm">
    <p><strong>{report.stage}</strong> · {report.reason}</p><p>Next action: {report.nextAction}</p>
    <p className="text-xs text-[#68746d]">Read at {report.observedAt}. {report.selected && `Original selected lane: ${report.selected.hostId}/${report.selected.laneId ?? 'not recorded'}.`}</p>
    {jsonPath && <a className="underline" href={jsonPath} target="_blank" rel="noreferrer">Read the same JSON report</a>}
    {report.requirements ? <section><h4 className="font-semibold">Frozen requested conditions</h4>
      <p>Platform: {report.requirements.effective.platform}. Routine API: {report.requirements.minimumRoutineApiVersion}.
        {report.requirements.minimumFrameworkVersion !== undefined && ` Framework minimum: ${report.requirements.minimumFrameworkVersion}.`}
        {' '}Placement: {report.requirements.target ? `${report.requirements.target.hostId ?? 'any enrolled host'}/${report.requirements.target.laneId ?? 'any compatible lane'}` : 'all resources on one compatible enrolled lane'}.</p>
      <ul className="mt-2 list-disc pl-5">{report.requirements.human.map((value, index) => <li key={index}>{value}</li>)}</ul>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left"><thead><tr><th>Resource</th><th>Capabilities</th><th>Permissions</th><th>Declared / effective storage</th></tr></thead>
        <tbody>{report.requirements.effective.resources.map(resource => <tr key={resource.kind} className="border-t"><th className="py-2">{resource.kind}</th>
          <td>{resource.capabilities.join(', ') || 'None declared'}</td><td>{resource.permissions?.map(value => `${value.recipient}: ${value.permission}`).join(', ') || 'None declared'}</td>
          <td>{resource.storage ? `${report.requirements!.declaredResources.find(value => value.kind === resource.kind)?.storage?.minimumAvailableBytes ?? 'Not specified'} / ${resource.storage.minimumAvailableBytes} bytes` : 'None declared'}</td></tr>)}</tbody></table></div>
      {report.requirements.estimatedOutputBytes !== undefined && <p>Estimated output: {report.requirements.estimatedOutputBytes} bytes. Effective storage includes the existing output and safety budget.</p>}
    </section> : <p>Exact frozen requirements are unavailable; the report cannot invent matching conditions.</p>}
    <section><h4 className="font-semibold">Lane × requested resource matrix</h4>
      <p>{report.summary.structurallyCompatibleLanes} structurally compatible lanes; {report.summary.candidateLanes} match the current candidate predicates. Reservation is still atomic.</p>
      <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th>Lane</th><th>Candidate match</th>{report.requirements?.effective.resources.map(value => <th key={value.kind}>{value.kind}</th>)}</tr></thead>
        <tbody>{report.lanes.map(lane => <tr key={`${lane.hostId}/${lane.laneId}`} className="border-t align-top"><th className="py-3 pr-3">{lane.hostId}<br />{lane.laneId}<br /><span className="font-normal">{lane.platform}; {lane.state}; {lane.dispatchMode}<br />{lane.observedAt}</span></th>
          <td className="p-2">{status[lane.candidateMatch]}<details><summary>Lane conditions</summary><Checklist rows={lane.conditions} /></details></td>
          {lane.resources.map(resource => <td key={resource.kind} className="min-w-64 p-2"><strong>{resource.resourceId ?? 'Not evaluated / not offered'}</strong>
            {resource.owner && <p>Owner: {resource.owner.kind}:{resource.owner.id}</p>}
            <p>{resource.conditions.filter(row => row.status === 'blocked').length} blocked · {resource.conditions.filter(row => row.status === 'unknown').length} unknown</p>
            <ul>{resource.conditions.filter(row => row.status === 'blocked' || row.status === 'unknown').map(row => <li key={row.id}>{status[row.status]} · {row.label}: {row.observed}</li>)}</ul>
            <details className="mt-2"><summary>All conditions, including passed checks</summary><Checklist rows={resource.conditions} /></details>
            {resource.physicalReport && <details className="mt-2"><summary>Reported physical checklist · {resource.physicalReport.outcome}</summary>
              <p>Recorded physical evidence, separately from the current accepted-return predicate above. Checked {resource.physicalReport.checkedAt ?? 'not recorded'}; original {resource.physicalReport.operationId ?? 'not recorded'}.</p>
              <ul>{resource.physicalReport.conditions.map(condition => <li key={condition.id}><strong>{condition.status}: {condition.label}</strong><div>Expected: {condition.expected ?? 'not reported'}</div><div>Observed: {condition.observed ?? 'not reported'}</div><div>{condition.explanation}</div></li>)}</ul>
              {resource.physicalReport.currentContract && <p>Current contract {resource.physicalReport.currentContract.contractVersion} is not checked; prior conditions do not prove current coverage.</p>}
            </details>}
          </td>)}</tr>)}</tbody></table></div>
    </section>
    <ul className="list-disc pl-5 text-xs text-[#68746d]">{report.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
  </div>
}
