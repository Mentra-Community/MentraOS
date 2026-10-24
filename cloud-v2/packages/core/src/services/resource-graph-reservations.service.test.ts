import {expect, test} from 'bun:test'
import {isDeepStrictEqual} from 'node:util'
import {backendCandidateFixture} from './backend-candidate-preparation.test-support'
import {candidatePrerequisiteRequestMatches, graphCandidateClaimMatches, graphCandidateReturnMatches, graphCheckOperationId} from './backend-candidate-preparation'
import {ResourceReservationsService, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import {requestInputDigest} from './test-request.service'
import {exclusiveResourceIntentSchema, exclusiveResourceReturnSchema, type ExclusiveHostReservation, type ExclusiveResourceReturn} from '../types/resource-reservations.types'

/** Real service and existing host-row CAS; provider observations are inert fixtures. */
async function graphAuthorityFixture() {
  const f = backendCandidateFixture(), versions = new Map<string, number>(), writes: string[][] = []
  for (const host of f.hosts) {
    host.resourceReservations!.resourceReadiness = true
    host.frameworkAcceptedAt = host.observedAt
    host.frameworkProcess = {pid: 100, startedAt: 'cpu-only-current-controller'}
    const previous = host.resourceLifecycle!.subjects[0]!
    host.resourceLifecycle!.subjects = host.lanes[0]!.resources.filter(ref => ref.kind !== 'network').map(ref => {
      ref.idleContract = {version: `${ref.kind}-baseline`, maximumAgeMs: 120_000, conditions: ['physical-baseline'], dependencies: [],
        repairConfigured: true, qualifiedScope: {kind: 'same-controller', controllerId: host.hostId}}
      return {...structuredClone(previous), subject: {kind: 'resource', id: ref.id, authorityHostId: host.hostId},
        supportedActions: ['mark-out-of-service'], idle: {...previous.idle, contractVersion: ref.idleContract.version},
        resource: {kind: ref.kind, capabilities: ref.capabilities ?? [], memberships: [{hostId: host.hostId, laneId: 'android'}],
          dependencies: [], placement: 'installed'}}
    })
    versions.set(host.hostId, 0)
  }
  await f.service.preparation('job-one')
  const pending = f.row.fleetCandidatePreparation!, purpose = pending.target.purpose
  if (purpose?.kind !== 'resource-readiness') throw Error('Expected the real graph candidate')
  const members = purpose.resources
  const host = f.hosts.find(value => value.hostId === pending.hostId)!, target = {schemaVersion: 1 as const, coreUrl: 'https://core.example/'},
    intent = exclusiveResourceIntentSchema.parse({operationId: `graph-prerequisite:${pending.targetInputSha256}`, hostId: host.hostId,
      laneId: pending.laneId, controller: {...pending.candidate.controller, sequence: host.sequence},
      owner: {kind: 'boundary-cleanup', id: `resource-graph:${pending.targetInputSha256}`}, inputSha256: pending.targetInputSha256,
      prerequisite: {...purpose, jobId: f.row.requestId, targetInputSha256: pending.targetInputSha256,
        binding: pending.target.acceptedBinding, candidate: pending.candidate, target},
      resources: purpose.resources.map(member => ({id: member.id, capabilities: ['resource-idle']}))})
  const rows: ResourceReservationRepository = {
    async get(id) {
      const value = f.hosts.find(value => value.hostId === id)
      const snapshot = value && (({receivedAt: _, authorityReservations: __, ...snapshot}) => snapshot)(value)
      return value ? {hostId: id, incarnation: value.incarnation, incarnationGeneration: value.incarnationGeneration, sequence: value.sequence,
        receivedAt: new Date(value.receivedAt), snapshot: structuredClone(snapshot), resourceReservationVersion: versions.get(id)!,
        resourceReservations: structuredClone(value.authorityReservations), laneControlVersion: 0, laneControls: []} as ResourceReservationHost : null
    },
    async request(id) {return id === f.row.requestId ? structuredClone(f.row) : null},
    async candidateRequest(id, digest) {return id === pending.hostId && digest === pending.targetInputSha256 ? structuredClone(f.row) : null},
    async replace(previous, claims) {
      const actual = f.hosts.find(value => value.hostId === previous.hostId)!
      if (previous.sequence !== actual.sequence || previous.incarnation !== actual.incarnation ||
        previous.incarnationGeneration !== actual.incarnationGeneration || previous.resourceReservationVersion !== versions.get(actual.hostId)) return false
      actual.authorityReservations = structuredClone(claims); versions.set(actual.hostId, versions.get(actual.hostId)! + 1)
      writes.push(claims.map(value => 'resourceId' in value ? value.resourceId : value.id)); return true
    },
    async replaceBackend(previous, claims, original, now) {
      if (!candidatePrerequisiteRequestMatches(f.row, original, now.getTime())) return false
      f.row.fleetCandidatePreparation!.backendTarget = original.prerequisite!.target
      return this.replace(previous, claims)
    },
    async recordCandidateClaim(_id, original, claim) {
      if (!isDeepStrictEqual(original, f.row.fleetCandidatePreparation) || !graphCandidateClaimMatches(original, claim)) return false
      const before = original.resourceClaims ?? [], same = before.find(value => (value as ExclusiveHostReservation).resourceId === claim.resourceId)
      if (same) return isDeepStrictEqual(same, claim)
      f.row.fleetCandidatePreparation!.resourceClaims = [...before, structuredClone(claim)]; return true
    },
    async recordCandidateReturn(_id, original, returned) {
      if (!isDeepStrictEqual(original, f.row.fleetCandidatePreparation) || !graphCandidateReturnMatches(original, returned)) return false
      const proof = exclusiveResourceReturnSchema.parse(returned), before = original.resourceReturns ?? [],
        same = before.find(value => (value as ExclusiveResourceReturn).resourceId === proof.resourceId)
      if (same) return isDeepStrictEqual(same, returned)
      f.row.fleetCandidatePreparation!.resourceReturns = [...before, structuredClone(returned)]; return true
    },
    async recordCandidateNoAcquisition(_id, original, receipt) {
      if (!isDeepStrictEqual(original, f.row.fleetCandidatePreparation)) return false
      f.row.fleetCandidatePreparation!.noAcquisitionReceipt = structuredClone(receipt); return true
    },
  }
  const service = new ResourceReservationsService(rows, () => f.now)
  function closedReturns(claims: ExclusiveHostReservation[], negative = false) {
    f.advance(1); host.sequence++; const at = new Date(f.now).toISOString()
    const returned = claims.map(claim => {
      const member = members.find(member => member.id === claim.resourceId)!,
        operationId = graphCheckOperationId(pending.targetInputSha256, member.id),
        subject = host.resourceLifecycle!.subjects.find(value => value.subject.id === member.id)!, generation = subject.generation + 3,
        eventId = `resource-lifecycle:${requestInputDigest({id: member.id, subjectGeneration: generation})}`
      subject.generation = generation; subject.owner = null; subject.status = negative && member.kind === 'phone' ? 'in-repair' : 'idle'
      subject.idle.outcome = negative && member.kind === 'phone' ? 'failed' : 'passed'; subject.idle.checkedAt = at
      subject.idle.acceptedCheck = {operationId, subjectGeneration: generation, resultSha256: 'a'.repeat(64), acceptedAt: at}
      host.resourceLifecycle!.history.push({id: eventId, resourceId: member.id, subjectGeneration: generation, event: 'resource-check-released',
        checkOperationId: operationId, ownerId: intent.owner.id, at})
      return {claimId: claim.id, authorityHostId: host.hostId, resourceId: member.id, intentSha256: claim.intentSha256,
        inputSha256: claim.inputSha256, originalOwner: claim.owner, laneId: pending.laneId,
        controller: {...pending.candidate.controller, sequence: host.sequence}, release: {kind: 'resource-check' as const,
          operationId, subjectGeneration: generation, releasedAt: at, eventId}}
    })
    host.resourceReservations!.returns = returned.map(({controller: _, ...proof}) => proof)
    return returned
  }
  return {f, host, pending, purpose, intent, rows, service, writes, closedReturns}
}

test('one original graph acquires all members atomically and recovers identical custody after cancellation', async () => {
  const f = await graphAuthorityFixture(), first = await f.service.acquire(f.intent, f.host.hostId)
  expect(first.status).toBe('reserved'); expect(first.claims).toHaveLength(f.purpose.resources.length); expect(f.writes).toHaveLength(1)
  expect(f.f.row.fleetCandidatePreparation!.resourceClaims).toEqual(first.claims)
  f.f.row.fleetCancellation = {requestedAt: new Date(f.f.now).toISOString(), reason: 'Original cancellation'}
  expect(await f.service.acquire(f.intent, f.host.hostId)).toEqual(first)
  expect(f.writes).toHaveLength(1); expect(f.host.resourceLifecycle!.subjects.every(subject => subject.owner === null)).toBe(true)
})

test('normal graph returns retire exact members even with a real negative and keep all other original claims', async () => {
  const f = await graphAuthorityFixture(), acquired = await f.service.acquire(f.intent, f.host.hostId)
  const returned = f.closedReturns(acquired.claims as ExclusiveHostReservation[], true)
  for (const [index, proof] of returned.entries()) {
    expect((await f.service.giveBack(proof, f.host.hostId)).status).toBe('returned')
    expect(f.host.authorityReservations).toHaveLength(returned.length - index - 1)
  }
  expect(f.f.row.fleetCandidatePreparation!.resourceReturns).toEqual(returned)
  expect(f.host.resourceLifecycle!.subjects.find(subject => subject.resource.kind === 'phone')!.idle.outcome).toBe('failed')
  expect(f.f.row.fleetBinding).toBeUndefined()
})

test.each(['missing-event', 'changed-generation', 'live-owner', 'foreign-claim'] as const)('graph return preserves custody for %s', async changed => {
  const f = await graphAuthorityFixture(), acquired = await f.service.acquire(f.intent, f.host.hostId),
    returned = f.closedReturns(acquired.claims as ExclusiveHostReservation[]), proof = returned[0]!,
    subject = f.host.resourceLifecycle!.subjects.find(value => value.subject.id === proof.resourceId)!
  if (changed === 'missing-event') f.host.resourceLifecycle!.history = []
  if (changed === 'changed-generation') subject.generation++
  if (changed === 'live-owner') subject.owner = {hostId: f.host.hostId, kind: 'fixer', id: 'original-live-reader', generation: 5}
  if (changed === 'foreign-claim') (f.host.authorityReservations![0] as ExclusiveHostReservation).id = '20000000-0000-4000-8000-000000000001'
  const before = structuredClone(f.host.authorityReservations)
  await expect(f.service.giveBack(proof, f.host.hostId)).rejects.toThrow()
  expect(f.host.authorityReservations).toEqual(before); expect(f.f.row.fleetCandidatePreparation!.resourceReturns).toBeUndefined()
})

test('an original never-acquired graph receives a current whole-generation absence fence without any new claim', async () => {
  const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
  const observed = await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
  expect(observed.status).toBe('not-acquired'); expect(observed.claims).toEqual([])
  expect('fence' in observed && 'subjects' in observed.fence && observed.fence.subjects).toEqual(f.purpose.resources.map(member => ({resourceId: member.id, subjectGeneration: member.subjectGeneration})))
  expect(f.host.authorityReservations).toEqual([]); expect(f.f.row.fleetCandidatePreparation!.noAcquisitionReceipt).toBeDefined()
})

test.each(['producer-absent', 'original-generation', 'new-dependency', 'operator-withdrawal', 'cancelled'] as const)(
  'graph acquisition refuses %s before any claim CAS', async changed => {
    const f = await graphAuthorityFixture()
    if (changed === 'producer-absent') delete f.host.resourceReservations!.resourceReadiness
    if (changed === 'original-generation') f.host.resourceLifecycle!.subjects[0]!.generation++
    if (changed === 'new-dependency') f.host.lanes[0]!.resources[0]!.idleContract!.dependencies = ['missing-physical-peer']
    if (changed === 'operator-withdrawal') f.host.resourceLifecycle!.subjects[0]!.status = 'out-of-service'
    if (changed === 'cancelled') f.f.row.fleetCancellation = {requestedAt: new Date(f.f.now).toISOString(), reason: 'Original cancellation'}
    expect((await f.service.acquire(f.intent, f.host.hostId)).status).toBe('unknown')
    expect(f.writes).toEqual([]); expect(f.host.authorityReservations).toEqual([])
  })
