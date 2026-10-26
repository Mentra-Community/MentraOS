import {expect, test, spyOn} from 'bun:test'
import {isDeepStrictEqual} from 'node:util'
import {backendCandidateFixture} from './backend-candidate-preparation.test-support'
import {candidatePrerequisiteRequestMatches, candidateSettlement, graphCandidateClaimMatches, graphCandidateReturnMatches, graphCandidateHistoricalSettlement, graphCheckOperationId} from './backend-candidate-preparation'
import {ResourceReservationsService, resourceReservationRepository, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import {TestRequestModel} from '../models/test-request.model'
import {TestHostStateService} from './test-host-state.service'
import {routineJobRepository} from './routine-job.service'
import {requestInputDigest} from './test-request.service'
import {exclusiveResourceIntentSchema, exclusiveResourceReturnSchema, type ExclusiveHostReservation, type ExclusiveResourceReturn} from '../types/resource-reservations.types'

/** Real service and existing host-row CAS; provider observations are inert fixtures. */
async function graphAuthorityFixture() {
  const f = backendCandidateFixture(), versions = new Map<string, number>(), writes: string[][] = [],
    framework: {history?: unknown[]; stops?: unknown[]} = {}
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
        resourceReservations: structuredClone(value.authorityReservations), laneControlVersion: 0, laneControls: [],
        frameworkHistory: structuredClone(framework.history), frameworkStopReceipts: structuredClone(framework.stops)} as ResourceReservationHost : null
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
      if (original.noAcquisitionReceipt) {const saved = original.noAcquisitionReceipt as {intent: unknown; journal: unknown}
        return isDeepStrictEqual(saved.intent, receipt.intent) && isDeepStrictEqual(saved.journal, receipt.journal)}
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
  return {f, host, pending, purpose, intent, rows, service, writes, closedReturns, framework}
}

async function successorReturns() {
  const g = await graphAuthorityFixture(), acquired = await g.service.acquire(g.intent, g.host.hostId)
  if (acquired.status !== 'reserved') throw Error('Original graph was not acquired')
  const original = {binding: structuredClone(g.host.frameworkBinding!), incarnation: g.host.incarnation!,
    incarnationGeneration: g.host.incarnationGeneration!, process: structuredClone(g.host.frameworkProcess!),
    effectiveAt: g.host.frameworkAcceptedAt!, observedAt: g.host.observedAt}
  g.f.advance(1)
  const stopped = {installationId: original.binding.installationId, process: original.process, observedAt: new Date(g.f.now).toISOString()}
  g.framework.stops = [stopped]
  g.f.advance(1)
  g.host.incarnation = 'accepted-successor'; g.host.incarnationGeneration!++; g.host.sequence = 1
  g.host.frameworkBinding = {...original.binding, version: original.binding.version + 1, revision: 'b'.repeat(40), installationId: 'accepted-successor-installation'}
  g.host.frameworkProcess = {pid: 200, startedAt: 'accepted-successor-process'}; g.host.frameworkAcceptedAt = g.host.observedAt
  g.framework.history = [{...original, endedAt: stopped.observedAt, endReason: 'observed-stop'},
    {binding: g.host.frameworkBinding, incarnation: g.host.incarnation, incarnationGeneration: g.host.incarnationGeneration,
      process: g.host.frameworkProcess, effectiveAt: g.host.frameworkAcceptedAt, observedAt: g.host.observedAt}]
  const returns = g.closedReturns(acquired.claims as ExclusiveHostReservation[]).map(value => ({...value,
    controller: {incarnation: g.host.incarnation!, generation: g.host.incarnationGeneration!, sequence: g.host.sequence}}))
  for (const subject of g.host.resourceLifecycle!.subjects) {subject.idle.outcome = 'unknown'; subject.status = 'unknown'}
  // Run the production journal writer; only its database CAS is an in-memory seam.
  g.rows.recordCandidateReturn = function (...args) {return resourceReservationRepository.recordCandidateReturn!.apply(this, args)}
  g.f.rows.settleCandidatePreparation = routineJobRepository.settleCandidatePreparation! as any
  const clock = spyOn(Date, 'now').mockImplementation(() => g.f.now),
    hostRead = spyOn(TestHostStateService.prototype, 'get').mockImplementation(async id => id === g.host.hostId ? structuredClone(g.host) : null),
    write = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any, update: any) => {
      if (filter.requestId !== g.f.row.requestId || !isDeepStrictEqual(filter.fleetCandidatePreparation, g.f.row.fleetCandidatePreparation)) return null as any
      if (update.$unset?.fleetCandidatePreparation === '') {
        expect(filter.fleetBinding).toEqual({$exists: false}); expect(filter.hostId).toEqual({$exists: false})
        expect(filter.fleetResourceAdmission).toEqual({$exists: false}); expect(filter.fleetDeadline).toBeUndefined()
        expect(update.$set.fleetCandidateSelection).toBeUndefined()
        g.f.row = {...g.f.row, ...structuredClone(update.$set), fleetCandidatePreparation: undefined}
        return structuredClone(g.f.row) as any
      }
      for (const [key, value] of Object.entries(update.$set)) {
        if (!key.startsWith('fleetCandidatePreparation.')) throw Error('Unexpected write')
        ;(g.f.row.fleetCandidatePreparation as any)[key.slice('fleetCandidatePreparation.'.length)] = structuredClone(value)
      }
      return {requestId: g.f.row.requestId} as any
    })
  return {...g, returns, acquired, close() {write.mockRestore(); hostRead.mockRestore(); clock.mockRestore()}}
}

