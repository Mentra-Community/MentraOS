import {expect, test} from 'bun:test'
import {RoutineWorkService, type RoutineWorkDelivery, type RoutineWorkRepository} from './routine-work.service'
import {requestInputDigest} from './test-request.service'
import {routineWorkRequestSchema, routineWorkStatusSchema} from '../types/routine-work.types'

const input = routineWorkRequestSchema.parse({
  schemaVersion: 1,
  workId: 'work:one',
  kind: 'edit',
  routineId: 'arbitrary-flow',
  brief: {
    goal: 'Correct the saved flow',
    stepsOrChanges: ['Observe the requested result'],
    expected: ['The full result is visible'],
  },
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40)},
  target: {hostId: 'mini', laneId: 'phone'},
  requirements: {platform: 'android', glasses: [], capabilities: [], environment: []},
  origin: {repository: 'Mentra-Community/MentraOS', prNumber: 12, headSha: 'b'.repeat(40)},
  buildSource: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 2},
})
function fixture(options: {buildHead?: string; noHost?: boolean; notificationFailure?: boolean} = {}) {
  const rows = new Map<string, RoutineWorkDelivery>()
  let resolves = 0,
    notifications = 0
  const repository: RoutineWorkRepository = {
    async get(id) {
      return structuredClone(rows.get(id) ?? null)
    },
    async insert(row) {
      if (rows.has(row.workId)) throw new Error('duplicate')
      rows.set(row.workId, {...structuredClone(row), createdAt: new Date('2026-10-05T10:00:00Z')})
    },
    async queued(hostId, after, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.hostId === hostId &&
            !row.acceptance &&
            (!after ||
              row.createdAt! > after.createdAt ||
              (row.createdAt!.getTime() === after.createdAt.getTime() && row.workId > after.workId)),
        )
        .sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime() || a.workId.localeCompare(b.workId))
        .slice(0, limit)
    },
    async accept(receipt) {
      const row = rows.get(receipt.workId)
      if (!row || row.acceptance) return null
      row.acceptance = structuredClone(receipt)
      return structuredClone(row)
    },
    async updateStatus(event) {
      const row = rows.get(event.workId)
      if (
        !row ||
        row.statusReceipts?.some((value) => value.eventId === event.eventId) ||
        (row.status && row.status.sequence >= event.sequence)
      )
        return null
      row.status = structuredClone(event)
      ;(row.statusReceipts ??= []).push({
        eventId: event.eventId,
        sequence: event.sequence,
        sha256: requestInputDigest(event),
      })
      return structuredClone(row)
    },
  }
  const service = new RoutineWorkService(
    repository,
    {
      async resolve(source, platform) {
        resolves++
        return {
          source,
          platform,
          availability: 'available',
          headSha: options.buildHead ?? input.origin.headSha,
          title: 'Candidate',
          buildUrl: 'https://github.com/build',
          createdAt: '2026-10-05T09:00:00Z',
          archive: {
            name: 'candidate.apk',
            url: 'https://artifactscdn.mentraglass.com/candidate.apk',
            size: 100,
            sha256: 'c'.repeat(64),
          },
          receipt: {url: 'https://artifactscdn.mentraglass.com/receipt.json', size: 50, sha256: 'd'.repeat(64)},
        }
      },
    },
    {
      async get(hostId) {
        return options.noHost
          ? null
          : {
              hostId,
              incarnation: 'one',
              incarnationGeneration: 1,
              sequence: 1,
              observedAt: '2026-10-05T09:00:00Z',
              receivedAt: '2026-10-05T09:00:00Z',
              lanes: [{id: 'phone', platform: 'android', state: 'reserved', dispatchMode: 'authoring', resources: []}],
            }
      },
    },
    {
      async publish() {
        notifications++
        if (options.notificationFailure) throw new Error('Unavailable')
      },
    },
  )
  return {
    service,
    rows,
    get resolves() {
      return resolves
    },
    get notifications() {
      return notifications
    },
  }
}
test('freezes one exact build and immutable work, without taking a hardware grant', async () => {
  const f = fixture(),
    row = await f.service.submit(input)
  expect(row.work).toMatchObject({
    workId: input.workId,
    kind: 'edit',
    source: input.source,
    requirements: input.requirements,
    build: {kind: 'android-apk', source: input.buildSource, headSha: input.origin.headSha},
  })
  expect(row.inputSha256).toBe(requestInputDigest(row.work))
  expect(row.reporting?.nextProgressAt).toBeInstanceOf(Date)
  expect(await f.service.submit(input)).toEqual(row)
  expect(f.resolves).toBe(1)
  for (const change of [
    {...input, brief: {...input.brief, goal: 'Changed'}},
    {...input, source: {...input.source, revision: 'e'.repeat(40)}},
    {...input, buildSource: {...input.buildSource, publicationAttempt: 3}},
    {...input, target: {...input.target, hostId: 'foreign'}},
  ])
    await expect(f.service.submit(change)).rejects.toThrow('frozen')
})
test('host acceptance is immutable and status sequences cannot replace newer truth', async () => {
  const f = fixture(),
    row = await f.service.submit(input)
  const receipt = {
    workId: row.workId,
    hostId: row.hostId,
    inputSha256: row.inputSha256,
    acceptedAt: '2026-10-05T10:01:00Z',
  }
  await expect(f.service.accept({...receipt, hostId: 'foreign'}, 'foreign')).rejects.toThrow('owner')
  expect(await f.service.accept(receipt, 'mini')).toEqual(receipt)
  expect(await f.service.accept(receipt, 'mini')).toEqual(receipt)
  await expect(f.service.accept({...receipt, acceptedAt: '2026-10-05T10:02:00Z'}, 'mini')).rejects.toThrow('original')
  const {acceptedAt: _, ...binding} = receipt
  const first = routineWorkStatusSchema.parse({
    ...binding,
    eventId: 'event:one',
    sequence: 1,
    state: 'authoring',
    details: {
      ...receipt,
      sequence: 1,
      state: 'authoring',
      work: row.work,
      details: {summary: 'Saved step'},
      events: [],
    },
  })
  expect(await f.service.status(first, 'mini')).toMatchObject({sequence: 1, state: 'authoring'})
  expect(await f.service.status(first, 'mini')).toMatchObject({eventId: 'event:one'})
  await expect(
    f.service.status({...first, details: {...first.details, details: {workspace: '/private/location'}}}, 'mini'),
  ).rejects.toMatchObject({status: 400})
  await expect(
    f.service.status(
      {...first, details: {...first.details, details: {prUrl: 'https://foreign.example/pull/1'}}},
      'mini',
    ),
  ).rejects.toMatchObject({status: 400})
  const next = {
    ...first,
    eventId: 'event:two',
    sequence: 2,
    state: 'awaiting-review',
    details: {...first.details, sequence: 2, state: 'awaiting-review'},
  }
  await f.service.status(next, 'mini')
  expect(await f.service.status(first, 'mini')).toEqual(first)
  expect(f.rows.get(row.workId)?.status?.sequence).toBe(2)
  await expect(
    f.service.status({...next, details: {...next.details, details: {summary: 'Changed'}}}, 'mini'),
  ).rejects.toThrow('changed')
  await expect(f.service.status({...next, eventId: first.eventId}, 'mini')).rejects.toThrow('changed')
  await expect(f.service.status({...first, eventId: 'event:stale'}, 'mini')).rejects.toThrow('stale')
})
test('delivery cursors and provider input limits remain host scoped', async () => {
  const f = fixture()
  await f.service.submit(input)
  await f.service.submit({...input, workId: 'work:two'})
  expect((await f.service.queued('mini', undefined, 50)).jobs).toHaveLength(2)
  expect((await f.service.queued('foreign', undefined, 50)).jobs).toHaveLength(0)
  const cursor = Buffer.from(
    JSON.stringify({hostId: 'foreign', workId: 'one', createdAt: '2026-10-05T10:00:00Z'}),
  ).toString('base64url')
  await expect(f.service.queued('mini', cursor, 50)).rejects.toThrow('cursor')
  await expect(
    f.service.submit({
      ...input,
      requirements: {
        ...input.requirements,
        environment: [{provider: 'existing-provider', input: 'x'.repeat(33 * 1024), description: 'Required provider'}],
      },
    }),
  ).rejects.toThrow('Invalid')
})

