import {expect, test} from 'bun:test'
import {RoutineWorkNotification, startRoutineWorkReporting} from './routine-work-notification'
import {PROGRESS_INTERVAL_MS, REPORT_LEASE_MS, type RoutineWorkReportRepository} from './routine-work-reporting'
import type {RoutineWorkDelivery} from './routine-work.service'
import type {TestRunGithubApp} from './test-run-github-app'
import {requestInputDigest} from './test-request.service'

const start = Date.parse('2026-10-05T10:00:00Z')
function fixture() {
  let now = start,
    sequence = 0,
    createCalls = 0,
    outage = false,
    loseReply = false,
    scopes: string[] = []
  const work = {
    workId: 'work-one',
    kind: 'edit',
    routineId: 'flow-one',
    brief: {goal: 'Observe the whole flow'},
    origin: {repository: 'Mentra-Community/MentraOS', prNumber: 12, headSha: 'a'.repeat(40)},
    target: {hostId: 'mini', laneId: 'mac'},
    build: {headSha: 'a'.repeat(40), prNumber: 12, source: {buildRunId: 20, publicationAttempt: 1}},
  }
  const row = {
    workId: 'work-one',
    hostId: 'mini',
    work,
    inputSha256: requestInputDigest(work),
    createdAt: new Date(start),
  } as RoutineWorkDelivery
  const comments: Array<{id: number; body: string; user: {type: string}; performed_via_github_app: {id: number}}> = []
  const rows: RoutineWorkReportRepository = {
    async get() {
      return structuredClone(row)
    },
    async schedule(value, date) {
      row.reporting ??= {nextProgressAt: date, history: []}
      if (
        !row.reporting.finalCommentId &&
        ((row.reporting.lastSequence ?? -1) < (value.status?.sequence ?? 0) ||
          (value.acceptance && row.reporting.lastAcceptedAt !== value.acceptance.acceptedAt))
      )
        row.reporting.nextProgressAt = date
    },
    async due(date) {
      return row.reporting &&
        !row.reporting.finalCommentId &&
        row.reporting.nextProgressAt <= date &&
        (!row.reporting.lease || row.reporting.lease.expiresAt <= date)
        ? [row.workId]
        : []
    },
    async claim(_, date) {
      if (
        !row.reporting ||
        row.reporting.finalCommentId ||
        row.reporting.nextProgressAt > date ||
        (row.reporting.lease && row.reporting.lease.expiresAt > date)
      )
        return null
      row.reporting.lease = {id: `lease-${++sequence}`, expiresAt: new Date(date.getTime() + REPORT_LEASE_MS)}
      return structuredClone(row)
    },
    async save(_, leaseId, reporting) {
      if (row.reporting?.lease?.id !== leaseId) return false
      row.reporting = structuredClone(reporting)
      return true
    },
  }
  const app = {
    applicationId: 123,
    async token(scope: string) {
      scopes.push(scope)
      return 'secret'
    },
  } as TestRunGithubApp
  const notification = () =>
    new RoutineWorkNotification(
      app,
      async (url, init) => {
        if (outage) return new Response(null, {status: 403})
        if (init.method === 'GET') return Response.json(comments)
        if (init.method === 'POST') {
          createCalls++
          comments.push({
            id: comments.length + 1,
            body: JSON.parse(String(init.body)).body,
            user: {type: 'Bot'},
            performed_via_github_app: {id: 123},
          })
          if (loseReply) {
            loseReply = false
            throw new Error('secret response lost')
          }
          return Response.json(comments.at(-1), {status: 201})
        }
        const id = Number(url.split('/').at(-1)),
          comment = comments.find((value) => value.id === id)!
        comment.body = JSON.parse(String(init.body)).body
        return Response.json(comment)
      },
      rows,
      () => now,
    )
  function status(state: string, details: object = {}) {
    row.acceptance ??= {
      workId: row.workId,
      hostId: row.hostId,
      inputSha256: requestInputDigest(work),
      acceptedAt: new Date(start).toISOString(),
    }
    row.status = {
      sequence: (row.status?.sequence ?? 0) + 1,
      state,
      details: {details, acceptedAt: row.acceptance.acceptedAt},
    } as RoutineWorkDelivery['status']
  }
  return {
    row,
    rows,
    comments,
    notification,
    status,
    scopes,
    get createCalls() {
      return createCalls
    },
    set now(value: number) {
      now = value
    },
    set outage(value: boolean) {
      outage = value
    },
    set loseReply(value: boolean) {
      loseReply = value
    },
  }
}

