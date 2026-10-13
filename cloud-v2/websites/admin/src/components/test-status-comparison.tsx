import {ArrowRight} from 'lucide-react'
import type {RerunAttempt} from '../../../../packages/core/src/types/test-rerun.types'
import {observedTestStatus, type TestStatusCounts} from '../../../../packages/core/src/types/test-status-comparison'
import {HistoryStatus} from './test-history-table'

export function OriginalLatestStatus({original, latest}: {original: string; latest?: Pick<RerunAttempt, 'status' | 'publicationComplete'> | null}) {
  return <span className="inline-flex flex-wrap items-center gap-1.5" title={latest ? 'Original → Latest' : 'Original result'}>
    <HistoryStatus outcome={original}/>{latest && <><ArrowRight aria-label="to latest" className="size-3.5 text-[#656d76]"/>
      <HistoryStatus outcome={observedTestStatus(latest)}/></>}
  </span>
}
export function SuiteCountComparison({original, latest}: {original: TestStatusCounts; latest?: TestStatusCounts}) {
  const count = (value: TestStatusCounts) => <span className={value.failed ? 'text-[#cf222e]' : !value.pending && !value.incomplete ? 'text-[#1a7f37]' : 'text-[#656d76]'}>
    {value.failed}/{value.total} failed{value.skipped ? `, ${value.skipped} skipped` : ''}
    {value.pending ? `, ${value.pending} pending` : ''}{value.incomplete ? `, ${value.incomplete} incomplete` : ''}
  </span>
  return <span className="inline-flex flex-wrap items-center gap-1.5 text-xs tabular-nums" title={latest ? 'Original → Latest' : 'Original results'}>
    {count(original)}{latest && <><ArrowRight aria-label="to latest" className="size-3.5 text-[#656d76]"/>{count(latest)}</>}
  </span>
}