test('same-time delivery pagination and concurrent admission preserve every occurrence once', async () => {
  const f = fixture()
  const duplicate = await Promise.all(Array.from({length: 6}, () => f.service.submit(input)))
  expect(duplicate.every((row) => row.inputSha256 === duplicate[0]!.inputSha256)).toBe(true)
  expect(f.rows.size).toBe(1)
  for (const workId of ['work:two', 'work:three']) await f.service.submit({...input, workId})
  const first = await f.service.queued('mini', undefined, 2),
    second = await f.service.queued('mini', first.nextCursor!, 2)
  expect([...first.jobs, ...second.jobs].map((row) => row.workId)).toEqual(['work:one', 'work:three', 'work:two'])
  expect(second.nextCursor).toBeNull()
})

test('stale app head, missing host, foreign lane and malformed provider input create no delivery', async () => {
  for (const [f, request] of [
    [fixture({buildHead: 'f'.repeat(40)}), input],
    [fixture({noHost: true}), input],
    [fixture(), {...input, target: {...input.target, laneId: 'foreign'}}],
  ] as const) {
    await expect(f.service.submit(request)).rejects.toMatchObject({status: 409})
    expect(f.rows.size).toBe(0)
  }
  const f = fixture()
  await expect(
    f.service.submit({
      ...input,
      requirements: {
        ...input.requirements,
        environment: [{provider: 'fixture', input: Infinity, description: 'Required'}],
      },
    }),
  ).rejects.toMatchObject({status: 400})
  expect(f.rows.size).toBe(0)
})

