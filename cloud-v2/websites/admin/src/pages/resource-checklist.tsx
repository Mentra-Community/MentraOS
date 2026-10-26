import type {ResourceCheckReport} from '../../../../packages/core/src/types/resource-check-report.types'

const statuses = {
  passed: {label: 'Passed', style: 'bg-[#e6f5ed] text-[#087d50]'},
  failed: {label: 'Failed', style: 'bg-red-50 text-red-700'},
  unknown: {label: 'Unknown', style: 'bg-amber-50 text-amber-800'},
  'not-checked': {label: 'Not checked', style: 'bg-[#f0f2ef] text-[#59655e]'},
}
export const resourceReportHref = (resourceId: string) =>
  `/?systemHealth=1&healthTab=resources#resource-${encodeURIComponent(resourceId)}`

export function ResourceConditionStatus({status}: {status: ResourceCheckReport['outcome']}) {
  const value = statuses[status]
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${value.style}`}>{value.label}</span>
}

export function resourceConditionSourceHref(source: ResourceCheckReport['conditions'][number]['source']) {
  if (!source || !source.revision || !/^[a-f0-9]{40}$/.test(source.revision) || !Number.isSafeInteger(source.line) || source.line < 1 ||
    !/^[A-Za-z0-9_.\/-]+$/.test(source.path) || source.path.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null
  return `https://github.com/Mentra-Community/Mentra/blob/${source.revision}/${source.path.split('/').map(encodeURIComponent).join('/')}#L${source.line}`
}

function Evidence({refs}: {refs: string[]}) {
  return refs.length ? <ul className="break-all text-xs">{refs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul> : <>Not reported</>
}

export function ResourceChecklist({report}: {report?: ResourceCheckReport}) {
  if (!report) return <div className="mt-3 text-sm"><h4 className="font-medium">Condition checklist</h4><p>Not reported</p></div>
  return <div className="mt-3 text-sm">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">Condition checklist</h4><ResourceConditionStatus status={report.outcome}/></div>
    {report.currentContract && <p>This retained check uses contract {report.contractVersion}. Installed contract {report.currentContract.contractVersion} has not been checked.</p>}
    {report.reportedOutcome && report.reportedOutcome !== report.outcome ? <p>Operation reported: {statuses[report.reportedOutcome].label}. Physical conditions are shown separately below.</p> : null}
    <p>Checked: {report.checkedAt ? <time dateTime={report.checkedAt} title={report.checkedAt}>{new Date(report.checkedAt).toLocaleString()}</time> : 'Not reported'}</p>
    <p className="break-all text-xs">Operation: {report.operationId ?? 'Not reported'} · Contract: {report.contractVersion ?? 'Not reported'}</p>
    <p className="break-all text-xs">Result: {report.resultSha256 ?? 'Not reported'}</p>
    {!report.conditions.length ? <p>No condition observations were reported.</p> : <ul className="mt-2 space-y-2">{report.conditions.map(condition => {
      const sourceHref = resourceConditionSourceHref(condition.source)
      return <li key={condition.id} className="rounded-lg border border-[#e0e4de] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-medium">{condition.label || condition.id.replace(/[-_.:]+/g, ' ')}</h5><ResourceConditionStatus status={condition.status}/></div>
        <p className="break-all text-xs text-[#59655e]">{condition.id}</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Reported outcome</dt><dd>{condition.reportedStatus ? statuses[condition.reportedStatus].label : 'Not reported'}</dd>
          <dt>Observed</dt><dd className="break-words">{condition.observed ?? 'Not reported'}</dd>
          <dt>Expected</dt><dd className="break-words">{condition.expected ?? 'Not reported'}</dd>
          <dt>Explanation</dt><dd className="break-words">{condition.explanation ?? 'Not reported'}</dd>
          <dt>Repair action</dt><dd className="break-words">{condition.repairAction ?? 'Not reported'}</dd>
          <dt>Source</dt><dd className="break-all">{sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{condition.source!.path}:{condition.source!.line}</a>
            : condition.source ? `${condition.source.path}:${condition.source.line} (${condition.source.revision ? 'source link unavailable' : 'revision not reported'})` : 'Not reported'}</dd>
          <dt>Evidence</dt><dd><Evidence refs={condition.evidenceRefs}/></dd>
        </dl>
      </li>
    })}</ul>}
    <div className="mt-2"><p className="text-xs font-medium">Report evidence</p><Evidence refs={report.evidenceRefs}/></div>
    {report.currentContract && <div className="mt-3 border-t pt-3"><h4 className="font-medium">Installed contract needs a new check</h4>
      <ResourceChecklist report={{...report, contractVersion: report.currentContract.contractVersion, operationId: null, checkedAt: null,
        resultSha256: null, outcome: 'not-checked', reportedOutcome: null, conditions: report.currentContract.conditions, evidenceRefs: [], currentContract: undefined}}/>
    </div>}
  </div>
}
