import {randomUUID} from 'node:crypto'
import {RoutineWorkModel} from '../models/routine-work.model'
import {testWriteConcern} from '../models/test-write-concern'
import {requestInputDigest} from './test-request.service'
import type {RoutineWorkDelivery} from './routine-work.service'
import type {RoutineWorkProgress} from '../types/routine-work.types'

export const PROGRESS_INTERVAL_MS = 10 * 60_000
export const REPORT_LEASE_MS = 120_000
export const terminalWorkState = (state?: string) => ['passed', 'failed', 'cancelled'].includes(state ?? '')
export interface RoutineWorkReportIntent {
  eventId: string
  kind: 'progress' | 'final'
  at: string
  sequence: number
  body: string
  sha256: string
}
export interface RoutineWorkReporting {
  nextProgressAt: Date
  lease?: {id: string; expiresAt: Date}
  pending?: RoutineWorkReportIntent
  progressCommentId?: number
  finalCommentId?: number
  finalSequence?: number
  lastSequence?: number
  lastAcceptedAt?: string
  history: Array<{
    eventId: string
    at: string
    sequence: number
    state: string
    progress: RoutineWorkProgress
    commentId: number
  }>
  error?: string
}
export interface RoutineWorkReportRepository {
  schedule(row: RoutineWorkDelivery, now: Date): Promise<void>
  due(now: Date): Promise<string[]>
  claim(workId: string, now: Date): Promise<RoutineWorkDelivery | null>
  save(workId: string, leaseId: string, reporting: RoutineWorkReporting): Promise<boolean>
  get(workId: string): Promise<RoutineWorkDelivery | null>
}
const read = (workId: string) =>
  RoutineWorkModel.findOne({workId}).read('primary').readConcern('majority').setOptions({timeoutMS: 10_000}).lean()