test('PR notification failure cannot block durable acceptance or subsequent host status receipts', async () => {
  const f = fixture({notificationFailure: true}),
    row = await f.service.submit(input)
  expect(f.rows.get(row.workId)?.inputSha256).toBe(row.inputSha256)
  expect(await f.service.submit(input)).toEqual(row)
  expect(f.resolves).toBe(1)
  expect(f.notifications).toBe(2)
  const receipt = {
    workId: row.workId,
    hostId: row.hostId,
    inputSha256: row.inputSha256,
    acceptedAt: '2026-10-05T10:01:00Z',
  }
  await f.service.accept(receipt, row.hostId)
  const {acceptedAt: _, ...binding} = receipt
  const status = routineWorkStatusSchema.parse({
    ...binding,
    eventId: 'event:failed-notification',
    sequence: 1,
    state: 'authoring',
    details: {...receipt, sequence: 1, state: 'authoring', work: row.work, details: {}, events: []},
  })
  expect(await f.service.status(status, row.hostId)).toEqual(status)
  expect(f.rows.get(row.workId)?.status?.sequence).toBe(1)
  expect(await f.service.status(status, row.hostId)).toEqual(status)
  expect(f.rows.get(row.workId)?.statusReceipts).toHaveLength(1)
  const next = routineWorkStatusSchema.parse({
    ...status,
    eventId: 'event:later-status-during-outage',
    sequence: 2,
    state: 'awaiting-review',
    details: {...status.details, sequence: 2, state: 'awaiting-review'},
  })
  expect(await f.service.status(next, row.hostId)).toEqual(next)
  expect(f.rows.get(row.workId)?.status?.state).toBe('awaiting-review')
  expect(f.rows.get(row.workId)?.statusReceipts).toHaveLength(2)
  await expect(f.service.report(f.rows.get(row.workId)!)).rejects.toMatchObject({status: 503})
})

