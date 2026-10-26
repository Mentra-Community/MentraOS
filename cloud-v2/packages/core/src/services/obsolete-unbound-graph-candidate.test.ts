import {expect, spyOn, test} from 'bun:test'
import {isDeepStrictEqual} from 'node:util'
import {TestRequestModel} from '../models/test-request.model'
import {TestHostStateModel} from '../models/test-host-state.model'
import type {ExclusiveHostReservation} from '../types/resource-reservations.types'
import {candidateRequestCurrent, candidateSettlement, graphCandidateHistoricalSettlement, obsoleteUnboundGraphCandidate} from './backend-candidate-preparation'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {resourceReservationRepository} from './resource-reservations.service'
import {routineJobRepository} from './routine-job.service'
import {TestRequestService} from './test-request.service'
import {TestHostStateService} from './test-host-state.service'

async function replacedGraphFixture(loseCas = false) {
  const f = routingGraphFixture()
  await f.service.preparation('job-one')
  const pending = structuredClone(f.row.fleetCandidatePreparation!), host = f.hosts.find(value => value.hostId === pending.hostId)!,
    old = {binding: structuredClone(host.frameworkBinding!), incarnation: host.incarnation!, incarnationGeneration: host.incarnationGeneration!,
      process: {pid: 100, startedAt: 'original-process'}, effectiveAt: host.observedAt, observedAt: host.observedAt}
  f.advance(1); const stoppedAt = host.observedAt
  f.advance(1); host.incarnation = 'accepted-new-controller'; host.incarnationGeneration!++; host.sequence++
  host.frameworkBinding = {...host.frameworkBinding!, version: host.frameworkBinding!.version + 1, installationId: 'accepted-new-installation'}
  host.frameworkHistory = [{...old, endedAt: stoppedAt, endReason: 'observed-stop'},
    {binding: structuredClone(host.frameworkBinding), incarnation: host.incarnation, incarnationGeneration: host.incarnationGeneration!,
      process: {pid: 200, startedAt: 'current-process'}, effectiveAt: host.observedAt, observedAt: host.observedAt}]
  let cas = 0
  const get = spyOn(TestHostStateService.prototype, 'get').mockImplementation(async id => id === host.hostId ? structuredClone(host) : null),
    write = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any, update: any): Promise<any> => {
      cas++; expect(filter.fleetCandidatePreparation).toEqual(f.row.fleetCandidatePreparation)
      expect(filter.fleetDeadline).toEqual({$gt: new Date(f.now)})
      expect(filter.fleetBinding).toEqual({$exists: false}); expect(filter.fleetResourceAdmission).toEqual({$exists: false})
      expect(Object.keys(update.$unset)).toEqual(['fleetCandidatePreparation'])
      expect(update.$set.fleetDeadline).toBeUndefined()
      if (loseCas || !isDeepStrictEqual(filter.fleetCandidatePreparation, f.row.fleetCandidatePreparation)) return null
      f.row = {...f.row, ...structuredClone(update.$set), fleetCandidatePreparation: undefined}
      return structuredClone(f.row)
    })
  f.rows.supersedeCandidatePreparation = routineJobRepository.supersedeCandidatePreparation!
  return {f, pending, host, get cas() {return cas}, close() {get.mockRestore(); write.mockRestore()}}
}
function originalClaim(g: Awaited<ReturnType<typeof replacedGraphFixture>>): ExclusiveHostReservation {
  const {pending, host} = g
  return {kind: 'exclusive', id: '20000000-0000-4000-8000-000000000001', resourceId: pending.target.purpose!.resourceId,
    authorityHostId: host.hostId, borrowerHostId: host.hostId, laneId: pending.laneId,
    operationId: `graph-prerequisite:${pending.targetInputSha256}`, intentSha256: 'a'.repeat(64), inputSha256: pending.targetInputSha256,
    owner: {kind: 'boundary-cleanup', id: `resource-graph:${pending.targetInputSha256}`},
    controllerIncarnation: pending.candidate.controller.incarnation, controllerGeneration: pending.candidate.controller.generation,
    borrowerSequence: 1, reservedAt: pending.candidate.requestedAt}
}
function leaveOnlyCurrentHostAvailable(f: ReturnType<typeof routingGraphFixture>, hostId: string) {
  // These cases exercise same-host controller replacement. An eligible untried
  // alternate is intentionally preferred by ordinary dispatch.
  for (const host of f.hosts) if (host.hostId !== hostId)
    for (const lane of host.lanes) lane.state = 'out-of-service'
}
for (const destination of ['current-generation', 'alternate-host'] as const) test(`obsolete unbound graph preserves original history and prepares ${destination}`, async () => {
  const g = await replacedGraphFixture(), {f, host, pending} = g, original = structuredClone(f.row), authority = structuredClone(host.authorityReservations)
  try {
    if (destination === 'current-generation') leaveOnlyCurrentHostAvailable(f, host.hostId)
    if (destination === 'alternate-host') {host.lanes[0]!.state = 'out-of-service'; f.rows.selectedLanes = async () => []}
    await f.service.preparation('job-one')
    const preserved = f.row.fleetCandidatePreparations![0]!
    expect(preserved.target).toEqual(pending.target); expect(preserved.candidate).toEqual(pending.candidate)
    expect(preserved.settlement).toBeUndefined(); expect(preserved.returnReceipt).toBeUndefined(); expect(preserved.resourceReturns).toBeUndefined()
    expect(graphCandidateHistoricalSettlement(preserved)).toBe(false)
    expect(preserved.coordinatorSupersession?.controller.generation).toBe(host.incarnationGeneration)
    expect(f.row.fleetCandidatePreparation?.hostId).toBe(destination === 'current-generation' ? host.hostId : 'air2')
    expect(f.row.fleetCandidatePreparation?.candidate.controller.incarnation).not.toBe(pending.candidate.controller.incarnation)
    expect(f.row.fleetCandidatePreparation?.targetInputSha256).not.toBe(pending.targetInputSha256)
    for (const field of ['requestId', 'fleetSelection', 'fleetSelectionSha256', 'fleetPreparation', 'fleetInputSha256', 'fleetDeadline'] as const)
      expect(f.row[field]).toEqual(original[field])
    expect(f.row.fleetBinding).toBeUndefined(); expect(f.row.fleetResourceReservation).toBeUndefined()
    expect(host.authorityReservations).toEqual(authority); expect(g.cas).toBe(1)
  } finally {g.close()}
})
test('coordinator supersession retains unanswered input and unrelated custody without manufacturing producer closure', async () => {
  const g = await replacedGraphFixture(), {f, host} = g
  try {
    f.row.fleetCandidatePreparation!.backendTarget = {schemaVersion: 1, coreUrl: 'https://core.example/'}
    const unrelated = {...originalClaim(g), id: '20000000-0000-4000-8000-000000000002', resourceId: 'other-mac-fixture',
      operationId: 'unrelated-operation', inputSha256: 'b'.repeat(64), owner: {kind: 'boundary-cleanup' as const, id: 'unrelated-owner'}}
    host.authorityReservations = [unrelated]
    const authority = structuredClone(host.authorityReservations)
    await f.service.preparation('job-one')
    const preserved = f.row.fleetCandidatePreparations![0]!
    expect(preserved.backendTarget).toEqual({schemaVersion: 1, coreUrl: 'https://core.example/'})
    expect(preserved.noAcquisitionReceipt).toBeUndefined(); expect(preserved.settlement).toBeUndefined()
    expect(preserved.claimReceipt).toBeUndefined(); expect(preserved.returnReceipt).toBeUndefined()
    expect(candidateSettlement(preserved, host, host.authorityReservations!, f.now)).toBeUndefined()
    expect(candidateRequestCurrent({...f.row, fleetCandidatePreparation: preserved}, preserved, f.now)).toBe(false)
    expect(host.authorityReservations).toEqual(authority); expect(g.cas).toBe(1)
  } finally {g.close()}
})
for (const gap of ['same-generation', 'missing-stop', 'changed-binding', 'live-claim', 'client-claim', 'recorded-claim',
  'live-owner', 'expired', 'cancelled', 'duplicate-history', 'missing-history', 'stale-host', 'foreign-current-binding', 'current-stopped', 'malformed-stop', 'bound-request', 'changed-input', 'recorded-return'] as const) test(`obsolete unbound graph refuses ${gap}`, async () => {
  const g = await replacedGraphFixture(), {f, host, pending} = g
  try {
    if (gap === 'missing-history') host.frameworkHistory = []
    if (gap === 'stale-host') host.receivedAt = new Date(f.now - 120_001).toISOString()
    if (gap === 'foreign-current-binding') host.frameworkHistory![1]!.binding!.installationId = 'foreign-current-installation'
    if (gap === 'current-stopped') host.frameworkHistory![1]!.endedAt = new Date(f.now).toISOString()
    if (gap === 'malformed-stop') host.frameworkHistory![0]!.endedAt = 'not-a-date'
    if (gap === 'bound-request') f.row.hostId = host.hostId
    if (gap === 'changed-input') f.row.fleetInputSha256 = 'f'.repeat(64)
    if (gap === 'recorded-return') f.row.fleetCandidatePreparation!.resourceReturns = [{}]
    if (gap === 'same-generation') {host.incarnation = pending.candidate.controller.incarnation; host.incarnationGeneration!--}
    if (gap === 'missing-stop') delete host.frameworkHistory![0]!.endedAt
    if (gap === 'changed-binding') host.frameworkHistory![0]!.binding!.installationId = 'foreign-installation'
    if (gap === 'live-claim') host.authorityReservations = [originalClaim(g)]
    if (gap === 'client-claim') host.resourceReservations!.claims = [originalClaim(g)] as any
    if (gap === 'recorded-claim') f.row.fleetCandidatePreparation!.resourceClaims = [originalClaim(g)]
    if (gap === 'live-owner') host.resourceLifecycle!.subjects[0]!.owner = {kind: 'boundary-cleanup', id: `resource-graph:${pending.targetInputSha256}`, hostId: host.hostId, generation: 2}
    if (gap === 'expired') f.advance(300_000)
    if (gap === 'cancelled') f.row.fleetCancellation = {requestedAt: new Date(f.now).toISOString(), reason: 'cancelled'}
    if (gap === 'duplicate-history') f.row.fleetCandidatePreparations = [structuredClone(pending)]
    const row = structuredClone(f.row), authority = structuredClone(host.authorityReservations)
    expect(obsoleteUnboundGraphCandidate(f.row, host, f.now)).toBeUndefined()
    expect(await routineJobRepository.supersedeCandidatePreparation!(f.row, new Date(f.now))).toBeNull()
    expect(f.row).toEqual(row); expect(host.authorityReservations).toEqual(authority); expect(g.cas).toBe(0)
  } finally {g.close()}
})
test('lost original request CAS retains the pending graph and all resource authority', async () => {
  const g = await replacedGraphFixture(true), original = structuredClone(g.f.row), authority = structuredClone(g.host.authorityReservations)
  try {
    expect(await routineJobRepository.supersedeCandidatePreparation!(g.f.row, new Date(g.f.now))).toBeNull()
    expect(g.f.row).toEqual(original); expect(g.host.authorityReservations).toEqual(authority); expect(g.cas).toBe(1)
  } finally {g.close()}
})
test('an old acquisition cannot commit its host claim after a strictly newer accepted controller', async () => {
  const g = await replacedGraphFixture(), {f, host, pending} = g
  const replace = spyOn(TestHostStateModel, 'findOneAndUpdate').mockImplementation((filter: any) => {
    expect(filter.incarnation).toBe(pending.candidate.controller.incarnation)
    expect(filter.incarnationGeneration).toBeLessThan(host.incarnationGeneration!)
    return {select() {return this}, setOptions() {return this}, async lean() {return null}} as any
  })
  try {
    expect(await resourceReservationRepository.replace({hostId: host.hostId, incarnation: pending.candidate.controller.incarnation,
      incarnationGeneration: pending.candidate.controller.generation, sequence: 1, snapshot: host, receivedAt: new Date(f.now)}, [originalClaim(g)])).toBe(false)
    expect(host.authorityReservations).toEqual([]); expect(g.cas).toBe(0)
  } finally {replace.mockRestore(); g.close()}
})

