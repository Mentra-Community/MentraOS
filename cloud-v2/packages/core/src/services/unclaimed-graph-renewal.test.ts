import {expect, test} from 'bun:test'
import {exclusiveResourceIntentSchema} from '../types/resource-reservations.types'
import {candidateRenewal, candidateSettlement, graphCandidateHistoricalSettlement} from './backend-candidate-preparation'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {requestInputDigest} from './test-request.service'

async function closedUnclaimedGraph(kind: 'never-requested' | 'not-acquired' = 'never-requested') {
  const f = routingGraphFixture()
  await f.prepareLegacy(f.row.requestId)
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
  test(`a closed ${kind} original reserves its current passed baseline${restarted ? ' after a compatible restart' : ''} without another qualification`, async () => {
    const {f, host, previous, original} = await closedUnclaimedGraph(kind)
    if (restarted) {
      host.incarnation = 'accepted-new-controller'; host.incarnationGeneration++
      host.frameworkBinding = {...host.frameworkBinding!, version: host.frameworkBinding!.version + 1,
        installationId: 'accepted-new-installation', runtimeSha256: 'e'.repeat(64)}
    }
    await f.prepareLegacy(f.row.requestId)
    expect(f.bindWrites).toBe(0); await f.bindReady(host.hostId)
    expect(f.row.fleetCandidatePreparation).toBeUndefined()
    expect(f.row.fleetResourceReservation?.hostId).toBe(host.hostId)
    expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
    expect(f.row.fleetCandidatePreparations![0]!.settlement!.outcome).toBe('unknown')
    expect(f.row.fleetBinding?.hostId).toBe(host.hostId); expect(f.bindWrites).toBe(1); expect(f.writes).toBe(1)
    for (const key of ['requestId', 'fleetSelection', 'fleetSelectionSha256', 'fleetPreparation', 'fleetInputSha256', 'fleetDeadline'] as const)
      expect(f.row[key]).toEqual(original[key])
    expect(previous.target.deadline).toBe(original.fleetDeadline.toISOString())
  })
}

for (const gap of ['unclosed', 'missing-proof', 'partial-claim', 'partial-return', 'unanswered-acquisition', 'provisional',
  'wrong-parent', 'wrong-candidate', 'wrong-target', 'cancelled', 'bound', 'exclusive-execution'] as const)
test(`historical UNKNOWN continuation classification preserves the ${gap} fence`, async () => {
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
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  expect(f.row.fleetCandidatePreparations).toEqual(before.fleetCandidatePreparations)
  expect(f.bindWrites).toBe(0)
})

for (const gap of ['expired', 'incompatible-binding', 'resource-owner', 'resource-repair', 'current-claim', 'pending-original'] as const)
test(`current baseline allocation preserves ${gap} refusal after a closed original`, async () => {
  const {f, host, previous, original} = await closedUnclaimedGraph()
  if (gap === 'expired') f.advance(300_000)
  if (gap === 'incompatible-binding') host.frameworkBinding!.routineApiVersion = 0
  if (gap === 'resource-owner') host.resourceLifecycle!.subjects[0]!.owner = {id: 'actual-owner', kind: 'boundary-cleanup', hostId: host.hostId, generation: 2}
  if (gap === 'resource-repair') host.resourceLifecycle!.subjects[0]!.repair.state = 'queued'
  if (gap === 'current-claim') host.authorityReservations = [{kind: 'exclusive', id: '10000000-0000-4000-8000-000000000001',
    resourceId: host.resourceLifecycle!.subjects[0]!.subject.id, authorityHostId: host.hostId, borrowerHostId: host.hostId, laneId: previous.laneId,
    operationId: 'run:foreign-original', intentSha256: 'e'.repeat(64), inputSha256: 'f'.repeat(64), owner: {kind: 'run', id: 'foreign-original'},
    controllerIncarnation: host.incarnation!, controllerGeneration: host.incarnationGeneration!, borrowerSequence: host.sequence!, reservedAt: new Date(f.now).toISOString()}]
  if (gap === 'pending-original') {
    f.row.fleetCandidatePreparation = {...structuredClone(previous), settlement: undefined, noAcquisitionReceipt: {status: 'unknown'}}
    host.resourceReservations!.candidatePrerequisites = []
  }
  const pending = structuredClone(f.row.fleetCandidatePreparation), claims = structuredClone(host.authorityReservations)
  await f.prepareLegacy(f.row.requestId)
  expect(f.row.fleetCandidatePreparation).toEqual(pending)
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
  expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
  expect(host.authorityReservations).toEqual(claims)
  expect(f.bindWrites).toBe(0); expect(f.row.fleetResourceReservation).toBeUndefined()
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
