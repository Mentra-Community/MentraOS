import {expect, spyOn, test} from 'bun:test'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import type {ReceivedTestHostState} from './test-host-state.service'
import type {OwnedRoutineQualification} from '../types/routine-job.types'
import {routineJobInputDigest, routineJobRepository} from './routine-job.service'
import {requestInputDigest} from './test-request.service'
import {TestRequestModel} from '../models/test-request.model'

async function fixture(change: (host: ReceivedTestHostState) => void = () => {}) {
  const f = routingGraphFixture()
  await f.prepareLegacy('job-one')
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

test('current passed physical checks preserve a target with older cached resource generations', async () => {
  const f = routingGraphFixture(); await f.prepareLegacy('job-one')
  const pending = structuredClone(f.row.fleetCandidatePreparation!), host = f.hosts[0]!
  host.sequence++
  for (const subject of host.resourceLifecycle!.subjects) {
    subject.generation += 3; subject.status = 'idle'; subject.owner = null
    subject.idle.outcome = 'passed'; subject.idle.checkedAt = host.observedAt
    subject.idle.acceptedCheck = {operationId: `manual-check:${subject.subject.id}`, subjectGeneration: subject.generation,
      resultSha256: 'a'.repeat(64), acceptedAt: host.observedAt}
  }
  const hosts = (f.service as unknown as {hosts: {get(id: string): Promise<ReceivedTestHostState | null>}}).hosts
  hosts.get = async id => id === host.hostId ? structuredClone(host) : null
  const purpose = pending.target.purpose!
  expect(purpose.kind === 'resource-readiness' && purpose.resources.every(member =>
    host.resourceLifecycle!.subjects.find(subject => subject.subject.id === member.id)!.generation > member.subjectGeneration)).toBe(true)
  expect((await f.service.qualificationTargets('air1')).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
  expect(f.row.fleetCandidatePreparation).toEqual(pending)
  expect(f.bindWrites).toBe(0)
})

test('a final passed physical check advancing resource generations preserves discovery', async () => {
  const {f, pending} = await fixture(host => {
    for (const subject of host.resourceLifecycle!.subjects) {
      subject.generation += 3; subject.status = 'idle'; subject.owner = null
      subject.idle.outcome = 'passed'; subject.idle.checkedAt = host.observedAt
      subject.idle.acceptedCheck = {operationId: `manual-check:${subject.subject.id}`, subjectGeneration: subject.generation,
        resultSha256: 'a'.repeat(64), acceptedAt: host.observedAt}
    }
  })
  expect((await f.service.qualificationTargets('air1')).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
  expect(f.row.fleetCandidatePreparation).toEqual(pending)
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
  expect(await f.service.qualificationTargets('air1', undefined, {jobId: pending.target.jobId, inputSha256: pending.targetInputSha256})).toEqual([])
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
  const f = routingGraphFixture(); await f.prepareLegacy('job-one')
  const pending = f.row.fleetCandidatePreparation!, host = f.hosts[0]!, ownerId = `resource-graph:${pending.targetInputSha256}`
  host.lanes[0]!.state = 'reserved'; host.lanes[0]!.activity = {generation: 2, owner: {id: ownerId, kind: 'boundary-cleanup'}}
  for (const subject of host.resourceLifecycle!.subjects) subject.owner = {id: ownerId, kind: 'boundary-cleanup', generation: 2, hostId: host.hostId}
  const owned: OwnedRoutineQualification = {jobId: f.row.requestId, laneId: 'android', inputSha256: pending.targetInputSha256,
    ownerId, generation: 2, binding: host.frameworkBinding!, controller: pending.candidate.controller, purpose: pending.target.purpose}
  let reads = 0
  const hosts = (f.service as unknown as {hosts: {get(id: string): Promise<ReceivedTestHostState | null>}}).hosts
  hosts.get = async () => ({...structuredClone(host), sequence: host.sequence + ++reads})
  expect((await f.service.qualificationTargets('air1', owned)).map(target => target.inputSha256)).toEqual([pending.targetInputSha256])
  expect(await f.service.qualificationTargets('air1', undefined, {jobId: pending.target.jobId, inputSha256: pending.targetInputSha256})).toEqual([])
})


test('unclaimed current-target lookup preserves the delivered graph across concurrent candidate persistence', async () => {
 const a = routingGraphFixture(), b = routingGraphFixture(), entered = Promise.withResolvers<void>(), persist = Promise.withResolvers<void>()
 a.row = {...a.row, requestId: 'job-a', fleetSelection: {...a.row.fleetSelection, requestId: 'job-a'}}
 a.row.fleetSelectionSha256 = requestInputDigest(a.row.fleetSelection); a.row.fleetInputSha256 = routineJobInputDigest(a.row)
 b.row = {...b.row, requestId: 'job-b', fleetSelection: {...b.row.fleetSelection, requestId: 'job-b'}}
 b.row.fleetSelectionSha256 = requestInputDigest(b.row.fleetSelection); b.row.fleetInputSha256 = routineJobInputDigest(b.row)
 const commit = a.rows.candidatePreparation!.bind(a.rows)
 a.rows.candidatePreparation = async (original, pending, at) => {entered.resolve(); await persist.promise; return commit(original, pending, at)}
 const preparingA = a.prepareLegacy('job-a')
 await entered.promise
 expect(a.row.fleetCandidatePreparation).toBeUndefined()
 b.advance(10); await b.prepareLegacy('job-b')
 const delivered = (await b.service.qualificationTargets('air1'))[0]!
 expect(delivered.jobId).toBe('job-b')
 persist.resolve(); await preparingA
 expect(Date.parse(a.row.fleetCandidatePreparation!.candidate.requestedAt)).toBeLessThan(Date.parse(delivered.candidate!.requestedAt))
 b.rows.get = async id => structuredClone(id === a.row.requestId ? a.row : id === b.row.requestId ? b.row : null)
 b.rows.qualificationCandidates = routineJobRepository.qualificationCandidates
 const get = (value: unknown, path: string): any => path.split('.').reduce((at: any, key) => at?.[key], value)
 const find = spyOn(TestRequestModel, 'find').mockImplementation(() => {
  let order: Record<string, number> = {}, limit = 100
  const chain: any = {sort(value: Record<string, number>) {order=value;return chain},limit(value:number){limit=value;return chain},
   read(){return chain},readConcern(){return chain},setOptions(){return chain},lean(){return chain},cursor(){
    const rows=[structuredClone(a.row),structuredClone(b.row)].sort((left,right)=>{
     for(const[key,direction]of Object.entries(order)){const l=get(left,key),r=get(right,key);if(l<r)return-direction;if(l>r)return direction}return 0
    }).slice(0,limit)
    return {async *[Symbol.asyncIterator](){yield* rows},async close(){}}
   }}
  return chain
 })
 try {
  const current = await b.service.qualificationTargets('air1', undefined, {jobId: delivered.jobId, inputSha256: delivered.inputSha256})
  expect(current.map(target=>target.inputSha256)).toEqual([delivered.inputSha256])
  expect(await b.service.qualificationTargets('air1', undefined, {jobId: delivered.jobId, inputSha256: 'f'.repeat(64)})).toEqual([])
  expect(await b.service.qualificationTargets('air1', undefined, {jobId: 'missing-original', inputSha256: delivered.inputSha256})).toEqual([])
  expect(b.bindWrites + a.bindWrites).toBe(0)
 } finally {persist.resolve(); find.mockRestore()}
})
