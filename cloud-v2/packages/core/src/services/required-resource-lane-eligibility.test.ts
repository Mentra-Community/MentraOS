import {expect, test} from 'bun:test'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {requestInputDigest} from './test-request.service'
import {routineJobInputDigest, routineJobRouting, routinePortableRequirements} from './routine-job.service'
import {routineResourceBlocker, type ResourceReservationHost} from './resource-reservations.service'
import {testRequestMatchReport} from './test-request-match.service'
import {hostStateSchema} from './test-host-state.service'

function noGlassesReturn() {
  const f = routingGraphFixture('ios-on-mac'), row = f.row
  f.hosts.splice(1)
  const host = f.hosts[0]!, lane = host.lanes[0]!, definition = row.fleetPreparation!.definition
  host.frameworkAcceptedAt = host.observedAt
  host.frameworkProcess = {pid: 123, startedAt: host.observedAt}
  definition.resourceRequirements = definition.resourceRequirements.filter(value => ['app', 'recorder'].includes(value.kind))
  definition.execution!.resourceKinds = ['app', 'recorder']
  delete definition.glasses
  row.fleetPreparation!.requirements = routinePortableRequirements({platform: 'ios-on-mac', definition} as never)
  row.fleetPreparation!.definitionSha256 = requestInputDigest(definition)
  row.fleetInputSha256 = routineJobInputDigest(row)
  f.passCurrentBaseline(host.hostId)
  const glasses = host.resourceLifecycle!.subjects.find(value => value.resource.kind === 'glasses')!
  glasses.status = 'out-of-service'
  glasses.owner = {id: 'original-glasses-repair', kind: 'fixer', generation: glasses.generation, hostId: host.hostId, laneId: lane.id}
  glasses.repair.state = 'halted'
  lane.state = 'out-of-service'
  const original = {requestId: row.requestId, inputSha256: row.fleetInputSha256!}
  const authority = () => {
    const {receivedAt, authorityReservations, ...snapshot} = structuredClone(host)
    return {hostId: host.hostId, incarnation: host.incarnation!, incarnationGeneration: host.incarnationGeneration!, sequence: host.sequence!,
      receivedAt: new Date(receivedAt), snapshot: hostStateSchema.parse(snapshot), resourceReservations: authorityReservations ?? []} as ResourceReservationHost
  }
  return {f, row, host, lane, glasses, original, authority}
}

test('a stopped unrelated glasses repair does not exclude ready no-glasses Mac resources', async () => {
  const {f, row, host, lane, glasses, original, authority} = noGlassesReturn()
  const before = structuredClone(glasses)
  expect(testRequestMatchReport(row, [host], f.now).lanes[0]?.candidateMatch).toBe('match')
  expect(routineJobRouting(row.fleetPreparation!.requirements, [host], f.now, undefined, row.fleetSelection.build, true, original).waitingReason).toBeUndefined()
  expect(routineResourceBlocker(authority(), row, lane.id, f.now)).toBeUndefined()
  await f.service.preparation(row.requestId)
  expect(f.bindWrites).toBe(1)
  expect(f.row.fleetResourceReservation?.hostId).toBe(host.hostId)
  expect(glasses).toEqual(before)
})

test('actual lane activity and requested resource custody still exclude the same no-glasses request', () => {
  for (const refusal of ['active-operation', 'requested-owner', 'paused'] as const) {
    const {f, row, host, lane, original, authority} = noGlassesReturn()
    if (refusal === 'active-operation') lane.activity = {owner: {id: 'current-run', kind: 'run', requestId: 'current-run'}, generation: 1}
    if (refusal === 'requested-owner') {
      const app = host.resourceLifecycle!.subjects.find(value => value.resource.kind === 'app')!
      app.status = 'reserved'
      app.owner = {id: 'current-app-owner', kind: 'run', generation: 1, hostId: host.hostId, laneId: lane.id}
    }
    if (refusal === 'paused') lane.dispatchMode = 'paused'
    expect(testRequestMatchReport(row, [host], f.now).lanes[0]?.candidateMatch).not.toBe('match')
    expect(routineJobRouting(row.fleetPreparation!.requirements, [host], f.now, undefined, row.fleetSelection.build, true, original).waitingReason).toBeDefined()
    expect(routineResourceBlocker(authority(), row, lane.id, f.now)).toBeDefined()
  }
})
