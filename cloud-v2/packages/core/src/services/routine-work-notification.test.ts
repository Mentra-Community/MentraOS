import {expect, spyOn, test} from 'bun:test'
import {RoutineWorkNotification, startRoutineWorkReporting} from './routine-work-notification'
import {PROGRESS_INTERVAL_MS, REPORT_LEASE_MS, routineWorkReportRepository, type RoutineWorkReportRepository} from './routine-work-reporting'
import {RoutineWorkModel} from '../models/routine-work.model'
import type {RoutineWorkDelivery} from './routine-work.service'
import type {TestRunGithubApp} from './test-run-github-app'
import {requestInputDigest} from './test-request.service'

const start = Date.parse('2026-10-05T10:00:00Z')
function fixture(repository = 'Mentra-Community/MentraOS') {
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
    origin: {repository, prNumber: 12, headSha: 'a'.repeat(40)},
    target: {hostId: 'mini', laneId: 'mac'},
    build: {repository, headSha: 'a'.repeat(40), prNumber: 12, source: {buildRunId: 20, publicationAttempt: 1, ...(repository === 'Mentra-Community/MentraOS' ? {} : {repository})}},
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
        (!row.reporting.finalCommentId || (value.status?.sequence ?? 0) > (row.reporting.finalSequence ?? 0)) &&
        ((row.reporting.lastSequence ?? -1) < (value.status?.sequence ?? 0) ||
          (value.acceptance && row.reporting.lastAcceptedAt !== value.acceptance.acceptedAt))
      )
        row.reporting.nextProgressAt = date
    },
    async due(date) {
      return row.reporting &&
        (!row.reporting.finalCommentId || (row.status?.sequence ?? 0) > (row.reporting.finalSequence ?? 0)) &&
        row.reporting.nextProgressAt <= date &&
        (!row.reporting.lease || row.reporting.lease.expiresAt <= date)
        ? [row.workId]
        : []
    },
    async claim(_, date) {
      if (
        !row.reporting ||
        (row.reporting.finalCommentId && (row.status?.sequence ?? 0) <= (row.reporting.finalSequence ?? 0)) ||
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
  const targets: Array<string | undefined> = [], urls: string[] = []
  const app = {
    applicationId: 123,
    async token(scope: string, repository?: string) {
      scopes.push(scope); targets.push(repository)
      return 'secret'
    },
  } as TestRunGithubApp
  const notification = () =>
    new RoutineWorkNotification(
      app,
      async (url, init) => {
        urls.push(url)
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
        if (loseReply) {loseReply = false; throw new Error('secret response lost')}
        return Response.json(comment)
      },
      rows,
      () => now,
    )
  function status(state: string, details: object = {}) {
    row.acceptance ??= {
      workId: row.workId,
      hostId: row.hostId!,
      inputSha256: requestInputDigest(work),
      acceptedAt: new Date(start).toISOString(),
    }
    row.status = {
      sequence: (row.status?.sequence ?? 0) + 1,
      state,
      details: {details, acceptedAt: row.acceptance!.acceptedAt},
    } as RoutineWorkDelivery['status']
  }
  return {
    row,
    rows,
    comments,
    notification,
    status,
    scopes, targets, urls,
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
  expect(f.comments[0]!.body).toContain('This authoring attempt is unfinished')
  expect(f.row.reporting?.history).toHaveLength(3)
  expect(f.row.reporting?.nextProgressAt.getTime()).toBe(start + 6 * PROGRESS_INTERVAL_MS)
  await f.notification().tick()
  expect(f.row.reporting?.history).toHaveLength(3)
})

test('startup tick initializes retained stopped PR jobs without a worker, and preserves an existing report receipt', async () => {
  const f = fixture()
  f.status('stopped', {reason: 'Agent exited before reporting was installed.'})
  const finds: Array<{filter: Record<string, unknown>; limit?: number}> = []
  let initializations = 0
  const find = spyOn(RoutineWorkModel, 'find').mockImplementation(((filter: Record<string, unknown> = {}) => {
    const call = {filter} as (typeof finds)[number]
    finds.push(call)
    const query = {
      select() { return query }, sort() { return query },
      limit(value: number) { call.limit = value; return query },
      read() { return query }, readConcern() { return query }, setOptions() { return query },
      async lean() {
        if ('reporting' in filter) return f.row.reporting ? [] : [{workId: f.row.workId}]
        return f.row.reporting && f.row.reporting.nextProgressAt <= new Date(start) ? [{workId: f.row.workId}] : []
      },
    }
    return query as never
  }) as typeof RoutineWorkModel.find)
  const update = spyOn(RoutineWorkModel, 'updateMany').mockImplementation(((filter: any, values: any) => {
    expect(filter).toEqual({workId: {$in: [f.row.workId]}, reporting: {$exists: false}})
    initializations++
    f.row.reporting ??= structuredClone(values.$set.reporting)
    return Promise.resolve({matchedCount: 1}) as never
  }) as typeof RoutineWorkModel.updateMany)
  const due = f.rows.due
  f.rows.due = date => routineWorkReportRepository.due(date)
  try {
    await f.notification().tick()
    expect(f.comments).toHaveLength(1)
    expect(f.comments[0]?.body).toContain('stopped')
    expect(f.row.reporting?.history).toHaveLength(1)
    expect(initializations).toBe(1)
    expect(finds.every(value => value.limit === 20)).toBe(true)
    expect(finds[0]?.filter).toEqual({'work.origin': {$exists: true}, reporting: {$exists: false}})
    const retained = structuredClone(f.row.reporting)
    await f.notification().tick()
    expect(initializations).toBe(1)
    expect(f.row.reporting).toEqual(retained)
    expect(f.createCalls).toBe(1)
  } finally {
    f.rows.due = due
    update.mockRestore()
    find.mockRestore()
  }
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
  expect(f.row.reporting?.error).toContain('pull_requests:write')
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
  const targets: Array<string | undefined> = [], urls: string[] = []
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

test('later cancellation custody refreshes the same final marker after a lost update and restart', async () => {
  const f = fixture()
  const detail = {summary: 'Operator cancelled this fixture.',
    prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/539',
    progress: {observedAt: new Date(start).toISOString(), completed: [], current: 'Cancelled',
      plan: ['Complete saved authoring, independent review and verification.'], estimatedCompletionAt: null, estimateReason: 'Cancelled'}}
  f.status('cancelled', detail)
  f.row.status!.sequence = 13
  await f.notification().publish(f.row)
  const id = f.row.reporting!.finalCommentId
  expect(f.row.reporting?.finalSequence).toBe(13)
  expect(f.comments[0]!.body).toContain('Plan: No further authoring is scheduled.')
  expect(f.comments[0]!.body).toContain('Next action: No further authoring is scheduled.')
  expect(f.comments[0]!.body).not.toContain('Complete saved authoring')
  f.now = start + 1_000
  f.status('cancelled', detail)
  f.loseReply = true
  await expect(f.notification().publish(f.row)).rejects.toThrow('retained')
  expect(f.row.reporting?.pending?.sequence).toBe(14)
  expect(f.row.reporting?.finalCommentId).toBe(id)
  f.status('cancelled', detail)
  f.now = start + 61_000
  await f.notification().tick()
  expect(f.row.reporting?.finalSequence).toBe(15)
  expect(f.row.reporting?.finalCommentId).toBe(id)
  expect(f.row.reporting?.pending).toBeUndefined()
  expect(f.comments).toHaveLength(1)
  expect(f.createCalls).toBe(1)
  expect(f.row.reporting?.history.at(-1)?.sequence).toBe(15)
  const completed = structuredClone(f.row.reporting)
  f.now = start + PROGRESS_INTERVAL_MS
  await f.notification().tick()
  expect(f.row.reporting).toEqual(completed)
})

test('existing reporting timer shares and drains the bounded incident retry hook', async () => {
  let authoring = 0, reports = 0, release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  const stop = startRoutineWorkReporting({async tick() {authoring++;}} as RoutineWorkNotification, 10,
    async () => {reports++; await held;});
  expect(authoring).toBe(1); expect(reports).toBe(1);
  let drained = false; const stopped = stop().then(() => {drained = true;});
  await Promise.resolve(); expect(drained).toBe(false); release(); await stopped; expect(drained).toBe(true);
});

test('a failed authoring tick still drains active incident reporting before shutdown', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  const stop = startRoutineWorkReporting({async tick() {throw Error('Authoring unavailable');}} as unknown as RoutineWorkNotification, 10,
    async () => held);
  let drained = false; const stopped = stop().then(() => {drained = true;});
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
  release(); await stopped; expect(drained).toBe(true);
});

test('one reporting timer keeps PR ticks independent and serialized while normal reports are held, then drains both', async () => {
  let timerTick!: () => void, normalCalls = 0, reportCalls = 0, prCalls = 0
  let releaseNormal!: () => void
  const normal = new Promise<void>(resolve => {releaseNormal = resolve})
  const prReleases: Array<() => void> = []
  const timers = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    timerTick = callback
    return {unref() {}} as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  let stop: (() => Promise<void>) | undefined
  try {
    stop = startRoutineWorkReporting({async tick() {normalCalls++; await normal}} as RoutineWorkNotification, 15_000,
      async () => {reportCalls++; await normal},
      async () => {prCalls++; await new Promise<void>(resolve => {prReleases.push(resolve)})})
    expect(timers).toHaveBeenCalledTimes(1)
    expect(timers.mock.calls[0]![1]).toBe(15_000)
    expect([normalCalls, reportCalls, prCalls]).toEqual([1, 1, 1])
    timerTick(); timerTick()
    expect([normalCalls, reportCalls, prCalls]).toEqual([1, 1, 1])
    prReleases[0]!()
    // Flush the callback and its settlement; a later timer tick may begin the next PR report.
    await new Promise<void>(resolve => queueMicrotask(() => queueMicrotask(() => queueMicrotask(resolve))))
    timerTick()
    expect([normalCalls, reportCalls, prCalls]).toEqual([1, 1, 2])
    timerTick()
    expect(prCalls).toBe(2)
    prReleases[1]!()
    await new Promise<void>(resolve => queueMicrotask(() => queueMicrotask(() => queueMicrotask(resolve))))
    timerTick()
    expect([normalCalls, reportCalls, prCalls]).toEqual([1, 1, 3])
    let drained = false
    const complete = stop().then(() => {drained = true})
    await Promise.resolve()
    expect(drained).toBe(false)
    releaseNormal()
    await new Promise<void>(resolve => queueMicrotask(() => queueMicrotask(() => queueMicrotask(resolve))))
    expect(drained).toBe(false)
    timerTick()
    expect([normalCalls, reportCalls, prCalls]).toEqual([1, 1, 3])
    prReleases[2]!()
    await complete
    expect(drained).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    releaseNormal?.()
    for (const release of prReleases) release()
    await stop?.()
    clear.mockRestore()
    timers.mockRestore()
  }
})


test('source-PR reporting and lost-response reconciliation stay on the retained app repository', async () => {
  for (const repository of ['Mentra-Community/Mentra', 'Mentra-Community/MentraOS'] as const) {
    const f = fixture(repository); f.loseReply = true;
    await expect(f.notification().publish(f.row)).rejects.toThrow('retained');
    f.now = start + 60_000;
    await f.notification().reconcile(f.row.workId);
    expect(f.createCalls).toBe(1);
    expect(f.targets.every(target => target === repository)).toBe(true);
    expect(f.urls.every(url => url.startsWith(`https://api.github.com/repos/${repository}/`))).toBe(true);
    expect(f.row.work.origin!.repository).toBe(repository);
  }
  const mismatch = fixture('Mentra-Community/Mentra');
  mismatch.row.work.build.source.repository = 'Mentra-Community/MentraOS';
  mismatch.row.inputSha256 = requestInputDigest(mismatch.row.work);
  await expect(mismatch.notification().publish(mismatch.row)).rejects.toThrow('repository differs');
  expect(mismatch.urls).toHaveLength(0); expect(mismatch.targets).toHaveLength(0);
  const wrong = fixture('other/Mentra');
  await expect(wrong.notification().publish(wrong.row)).rejects.toThrow();
  expect(wrong.urls).toHaveLength(0); expect(wrong.targets).toHaveLength(0);
});