test('verified stopped source and accepted successor return the same original claims as UNKNOWN through the real journal writer', async () => {
  const g = await successorReturns()
  try {
    const original = structuredClone(g.pending)
    for (const returned of g.returns) expect(await g.service.giveBack(returned, g.host.hostId)).toEqual({status: 'returned', claimId: returned.claimId})
    const saved = g.f.row.fleetCandidatePreparation!
    expect(saved.target).toEqual(original.target); expect(saved.resourceClaims).toEqual(original.resourceClaims)
    expect(g.framework.stops![0]).toEqual(saved.resourceReturnContinuation?.stopped)
    expect(saved.resourceReturns?.every(value => graphCandidateReturnMatches(saved, value))).toBe(true)
    expect(g.host.authorityReservations).toEqual([])
    g.f.advance(1); g.host.sequence++
    expect(await g.service.giveBack({...g.returns[0]!, controller: {...g.returns[0]!.controller, sequence: g.host.sequence}}, g.host.hostId))
      .toEqual({status: 'returned', claimId: g.returns[0]!.claimId})
    expect(g.f.row.fleetCandidatePreparation!.resourceReturns).toHaveLength(g.returns.length)
  } finally {g.close()}
})

function reportSuccessorSettlement(g: Awaited<ReturnType<typeof successorReturns>>) {
  const checks = g.purpose.resources.map(member => {
    const subject = g.host.resourceLifecycle!.subjects.find(value => value.subject.id === member.id)!
    return {resourceId: member.id, checkOperationId: subject.idle.acceptedCheck!.operationId, outcome: 'unknown' as const,
      subjectGeneration: subject.generation, contractVersion: member.contractVersion,
      resultSha256: subject.idle.acceptedCheck!.resultSha256, checkedAt: subject.idle.checkedAt!}
  })
  const receipt = {candidate: g.pending.candidate, targetInputSha256: g.pending.targetInputSha256,
    outcome: 'unknown' as const, hostWorkSettled: true as const, checkOperationId: g.intent.operationId, graphChecks: checks}
  g.host.resourceReservations!.candidatePrerequisites = [receipt]
  g.host.frameworkHistory = structuredClone(g.framework.history) as any
  return receipt
}

async function completedGraphReturns() {
  const g = await successorReturns()
  for (const returned of g.returns) await g.service.giveBack(returned, g.host.hostId)
  reportSuccessorSettlement(g)
  g.f.advance(400_000)
  g.host.frameworkHistory!.at(-1)!.observedAt = g.host.observedAt
  await g.f.service.preparation('job-one')
  g.rows.candidateRequest = async (id, digest) => g.f.row.fleetCandidatePreparation?.hostId === id &&
    g.f.row.fleetCandidatePreparation.targetInputSha256 === digest ? structuredClone(g.f.row) : null
  g.rows.completedCandidateRequest = async (id, digest) => g.f.row.fleetCandidatePreparations?.some(value =>
    value.hostId === id && value.targetInputSha256 === digest) ? structuredClone(g.f.row) : null
  return g
}

