import {expect, spyOn, test} from 'bun:test'
import {RoutineWorkModel} from '../models/routine-work.model'
import {RoutineWorkService as ActualRoutineWorkService, type RoutineWorkDelivery, type RoutineWorkRepository} from './routine-work.service'
import {requestInputDigest} from './test-request.service'
import {routineWorkRequestSchema, routineWorkStatusSchema, authoringWorkSchema, type AuthoringWork} from '../types/routine-work.types'
import {createRoutineWorkIntakeApi} from '../api/internal/routine-work.api'


// Existing status/cursor regression cases operate after the single host binding.
class RoutineWorkService extends ActualRoutineWorkService {
  constructor(...args: ConstructorParameters<typeof ActualRoutineWorkService>) {
    args[4] ??= {async resolve(revision) {return revision ?? 'a'.repeat(40)}};
    args[6] = null;
    super(...args);
  }
  override async submit(value:unknown):Promise<RoutineWorkDelivery & {hostId:string;work:AuthoringWork}> {return await super.submit(value) as RoutineWorkDelivery & {hostId:string;work:AuthoringWork};}
}

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
  requirements: {platform: 'android', glasses: [], environment: [], resources:[{kind:"app",capabilities:[]},{kind:"phone",capabilities:[]},{kind:"recorder",capabilities:[]}]},
  origin: {repository: 'Mentra-Community/MentraOS', prNumber: 12, headSha: 'b'.repeat(40)},
  buildSource: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 2},
})
test('invalid portable author fixtures fail intake before any persistence or Actions delivery', async () => {
  const previous = process.env.TEST_RUN_INGEST_TOKEN, token = 'f'.repeat(40)
  process.env.TEST_RUN_INGEST_TOKEN = token
  let touched = 0
  const unexpected = async (): Promise<never> => {touched++; throw new Error('Invalid intake reached a dependency')}
  const rows: RoutineWorkRepository = {get: unexpected, insert: unexpected, queued: unexpected, accept: unexpected, updateStatus: unexpected}
  const service = new ActualRoutineWorkService(rows, {resolve: unexpected}, {get: unexpected}, {publish: unexpected},
    {resolve: unexpected}, Date.now, {dispatch: unexpected, cancel: unexpected})
  const app = createRoutineWorkIntakeApi(service)
  const resources = input.requirements.resources
  try {
    for (const requirements of [
      {...input.requirements, resources: [...resources, resources[0]]},
      {...input.requirements, glasses: ['mentra-live'], resources},
      {...input.requirements, resources: [...resources, {kind: 'glasses', capabilities: []}]},
      {...input.requirements, glasses: ['bad_model'], resources: [...resources, {kind: 'glasses', capabilities: []}]},
      {...input.requirements, glasses: ['mentra-live', 'mentra-live'], resources: [...resources, {kind: 'glasses', capabilities: []}]},
      {...input.requirements, resources: resources.filter(resource => resource.kind !== 'recorder')},
      {...input.requirements, resources: resources.map(resource => resource.kind === 'phone' ? {...resource, capabilities: ['camera']} : resource)},
    ]) {
      const response = await app.request('/', {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify({...input, requirements})})
      expect(response.status).toBe(400)
    }
    expect(touched).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.TEST_RUN_INGEST_TOKEN
    else process.env.TEST_RUN_INGEST_TOKEN = previous
  }
})
test('author routing uses an accepting alternate model and refreshes labels without changing its portable input', async () => {
  const {routineRequirementLabels} = await import('./routine-job.service')
  type Host = import('./test-host-state.service').ReceivedTestHostState
  const time = Date.parse('2026-10-08T00:00:00Z'), rows = new Map<string, RoutineWorkDelivery>()
  const unexpected = async (): Promise<never> => {throw new Error('Unexpected host operation')}
  const repository: RoutineWorkRepository = {async get(id) {return structuredClone(rows.get(id) ?? null)}, async insert(row) {rows.set(row.workId, structuredClone(row))},
    queued: unexpected, accept: unexpected, updateStatus: unexpected}
  const resources = [...input.requirements.resources, {kind: 'glasses' as const, capabilities: []}]
  const lane = (model: string, state: Host['lanes'][number]['state'], dispatchMode: Host['lanes'][number]['dispatchMode']) => ({id: model, platform: 'android' as const,
    state, dispatchMode, resources: resources.map(resource => ({id: `${resource.kind}:${model}`, kind: resource.kind})),
    glasses: [{resourceId: `glasses:${model}`, deviceId: model, model, capabilities: ['camera']}]})
  const host: Host = {hostId: 'mini', incarnation: 'one', incarnationGeneration: 1, sequence: 1,
    observedAt: new Date(time).toISOString(), receivedAt: new Date(time).toISOString(), lanes: [lane('g1', 'idle', 'paused'), lane('mentra-live', 'idle', 'automatic')]}
  const service = new ActualRoutineWorkService(repository, {async resolve(source, platform) {return {source, platform, availability: 'available',
    headSha: input.origin.headSha, title: 'Candidate', buildUrl: 'https://github.com/build', createdAt: new Date(time).toISOString(),
    archive: {name: 'candidate.apk', url: 'https://artifactscdn.mentraglass.com/candidate.apk', size: 100, sha256: 'c'.repeat(64)},
    receipt: {url: 'https://artifactscdn.mentraglass.com/receipt.json', size: 50, sha256: 'd'.repeat(64)}}}},
    {get: unexpected, async list() {return [structuredClone(host)]}}, {async publish() {}}, {async resolve() {return 'a'.repeat(40)}}, () => time, null)
  const {target: _target, ...portable} = input
  const row = await service.submit({...portable, requirements: {...input.requirements, resources, glasses: ['g1', 'mentra-live']}})
  const first = await service.preparation(row.workId), frozen = structuredClone(row.fleetSelection)
  expect(first.chosenModel).toBe('mentra-live'); expect(first.waitingReason).toBeUndefined()
  expect(first.routingLabels).toEqual(routineRequirementLabels(first.prepared.requirements, 'mentra-live'))
  host.lanes[0]!.dispatchMode = 'automatic'; host.lanes[0]!.state = 'in-repair'
  expect((await service.preparation(row.workId)).chosenModel).toBe('mentra-live')
  host.lanes[1]!.state = 'running'
  expect(await service.preparation(row.workId)).toMatchObject({state: 'awaiting-runner', waitingReason: 'Awaiting an idle compatible enrolled runner', inputSha256: first.inputSha256})
  host.lanes[0]!.state = 'idle'
  expect((await service.preparation(row.workId)).chosenModel).toBe('g1')
  expect((await service.inspect(row.workId)).fleetSelection).toEqual(frozen)
  expect((await service.inspect(row.workId)).fleetInputSha256).toBe(first.inputSha256)
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
      const work=authoringWorkSchema.parse({...row.work,target:input.target});
      rows.set(row.workId, {...structuredClone(row),work,inputSha256:requestInputDigest(work),hostId:'mini', createdAt: new Date('2026-10-05T10:00:00Z')})
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
    async updateVerification(value, original, previous) {
      const row=rows.get(value.event.workId)
      if(!row||requestInputDigest(row.status)!==requestInputDigest(original)||requestInputDigest(row.verification??null)!==requestInputDigest(previous??null))return null
      row.verification={identity:structuredClone(value.identity),status:structuredClone(value.event),receipts:[...(previous?.receipts??[]),
        {eventId:value.event.eventId,sequence:value.event.sequence,sha256:requestInputDigest(value.event)}]}
      return structuredClone(row)
    },
    async updateStatus(event, previous) {
      const row = rows.get(event.workId)
      if (
        !row ||
        requestInputDigest(row.status ?? null) !== requestInputDigest(previous ?? null) ||
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

test('stale app head and malformed provider input create no delivery while offline source work is retained', async () => {
  for (const [f, request] of [[fixture({buildHead: 'f'.repeat(40)}), input]] as const) {
    await expect(f.service.submit(request)).rejects.toMatchObject({status: 409})
    expect(f.rows.size).toBe(0)
  }
  const offline=fixture({noHost:true});expect((await offline.service.submit(input)).workId).toBe(input.workId);
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
  const custody = {...event, eventId: 'terminal-custody', sequence: 2,
    details: {...event.details, sequence: 2}}
  expect(await f.service.status(custody, row.hostId)).toEqual(custody)
  for (const changed of [
    {...details, requestId: 'different-run'},
    {...details, resultUrl: 'https://admin.dev.mentraglass.com/?testRun=different',
      completion: {...details.completion, resultUrl: 'https://admin.dev.mentraglass.com/?testRun=different'}},
    {...details, review: {...details.review, reviewUrl: `${prUrl}#pullrequestreview-22`},
      completion: {...details.completion, reviewUrl: `${prUrl}#pullrequestreview-22`}},
    {...details, completion: {...details.completion, summary: 'Different completion claim'}},
  ])
    await expect(f.service.status({...custody, eventId: 'changed-passing-outcome', sequence: 3,
      details: {...custody.details, sequence: 3, details: changed}}, row.hostId)).rejects.toThrow('Terminal')
})

test('ordered cancellation custody events retain the original outcome through sequence 13, 14 and 15', async () => {
  const f = fixture(), row = await f.service.submit(input)
  const acceptance = {workId: row.workId, hostId: row.hostId, inputSha256: row.inputSha256,
    acceptedAt: '2026-10-05T10:01:00Z'}
  await f.service.accept(acceptance, row.hostId)
  const {acceptedAt: _, ...binding} = acceptance
  const details = {sourceRevision: 'd'.repeat(40), prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/539',
    summary: 'Operator cancelled this stopped wording fixture; preserve its unmerged source and dispose its workspace.'}
  const events: Array<{eventId: string; sequence: number; state: 'cancelled'; at: string; details: typeof details | {}}> = []
  const submitted = []
  for (const [sequence, eventId] of [[13, 'operator-cancel'], [14, 'source-preserved'], [15, 'workspace-disposed']] as const) {
    events.push({eventId, sequence, state: 'cancelled', at: '2026-10-05T10:02:00Z', details: sequence === 13 ? {summary: details.summary} : {}})
    const event = routineWorkStatusSchema.parse({...binding, eventId, sequence, state: 'cancelled',
      details: {...acceptance, sequence, state: 'cancelled', attemptId: 1, work: row.work, details, events: structuredClone(events)}})
    expect(await f.service.status(event, row.hostId)).toEqual(event)
    submitted.push(event)
  }
  expect(f.rows.get(row.workId)?.status?.sequence).toBe(15)
  expect(f.rows.get(row.workId)?.statusReceipts).toHaveLength(3)
  for (const event of submitted) expect(await f.service.status(event, row.hostId)).toEqual(event)
  expect(f.rows.get(row.workId)?.status?.sequence).toBe(15)
  const latest = submitted.at(-1)!
  for (const change of [
    {state: 'failed', details: {...latest.details, state: 'failed'}},
    {state: 'authoring', details: {...latest.details, state: 'authoring'}},
    {details: {...latest.details, attemptId: 2}},
    {details: {...latest.details, attemptId: undefined}},
    {details: {...latest.details, details: {...details, summary: 'Different cause'}}},
    {details: {...latest.details, details: {...details, sourceRevision: 'e'.repeat(40)}}},
    {details: {...latest.details, details: {...details, prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/540'}}},
    {details: {...latest.details, details: {...details, requestId: 'different-verification'}}},
    {details: {...latest.details, details: {...details, resultUrl: 'https://admin.dev.mentraglass.com/?testRun=different'}}},
  ]) {
    const candidate = {...latest, ...change, eventId: 'changed-terminal', sequence: 16,
      details: {...(change.details ?? latest.details), sequence: 16}}
    await expect(f.service.status(candidate, row.hostId)).rejects.toThrow('Terminal')
  }
  expect(f.rows.get(row.workId)?.status?.sequence).toBe(15)
})

test('Mongo status compare-and-swap refuses a terminal outcome raced after the service inspection', async () => {
  const f = fixture(), row = await f.service.submit(input)
  const acceptance = {workId: row.workId, hostId: row.hostId, inputSha256: row.inputSha256,
    acceptedAt: '2026-10-05T10:01:00Z'}
  await f.service.accept(acceptance, row.hostId)
  const {acceptedAt: _, ...binding} = acceptance
  const event = routineWorkStatusSchema.parse({...binding, eventId: 'cancel13', sequence: 13, state: 'cancelled',
    details: {...acceptance, sequence: 13, state: 'cancelled', attemptId: 1, work: row.work,
      details: {summary: 'Operator stopped this fixture.'}, events: []}})
  await f.service.status(event, row.hostId)
  const candidate = routineWorkStatusSchema.parse({...event, eventId: 'custody14', sequence: 14,
    details: {...event.details, sequence: 14}})
  const chain = (read: () => unknown) => ({read() {return this}, readConcern() {return this}, lean: async () => read()})
  const find = spyOn(RoutineWorkModel, 'findOne').mockImplementation(() => chain(() => structuredClone(f.rows.get(row.workId))) as any)
  const update = spyOn(RoutineWorkModel, 'findOneAndUpdate').mockImplementation(((filter: any) => {
    expect(filter.status).toEqual(event)
    expect(filter['status.state']).toBeUndefined()
    // Another accepted write wins before this CAS: preserve its different identity.
    const concurrent = {...event, details: {...event.details, attemptId: 2}}
    f.rows.get(row.workId)!.status = concurrent
    expect(requestInputDigest(filter.status)).not.toBe(requestInputDigest(concurrent))
    return {lean: async () => null}
  }) as any)
  try {
    const service = new RoutineWorkService(undefined, undefined, undefined, {async publish() {}})
    await expect(service.status(candidate, row.hostId)).rejects.toThrow('stale')
    expect(f.rows.get(row.workId)?.status?.details.attemptId).toBe(2)
    expect(f.rows.get(row.workId)?.statusReceipts).toHaveLength(1)
  } finally {update.mockRestore(); find.mockRestore()}
})


test('recording verification has separate durable identity and preserves original terminal failure',async()=>{
 const f=fixture(),row=await f.service.submit(input)
 const accepted={workId:row.workId,inputSha256:row.inputSha256,hostId:row.hostId,acceptedAt:'2026-10-05T10:00:00.000Z'}
 await f.service.accept(accepted,row.hostId)
 const details={reason:'Recording response failed',summary:'Recording response failed',sourceRevision:'c'.repeat(40),requestId:'original-recorded-run',
  prUrl:'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601',review:{sourceRevision:'c'.repeat(40),
    prUrl:'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601',reviewUrl:'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601#pullrequestreview-21',verdict:'APPROVED'}}
 const {acceptedAt:_,...binding}=accepted
 const original=routineWorkStatusSchema.parse({...binding,eventId:'failed',sequence:4,state:'failed',details:{...accepted,work:row.work,attemptId:2,
  state:'failed',sequence:4,details,events:[{eventId:'failed',sequence:4,state:'failed',at:'2026-10-05T11:00:00.000Z',details}]}})
 await f.service.status(original,row.hostId)
 const identity={decisionId:'recording-retry',inputSha256:'d'.repeat(64),failureEventId:original.eventId,failureSha256:requestInputDigest(original),
  acceptedAt:'2026-10-05T11:01:00.000Z',deadline:'2026-10-05T11:31:00.000Z',previousFailure:{code:'recording-response',reason:details.reason}}
 const event=routineWorkStatusSchema.parse({...original,eventId:'recording-retry',sequence:5,state:'verifying',details:{...original.details,state:'verifying',sequence:5,
  details:{...details,summary:'Verify original recording'},events:[...original.details.events,{eventId:'recording-retry',sequence:5,state:'verifying',at:'2026-10-05T11:01:00.003Z',details}]}})
 await expect(f.service.status(event,row.hostId)).rejects.toThrow('Terminal')
 expect(await f.service.verifyRecording({identity,event},row.hostId)).toEqual(event)
 expect(await f.service.verifyRecording({identity,event},row.hostId)).toEqual(event)
 expect(f.rows.get(row.workId)?.status).toEqual(original)
 expect(f.rows.get(row.workId)?.verification?.status).toEqual(event)
 for(const change of [{failureSha256:'e'.repeat(64)},{decisionId:'other'},{deadline:'2026-10-05T11:32:00.000Z'}])
  await expect(f.service.verifyRecording({identity:{...identity,...change},event},row.hostId)).rejects.toThrow()
 for(const key of ['sourceRevision','requestId','review'] as const){
  const altered=structuredClone(event);(altered.details.details as any)[key]=key==='review'?{...details.review,sourceRevision:'e'.repeat(40)}:'other'
  await expect(f.service.verifyRecording({identity,event:altered},row.hostId)).rejects.toThrow()
 }
 const final=routineWorkStatusSchema.parse({...event,eventId:'verification-failed',sequence:6,state:'failed',details:{...event.details,state:'failed',sequence:6,
  events:[...event.details.events,{eventId:'verification-failed',sequence:6,state:'failed',at:'2026-10-05T11:02:00.000Z',details}]}})
 expect(await f.service.verifyRecording({identity,event:final},row.hostId)).toEqual(final)
 await expect(f.service.verifyRecording({identity,event:{...event,eventId:'reopen',sequence:7,details:{...event.details,sequence:7}}},row.hostId)).rejects.toThrow('terminal')
 expect(f.rows.get(row.workId)?.status).toEqual(original)
})

test('pre-admission verification retains the failed status and admits only its original ordered authenticated retry',async()=>{
 const f=fixture(),row=await f.service.submit(input)
 const accepted={workId:row.workId,inputSha256:row.inputSha256,hostId:row.hostId,acceptedAt:'2026-10-05T10:00:00.000Z'}
 await f.service.accept(accepted,row.hostId)
 const details={reason:'Selected app microphone permission is missing',summary:'Original unadmitted candidate failed',sourceRevision:'c'.repeat(40),
  prUrl:'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601',review:{sourceRevision:'c'.repeat(40),
   prUrl:'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601',reviewUrl:'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601#pullrequestreview-21',verdict:'APPROVED'}}
 const {acceptedAt:_,...binding}=accepted
 const original=routineWorkStatusSchema.parse({...binding,eventId:'permission-failed',sequence:4,state:'failed',details:{...accepted,work:row.work,attemptId:2,
  state:'failed',sequence:4,details,events:[{eventId:'permission-failed',sequence:4,state:'failed',at:'2026-10-05T11:00:00.000Z',details}]}})
 await f.service.status(original,row.hostId)
 const requestId='local:1792177290232:original-candidate',identity={decisionId:'admission-retry',inputSha256:'d'.repeat(64),
  failureEventId:original.eventId,failureSha256:requestInputDigest(original),acceptedAt:'2026-10-05T11:01:00.000Z',deadline:'2026-10-05T11:31:00.000Z',
  previousFailure:{code:'permission-required',reason:details.reason},admission:{requestId,originalAdmissionExpiresAt:1792177290232}}
 const event=routineWorkStatusSchema.parse({...original,eventId:identity.decisionId,sequence:5,state:'awaiting-installation',details:{...original.details,
  state:'awaiting-installation',sequence:5,details:{...details,requestId,summary:'Prepare original candidate with fresh permissions'},
  events:[...original.details.events,{eventId:identity.decisionId,sequence:5,state:'awaiting-installation',at:'2026-10-05T11:01:00.002Z',details}]}})
 let registered=false,reads=0
 const service=new ActualRoutineWorkService((f.service as any).rows,undefined,undefined,{async publish(){}},undefined,undefined,null,
  async id=>{expect(id).toBe(requestId);reads++;return registered})
 registered=true;await expect(service.verifyRecording({identity,event},row.hostId)).rejects.toThrow('unregistered');registered=false
 const futureIdentity={...identity,acceptedAt:new Date(Date.now()+60000).toISOString(),deadline:new Date(Date.now()+1800000).toISOString()}
 const futureEvent=structuredClone(event);futureEvent.details.events.at(-1)!.at=futureIdentity.acceptedAt
 await expect(service.verifyRecording({identity:futureIdentity,event:futureEvent},row.hostId)).rejects.toThrow('future')
 for(const altered of [{...event,state:'passed'},{...event,hostId:'other'},{...event,sequence:4},
  {...event,details:{...event.details,attemptId:3}},{...event,details:{...event.details,details:{...event.details.details,requestId:'other'}}}])
  await expect(service.verifyRecording({identity,event:altered},row.hostId)).rejects.toThrow()
 for(const changed of [{failureSha256:'e'.repeat(64)},{admission:{...identity.admission,originalAdmissionExpiresAt:1}},
  {previousFailure:{code:'recording-response',reason:details.reason}}])
  await expect(service.verifyRecording({identity:{...identity,...changed},event},row.hostId)).rejects.toThrow()
 expect(await service.verifyRecording({identity,event},row.hostId)).toEqual(event)
 registered=true;const readCount=reads;expect(await service.verifyRecording({identity,event},row.hostId)).toEqual(event);expect(reads).toBe(readCount)
 expect(f.rows.get(row.workId)?.status).toEqual(original)
 await expect(service.verifyRecording({identity:{...identity,decisionId:'replaced-retry'},event},row.hostId)).rejects.toThrow('identity')
 const cancelled=routineWorkStatusSchema.parse({...event,eventId:'retry-cancelled',sequence:6,state:'cancelled',details:{...event.details,
  state:'cancelled',sequence:6,events:[...event.details.events,{eventId:'retry-cancelled',sequence:6,state:'cancelled',at:'2026-10-05T11:02:00.000Z',details}]}})
 expect(await service.verifyRecording({identity,event:cancelled},row.hostId)).toEqual(cancelled)
 await expect(service.verifyRecording({identity,event:{...event,eventId:'reopen-cancelled',sequence:7,details:{...event.details,sequence:7}}},row.hostId)).rejects.toThrow('terminal')
 expect(f.rows.get(row.workId)?.status).toEqual(original)
 f.rows.get(row.workId)!.fleetCancellation={requestedAt:'2026-10-05T11:03:00.000Z',reason:'Cancel work'}
 await expect(service.verifyRecording({identity,event},row.hostId)).rejects.toThrow('uncancelled')
})