test('durable ten-minute progress survives a worker exit and reporter restart without missed-window flood', async () => {
  const f = fixture()
  await f.notification().publish(f.row)
  expect(f.comments).toHaveLength(1)
  expect(f.scopes).toEqual(['reporter', 'reporter'])
  const first = f.comments[0]!.body
  f.status('stopped', {
    reason: 'Owned agent exited; waiting for its answer.',
    progress: {
      observedAt: new Date(start).toISOString(),
      completed: ['Saved two steps.'],
      current: 'Waiting for the expected destination.',
      plan: ['Answer the retained question; continue the same job.'],
      estimatedCompletionAt: null,
      estimateReason: 'Waiting for human input.',
    },
  })
  await f.notification().publish(f.row)
  f.now = start + 5 * PROGRESS_INTERVAL_MS
  await f.notification().tick()
  expect(f.comments).toHaveLength(1)
  expect(f.comments[0]!.body).not.toBe(first)
  expect(f.comments[0]!.body).toContain('worker activity is unknown')
  expect(f.comments[0]!.body).toContain('Waiting for human input')
  expect(f.row.reporting?.history).toHaveLength(3)
  expect(f.row.reporting?.nextProgressAt.getTime()).toBe(start + 6 * PROGRESS_INTERVAL_MS)
  await f.notification().tick()
  expect(f.row.reporting?.history).toHaveLength(3)
})

test('unknown comment create reconciles one owned marker and retains intent across outage and restart', async () => {
  const f = fixture()
  f.loseReply = true
  await expect(f.notification().publish(f.row)).rejects.toThrow('retained')
  const intent = structuredClone(f.row.reporting?.pending)
  expect(f.comments).toHaveLength(1)
  f.now = start + 60_000
  await f.notification().tick()
  expect(f.createCalls).toBe(1)
  expect(f.row.reporting?.pending).toBeUndefined()
  expect(f.row.reporting?.history[0]?.eventId).toBe(intent?.eventId)
  f.outage = true
  f.now = start + 11 * 60_000
  await f.notification().tick()
  expect(f.row.reporting?.error).toContain('issues:write')
  expect(JSON.stringify(f.row.reporting)).not.toContain('secret')
  f.outage = false
  f.now = start + 12 * 60_000
  await f.notification().tick()
  expect(f.comments).toHaveLength(1)
})

test('terminal receipt supersedes retained progress and publishes one distinct final comment', async () => {
  const f = fixture()
  f.outage = true
  await expect(f.notification().publish(f.row)).rejects.toThrow('retained')
  f.status('failed', {
    reason: 'No SIM is present for the requested cellular flow.',
    summary: 'Validated setup before Call.',
    progress: {
      observedAt: new Date(start).toISOString(),
      completed: ['Validated setup.'],
      current: 'Missing phone cellular capability.',
      plan: ['Provide a phone with service or change the requested coverage.'],
      estimatedCompletionAt: null,
      estimateReason: 'Hardware is required.',
    },
  })
  f.outage = false
  await f.notification().publish(f.row)
  expect(f.comments).toHaveLength(1)
  expect(f.comments[0]?.body).toContain('mentra-routine-work-final')
  expect(f.comments[0]?.body).toContain('No SIM')
  f.now = start + 10 * PROGRESS_INTERVAL_MS
  await f.notification().tick()
  expect(f.createCalls).toBe(1)
  expect(f.row.reporting?.finalSequence).toBe(1)
})

test('success final links exact reviewed unmerged source and ordinary recorded result, retaining progress separately', async () => {
  const f = fixture()
  await f.notification().publish(f.row)
  f.status('passed', {
    completion: {
      sourceRevision: 'b'.repeat(40),
      reviewedRevision: 'b'.repeat(40),
      prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/600',
      reviewUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/600#pullrequestreview-20',
      resultUrl: 'https://admin.dev.mentraglass.com/?testRun=run-one',
      summary: 'Every step passed; baseline restored and owned workspace disposed.',
    },
  })
  await f.notification().publish(f.row)
  expect(f.comments).toHaveLength(2)
  expect(f.comments[0]!.body).toContain('mentra-routine-work-progress')
  expect(f.comments[1]!.body).toContain('Independent passing review')
  expect(f.comments[1]!.body).toContain('Every step passed')
  await f.notification().publish(f.row)
  expect(f.createCalls).toBe(2)
})