test('a completed graph repeats only its saved return ACK after archival and later resource/controller reports', async () => {
  const g = await completedGraphReturns()
  try {
    const before = structuredClone(g.f.row), writes = g.writes.length
    for (const subject of g.host.resourceLifecycle!.subjects) subject.generation++
    g.host.incarnation = 'later-accepted-controller'; g.host.incarnationGeneration!++; g.host.sequence = 1
    const foreign = {...structuredClone(g.acquired.claims[0]!), id: '20000000-0000-4000-8000-000000000001',
      inputSha256: 'c'.repeat(64), owner: {kind: 'boundary-cleanup' as const, id: 'unrelated-owner'}, prerequisite: undefined, resourceCheck: undefined}
    g.host.authorityReservations = [foreign]
    for (const returned of g.returns) {
      const repeated = {...returned, controller: {incarnation: g.host.incarnation!, generation: g.host.incarnationGeneration!, sequence: g.host.sequence}}
      expect(await g.service.giveBack(repeated, g.host.hostId)).toEqual({status: 'returned', claimId: returned.claimId})
      g.host.sequence++
      expect(await g.service.giveBack({...repeated, controller: {...repeated.controller, sequence: g.host.sequence}}, g.host.hostId))
        .toEqual({status: 'returned', claimId: returned.claimId})
    }
    expect(g.f.row).toEqual(before); expect(g.writes).toHaveLength(writes)
    expect(g.host.authorityReservations).toEqual([foreign])
  } finally {g.close()}
})

test('a historical ACK preserves another current preparation without expanding current acquisition lookup', async () => {
  const g = await completedGraphReturns()
  try {
    const other = structuredClone(g.pending)
    other.candidate.attemptId = 'different-current-attempt'; other.targetInputSha256 = 'c'.repeat(64)
    g.f.row.fleetCandidatePreparation = other
    const before = structuredClone(g.f.row), writes = g.writes.length, returned = g.returns[0]!
    expect(await g.rows.candidateRequest!(g.host.hostId, returned.inputSha256)).toBeNull()
    expect(await g.service.giveBack({...returned, controller: {incarnation: g.host.incarnation!,
      generation: g.host.incarnationGeneration!, sequence: g.host.sequence}}, g.host.hostId)).toEqual({status: 'returned', claimId: returned.claimId})
    expect(g.f.row).toEqual(before); expect(g.writes).toHaveLength(writes)
  } finally {g.close()}
})

test.each(['changed-proof', 'changed-owner', 'incomplete-graph', 'foreign-controller', 'foreign-generation', 'stale-sequence', 'live-original', 'duplicate-history',
  'ambiguous-request', 'foreign-host'] as const)('completed graph ACK refuses %s without changing any custody', async changed => {
  const g = await completedGraphReturns()
  try {
    const returned = {...structuredClone(g.returns[0]!), controller: {incarnation: g.host.incarnation!,
      generation: g.host.incarnationGeneration!, sequence: g.host.sequence}}
    if (changed === 'changed-proof') returned.release.releasedAt = new Date(g.f.now).toISOString()
    if (changed === 'changed-owner') returned.originalOwner.id = 'foreign-original-owner'
    if (changed === 'incomplete-graph') g.f.row.fleetCandidatePreparations![0]!.resourceReturns!.pop()
    if (changed === 'foreign-controller') returned.controller.incarnation = 'foreign-controller'
    if (changed === 'foreign-generation') returned.controller.generation++
    if (changed === 'stale-sequence') returned.controller.sequence--
    if (changed === 'live-original') g.host.authorityReservations = [structuredClone(g.acquired.claims[0]!)]
    if (changed === 'duplicate-history') g.f.row.fleetCandidatePreparations!.push(structuredClone(g.f.row.fleetCandidatePreparations![0]!))
    if (changed === 'ambiguous-request') g.rows.completedCandidateRequest = async () => null
    if (changed === 'foreign-host') g.f.row.fleetCandidatePreparations![0]!.hostId = 'another-host'
    const before = structuredClone(g.f.row), claims = structuredClone(g.host.authorityReservations), writes = g.writes.length
    await expect(g.service.giveBack(returned, g.host.hostId)).rejects.toThrow()
    expect(g.f.row).toEqual(before); expect(g.host.authorityReservations).toEqual(claims); expect(g.writes).toHaveLength(writes)
  } finally {g.close()}
})

