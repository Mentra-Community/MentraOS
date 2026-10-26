import {expect, spyOn, test} from 'bun:test'
import {TestRequestModel} from '../models/test-request.model'
import {exclusiveResourceIntentSchema} from '../types/resource-reservations.types'
import {candidateRenewal, candidateSettlement, graphCandidateHistoricalSettlement} from './backend-candidate-preparation'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {routineJobRepository} from './routine-job.service'
import {requestInputDigest} from './test-request.service'

async function closedUnclaimedGraph(kind: 'never-requested' | 'not-acquired' = 'never-requested') {
  const f = routingGraphFixture()
  await f.service.preparation(f.row.requestId)
  const {pending, host, receipt} = f.settleNeverRequested()
  if (kind === 'not-acquired') {
    delete receipt.neverRequested
    const purpose = pending.target.purpose
    if (purpose?.kind !== 'resource-readiness') throw Error('Expected graph fixture')
    const intent = exclusiveResourceIntentSchema.parse({operationId: `graph-prerequisite:${pending.targetInputSha256}`,
      hostId: host.hostId, laneId: pending.laneId, controller: {...pending.candidate.controller, sequence: 1},
      owner: {kind: 'boundary-cleanup', id: `resource-graph:${pending.targetInputSha256}`}, inputSha256: pending.targetInputSha256,
      resources: purpose.resources.map(member => ({id: member.id, capabilities: ['resource-idle']})),
      prerequisite: {...purpose, jobId: pending.target.jobId, targetInputSha256: pending.targetInputSha256,
        binding: pending.target.acceptedBinding, candidate: pending.candidate}})
    pending.noAcquisitionReceipt = {intent, journal: structuredClone(pending.target), observation: {status: 'not-acquired', claims: [],
      intentSha256: requestInputDigest({...intent, controller: pending.candidate.controller,
        dependencies: purpose.resources.map(member => ({resourceId: member.id, authorityHostId: member.authorityHostId, capability: 'resource-idle'}))}),
      fence: {hostId: host.hostId, controller: {...pending.candidate.controller, sequence: 2}, resourceReservationVersion: 1,
        subjects: purpose.resources.map(member => ({resourceId: member.id, subjectGeneration: member.subjectGeneration}))}}}
  }
  const settlement = candidateSettlement(pending, host, [], f.now)
  expect(settlement).toEqual(receipt)
  await f.rows.settleCandidatePreparation!(f.row, {...pending, settlement}, new Date(f.now))
  const original = structuredClone(f.row), previous = f.row.fleetCandidatePreparations![0]!
  f.hosts.splice(1)
  f.advance(1)
  for (const subject of host.resourceLifecycle!.subjects) {
    subject.generation += 10; subject.status = 'idle'; subject.idle.outcome = 'passed'; subject.idle.checkedAt = host.observedAt
    subject.idle.acceptedCheck = {operationId: `independent-return:${subject.subject.id}`, subjectGeneration: subject.generation,
      resultSha256: 'd'.repeat(64), acceptedAt: host.observedAt}
  }
  return {f, host, previous, original}
}

test('closed source preparation failure tries an untried eligible lane before unchanged renewal', async () => {
  const f = routingGraphFixture()
  await f.service.preparation(f.row.requestId)
  const first = f.row.fleetCandidatePreparation!
  const {pending, host} = f.settleNeverRequested()
  const settlement = candidateSettlement(pending, host, [], f.now)
  expect(settlement?.outcome).toBe('unknown')
  await f.rows.settleCandidatePreparation!(f.row, {...pending, settlement}, new Date(f.now))
  const original = structuredClone(f.row)
  f.advance(1)

  await f.service.preparation(f.row.requestId)
  const alternate = f.row.fleetCandidatePreparation!
  expect(alternate.hostId).not.toBe(first.hostId)
  expect(alternate.candidate.previousAttemptId).toBeUndefined()
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
  expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
  expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
  expect(f.bindWrites).toBe(0)

  f.settleGraph('qualified')
  await f.service.preparation(f.row.requestId)
  expect(f.row.fleetCandidateSelection?.hostId).toBe(alternate.hostId)
  expect(f.row.fleetResourceReservation?.hostId).toBe(alternate.hostId)
  expect(f.bindWrites).toBe(1)
  expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
  expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
})

