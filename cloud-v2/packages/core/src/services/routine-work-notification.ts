import {TestRunGithubApp} from './test-run-github-app'
import {requestInputDigest} from './test-request.service'
import {readTestMetadata} from './test-builds.service'
import type {RoutineWorkDelivery} from './routine-work.service'
import {
  PROGRESS_INTERVAL_MS,
  observedWorkProgress,
  reportIntent,
  routineWorkFinalMarker,
  routineWorkProgressMarker,
  routineWorkReportRepository,
  terminalWorkState,
  type RoutineWorkReportIntent,
  type RoutineWorkReportRepository,
} from './routine-work-reporting'

interface Comment {
  id: number
  body: string
  user?: {type: string}
  performed_via_github_app?: {id: number}
}
class ReportingFailure extends Error {}
export class RoutineWorkNotification {
  constructor(
    private readonly app = new TestRunGithubApp(),
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly rows: RoutineWorkReportRepository = routineWorkReportRepository,
    private readonly now: () => number = Date.now,
  ) {}
  private async api(path: string, method = 'GET', body?: unknown, deadline = this.now() + 90_000): Promise<unknown> {
    try {
      if (this.now() >= deadline) throw new Error('unavailable')
      const response = await this.transport(`https://api.github.com/repos/Mentra-Community/MentraOS/${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - this.now()))),
        headers: {
          'Authorization': `Bearer ${await this.app.token('reporter')}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        ...(body ? {body: JSON.stringify(body)} : {}),
      })
      if (!response.ok) throw new Error(response.status === 403 ? 'permission' : 'unavailable')
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readTestMetadata(response, 8 * 1024 * 1024)))
    } catch (error) {
      if (error instanceof Error && error.message === 'permission')
        throw new ReportingFailure(
          'GitHub App lacks source-PR comment permission; grant pull_requests:write for MentraOS and retry this retained report.',
        )
      throw new ReportingFailure(
        'GitHub App source-PR reporting is unavailable; verify its installation and pull_requests:write permission. The original job is retained.',
      )
    }
  }
  private async comments(pr: number, deadline: number): Promise<Comment[]> {
    const comments: Comment[] = []
    for (let page = 1; page <= 10; page++) {
      if (this.now() >= deadline)
        throw new ReportingFailure('Source-PR comment reconciliation exceeded its bounded reporting lifetime')
      const values = (await this.api(
        `issues/${pr}/comments?per_page=100&page=${page}`,
        'GET',
        undefined,
        deadline,
      )) as Comment[]
      if (!Array.isArray(values)) throw new ReportingFailure('Source-PR comment history is unavailable')
      comments.push(...values)
      if (new Set(comments.map((value) => value.id)).size !== comments.length)
        throw new ReportingFailure('Source-PR comment history changed during reconciliation')
      if (values.length < 100) return comments
    }
    throw new ReportingFailure('Source-PR comment history exceeds its reporting bound')
  }
  private owned(comments: Comment[], marker: string) {
    if (!this.app.applicationId)
      throw new ReportingFailure('GitHub App identity is not configured for source-PR reporting')
    const found = comments.filter(
      (comment) =>
        comment.user?.type === 'Bot' &&
        comment.performed_via_github_app?.id === this.app.applicationId &&
        comment.body?.startsWith(`${marker}\n`),
    )
    if (found.length > 1) throw new ReportingFailure('Duplicate owned source-PR reports require reconciliation')
    return found[0]
  }
  private async send(row: RoutineWorkDelivery, intent: RoutineWorkReportIntent): Promise<number | null> {
    const deadline = Math.min(this.now() + 90_000, row.reporting!.lease!.expiresAt.getTime() - 10_000)
    const comments = await this.comments(row.work.origin!.prNumber, deadline)
    const final = this.owned(comments, routineWorkFinalMarker(row.workId))
    const latest = await this.rows.get(row.workId)
    if (
      !latest ||
      (latest.status?.sequence ?? 0) !== intent.sequence ||
      (intent.kind === 'progress' && (final || terminalWorkState(latest.status?.state)))
    )
      return null
    if (this.now() >= deadline)
      throw new ReportingFailure('Source-PR report exceeded its lease; its same intent will reconcile after restart')
    const marker = intent.kind === 'final' ? routineWorkFinalMarker(row.workId) : routineWorkProgressMarker(row.workId)
    const existing = this.owned(comments, marker)
    if (existing?.body === intent.body) return existing.id
    // Lost create/update responses reconcile the same marker/body on the next durable attempt.
    const result = (await this.api(
      existing ? `issues/comments/${existing.id}` : `issues/${row.work.origin!.prNumber}/comments`,
      existing ? 'PATCH' : 'POST',
      {body: intent.body},
      deadline,
    )) as Comment
    if (!Number.isSafeInteger(result?.id) || result.id <= 0)
      throw new ReportingFailure('Source-PR report acknowledgement is unavailable')
    return result.id
  }
  async publish(row: RoutineWorkDelivery): Promise<void> {
    if (!row.work.origin) return
    await this.rows.schedule(row, new Date(this.now()))
    await this.reconcile(row.workId)
  }
  async reconcile(workId: string): Promise<void> {
    const now = new Date(this.now()),
      row = await this.rows.claim(workId, now)
    if (!row?.reporting?.lease) return
    const leaseId = row.reporting.lease.id,
      reporting = structuredClone(row.reporting)
    try {
      // Re-read after claiming: a terminal receipt supersedes a pending progress report, including after restart.
      const current = await this.rows.get(workId)
      if (!current) throw new ReportingFailure('Retained authoring work is unavailable')
      current.reporting = reporting
      const kind = terminalWorkState(current.status?.state) ? 'final' : 'progress'
      let intent = reporting.pending
      if (!intent || intent.sequence !== (current.status?.sequence ?? 0) || intent.kind !== kind)
        intent = reportIntent(current, kind, now)
      reporting.pending = intent
      if (intent.sha256 !== requestInputDigest(intent.body))
        throw new ReportingFailure('Retained source-PR report digest differs')
      if (!(await this.rows.save(workId, leaseId, reporting))) return
      const commentId = await this.send(current, intent)
      if (commentId === null) {
        delete reporting.pending
        delete reporting.lease
        reporting.nextProgressAt = now
        await this.rows.save(workId, leaseId, reporting)
        return
      }
      reporting.history = [
        ...reporting.history,
        {
          eventId: intent.eventId,
          at: intent.at,
          sequence: intent.sequence,
          state: current.status?.state ?? 'queued',
          progress: observedWorkProgress(current),
          commentId,
        },
      ].slice(-50)
      reporting.lastSequence = intent.sequence
      const firstAcceptanceReport = current.acceptance && reporting.lastAcceptedAt !== current.acceptance.acceptedAt
      reporting.lastAcceptedAt = current.acceptance?.acceptedAt
      if (kind === 'final') {
        reporting.finalCommentId = commentId
        reporting.finalSequence = intent.sequence
      } else reporting.progressCommentId = commentId
      const acceptedDue = firstAcceptanceReport ? Date.parse(current.acceptance!.acceptedAt) + PROGRESS_INTERVAL_MS : 0
      reporting.nextProgressAt = new Date(
        acceptedDue > now.getTime() ? acceptedDue : now.getTime() + PROGRESS_INTERVAL_MS,
      )
      delete reporting.pending
      delete reporting.lease
      delete reporting.error
      if (!(await this.rows.save(workId, leaseId, reporting))) return
      const latest = await this.rows.get(workId)
      if (
        latest &&
        ((latest.status?.sequence ?? 0) > intent.sequence ||
          latest.acceptance?.acceptedAt !== current.acceptance?.acceptedAt)
      )
        await this.rows.schedule(latest, now)
    } catch (error) {
      reporting.error =
        error instanceof ReportingFailure
          ? error.message
          : 'Source-PR reporting storage is unavailable; the retained report will retry.'
      reporting.nextProgressAt = new Date(now.getTime() + 60_000)
      delete reporting.lease
      await this.rows.save(workId, leaseId, reporting)
      throw new ReportingFailure(reporting.error)
    }
  }
  async tick(): Promise<void> {
    await Promise.all(
      (await this.rows.due(new Date(this.now()))).map(async (workId) => {
        try {
          await this.reconcile(workId)
        } catch {
          console.error('Retained authoring PR report will retry', workId)
        }
      }),
    )
  }
}
/** Durable due dates outlive this process. One immediate overdue update resumes cadence after restart. */
export function startRoutineWorkReporting(notification = new RoutineWorkNotification(), intervalMs = 30_000,
  reportNotifications?: () => Promise<void>) {
  let stopped = false,
    active: Promise<void> | undefined
  const tick = () => {
    if (stopped || active) return
    active = Promise.allSettled([notification.tick(), reportNotifications?.()])
      .then((results) => {if (results.some(result => result.status === 'rejected')) console.error('Cloud reporting reconciliation is unavailable')})
      .catch(() => console.error('Authoring reporting reconciliation is unavailable'))
      .finally(() => {
        active = undefined
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    await active
  }
}