test.each(['heartbeat', 'restart-no-retry', 'restart-retry'] as const)('production UNKNOWN settlement completes after all ACKs and %s', async scenario => {
  const g = await successorReturns()
  try {
    for (const returned of g.returns) await g.service.giveBack(returned, g.host.hostId)
    const restart = scenario !== 'heartbeat'
    if (restart) {
      g.f.advance(1)
      const prior = g.framework.history!.at(-1) as any
      prior.endedAt = g.host.observedAt; prior.endReason = 'accepted-replacement'
      g.host.incarnation = 'same-source-restart'; g.host.incarnationGeneration!++; g.host.sequence = 1
      g.host.frameworkProcess = {pid: 201, startedAt: 'same-source-restart-process'}; g.host.frameworkAcceptedAt = g.host.observedAt
      g.framework.history!.push({binding: g.host.frameworkBinding, incarnation: g.host.incarnation,
        incarnationGeneration: g.host.incarnationGeneration, process: g.host.frameworkProcess,
        effectiveAt: g.host.frameworkAcceptedAt, observedAt: g.host.observedAt})
      // Lost acknowledgement: the new reporter retries the unchanged old release.
      if (scenario === 'restart-retry') expect(await g.service.giveBack({...g.returns[0]!, controller: {incarnation: g.host.incarnation,
        generation: g.host.incarnationGeneration!, sequence: g.host.sequence}}, g.host.hostId))
        .toEqual({status: 'returned', claimId: g.returns[0]!.claimId})
    }
    const receipt = reportSuccessorSettlement(g), original = structuredClone(g.pending.target)
    g.f.advance(400_000)
    g.host.frameworkHistory!.at(-1)!.observedAt = g.host.observedAt
    await g.f.service.preparation('job-one')
    expect(g.f.row.fleetCandidatePreparation).toBeUndefined()
    const saved = g.f.row.fleetCandidatePreparations!.at(-1)!
    expect(saved.target).toEqual(original); expect(saved.settlement).toEqual(receipt)
    expect(saved.resourceReturnContinuation!.history).toHaveLength(restart ? 3 : 2)
    expect(graphCandidateHistoricalSettlement(saved)).toBe(true)
    expect(g.f.row.fleetCandidateSelection).toBeUndefined(); expect(g.f.row.fleetBinding).toBeUndefined()
    expect(g.f.row.fleetDeadline.toISOString()).toBe(original.deadline)
  } finally {g.close()}
})

test.each(['positive-check', 'missing-return', 'live-claim', 'foreign-process', 'changed-source'] as const)(
  'successor settlement retains the original when %s', async changed => {
    const g = await successorReturns()
    try {
      for (const returned of g.returns) await g.service.giveBack(returned, g.host.hostId)
      const receipt = reportSuccessorSettlement(g)
      if (changed === 'positive-check') (receipt.graphChecks[0] as any).outcome = 'passed'
      if (changed === 'missing-return') g.f.row.fleetCandidatePreparation!.resourceReturns!.pop()
      if (changed === 'live-claim') g.host.authorityReservations = [g.acquired.claims[0]!]
      if (changed === 'foreign-process') g.host.frameworkProcess = {pid: 999, startedAt: 'foreign'}
      if (changed === 'changed-source') g.host.frameworkBinding = {...g.host.frameworkBinding!, revision: 'c'.repeat(40)}
      g.f.advance(400_000)
      await g.f.service.preparation('job-one')
      expect(g.f.row.fleetCandidatePreparation).toBeDefined()
      expect(g.f.row.fleetCandidatePreparations?.length ?? 0).toBe(0)
    } finally {g.close()}
  })

test.each(['changed-claim', 'changed-target', 'foreign-history', 'missing-stop', 'stale-host', 'lost-cas', 'positive'] as const)(
  'production settlement writer rejects %s without archiving the original', async changed => {
    const g = await successorReturns()
    try {
      for (const returned of g.returns) await g.service.giveBack(returned, g.host.hostId)
      const settlement = reportSuccessorSettlement(g), original = structuredClone(g.f.row),
        value = {...structuredClone(original.fleetCandidatePreparation!), settlement: structuredClone(settlement)}
      if (changed === 'changed-claim') (value.resourceClaims![0] as any).id = '99999999-9999-4999-8999-999999999999'
      if (changed === 'changed-target') value.target.deadline = new Date(g.f.now + 600_000).toISOString()
      if (changed === 'foreign-history') g.host.frameworkHistory![1]!.process = {pid: 999, startedAt: 'foreign'}
      if (changed === 'missing-stop') g.host.frameworkHistory![0]!.endReason = 'accepted-replacement'
      if (changed === 'stale-host') g.host.receivedAt = new Date(g.f.now - 120_001).toISOString()
      if (changed === 'lost-cas') g.f.row.fleetCandidatePreparation!.resourceReturns!.pop()
      if (changed === 'positive') (value.settlement as any).outcome = 'qualified'
      expect(await routineJobRepository.settleCandidatePreparation!(original, value, new Date(g.f.now))).toBeNull()
      expect(g.f.row.fleetCandidatePreparation).toBeDefined(); expect(g.f.row.fleetCandidatePreparations?.length ?? 0).toBe(0)
    } finally {g.close()}
  })

