import {expect, test} from 'bun:test'
import {ResourceReservationsService, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import {createTestHostStateApi} from '../api/internal/test-host-state.api'
import {TestHostStateService} from './test-host-state.service'
import {LaneControlsService} from './lane-controls.service'
import {exclusiveHostReservationSchema, hostResourceReservationsSchema, type ExclusiveResourceIntent,
  type ExclusiveResourceReturn, type HostResourceReservation} from '../types/resource-reservations.types'

const at = Date.parse('2026-10-15T21:10:00Z'), dependency = {resourceId: 'conference-account', authorityHostId: 'mini', capability: 'google-authentication'}
const intent = (hostId: string, owner = hostId): ExclusiveResourceIntent => ({operationId: `request-${owner}`, hostId, laneId: 'mac',
  controller: {incarnation: `${hostId}-process`, generation: 1, sequence: 1}, owner: {id: owner, kind: 'run'},
  inputSha256: 'a'.repeat(64), resources: [{id: 'fixtures', capabilities: ['google-authentication']}]})
function fixture(options: {race?: boolean} = {}) {
  let now = at, raced = false
  const rows = new Map<string, ResourceReservationHost>(['mini', 'air1', 'air2'].map(hostId => [hostId, {hostId,
    incarnation: `${hostId}-process`, incarnationGeneration: 1, sequence: 1, receivedAt: new Date(at), resourceReservationVersion: 0,
    resourceReservations: [], snapshot: {hostId, incarnation: `${hostId}-process`, incarnationGeneration: 1, sequence: 1,
      observedAt: new Date(at).toISOString(), lanes: [{id: 'mac', platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic',
        resources: [{id: 'fixtures', kind: 'fixture-data', capabilities: ['google-authentication', 'clipboard'], exclusiveDependencies: [dependency]}]}]}}]))
  const writes: HostResourceReservation[][] = []
  const repository: ResourceReservationRepository = {
    async get(hostId) {return structuredClone(rows.get(hostId) ?? null)},
    async replace(previous, claims) {
      const current = rows.get(previous.hostId)!
      if (options.race && !raced) {raced = true; current.sequence++; current.snapshot.sequence++; return false}
      if (previous.sequence !== current.sequence || previous.resourceReservationVersion !== current.resourceReservationVersion) return false
      current.resourceReservations = structuredClone(claims); current.resourceReservationVersion = (current.resourceReservationVersion ?? 0) + 1
      writes.push(structuredClone(claims)); return true
    },
  }
  return {service: new ResourceReservationsService(repository, () => now), rows, writes,
    advance(milliseconds = 1) {now += milliseconds; return now},
    observe(hostId: string, time = now) {const row = rows.get(hostId)!; row.sequence++; row.snapshot.sequence = row.sequence;
      row.snapshot.observedAt = new Date(time).toISOString(); row.receivedAt = new Date(time); return row},
  }
}
const returned = (claim: ReturnType<typeof exclusiveHostReservationSchema.parse>, host: ResourceReservationHost,
  overrides: Partial<ExclusiveResourceReturn> = {}): ExclusiveResourceReturn => ({claimId: claim.id, authorityHostId: claim.authorityHostId,
  resourceId: claim.resourceId, intentSha256: claim.intentSha256, inputSha256: claim.inputSha256, originalOwner: claim.owner,
  laneId: claim.laneId, controller: {incarnation: host.incarnation, generation: host.incarnationGeneration, sequence: host.sequence},
  release: {eventId: `lane-release:${claim.owner.id}:2`, owner: {...claim.owner, generation: 2}, releasedAt: host.snapshot.observedAt,
    lineage: [{...claim.owner, generation: 2}]}, ...overrides})

test('two hosts requesting one account use one existing authority CAS and only one receives all claims', async () => {
  const f = fixture(), outcomes = await Promise.all([f.service.acquire(intent('air1'), 'air1'), f.service.acquire(intent('air2'), 'air2')])
  expect(outcomes.map(value => value.status).sort()).toEqual(['reserved', 'waiting'])
  expect(f.rows.get('mini')!.resourceReservations).toHaveLength(1)
  expect(outcomes.find(value => value.status === 'waiting')!.blocked).toMatchObject({resourceId: dependency.resourceId, laneId: 'mac'})
})
test('same intent retry adopts its original claim after report advancement; identity changes cannot borrow it', async () => {
  const f = fixture(), first = await f.service.acquire(intent('air1'), 'air1'), host = f.observe('air1')
  const again = await f.service.acquire({...intent('air1'), controller: {...intent('air1').controller, sequence: host.sequence}}, 'air1')
  expect(again.claims).toEqual(first.claims); expect(f.writes).toHaveLength(1)
  expect((await f.service.acquire({...intent('air1'), controller: {...intent('air1').controller, sequence: host.sequence}, inputSha256: 'b'.repeat(64)}, 'air1')).status).toBe('waiting')
})
test('a host report CAS race retries current authority without losing recorder claims', async () => {
  const f = fixture({race: true}), recorder = {id: '4d3e1aac-c3ce-40f0-a2b1-106e70986b9d', requestId: 'other', fleetInputSha256: 'b'.repeat(64),
    hostId: 'mini', laneId: 'android', poolId: 'mini-disk', minimumAvailableBytes: 123, reservedAt: new Date(at).toISOString()}
  f.rows.get('mini')!.resourceReservations = [recorder]
  expect((await f.service.acquire(intent('air1'), 'air1')).status).toBe('reserved')
  expect(f.rows.get('mini')!.resourceReservations).toContainEqual(recorder)
  expect(f.rows.get('mini')!.resourceReservations).toHaveLength(2)
})
test('unrelated fixture consumers do not claim Google and absent enrollment is refused', async () => {
  const f = fixture()
  expect(await f.service.acquire({...intent('air1'), resources: [{id: 'fixtures', capabilities: ['clipboard']}]}, 'air1'))
    .toMatchObject({status: 'reserved', claims: []})
  expect(f.writes).toEqual([])
  delete f.rows.get('mini')!.snapshot.lanes[0]!.resources[0]!.exclusiveDependencies
  await expect(f.service.acquire(intent('air1'), 'air1')).rejects.toThrow('has not enrolled')
})
test('forged host, stale observation and wrong current owner are rejected before claim mutation', async () => {
  const f = fixture()
  await expect(f.service.acquire(intent('air1'), 'air2')).rejects.toThrow('authenticated controller')
  await expect(f.service.acquire({...intent('air1'), controller: {...intent('air1').controller, sequence: 2}}, 'air1')).rejects.toThrow('current reporting controller')
  const lane = f.rows.get('air1')!.snapshot.lanes[0]!
  lane.state = 'reserved'; lane.activity = {generation: 2, owner: {id: 'other-owner', kind: 'authoring'}}
  await expect(f.service.acquire(intent('air1'), 'air1')).rejects.toThrow('unchanged current owner')
  lane.state = 'idle'; delete lane.activity; f.advance(120_001)
  await expect(f.service.acquire(intent('air1'), 'air1')).rejects.toThrow('current reporting controller')
  expect(f.writes).toEqual([])
})
test('claims persist beyond reporting expiry and halted repair; only later clean local return frees them', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!
  f.advance(600_000); f.observe('air2')
  expect((await f.service.acquire({...intent('air2'), controller: {...intent('air2').controller, sequence: 2}}, 'air2')).status).toBe('waiting')
  const host = f.observe('air1'), lane = host.snapshot.lanes[0]!
  lane.state = 'out-of-service'; lane.activity = {generation: 3, owner: {id: 'repair-owner', kind: 'fixer'}}
  await expect(f.service.giveBack(returned(claim, host), 'air1')).rejects.toThrow('fresh idle custody')
  lane.state = 'idle'; delete lane.activity
  const proof = returned(claim, host); const {controller: _, ...normalReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [normalReturn]}
  await expect(f.service.giveBack(returned(claim, host, {originalOwner: {id: 'other', kind: 'run'}}), 'air1')).rejects.toThrow('recorded normal local release lineage')
  expect(await f.service.giveBack(returned(claim, host), 'air1')).toEqual({status: 'returned', claimId: claim.id})
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  expect((await f.service.acquire({...intent('air2'), controller: {...intent('air2').controller, sequence: 2}}, 'air2')).status).toBe('reserved')
  await expect(f.service.giveBack(returned(claim, host), 'air1')).rejects.toThrow('original resource authority')
})
test('multiple dependencies in one host authority are atomic and a busy dependency does not leak partial claims', async () => {
  const f = fixture(), second = {...dependency, resourceId: 'second-account'}
  for (const row of f.rows.values()) row.snapshot.lanes[0]!.resources[0]!.exclusiveDependencies!.push(second)
  const held = await f.service.acquire(intent('air2'), 'air2')
  f.rows.get('mini')!.resourceReservations = held.claims.filter(claim => claim.resourceId === second.resourceId)
  const partial = await f.service.acquire(intent('air1'), 'air1')
  expect(partial.status).toBe('waiting'); expect(partial.claims).toHaveLength(0)
  expect((await f.service.acquire(intent('air1'), 'air1')).claims).toEqual(partial.claims)
  expect(f.rows.get('mini')!.resourceReservations).toHaveLength(1)
})
test('the typed authority union rejects duplicate exclusive identities while preserving recorder identity rules', () => {
  const exclusive = {kind: 'exclusive', id: 'cddce3f7-29ac-490a-8d0a-dd7e9e4c2d5d', resourceId: 'account', authorityHostId: 'mini',
    borrowerHostId: 'air1', laneId: 'mac', operationId: 'one', intentSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64),
    owner: {id: 'one', kind: 'run'}, controllerIncarnation: 'process', controllerGeneration: 1, borrowerSequence: 1, reservedAt: new Date(at).toISOString()}
  expect(hostResourceReservationsSchema.safeParse([exclusive]).success).toBe(true)
  expect(hostResourceReservationsSchema.safeParse([exclusive, {...exclusive, id: '4d3e1aac-c3ce-40f0-a2b1-106e70986b9d'}]).success).toBe(false)
})
test('existing host-authenticated routes reject impersonation and never expose the account bytes', async () => {
  const f = fixture(), token = 'air1-controller-credential'.repeat(2)
  const api = createTestHostStateApi(new TestHostStateService(), () => JSON.stringify({air1: token}), new LaneControlsService(), f.service)
  const send = (body: unknown, authorized = true) => api.request('/resource-reservations/acquire', {method: 'POST',
    headers: {'Content-Type': 'application/json', ...(authorized ? {Authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body)})
  expect((await send(intent('air1'), false)).status).toBe(401)
  expect((await send(intent('air2'))).status).toBe(409)
  const response = await send(intent('air1'))
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain('conference-account'); expect(body).not.toContain('conference@'); expect(body).not.toContain('password')
})

test('a claimed idle lane without its recorded release or exact repair lineage cannot return an account', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!, host = f.observe('air1')
  await expect(f.service.giveBack(returned(claim, host), 'air1')).rejects.toThrow('recorded normal local release lineage')
  const proof = returned(claim, host), {controller: _, ...normalReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [normalReturn]}
  const wrong = {...proof, release: {...proof.release, lineage: [{id: 'unrelated', kind: 'fixer' as const, generation: 2}]}}
  const {controller: ignored, ...badReturn} = wrong
  host.snapshot.resourceReservations.returns = [badReturn]
  await expect(f.service.giveBack(wrong, 'air1')).rejects.toThrow('recorded normal local release lineage')
  expect(f.rows.get('mini')!.resourceReservations).toHaveLength(1)
})

test('exact cancelled-before-allocation proof returns a claim without inventing cleanup or releasing another owner', async () => {
  const f = fixture(), request = {...intent('air1', 'cancelled'), operationId: 'run:cancelled'}
  const claim = (await f.service.acquire(request, 'air1')).claims[0]!, host = f.observe('air1')
  const proof = returned(claim, host)
  proof.release.neverStarted = {requestId: 'cancelled', reason: 'cancelled-before-allocation'}
  const {controller: _, ...local} = proof
  host.snapshot.resourceReservations = {claims: [claim], returns: [local]}
  await expect(f.service.giveBack({...proof, release: {...proof.release, neverStarted: {requestId: 'another-request', reason: 'cancelled-before-allocation'}}}, 'air1'))
    .rejects.toThrow('recorded normal local release lineage')
  expect(await f.service.giveBack(proof, 'air1')).toEqual({status: 'returned', claimId: claim.id})
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  expect(await f.service.giveBack(proof, 'air1')).toEqual({status: 'returned', claimId: claim.id})
})

test('a restarted reporter observes the original lost acquisition without renewing it or borrowing a competing claim', async () => {
  const f = fixture(), original = intent('air1'), claim = (await f.service.acquire(original, 'air1')).claims[0]!
  const host = f.observe('air1'); host.incarnation = 'air1-new-process'; host.incarnationGeneration = 2
  host.snapshot.incarnation = host.incarnation; host.snapshot.incarnationGeneration = host.incarnationGeneration
  const controller = {incarnation: host.incarnation, generation: 2, sequence: host.sequence}
  const recovered = await f.service.observe({intent: original, controller}, 'air1')
  expect(recovered).toMatchObject({status: 'reserved', claims: [claim]})
  expect(f.writes).toHaveLength(1)
  await expect(f.service.observe({intent: original, controller}, 'air2')).rejects.toThrow('authenticated controller')
  expect((await f.service.observe({intent: {...original, inputSha256: 'b'.repeat(64)}, controller}, 'air1')).status).toBe('unknown')
  f.rows.get('mini')!.resourceReservations = []
  expect(await f.service.observe({intent: original, controller}, 'air1')).toMatchObject({status: 'unknown', claims: []})
  expect(f.writes).toHaveLength(1)
})