test('unavailable untried lane does not prevent an operational original from renewing', async () => {
  const f = routingGraphFixture()
  await f.service.preparation(f.row.requestId)
  const {pending, host} = f.settleNeverRequested()
  await f.rows.settleCandidatePreparation!(f.row, {...pending,
    settlement: candidateSettlement(pending, host, [], f.now)}, new Date(f.now))
  f.hosts.find(value => value.hostId !== host.hostId)!.lanes[0]!.state = 'out-of-service'
  f.advance(1)
  await f.service.preparation(f.row.requestId)
  expect(f.row.fleetCandidatePreparation?.hostId).toBe(host.hostId)
  expect(f.row.fleetCandidatePreparation?.candidate.previousAttemptId).toBe(pending.candidate.attemptId)
  expect(f.bindWrites).toBe(0)
})

async function twoClosedUnclaimedLanes() {
  const f = routingGraphFixture(), previous = []
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.service.preparation(f.row.requestId)
    const {pending, host} = f.settleNeverRequested(), settlement = candidateSettlement(pending, host, [], f.now)
    expect(settlement?.outcome).toBe('unknown')
    await f.rows.settleCandidatePreparation!(f.row, {...pending, settlement}, new Date(f.now))
    previous.push(structuredClone(pending)); f.advance(1)
  }
  expect(previous[0]!.hostId).not.toBe(previous[1]!.hostId)
  return {f, previous}
}

test('both closed unclaimed lanes can recover the earlier available lane when the latest lane is unavailable', async () => {
  const {f, previous} = await twoClosedUnclaimedLanes(), first = previous[0]!, last = previous[1]!, original = structuredClone(f.row),
    available = f.hosts.find(host => host.hostId === first.hostId)!
  f.hosts.find(host => host.hostId === last.hostId)!.lanes[0]!.state = 'out-of-service'
  for (const subject of available.resourceLifecycle!.subjects) {
    subject.generation += 3; subject.status = 'idle'; subject.owner = null; subject.idle.outcome = 'passed'
    subject.idle.checkedAt = available.observedAt
    subject.idle.acceptedCheck = {operationId: `actual-current-check:${subject.subject.id}`, subjectGeneration: subject.generation,
      resultSha256: 'd'.repeat(64), acceptedAt: available.observedAt}
  }
  let writes = 0
  const write = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any, update: any) => {
    expect(filter.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
    expect(filter.fleetCandidatePreparation).toEqual({$exists: false})
    expect(filter.fleetBinding).toEqual({$exists: false})
    expect(filter.fleetCancellation).toEqual({$exists: false})
    expect(filter.fleetDeadline.$gt.getTime()).toBe(f.now)
    writes++; f.row = {...f.row, fleetCandidatePreparation: structuredClone(update.$set.fleetCandidatePreparation)}
    return structuredClone(f.row) as any
  })
  f.rows.candidatePreparation = routineJobRepository.candidatePreparation
  try {
    await f.service.preparation(f.row.requestId)
    const next = f.row.fleetCandidatePreparation!
    expect(next).toBeDefined()
    expect(next.hostId).toBe(first.hostId)
    expect(next.candidate.previousAttemptId).toBe(first.candidate.attemptId)
    expect(next.targetInputSha256).not.toBe(first.targetInputSha256)
    expect(next.target.acceptedBinding).toEqual(available.frameworkBinding)
    expect(next.candidate.controller).toEqual({incarnation: available.incarnation, generation: available.incarnationGeneration})
    expect(next.target.deadline).toBe(original.fleetDeadline.toISOString())
    expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
    expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
    expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
    expect(writes).toBe(1); expect(f.bindWrites).toBe(0)
  } finally {write.mockRestore()}
})

test('closed unclaimed renewal keeps least-attempt ordering and each lane latest predecessor', async () => {
  const {f, previous} = await twoClosedUnclaimedLanes(), original = structuredClone(f.row)
  await f.service.preparation(f.row.requestId)
  const renewed = f.row.fleetCandidatePreparation!
  expect(renewed.hostId).toBe(previous[0]!.hostId)
  expect(renewed.candidate.previousAttemptId).toBe(previous[0]!.candidate.attemptId)
  const {pending, host} = f.settleNeverRequested()
  await f.rows.settleCandidatePreparation!(f.row, {...pending, settlement: candidateSettlement(pending, host, [], f.now)}, new Date(f.now))
  f.advance(1)
  expect(candidateRenewal(f.row, renewed.hostId, renewed.laneId)?.candidate.attemptId).toBe(renewed.candidate.attemptId)
  await f.service.preparation(f.row.requestId)
  const next = f.row.fleetCandidatePreparation!
  expect(next.hostId).toBe(previous[1]!.hostId)
  expect(next.candidate.previousAttemptId).toBe(previous[1]!.candidate.attemptId)
  expect(f.row.fleetCandidatePreparations).toHaveLength(3)
  expect(f.row.fleetCandidatePreparations!.slice(0, 2)).toEqual(original.fleetCandidatePreparations!)
  expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
  expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
  expect(f.bindWrites).toBe(0)
})