test.each(['live-old', 'missing-cessation', 'wrong-stopped-process', 'unaccepted-successor', 'foreign-successor', 'stale-binding',
  'stale-claim', 'stale-grant', 'different-host', 'positive-result', 'client-only-history'] as const)(
  'successor return rejects %s before changing original claim custody', async changed => {
    const g = await successorReturns()
    try {
      const returned = structuredClone(g.returns[0]!)
      if (changed === 'live-old') {delete (g.framework.history![0] as any).endedAt; delete (g.framework.history![0] as any).endReason}
      if (changed === 'missing-cessation') g.framework.stops = []
      if (changed === 'wrong-stopped-process') (g.framework.stops![0] as any).process = {pid: 999, startedAt: 'foreign'}
      if (changed === 'unaccepted-successor') delete g.host.frameworkAcceptedAt
      if (changed === 'foreign-successor') (g.framework.history![1] as any).process = {pid: 999, startedAt: 'foreign'}
      if (changed === 'stale-binding') g.host.frameworkBinding = {...g.host.frameworkBinding!, configurationSha256: 'c'.repeat(64)}
      if (changed === 'stale-claim') returned.claimId = '99999999-9999-4999-8999-999999999999'
      if (changed === 'stale-grant') returned.originalOwner = {...returned.originalOwner, id: 'another-owner'}
      if (changed === 'different-host') g.host.hostId = 'foreign-host'
      if (changed === 'positive-result') g.host.resourceLifecycle!.subjects.find(value => value.subject.id === returned.resourceId)!.idle.outcome = 'passed'
      if (changed === 'client-only-history') {g.host.frameworkHistory = g.framework.history as any; g.framework.history = undefined}
      const claims = structuredClone(g.host.authorityReservations), original = structuredClone(g.f.row.fleetCandidatePreparation)
      await expect(g.service.giveBack(returned, g.pending.hostId)).rejects.toThrow()
      expect(g.host.authorityReservations).toEqual(claims); expect(g.f.row.fleetCandidatePreparation).toEqual(original)
    } finally {g.close()}
  })

function reportJoinedUnused(f: Awaited<ReturnType<typeof graphAuthorityFixture>>) {
  f.host.resourceReservations!.candidatePrerequisites = [{candidate: f.pending.candidate, targetInputSha256: f.pending.targetInputSha256,
    outcome: 'unknown', hostWorkSettled: true, checkOperationId: f.intent.operationId, graphChecks: []}]
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
  reportJoinedUnused(f)
  const observed = await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
  expect(observed.status).toBe('not-acquired'); expect(observed.claims).toEqual([])
  expect('fence' in observed && 'subjects' in observed.fence && observed.fence.subjects).toEqual(f.purpose.resources.map(member => ({resourceId: member.id, subjectGeneration: member.subjectGeneration})))
  expect(f.host.authorityReservations).toEqual([]); expect(f.f.row.fleetCandidatePreparation!.noAcquisitionReceipt).toBeDefined()
})

test('an acknowledged not-acquired original cannot start a late acquisition from the same saved intent', async () => {
  const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
  reportJoinedUnused(f)
  const observed = await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
  expect(observed.status).toBe('not-acquired')
  expect((await f.service.acquire(f.intent, f.host.hostId)).status).toBe('unknown')
  expect(f.host.authorityReservations).toEqual([])
})

