import {expect, test} from 'bun:test'
import {qualifiedGraphCandidate} from './backend-candidate-preparation'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {routineResourceReadinessPurpose} from './routine-job.service'

async function returnedGraph(platform: 'android' | 'ios-on-mac' = 'android') {
  const f = routingGraphFixture(platform)
  await f.prepareLegacy('job-one')
  f.settleGraph('qualified')
  await f.prepareLegacy('job-one')
  await f.seedUnusedRecorderQuota()
  const original = structuredClone(f.row)
  f.advance(120_001)
  const host = f.hosts[0]!, pending = f.row.fleetCandidatePreparations!.at(-1)!, lane = host.lanes[0]!
  return {f, host, pending, lane, original}
}

for (const platform of ['android', 'ios-on-mac'] as const) test(`${platform} unchanged returned graph stays eligible after 120 seconds without another check`, async () => {
  const {f, host, pending, lane, original} = await returnedGraph(platform)
  expect(qualifiedGraphCandidate(f.row, host, lane.id, f.now, host.receivedAt)).toBe(pending)
  await f.prepareLegacy('job-one')
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  expect(f.row.fleetCandidatePreparations).toEqual(original.fleetCandidatePreparations)
  expect(f.row.fleetCandidateSelection).toEqual(original.fleetCandidateSelection)
  const {reservedAt: _, ...claim} = f.row.fleetResourceReservation!,
    {reservedAt: __, ...originalClaim} = original.fleetResourceReservation!
  expect(claim).toEqual(originalClaim)
  expect(f.row.fleetInputSha256).toBe(original.fleetInputSha256)
  expect(f.row.fleetSelection).toEqual(original.fleetSelection)
  expect(f.row.fleetDeadline).toEqual(original.fleetDeadline)
  expect(f.row.fleetBinding).toBeUndefined()
})

for (const changed of ['disconnected', 'unqualified', 'app', 'reporter', 'generation', 'owner', 'return',
  'failed-check', 'source', 'future-close', 'pending-successor', 'cancelled', 'deadline'] as const)
  test(`age-independent graph admission still rejects ${changed}`, async () => {
    const {f, host, pending, lane} = await returnedGraph(), subject = host.resourceLifecycle!.subjects[0]!,
      health = pending.settlement!.graphChecks!.find(check => check.backendConnectivity)!.backendConnectivity!
    if (changed === 'disconnected') health.outcome = 'unqualified'
    if (changed === 'unqualified') subject.idle.qualifiedScope = {kind: 'unqualified'}
    if (changed === 'app') health.app.archiveSha256 = 'f'.repeat(64)
    if (changed === 'reporter') host.incarnation = 'replacement-controller'
    if (changed === 'generation') subject.generation++
    if (changed === 'owner') subject.owner = {kind: 'run', id: 'other-job', generation: 8, hostId: host.hostId, laneId: lane.id}
    if (changed === 'return') pending.resourceReturns!.pop()
    if (changed === 'failed-check') pending.settlement!.graphChecks![0]!.outcome = 'failed'
    if (changed === 'source') f.row.fleetInputSha256 = 'f'.repeat(64)
    if (changed === 'future-close') health.check.closedAt = new Date(f.now + 1).toISOString()
    if (changed === 'pending-successor') f.row.fleetCandidatePreparation = structuredClone(pending)
    if (changed === 'cancelled') f.row.fleetCancellation = {requestedAt: new Date(f.now).toISOString(), reason: 'Cancelled original'}
    if (changed === 'deadline') f.advance(f.row.fleetDeadline.getTime() - f.now)
    expect(qualifiedGraphCandidate(f.row, host, lane.id, f.now, host.receivedAt)).toBeUndefined()
  })

test('withdrawn actions still refuse a new readiness graph', async () => {
  const f = routingGraphFixture(), host = f.hosts[0]!, lane = host.lanes[0]!
  for (const subject of host.resourceLifecycle!.subjects) subject.supportedActions = []
  expect(routineResourceReadinessPurpose(host, lane, f.row.fleetPreparation!.requirements, f.now,
    {requestId: f.row.requestId, inputSha256: f.row.fleetInputSha256!})).toBeUndefined()
})