test('renewal cannot skip a newer same-lane UNKNOWN attempt with real claims and completed checks', async () => {
  const {f, previous} = await twoClosedUnclaimedLanes()
  await f.service.preparation(f.row.requestId)
  const pending = f.row.fleetCandidatePreparation!, host = f.hosts.find(value => value.hostId === pending.hostId)!
  f.settleGraph('unknown')
  const settlement = candidateSettlement(pending, host, [], f.now)
  expect(settlement?.outcome).toBe('unknown')
  expect(pending.resourceClaims!.length).toBeGreaterThan(0)
  expect(settlement!.graphChecks!.length).toBeGreaterThan(0)
  await f.rows.settleCandidatePreparation!(f.row, {...pending, settlement}, new Date(f.now))
  f.hosts.find(value => value.hostId === previous[1]!.hostId)!.lanes[0]!.state = 'out-of-service'
  const original = structuredClone(f.row); f.advance(1)
  expect(candidateRenewal(f.row, pending.hostId, pending.laneId)).toBeUndefined()
  await f.service.preparation(f.row.requestId)
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
  expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
  expect(f.bindWrites).toBe(0)
})

for (const kind of ['never-requested', 'not-acquired'] as const) {
  test(`genuine ${kind} closed UNKNOWN history permits same-lane renewal, never execution`, async () => {
    const {f, previous} = await closedUnclaimedGraph(kind)
    expect(graphCandidateHistoricalSettlement(previous)).toBe(true)
    expect(candidateRenewal(f.row, previous.hostId, previous.laneId)?.candidate.attemptId).toBe(previous.candidate.attemptId)
    expect(previous.settlement!.outcome).toBe('unknown')
    expect(f.row.fleetCandidateSelection).toBeUndefined()
    expect(f.bindWrites).toBe(0)
  })

  for (const restarted of [false, true])
  test(`real service renews ${kind} on current resources${restarted ? ' after a compatible restart' : ''} with the original request CAS and deadline`, async () => {
    const {f, host, previous, original} = await closedUnclaimedGraph(kind)
    if (restarted) {
      host.incarnation = 'accepted-new-controller'; host.incarnationGeneration++
      host.frameworkBinding = {...host.frameworkBinding!, version: host.frameworkBinding!.version + 1,
        installationId: 'accepted-new-installation', runtimeSha256: 'e'.repeat(64)}
    }
    let writes = 0
    const write = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any, update: any) => {
      expect(filter.requestId).toBe(original.requestId)
      expect(filter.fleetInputSha256).toBe(original.fleetInputSha256)
      expect(filter.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
      expect(filter.fleetCandidatePreparation).toEqual({$exists: false})
      expect(filter.fleetBinding).toEqual({$exists: false})
      expect(filter.fleetCancellation).toEqual({$exists: false})
      expect(filter.fleetDeadline.$gt.getTime()).toBe(f.now)
      writes++
      f.row = {...f.row, fleetCandidatePreparation: structuredClone(update.$set.fleetCandidatePreparation)}
      return structuredClone(f.row) as any
    })
    f.rows.candidatePreparation = routineJobRepository.candidatePreparation
    try {
      await f.service.preparation(f.row.requestId)
      const current = f.row.fleetCandidatePreparation!
      expect(current).toBeDefined()
      expect(current.candidate.previousAttemptId).toBe(previous.candidate.attemptId)
      expect(current.targetInputSha256).not.toBe(previous.targetInputSha256)
      expect(current.target.jobId).toBe(original.requestId)
      expect(current.candidate.controller).toEqual({incarnation: host.incarnation, generation: host.incarnationGeneration})
      expect(current.target.acceptedBinding).toEqual(host.frameworkBinding)
      expect(current.target.deadline).toBe(original.fleetDeadline.toISOString())
      expect(current.target.selection).toEqual({...original.fleetSelection, routineSource: original.fleetPreparation!.routineSource})
      expect(current.target.purpose?.kind).toBe('resource-readiness')
      if (current.target.purpose?.kind === 'resource-readiness')
        expect(current.target.purpose.resources.map(member => member.subjectGeneration)).toEqual(
          current.target.purpose.resources.map(member => host.resourceLifecycle!.subjects.find(subject => subject.subject.id === member.id)!.generation))
      expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
      expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
      expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
      expect(writes).toBe(1); expect(f.bindWrites).toBe(0)
    } finally {write.mockRestore()}
  })
}