async function lostAbsenceFixture() {
  const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
  reportJoinedUnused(f)
  // Core saved this real service result; the original caller never received it.
  expect((await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)).status).toBe('not-acquired')
  f.host.resourceReservations!.candidatePrerequisites = [{candidate: f.pending.candidate, targetInputSha256: f.pending.targetInputSha256,
    outcome: 'unknown', hostWorkSettled: true, checkOperationId: f.intent.operationId, graphChecks: []}]
  const other = await graphAuthorityFixture(), acquired = await other.service.acquire(other.intent, other.host.hostId),
    claims = structuredClone(acquired.claims) as ExclusiveHostReservation[], digest = 'c'.repeat(64)
  for (const claim of claims) {
    claim.owner.id = `resource-graph:${digest}`; claim.operationId = `graph-prerequisite:${digest}`; claim.inputSha256 = digest
    claim.prerequisite!.jobId = 'different-original'; claim.prerequisite!.targetInputSha256 = digest
    claim.prerequisite!.candidate!.attemptId = 'candidate:different-original:1'
  }
  f.host.authorityReservations = claims; f.host.lanes[0]!.state = 'reserved'; f.host.lanes[0]!.activity = {generation: 4, owner: claims[0]!.owner}
  for (const subject of f.host.resourceLifecycle!.subjects) {subject.owner = {...claims[0]!.owner, hostId: f.host.hostId, generation: 4}; subject.generation++}
  await f.f.service.preparation('job-one')
  expect(f.f.row.fleetCandidatePreparations?.[0]?.targetInputSha256).toBe(f.pending.targetInputSha256)
  expect(f.f.row.fleetCandidatePreparation?.hostId).not.toBe(f.host.hostId)
  return f
}

test.each([false, true])('lost original absence response recovers after archival and alternate selection, expired=%s', async expired => {
  const f = await lostAbsenceFixture(), original = structuredClone(f.f.row), claims = structuredClone(f.host.authorityReservations)
  if (expired) f.f.advance(Date.parse(f.pending.target.deadline) - f.f.now + 1)
  f.host.sequence++; f.host.receivedAt = new Date(f.f.now).toISOString(); f.host.observedAt = f.host.receivedAt
  const answer = await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
  expect(answer.status).toBe('not-acquired'); expect('fence' in answer && answer.fence.controller.sequence).toBe(f.host.sequence)
  expect(f.f.row).toEqual(original); expect(f.host.authorityReservations).toEqual(claims)
  expect((await f.service.acquire(f.intent, f.host.hostId)).status).toBe('unknown')
  expect(f.f.bindWrites).toBe(0); expect(f.pending.target.deadline).toBe(original.fleetDeadline.toISOString())
})

