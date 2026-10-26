import {expect, test} from 'bun:test'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import type {ReceivedTestHostState} from './test-host-state.service'
import type {OwnedRoutineQualification} from '../types/routine-job.types'

async function fixture(change: (host: ReceivedTestHostState) => void = () => {}) {
  const f = routingGraphFixture()
  await f.service.preparation('job-one')
  const pending = structuredClone(f.row.fleetCandidatePreparation!), original = structuredClone(f.hosts[0]!)
  let reads = 0
  const hosts = (f.service as unknown as {hosts: {get(id: string): Promise<ReceivedTestHostState | null>}}).hosts
  hosts.get = async id => {
    if (id !== original.hostId) return null
    const host = structuredClone(original)
    if (++reads > 1) {host.sequence++; change(host)}
    return host
  }
  return {f, pending, original}
}

test('periodic sequence-only reports preserve discovery of the same original graph', async () => {
  const {f, pending} = await fixture()
  expect((await f.service.qualificationTargets('air1')).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
  expect(f.row.fleetCandidatePreparation).toEqual(pending)
  expect(f.bindWrites).toBe(0)
})

test('unrelated resource changes do not withdraw requested graph authority', async () => {
  const {f, pending} = await fixture(host => {
    const unrelated = structuredClone(host.resourceLifecycle!.subjects[0]!)
    unrelated.subject.id = 'unrelated-resource'; unrelated.generation += 10
    unrelated.current = false; unrelated.status = 'out-of-service'
    host.resourceLifecycle!.subjects.push(unrelated)
  })
  expect((await f.service.qualificationTargets('air1')).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
})

test('unknown baseline age remains eligible for its original current graph check', async () => {
  const {f, pending} = await fixture(host => {
    for (const subject of host.resourceLifecycle!.subjects) {
      subject.status = 'unknown'
      subject.reason = {code: 'idle-check-required', message: 'Original baseline age requires its current check'}
    }
  })
  expect((await f.service.qualificationTargets('air1')).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
})

const withdrawals: [string, (host: ReceivedTestHostState) => void][] = [
  ['controller incarnation', host => {host.incarnation = 'new-controller'}],
  ['controller generation', host => {host.incarnationGeneration++}],
  ['framework binding', host => {host.frameworkBinding!.runtimeSha256 = 'f'.repeat(64)}],
  ['resource-readiness support', host => {delete host.resourceReservations!.resourceReadiness}],
  ['lane removal', host => {host.lanes = []}],
  ['lane mode', host => {host.lanes[0]!.dispatchMode = 'paused'}],
  ['lane state', host => {host.lanes[0]!.state = 'out-of-service'}],
  ['lane owner', host => {host.lanes[0]!.activity = {generation: 2, owner: {id: 'foreign-owner', kind: 'boundary-cleanup'}}}],
  ['resource generation', host => {host.resourceLifecycle!.subjects[0]!.generation++}],
  ['resource owner', host => {host.resourceLifecycle!.subjects[0]!.owner = {id: 'foreign-owner', kind: 'boundary-cleanup', generation: 2, hostId: host.hostId}}],
  ['resource currentness', host => {host.resourceLifecycle!.subjects[0]!.current = false}],
  ['resource authority', host => {host.resourceLifecycle!.subjects[0]!.subject.authorityHostId = 'another-host'}],
  ['resource withdrawal', host => {host.resourceLifecycle!.subjects[0]!.status = 'out-of-service'}],
  ['resource offline', host => {host.resourceLifecycle!.subjects[0]!.status = 'offline'}],
  ['resource repair', host => {host.resourceLifecycle!.subjects[0]!.repair.state = 'queued'}],
  ['expired host envelope', host => {host.receivedAt = '2026-10-20T11:57:59Z'}],
]
for (const [name, change] of withdrawals) test(`a final ${name} change still withdraws the original graph`, async () => {
  const {f, pending} = await fixture(change)
  expect(await f.service.qualificationTargets('air1')).toEqual([])
  expect(f.row.fleetCandidatePreparation).toEqual(pending)
  expect(f.bindWrites).toBe(0)
})

test('the immutable candidate cannot change between graph discovery reads', async () => {
  const {f} = await fixture()
  const get = f.rows.get.bind(f.rows)
  f.rows.get = async id => {
    const row = await get(id)
    if (row?.fleetCandidatePreparation) row.fleetCandidatePreparation.targetInputSha256 = 'f'.repeat(64)
    return row
  }
  expect(await f.service.qualificationTargets('air1')).toEqual([])
})

test('a final read reaching the unchanged five-second budget does not publish a target', async () => {
  const {f} = await fixture(() => f.advance(5_000))
  expect(await f.service.qualificationTargets('air1')).toEqual([])
})

test('a current owned graph remains discoverable across periodic reports', async () => {
  const f = routingGraphFixture(); await f.service.preparation('job-one')
  const pending = f.row.fleetCandidatePreparation!, host = f.hosts[0]!, ownerId = `resource-graph:${pending.targetInputSha256}`
  host.lanes[0]!.state = 'reserved'; host.lanes[0]!.activity = {generation: 2, owner: {id: ownerId, kind: 'boundary-cleanup'}}
  for (const subject of host.resourceLifecycle!.subjects) subject.owner = {id: ownerId, kind: 'boundary-cleanup', generation: 2, hostId: host.hostId}
  const owned: OwnedRoutineQualification = {jobId: f.row.requestId, laneId: 'android', inputSha256: pending.targetInputSha256,
    ownerId, generation: 2, binding: host.frameworkBinding!, controller: pending.candidate.controller, purpose: pending.target.purpose}
  let reads = 0
  const hosts = (f.service as unknown as {hosts: {get(id: string): Promise<ReceivedTestHostState | null>}}).hosts
  hosts.get = async () => ({...structuredClone(host), sequence: host.sequence + ++reads})
  expect((await f.service.qualificationTargets('air1', owned)).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
})