export const routineWorkReportRepository: RoutineWorkReportRepository = {
  async get(workId) {
    return (await read(workId)) as RoutineWorkDelivery | null
  },
  async schedule(row, now) {
    if (!row.work.origin) return
    await RoutineWorkModel.updateOne(
      {workId: row.workId, reporting: {$exists: false}},
      {$set: {reporting: {nextProgressAt: now, history: []}}},
      {writeConcern: testWriteConcern, timeoutMS: 10_000},
    )
    const sequence = row.status?.sequence ?? 0
    await RoutineWorkModel.updateOne(
      {
        'workId': row.workId,
        'reporting.finalCommentId': {$exists: false},
        '$or': [
          {'reporting.lastSequence': {$exists: false}},
          {'reporting.lastSequence': {$lt: sequence}},
          ...(row.acceptance ? [{'reporting.lastAcceptedAt': {$ne: row.acceptance.acceptedAt}}] : []),
        ],
      },
      {$min: {'reporting.nextProgressAt': now}},
      {writeConcern: testWriteConcern, timeoutMS: 10_000},
    )
  },
  async due(now) {
    const rows = await RoutineWorkModel.find({
      'work.origin': {$exists: true},
      'reporting.finalCommentId': {$exists: false},
      'reporting.nextProgressAt': {$lte: now},
      '$or': [{'reporting.lease': {$exists: false}}, {'reporting.lease.expiresAt': {$lte: now}}],
    })
      .select({workId: 1})
      .sort({'reporting.nextProgressAt': 1})
      .limit(20)
      .read('primary')
      .readConcern('majority')
      .setOptions({timeoutMS: 10_000})
      .lean()
    return rows.map((row) => row.workId as string)
  },
  async claim(workId, now) {
    return (await RoutineWorkModel.findOneAndUpdate(
      {
        workId,
        'reporting.finalCommentId': {$exists: false},
        'reporting.nextProgressAt': {$lte: now},
        '$or': [{'reporting.lease': {$exists: false}}, {'reporting.lease.expiresAt': {$lte: now}}],
      },
      {$set: {'reporting.lease': {id: randomUUID(), expiresAt: new Date(now.getTime() + REPORT_LEASE_MS)}}},
      {new: true, writeConcern: testWriteConcern, timeoutMS: 10_000},
    ).lean()) as RoutineWorkDelivery | null
  },
  async save(workId, leaseId, reporting) {
    const result = await RoutineWorkModel.updateOne(
      {workId, 'reporting.lease.id': leaseId},
      {$set: {reporting}},
      {writeConcern: testWriteConcern, timeoutMS: 10_000},
    )
    return result.matchedCount === 1
  },
}
const plain = (value: string) => value.replace(/[\\`*_|<>\r\n]/g, ' ').trim()
const items = (values: string[]) => values.map((value) => plain(value).slice(0, 250)).join('; ')
export const routineWorkProgressMarker = (id: string) => `<!-- mentra-routine-work-progress:${id} -->`
export const routineWorkFinalMarker = (id: string) => `<!-- mentra-routine-work-final:${id} -->`
export function observedWorkProgress(row: RoutineWorkDelivery): RoutineWorkProgress {
  const detail = row.status?.details.details
  return (
    detail?.progress ?? {
      observedAt: row.acceptance?.acceptedAt ?? row.createdAt?.toISOString() ?? new Date(0).toISOString(),
      completed: row.acceptance
        ? ['The assigned machine accepted the frozen request.']
        : ['Core retained the frozen request.'],
      current:
        detail?.reason ??
        detail?.question ??
        detail?.summary ??
        (row.acceptance
          ? `Last reported stage: ${row.status?.state ?? 'preparing'}.`
          : 'Waiting for the assigned machine to accept the request.'),
      plan: ['Complete saved authoring, independent review, recorded verification and cleanup.'],
      estimatedCompletionAt: null,
      estimateReason: 'The machine has not supplied an updated completion estimate.',
    }
  )
}
export function renderRoutineWorkReport(row: RoutineWorkDelivery, kind: 'progress' | 'final', at: string): string {
  const origin = row.work.origin!
  if (
    !origin ||
    row.work.workId !== row.workId ||
    row.work.target.hostId !== row.hostId ||
    row.inputSha256 !== requestInputDigest(row.work) ||
    row.work.build.headSha !== origin.headSha ||
    row.work.build.prNumber !== origin.prNumber
  )
    throw new Error('Authoring report differs from its frozen originating PR/build')
  const state = row.status?.state ?? 'queued',
    detail = row.status?.details.details ?? {},
    progress = observedWorkProgress(row)
  const completion = detail.completion
  if (kind === 'final' && (!terminalWorkState(state) || (state === 'passed' && !completion)))
    throw new Error('Terminal work has no complete reviewed result')
  const marker = kind === 'final' ? routineWorkFinalMarker(row.workId) : routineWorkProgressMarker(row.workId)
  const lines = [
    marker,
    `### Routine ${row.work.kind} — ${state}`,
    '',
    `Updated: ${at}. Work: \`${row.workId}\`.`,
    `Coverage: ${plain(row.work.brief.goal)}. Routine: \`${row.work.routineId}\`.`,
    `Assigned machine/lane: \`${row.hostId}/${row.work.target.laneId}\`.`,
    `Frozen app head: [\`${origin.headSha}\`](https://github.com/${origin.repository}/commit/${origin.headSha}).`,
    `[Exact app build ${row.work.build.source.buildRunId}/${row.work.build.source.publicationAttempt}](https://github.com/${origin.repository}/actions/runs/${row.work.build.source.buildRunId}/attempts/${row.work.build.source.publicationAttempt}).`,
    'This reports the accepted app head; later PR changes are not included.',
    '',
    `Completed: ${progress.completed.length ? items(progress.completed) : 'No completed work reported.'}`,
    `Current: ${plain(progress.current)}`,
    `Plan: ${progress.plan.length ? items(progress.plan) : 'No remaining plan reported.'}`,
    `Estimated completion: ${progress.estimatedCompletionAt ?? 'unknown'}. ${plain(progress.estimateReason)}`,
    ...(progress.estimatedCompletionAt &&
    Date.parse(progress.estimatedCompletionAt) < Date.parse(at) &&
    !terminalWorkState(state)
      ? ['The last completion estimate has passed; the current wait and remaining plan above are retained.']
      : []),
    `Last machine observation: ${progress.observedAt}.`,
    ...(Date.parse(at) - Date.parse(progress.observedAt) >= PROGRESS_INTERVAL_MS && !terminalWorkState(state)
      ? ['No newer machine observation is available; worker activity is unknown. No additional progress is assumed.']
      : []),
    '',
  ]
  if (detail.question) lines.push(`Input needed (${plain(detail.questionId ?? '')}): ${plain(detail.question)}`, '')
  if (kind === 'final' && state === 'passed')
    lines.push(
      `[Open, unmerged routine PR](${completion!.prUrl})`,
      `[Independent passing review of \`${completion!.reviewedRevision}\`](${completion!.reviewUrl})`,
      `[Passing ordinary run and recording](${completion!.resultUrl})`,
      plain(completion!.summary),
    )
  else {
    if (detail.prUrl) lines.push(`[Routine source PR](${detail.prUrl})`)
    if (detail.resultUrl) lines.push(`[Recorded result](${detail.resultUrl})`)
    if (kind === 'final')
      lines.push(
        `Cause: ${plain(detail.reason ?? 'No precise cause was recorded.')}`,
        `Attempted work: ${plain(detail.summary ?? (items(progress.completed) || 'No completed attempt reported.'))}`,
        `Next action: ${progress.plan.length ? items(progress.plan) : 'Resolve the recorded cause with the machine owner.'}`,
      )
    else lines.push('Authoring progress is separate from an ordinary passing routine result.')
  }
  const body = lines.join('\n')
  if (body.length > 30_000) throw new Error('Source-PR report exceeds its public comment bound')
  return body
}
export function reportIntent(row: RoutineWorkDelivery, kind: 'progress' | 'final', now: Date): RoutineWorkReportIntent {
  const reporting = row.reporting!,
    sequence = row.status?.sequence ?? 0
  const at =
    reporting.pending?.sequence === sequence && reporting.pending.kind === kind
      ? reporting.pending.at
      : now.toISOString()
  const body = renderRoutineWorkReport(row, kind, at)
  return {
    eventId: `work-report:${requestInputDigest({workId: row.workId, sequence, kind, at}).slice(0, 48)}`,
    kind,
    at,
    sequence,
    body,
    sha256: requestInputDigest(body),
  }
}