test.each(['changed-source', 'foreign-intent', 'original-custody', 'missing-receipt', 'duplicate-original', 'changed-binding', 'missing-closed-report', 'foreign-closed-report'] as const)(
  'archived original absence recovery cannot hide %s', async changed => {
    const f = await lostAbsenceFixture(), intent = structuredClone(f.intent), original = f.f.row.fleetCandidatePreparations![0]!
    if (changed === 'changed-source') f.f.row.fleetPreparation!.routineSource.commit = 'd'.repeat(40)
    if (changed === 'foreign-intent') intent.owner.id += ':foreign'
    if (changed === 'original-custody') (f.host.authorityReservations![0] as ExclusiveHostReservation).owner.id = intent.owner.id
    if (changed === 'missing-receipt') delete original.noAcquisitionReceipt
    if (changed === 'duplicate-original') f.f.row.fleetCandidatePreparations!.push(structuredClone(original))
    if (changed === 'changed-binding') f.host.frameworkBinding!.version++
    if (changed === 'missing-closed-report') f.host.resourceReservations!.candidatePrerequisites = []
    if (changed === 'foreign-closed-report') f.host.resourceReservations!.candidatePrerequisites![0]!.checkOperationId += ':foreign'
    f.host.sequence++
    const before = structuredClone({row: f.f.row, claims: f.host.authorityReservations})
    expect((await f.service.observe({intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)).status).toBe('unknown')
    expect({row: f.f.row, claims: f.host.authorityReservations}).toEqual(before)
  })

test('an acquisition before absence receipt storage refuses the same authenticated closed original', async () => {
  const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
  reportJoinedUnused(f)
  const save = f.rows.recordCandidateNoAcquisition!.bind(f.rows)
  const hook = spyOn(f.rows, 'recordCandidateNoAcquisition').mockImplementation(async (id, pending, receipt) => {
    const acquired = await f.service.acquire(f.intent, f.host.hostId)
    expect(acquired.status).toBe('unknown')
    return save(id, pending, receipt)
  })
  try {
    const observed = await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
    expect(observed.status).toBe('not-acquired'); expect(f.f.row.fleetCandidatePreparation!.noAcquisitionReceipt).toBeDefined()
    expect(f.host.authorityReservations).toEqual([])
  } finally {hook.mockRestore()}
})

test('absence cannot open a post-fence host version before its original closed report exists', async () => {
  const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
  f.f.row.fleetCandidatePreparation!.backendTarget = f.intent.prerequisite!.target
  let resume!: () => void, entered!: () => void, acquisition: ReturnType<typeof f.service.acquire> | undefined
  const paused = new Promise<void>(resolve => {resume = resolve}), reached = new Promise<void>(resolve => {entered = resolve}),
    replace = f.rows.replace.bind(f.rows), save = f.rows.recordCandidateNoAcquisition!.bind(f.rows),
    write = spyOn(f.rows, 'replace').mockImplementation(async (host, claims) => {
      if (claims.length) {entered(); await paused}
      return replace(host, claims)
    }),
    record = spyOn(f.rows, 'recordCandidateNoAcquisition').mockImplementation(async (id, pending, receipt) => {
      // Retry reads the observer's newly advanced version and passes its final
      // request check, but pauses before the independent host-row claim CAS.
      acquisition = f.service.acquire(f.intent, f.host.hostId); await reached
      return save(id, pending, receipt)
    })
  try {
    const observed = await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
    resume(); await acquisition
    expect(f.host.authorityReservations).toEqual([])
    expect(observed.status).toBe('unknown')
    expect(record).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
    expect(f.f.row.fleetCandidatePreparation!.noAcquisitionReceipt).toBeUndefined()
    expect(f.host.authorityReservations).toEqual([])
  } finally {resume(); await acquisition; write.mockRestore(); record.mockRestore()}
})

test('a recorded original not-acquired fence closes despite later unrelated occupancy without releasing those claims', async () => {
  const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
  reportJoinedUnused(f)
  await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
  const pending = f.f.row.fleetCandidatePreparation!, receipt = {candidate: pending.candidate,
    targetInputSha256: pending.targetInputSha256, outcome: 'unknown' as const, hostWorkSettled: true as const,
    checkOperationId: f.intent.operationId, graphChecks: []}
  f.host.resourceReservations!.candidatePrerequisites = [receipt]
  const other = await graphAuthorityFixture(), acquired = await other.service.acquire(other.intent, other.host.hostId),
    claims = structuredClone(acquired.claims) as ExclusiveHostReservation[], digest = 'c'.repeat(64)
  for (const claim of claims) {
    claim.owner.id = `resource-graph:${digest}`; claim.operationId = `graph-prerequisite:${digest}`; claim.inputSha256 = digest
    claim.prerequisite!.jobId = 'different-original'; claim.prerequisite!.targetInputSha256 = digest
    claim.prerequisite!.candidate!.attemptId = 'candidate:different-original:1'
  }
  f.host.authorityReservations = claims
  f.host.lanes[0]!.activity = {generation: 4, owner: claims[0]!.owner}
  for (const subject of f.host.resourceLifecycle!.subjects) {
    subject.owner = {...claims[0]!.owner, hostId: f.host.hostId, generation: 4}; subject.generation++
  }
  const retained = structuredClone({pending, claims, lifecycle: f.host.resourceLifecycle})
  expect(candidateSettlement(pending, f.host, claims, f.f.now)).toEqual(receipt)
  expect({pending, claims, lifecycle: f.host.resourceLifecycle}).toEqual(retained)
  expect(f.f.bindWrites).toBe(0)
})

test.each(['missing-receipt', 'unknown-observation', 'original-sequence', 'intent-digest', 'subject-fence', 'live-original-claim', 'foreign-operation', 'foreign-owner', 'foreign-binding', 'foreign-controller'] as const)(
  'negative graph settlement preserves the original not-acquired authority for %s', async changed => {
    const f = await graphAuthorityFixture(); f.f.advance(1); f.host.sequence++
    reportJoinedUnused(f)
    await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
    const pending = f.f.row.fleetCandidatePreparation!, saved = pending.noAcquisitionReceipt as any
    f.host.resourceReservations!.candidatePrerequisites = [{candidate: pending.candidate,
      targetInputSha256: pending.targetInputSha256, outcome: 'unknown', hostWorkSettled: true,
      checkOperationId: f.intent.operationId, graphChecks: []}]
    if (changed === 'missing-receipt') delete pending.noAcquisitionReceipt
    if (changed === 'unknown-observation') saved.observation.status = 'unknown'
    if (changed === 'original-sequence') saved.observation.fence.controller.sequence = saved.intent.controller.sequence
    if (changed === 'intent-digest') saved.observation.intentSha256 = 'c'.repeat(64)
    if (changed === 'subject-fence') saved.observation.fence.subjects[0].subjectGeneration++
    if (changed === 'foreign-operation') saved.intent.operationId += ':foreign'
    if (changed === 'foreign-owner') saved.intent.owner.id += ':foreign'
    if (changed === 'foreign-binding') saved.intent.prerequisite.binding.version++
    if (changed === 'foreign-controller') saved.intent.controller.incarnation += ':foreign'
    if (changed.startsWith('foreign-')) saved.observation.intentSha256 = requestInputDigest({...saved.intent,
      controller: {incarnation: saved.intent.controller.incarnation, generation: saved.intent.controller.generation},
      dependencies: f.purpose.resources.map(member => ({resourceId: member.id, authorityHostId: member.authorityHostId, capability: 'resource-idle'}))})
    const claims = changed === 'live-original-claim' ? [{owner: {id: f.intent.owner.id}}] : []
    expect(candidateSettlement(pending, f.host, claims, f.f.now)).toBeUndefined()
    expect(f.f.bindWrites).toBe(0)
  })

test('closed original host work obtains only B absence while A retains the same lane and resources', async () => {
  const f = await graphAuthorityFixture(), other = await graphAuthorityFixture(), acquired = await other.service.acquire(other.intent, other.host.hostId),
    claims = structuredClone(acquired.claims) as ExclusiveHostReservation[], digest = 'c'.repeat(64)
  for (const claim of claims) {
    claim.owner.id = `resource-graph:${digest}`; claim.operationId = `graph-prerequisite:${digest}`; claim.inputSha256 = digest
    claim.prerequisite!.jobId = 'different-original'; claim.prerequisite!.targetInputSha256 = digest
    claim.prerequisite!.candidate!.attemptId = 'candidate:different-original:1'
  }
  f.host.authorityReservations = claims; f.host.lanes[0]!.activity = {generation: 4, owner: claims[0]!.owner}
  f.host.lanes[0]!.state = 'reserved'
  for (const subject of f.host.resourceLifecycle!.subjects) {
    subject.owner = {...claims[0]!.owner, hostId: f.host.hostId, generation: 4}; subject.generation++
  }
  f.host.resourceReservations!.candidatePrerequisites = [{candidate: f.pending.candidate, targetInputSha256: f.pending.targetInputSha256,
    outcome: 'unknown', hostWorkSettled: true, checkOperationId: f.intent.operationId, graphChecks: []}]
  f.f.advance(1); f.host.sequence++
  const before = structuredClone({claims, lifecycle: f.host.resourceLifecycle, activity: f.host.lanes[0]!.activity}), observed =
    await f.service.observe({intent: f.intent, controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
  expect(observed.status).toBe('not-acquired'); expect(observed.claims).toEqual([])
  expect({claims, lifecycle: f.host.resourceLifecycle, activity: f.host.lanes[0]!.activity}).toEqual(before)
  const pending = f.f.row.fleetCandidatePreparation!
  expect(candidateSettlement(pending, f.host, claims, f.f.now)?.outcome).toBe('unknown')
  expect(f.f.bindWrites).toBe(0)
})

test.each([false, true])('an old acquisition CAS loses to original closure and absence ACK, archived=%s', async archived => {
  const f = await graphAuthorityFixture(), replace = f.rows.replace.bind(f.rows)
  let closed = false
  const hook = spyOn(f.rows, 'replace').mockImplementation(async (host, claims) => {
    if (!closed) {
      closed = true; f.host.sequence++
      f.host.resourceReservations!.candidatePrerequisites = [{candidate: f.pending.candidate, targetInputSha256: f.pending.targetInputSha256,
        outcome: 'unknown', hostWorkSettled: true, checkOperationId: f.intent.operationId, graphChecks: []}]
      const observed = await f.service.observe({intent: f.intent,
        controller: {...f.pending.candidate.controller, sequence: f.host.sequence}}, f.host.hostId)
      expect(observed.status).toBe('not-acquired')
      if (archived) {
        // The real router consumes that exact negative history before the
        // caller's older claim CAS resumes its independent host write.
        await f.f.service.preparation('job-one')
        expect(f.f.row.fleetCandidatePreparations![0]!.targetInputSha256).toBe(f.pending.targetInputSha256)
      }
    }
    return replace(host, claims)
  })
  try {
    expect((await f.service.acquire(f.intent, f.host.hostId)).status).toBe('unknown')
    expect(f.host.authorityReservations).toEqual([]); expect(f.f.row.fleetCandidatePreparation?.resourceClaims).toBeUndefined()
  } finally {hook.mockRestore()}
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