test('the controller ACK view preserves completed history while retaining unresolved supersession only in storage', async () => {
  const g = await replacedGraphFixture(), {f, host} = g
  try {
    leaveOnlyCurrentHostAvailable(f, host.hostId)
    await f.service.preparation('job-one')
    const unresolved = structuredClone(f.row.fleetCandidatePreparations![0]!), fresh = structuredClone(f.row.fleetCandidatePreparation!)
    f.settleGraph('qualified'); await f.service.preparation('job-one')
    const stored = structuredClone(f.row), completed = structuredClone(f.row.fleetCandidatePreparations![1]!)
    const requests = new TestRequestService({get: async () => structuredClone(f.row)} as any)
    const view = await requests.preparationView('job-one', host.hostId) as any
    expect(view.fleetCandidatePreparations).toEqual([completed])
    expect(view.fleetCandidatePreparations[0].settlement).toEqual(completed.settlement)
    expect(view.fleetCandidatePreparations[0].target).toEqual(fresh.target)
    expect(f.row).toEqual(stored); expect(f.row.fleetCandidatePreparations![0]).toEqual(unresolved)
    expect(unresolved.settlement).toBeUndefined(); expect(g.cas).toBe(1)
    await expect(requests.preparationView('job-one', 'foreign-host')).rejects.toThrow('Assigned routine request was not found')
  } finally {g.close()}
})

for (const gap of ['ordinary-unknown', 'malformed-marker', 'original-claim'] as const)
  test(`the controller ACK view never silently omits ${gap} history`, async () => {
    const g = await replacedGraphFixture(), {f, host} = g
    try {
      leaveOnlyCurrentHostAvailable(f, host.hostId)
      await f.service.preparation('job-one')
      const history = f.row.fleetCandidatePreparations![0]!
      if (gap === 'ordinary-unknown') delete history.coordinatorSupersession
      if (gap === 'malformed-marker') history.coordinatorSupersession!.controller.generation = 0
      if (gap === 'original-claim') history.resourceClaims = [originalClaim(g)]
      const original = structuredClone(f.row)
      const requests = new TestRequestService({get: async () => structuredClone(f.row)} as any)
      const view = await requests.preparationView('job-one', host.hostId) as any
      expect(view.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
      expect(f.row).toEqual(original)
    } finally {g.close()}
  })