test('a lost terminal comment acknowledgement reconciles the final marker after service restart', async () => {
  const f = fixture()
  f.status('cancelled', {
    reason: 'Employee cancelled the same owned job.',
    summary: 'Stopped the agent and returned the lane.',
  })
  f.loseReply = true
  await expect(f.notification().publish(f.row)).rejects.toThrow('retained')
  expect(f.comments).toHaveLength(1)
  expect(f.row.reporting?.finalCommentId).toBeUndefined()
  f.now = start + 60_000
  await f.notification().tick()
  expect(f.createCalls).toBe(1)
  expect(f.row.reporting?.finalCommentId).toBe(1)
})

test('foreign marker is never adopted and live lease prevents two reporters creating comments', async () => {
  const f = fixture()
  f.comments.push({
    id: 8,
    body: '<!-- mentra-routine-work-progress:work-one -->\nforged',
    user: {type: 'Bot'},
    performed_via_github_app: {id: 999},
  })
  await Promise.all([f.notification().publish(f.row), f.notification().publish(f.row)])
  expect(f.createCalls).toBe(1)
  expect(f.comments[0]!.body).toEndWith('forged')
})

test('terminal status received during comment lookup prevents a stale progress write', async () => {
  const f = fixture()
  const app = {
    applicationId: 123,
    async token() {
      return 'secret'
    },
  } as unknown as TestRunGithubApp
  let writes = 0
  const notification = new RoutineWorkNotification(
    app,
    async (_, init) => {
      if (init.method === 'GET') {
        f.status('failed', {reason: 'Original owned operation failed.'})
        return Response.json([])
      }
      writes++
      return Response.json({id: 1})
    },
    f.rows,
    () => start,
  )
  await notification.publish(f.row)
  expect(writes).toBe(0)
  expect(f.row.reporting?.pending).toBeUndefined()
  await f.notification().tick()
  expect(f.comments).toHaveLength(1)
  expect(f.comments[0]?.body).toContain('mentra-routine-work-final')
})

test('a persisted live lease fences restart; an expired lease resumes the same pending report', async () => {
  const f = fixture()
  f.outage = true
  await expect(f.notification().publish(f.row)).rejects.toThrow('retained')
  const pending = f.row.reporting!.pending!.eventId
  f.row.reporting!.lease = {id: 'previous-process', expiresAt: new Date(start + REPORT_LEASE_MS)}
  f.outage = false
  f.now = start + 60_000
  await f.notification().tick()
  expect(f.createCalls).toBe(0)
  f.now = start + REPORT_LEASE_MS
  await f.notification().tick()
  expect(f.createCalls).toBe(1)
  expect(f.row.reporting?.history[0]?.eventId).toBe(pending)
})

test('local jobs have no PR reporting and raw storage errors do not enter public reporting diagnostics', async () => {
  const f = fixture()
  delete f.row.work.origin
  await f.notification().publish(f.row)
  expect(f.row.reporting).toBeUndefined()
  expect(f.createCalls).toBe(0)
  const g = fixture(),
    original = g.rows.get
  g.rows.get = async () => {
    throw new Error('raw credential SECRET')
  }
  await expect(g.notification().publish(g.row)).rejects.toThrow('storage is unavailable')
  expect(g.row.reporting?.error).toBe('Source-PR reporting storage is unavailable; the retained report will retry.')
  expect(JSON.stringify(g.row.reporting)).not.toContain('SECRET')
  g.rows.get = original
})

test('service timer starts without importing an agent and shutdown drains active reconciliation', async () => {
  let calls = 0,
    release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const stop = startRoutineWorkReporting(
    {
      async tick() {
        calls++
        await pending
      },
    } as RoutineWorkNotification,
    10,
  )
  expect(calls).toBe(1)
  let stopped = false
  const complete = stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await complete
  expect(stopped).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(calls).toBe(1)
})