test('cancelled status preserves the machine recorded cancellation summary as its cause', async () => {
  const f = fixture(), row = await f.service.submit(input)
  const receipt = {workId: row.workId, hostId: row.hostId, inputSha256: row.inputSha256,
    acceptedAt: '2026-10-05T10:01:00Z'}
  await f.service.accept(receipt, row.hostId)
  const {acceptedAt: _, ...binding} = receipt
  const cause = 'Operator cancelled the extra proof; preserve the unmerged source.'
  const event = routineWorkStatusSchema.parse({...binding, eventId: 'cancel-one', sequence: 1, state: 'cancelled',
    details: {...receipt, sequence: 1, state: 'cancelled', attemptId: 1, work: row.work,
      details: {summary: cause}, events: []}})
  expect(await f.service.status(event, row.hostId)).toEqual(event)
  expect(await f.service.status(event, row.hostId)).toEqual(event)
  expect(f.rows.get(row.workId)?.statusReceipts).toHaveLength(1)
  await expect(f.service.status({...event, eventId: 'empty-cause',
    details: {...event.details, details: {}}}, row.hostId)).rejects.toMatchObject({status: 400})
  await expect(f.service.status({...event, details: {...event.details, details: {summary: 'Changed cause'}}},
    row.hostId)).rejects.toThrow('Terminal')
})

test('terminal status requires exact reviewed source and recording links and cannot regress after restart', async () => {
  const f = fixture(),
    row = await f.service.submit(input)
  const receipt = {
    workId: row.workId,
    hostId: row.hostId,
    inputSha256: row.inputSha256,
    acceptedAt: '2026-10-05T10:01:00Z',
  }
  await f.service.accept(receipt, row.hostId)
  const {acceptedAt: _, ...binding} = receipt
  const state = 'passed' as const,
    prUrl = 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/600'
  const details = {
    sourceRevision: 'c'.repeat(40),
    prUrl,
    requestId: 'candidate-one',
    resultUrl: 'https://admin.dev.mentraglass.com/?testRun=run-one',
    review: {sourceRevision: 'c'.repeat(40), prUrl, reviewUrl: `${prUrl}#pullrequestreview-21`, verdict: 'APPROVED' as const},
    completion: {
      sourceRevision: 'c'.repeat(40),
      reviewedRevision: 'c'.repeat(40),
      prUrl,
      reviewUrl: `${prUrl}#pullrequestreview-21`,
      resultUrl: 'https://admin.dev.mentraglass.com/?testRun=run-one',
      summary: 'Recorded steps passed, baseline restored and workspace disposed.',
    },
  }
  const event = {
    ...binding,
    eventId: 'terminal-one',
    sequence: 1,
    state,
    details: {...receipt, sequence: 1, state, attemptId: 3, work: row.work, details, events: []},
  }
  for (const invalid of [
    {...details, review: undefined},
    {...details, review: {...details.review, reviewUrl: `${prUrl}#pullrequestreview-22`}},
    {...details, completion: undefined},
    {...details, completion: {...details.completion, reviewedRevision: 'd'.repeat(40)}},
    {...details, completion: {...details.completion, reviewUrl: `${prUrl}/comments/21`}},
    {
      ...details,
      completion: {
        ...details.completion,
        reviewUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601#pullrequestreview-21',
      },
    },
  ])
    await expect(
      f.service.status({...event, details: {...event.details, details: invalid}}, row.hostId),
    ).rejects.toMatchObject({status: 400})
  await expect(f.service.status({...event, details: {...event.details, attemptId: undefined}}, row.hostId))
    .rejects.toMatchObject({status: 400})
  await f.service.status(event, row.hostId)
  expect(await f.service.status(event, row.hostId)).toEqual(event)
  await expect(
    f.service.status(
      {
        ...event,
        eventId: 'late-progress',
        sequence: 2,
        state: 'authoring',
        details: {...event.details, state: 'authoring', sequence: 2},
      },
      row.hostId,
    ),
  ).rejects.toThrow('Terminal')
  expect(f.rows.get(row.workId)?.status?.state).toBe('passed')
  expect(f.rows.get(row.workId)?.status?.details).toMatchObject({attemptId: 3, details: {review: details.review}})
})
