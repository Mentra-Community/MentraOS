/** Per-source evidence receipts. Report readiness does not assert that every device uploaded. */
export const REPORT_LOG_SOURCES = ['phone', 'glasses', 'glasses_firmware', 'cloud', 'miniapp_server'] as const
export type ReportLogSource = typeof REPORT_LOG_SOURCES[number]
export type ReportLogCollectionState = 'requested' | 'received' | 'unavailable' | 'failed' | 'timed-out'
export interface ReportLogCollection {
  state: ReportLogCollectionState
  requestedAt: string
  deadlineAt: string
  reason?: string
  receivedAt?: string
  artifactId?: string
  entryCount?: number
}
export const REPORT_LOG_DEADLINE_MS = 4 * 60_000
export function initialReportLogCollection(now: Date): Record<ReportLogSource, ReportLogCollection> {
  return Object.fromEntries(REPORT_LOG_SOURCES.map(source => [source, {
    state: 'requested', requestedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + REPORT_LOG_DEADLINE_MS).toISOString(),
  }])) as Record<ReportLogSource, ReportLogCollection>
}
export function isReportLogSource(source: string): source is ReportLogSource {
  return REPORT_LOG_SOURCES.some(value => value === source)
}
export function visibleReportLogCollection(rows: Partial<Record<ReportLogSource, ReportLogCollection>> | undefined, now = Date.now()) {
  return Object.fromEntries(Object.entries(rows ?? {}).map(([source, receipt]) => [source,
    receipt.state === 'requested' && Date.parse(receipt.deadlineAt) <= now
      ? {...receipt, state: 'timed-out', reason: 'No log artifact arrived before the collection deadline'} : receipt,
  ])) as Partial<Record<ReportLogSource, ReportLogCollection>>
}