for (const gap of ['unclosed', 'missing-proof', 'partial-claim', 'partial-return', 'unanswered-acquisition', 'provisional',
  'wrong-parent', 'wrong-candidate', 'wrong-target', 'cancelled', 'bound', 'exclusive-execution'] as const)
test(`UNKNOWN renewal preserves the existing fence with ${gap}`, async () => {
  const {f, previous} = await closedUnclaimedGraph()
  if (gap === 'unclosed') delete previous.settlement
  if (gap === 'missing-proof') delete previous.settlement!.neverRequested
  if (gap === 'partial-claim') previous.resourceClaims = [{id: 'unresolved-original'}]
  if (gap === 'partial-return') previous.resourceReturns = [{claimId: 'unresolved-original'}]
  if (gap === 'unanswered-acquisition') previous.noAcquisitionReceipt = {status: 'unknown'}
  if (gap === 'provisional') previous.provisionalReturn = {recorder: {id: 'unresolved'} as any}
  if (gap === 'wrong-parent') previous.settlement!.checkOperationId += '-foreign'
  if (gap === 'wrong-candidate') previous.settlement!.candidate = {...previous.candidate, attemptId: 'foreign'}
  if (gap === 'wrong-target') previous.settlement!.targetInputSha256 = 'f'.repeat(64)
  if (gap === 'cancelled') f.row.fleetCancellation = {requestedAt: new Date(f.now).toISOString(), reason: 'Cancelled original'}
  if (gap === 'bound') f.row.hostId = previous.hostId
  if (gap === 'exclusive-execution') f.row.fleetExclusiveExecutionBinding = {} as any
  const before = structuredClone(f.row)
  expect(candidateRenewal(f.row, previous.hostId, previous.laneId)).toBeUndefined()
  await f.service.preparation(f.row.requestId)
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  expect(f.row.fleetCandidatePreparations).toEqual(before.fleetCandidatePreparations)
  expect(f.bindWrites).toBe(0)
})

for (const gap of ['expired', 'incompatible-binding', 'controller-race', 'binding-race', 'resource-owner', 'resource-repair', 'concurrent-request'] as const)
test(`real service refuses unclaimed renewal after ${gap}`, async () => {
  const {f, host, original} = await closedUnclaimedGraph()
  if (gap === 'expired') f.advance(300_000)
  if (gap === 'incompatible-binding') host.frameworkBinding!.routineApiVersion = 0
  if (gap === 'controller-race' || gap === 'binding-race') {
    const hosts = (f.service as any).hosts, get = hosts.get.bind(hosts)
    let reads = 0
    hosts.get = async (id: string) => {
      const current = await get(id)
      if (++reads > 1 && current) {
        if (gap === 'controller-race') current.incarnation = 'different-controller'
        else current.frameworkBinding.runtimeSha256 = 'e'.repeat(64)
      }
      return current
    }
  }
  if (gap === 'resource-owner') host.resourceLifecycle!.subjects[0]!.owner = {id: 'actual-owner', kind: 'boundary-cleanup', hostId: host.hostId, generation: 2}
  if (gap === 'resource-repair') host.resourceLifecycle!.subjects[0]!.repair.state = 'queued'
  const write = gap === 'concurrent-request' ? spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any) => {
    expect(filter.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
    expect(filter.fleetCandidatePreparation).toEqual({$exists: false})
    return null as any
  }) : undefined
  if (write) f.rows.candidatePreparation = routineJobRepository.candidatePreparation
  try {
    await f.service.preparation(f.row.requestId)
    expect(f.row.fleetCandidatePreparation).toBeUndefined()
    expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
    expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
    expect(f.bindWrites).toBe(0)
    if (write) expect(write).toHaveBeenCalledTimes(1)
  } finally {write?.mockRestore()}
})

for (const gap of ['unanswered', 'partial-claim', 'foreign-controller', 'incomplete-fence'] as const)
test(`unclaimed renewal refuses an invalid not-acquired proof with ${gap}`, async () => {
  const {f, previous} = await closedUnclaimedGraph('not-acquired')
  const saved = previous.noAcquisitionReceipt as any
  if (gap === 'unanswered') saved.observation.status = 'unknown'
  if (gap === 'partial-claim') saved.observation.claims = [{id: 'unresolved'}]
  if (gap === 'foreign-controller') saved.observation.fence.controller.incarnation = 'other-controller'
  if (gap === 'incomplete-fence') saved.observation.fence.subjects.pop()
  expect(candidateRenewal(f.row, previous.hostId, previous.laneId)).toBeUndefined()
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  expect(f.bindWrites).toBe(0)
})
