import {expect, test} from 'bun:test'
import {isDeepStrictEqual} from 'node:util'
import {ResourceReservationsService, type ResourceReservationHost, type ResourceReservationRepository} from './resource-reservations.service'
import {createTestHostStateApi} from '../api/internal/test-host-state.api'
import {TestHostStateService} from './test-host-state.service'
import {LaneControlsService} from './lane-controls.service'
import {exclusiveHostReservationSchema, hostResourceReservationsSchema, type ExclusiveResourceIntent,
  resourceReservationObservationSchema, type ExclusiveResourceReturn, type HostResourceReservation} from '../types/resource-reservations.types'
import type {StoredRoutineJob} from '../types/routine-job.types'
import type {RecorderHostReservation} from '../types/recorder-storage.types'
import {fleetResourceExecutionBinding} from './fleet-resource-binding'
import {requestInputDigest} from './test-request.service'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'

const at = Date.parse('2026-10-15T21:10:00Z'), dependency = {resourceId: 'conference-account', authorityHostId: 'mini', capability: 'google-authentication'}
const intent = (hostId: string, owner = hostId): ExclusiveResourceIntent => ({operationId: `request-${owner}`, hostId, laneId: 'mac',
  controller: {incarnation: `${hostId}-process`, generation: 1, sequence: 1}, owner: {id: owner, kind: 'run'},
  inputSha256: 'a'.repeat(64), resources: [{id: 'fixtures', capabilities: ['google-authentication']}]})
function fixture(options: {race?: boolean; afterCommit?: (requests: Map<string, StoredRoutineJob & {input?: unknown}>) => void;
  beforeFleetClaim?: (admission: NonNullable<StoredRoutineJob['fleetResourceAdmission']>) => Promise<void>;
  refuseFleetClaim?: (admission: NonNullable<StoredRoutineJob['fleetResourceAdmission']>) => boolean} = {}) {
  let now = at, raced = false
  const rows = new Map<string, ResourceReservationHost>(['mini', 'air1', 'air2'].map(hostId => [hostId, {hostId,
    incarnation: `${hostId}-process`, incarnationGeneration: 1, sequence: 1, receivedAt: new Date(at), resourceReservationVersion: 0,
    resourceReservations: [], snapshot: {hostId, frameworkBinding: testFrameworkBinding(), frameworkAcceptedAt: new Date(at).toISOString(), frameworkProcess: {pid:100,startedAt:'software-current-controller'}, incarnation: `${hostId}-process`, incarnationGeneration: 1, sequence: 1,
      observedAt: new Date(at).toISOString(), lanes: [{id: 'mac', platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic',
        resources: [{id: 'fixtures', kind: 'fixture-data', capabilities: ['google-authentication', 'clipboard'], exclusiveDependencies: [dependency]}]}]}}]))
  const writes: HostResourceReservation[][] = [], requests = new Map<string, StoredRoutineJob & {input?: unknown}>()
  const repository: ResourceReservationRepository = {
    async get(hostId) {return structuredClone(rows.get(hostId) ?? null)},
    async replace(previous, claims) {
      const current = rows.get(previous.hostId)!
      if (options.race && !raced) {raced = true; current.sequence++; current.snapshot.sequence++; return false}
      if (previous.sequence !== current.sequence || previous.resourceReservationVersion !== current.resourceReservationVersion) return false
      current.resourceReservations = structuredClone(claims); current.resourceReservationVersion = (current.resourceReservationVersion ?? 0) + 1
      writes.push(structuredClone(claims)); options.afterCommit?.(requests); return true
    },
    async request(requestId) {return structuredClone(requests.get(requestId) ?? null)},
    async stage(requestId, digest, admission) {
      const row = requests.get(requestId)
      if (!row || row.fleetInputSha256 !== digest || row.state !== 'awaiting-runner' || row.fleetResourceAdmission || row.fleetBinding || row.fleetCancellation) return null
      row.fleetResourceAdmission = structuredClone(admission); return structuredClone(row)
    },
    async claimFleet(expected, previous, claims, admission, receipts, claimedAt, borrower) {
      await options.beforeFleetClaim?.(admission)
      const request = requests.get(expected.requestId), current = rows.get(previous.hostId), currentBorrower = borrower && rows.get(borrower.hostId)
      if (!request || !current || options.refuseFleetClaim?.(admission) ||
        request.state !== 'awaiting-runner' || request.fleetInputSha256 !== expected.fleetInputSha256 ||
        request.fleetDeadline <= claimedAt || request.fleetBinding || request.fleetCancellation || request.fleetCandidatePreparation ||
        request.hostId || request.input || request.inputSha256 ||
        !isDeepStrictEqual(request.fleetResourceAdmission, expected.fleetResourceAdmission) ||
        !isDeepStrictEqual(request.fleetResourceReservation, expected.fleetResourceReservation) ||
        !isDeepStrictEqual(request.fleetExclusiveReservation, expected.fleetExclusiveReservation) ||
        request.fleetExclusiveExecutionBinding ||
        previous.incarnation !== current.incarnation || previous.incarnationGeneration !== current.incarnationGeneration ||
        previous.sequence !== current.sequence || previous.laneControlVersion !== current.laneControlVersion ||
        previous.resourceReservationVersion !== current.resourceReservationVersion ||
        borrower && borrower.hostId !== previous.hostId && (!currentBorrower ||
          borrower.incarnation !== currentBorrower.incarnation || borrower.incarnationGeneration !== currentBorrower.incarnationGeneration ||
          borrower.sequence !== currentBorrower.sequence || borrower.laneControlVersion !== currentBorrower.laneControlVersion ||
          borrower.resourceReservationVersion !== currentBorrower.resourceReservationVersion)) return null
      current.resourceReservations = structuredClone(claims)
      current.resourceReservationVersion = (current.resourceReservationVersion ?? 0) + 1
      if (borrower && borrower.hostId !== previous.hostId) currentBorrower!.resourceReservationVersion = (currentBorrower!.resourceReservationVersion ?? 0) + 1
      Object.assign(request, structuredClone({fleetResourceAdmission: admission, ...receipts}))
      writes.push(structuredClone(claims)); options.afterCommit?.(requests)
      return structuredClone(request)
    },
    async recorderClaims(requestId) {return [...rows.values()].flatMap(row => hostResourceReservationsSchema.parse(row.resourceReservations ?? [])
      .filter((claim): claim is RecorderHostReservation => !('kind' in claim) && claim.requestId === requestId))},
    async claimedHosts(requestId) {return [...rows.values()].filter(row => hostResourceReservationsSchema.parse(row.resourceReservations ?? [])
      .some(claim => 'kind' in claim && claim.owner.id === requestId && claim.origin?.kind === 'fleet')).map(row => structuredClone(row))},
  }
  return {service: new ResourceReservationsService(repository, () => now), rows, writes, requests,
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

function fleetRequest(requestId: string): StoredRoutineJob {
  return {requestId, state: 'awaiting-runner', fleetSelectionSha256: 'b'.repeat(64), fleetInputSha256: 'a'.repeat(64),
    fleetDeadline: new Date(at + 60_000), fleetSelection: {requestId, build: {headSha: 'a'.repeat(40)}} as StoredRoutineJob['fleetSelection'],
    fleetPreparation: {requirements: {platform: 'ios-on-mac', resources: [{kind: 'fixture-data', capabilities: ['google-authentication']}]}} as StoredRoutineJob['fleetPreparation']}
}
test('portable requests contend on the same existing authority before binding and repeated delivery retains the original controller intent', async () => {
  const f = fixture(); f.requests.set('first', fleetRequest('first')); f.requests.set('second', fleetRequest('second'))
  const [one, two] = await Promise.all([f.service.reserveFleet('first', 'a'.repeat(64), 'air1', 'mac'),
    f.service.reserveFleet('second', 'a'.repeat(64), 'air2', 'mac')])
  expect(Boolean(one)).not.toBe(Boolean(two)); expect(f.rows.get('mini')!.resourceReservations).toHaveLength(1)
  const winner = one ? {id: 'first', host: 'air1', receipt: one} : {id: 'second', host: 'air2', receipt: two!}
  f.observe(winner.host)
  expect(await f.service.reserveFleet(winner.id, 'a'.repeat(64), winner.host, 'mac')).toEqual(winner.receipt)
  expect(f.writes).toHaveLength(1)
  expect(winner.receipt!.origin).toEqual({kind: 'fleet', fleetInputSha256: 'a'.repeat(64)})
  expect(winner.receipt!.intent.operationId).toBe(`run:${winner.id}`)
})
test('portable contention reports its existing canonical blocker without changing any authority or request custody', async () => {
  const f = fixture(); f.requests.set('first', fleetRequest('first')); f.requests.set('second', fleetRequest('second'));
  const winner = await f.service.reserveFleet('first', 'a'.repeat(64), 'air1', 'mac');
  const before = structuredClone(f.rows.get('mini')!.resourceReservations), blocked: unknown[] = [];
  expect(await f.service.reserveFleet('second', 'a'.repeat(64), 'air2', 'mac', (value, dependencies) => blocked.push({value, dependencies}))).toBeNull();
  expect(blocked).toEqual([{value: {resourceId: dependency.resourceId, hostId: 'air1', laneId: 'mac', owner: {id: 'first', kind: 'run'}}, dependencies: [dependency]}]);
  expect(f.rows.get('mini')!.resourceReservations).toEqual(before); expect(f.writes).toHaveLength(1);
  expect(f.requests.get('second')).not.toHaveProperty('fleetExclusiveReservation');
  expect(f.requests.get('second')).not.toHaveProperty('fleetResourceAdmission');
  expect(winner!.intent.hostId).toBe('air1');
});
test('a dependency-bearing candidate without an acquired claim can use another matching host in the same controller incarnation', async () => {
  const f = fixture({refuseFleetClaim: admission => admission.intent.hostId === 'air1'}), row = fleetRequest('fallback'), original = structuredClone(row)
  f.requests.set(row.requestId, row)
  expect(await f.service.reserveFleet(row.requestId, row.fleetInputSha256!, 'air1', 'mac')).toBeNull()
  expect(row).toEqual(original); expect(f.writes).toEqual([])
  const selected = await f.service.reserveFleet(row.requestId, row.fleetInputSha256!, 'air2', 'mac')
  expect(selected).toBeTruthy()
  expect(row.fleetResourceAdmission!.intent.hostId).toBe('air2')
  expect(selected!.claims).toHaveLength(1); expect(f.writes).toHaveLength(1)
  expect(f.rows.get('air1')!.incarnation).toBe('air1-process')
  expect(f.rows.get('air2')!.incarnation).toBe('air2-process')
  expect({selection: row.fleetSelection, preparation: row.fleetPreparation, selectionSha256: row.fleetSelectionSha256,
    inputSha256: row.fleetInputSha256, deadline: row.fleetDeadline}).toEqual({selection: original.fleetSelection,
    preparation: original.fleetPreparation, selectionSha256: original.fleetSelectionSha256,
    inputSha256: original.fleetInputSha256, deadline: original.fleetDeadline})
})
test('concurrent matching candidates save only the original request claim winner without a persistent preclaim target', async () => {
  const gates = new Map<string, {promise: Promise<void>; release(): void}>(), entered = new Set<string>()
  for (const hostId of ['air1', 'air2']) {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve}); gates.set(hostId, {promise, release})}
  let arrived!: () => void; const both = new Promise<void>(resolve => {arrived = resolve})
  const f = fixture({async beforeFleetClaim(admission) {
    entered.add(admission.intent.hostId); if (entered.size === 2) arrived(); await gates.get(admission.intent.hostId)!.promise
  }}), row = fleetRequest('one-original')
  f.requests.set(row.requestId, row)
  const first = f.service.reserveFleet(row.requestId, row.fleetInputSha256!, 'air1', 'mac'),
    second = f.service.reserveFleet(row.requestId, row.fleetInputSha256!, 'air2', 'mac')
  try {
    await both
    expect(row).not.toHaveProperty('fleetResourceAdmission'); expect(f.writes).toEqual([])
    gates.get('air2')!.release(); const winner = await second
    expect(winner).toBeTruthy(); expect(winner!.intent.hostId).toBe('air2')
    gates.get('air1')!.release(); expect(await first).toBeNull()
    expect(row.fleetResourceAdmission).toEqual({intent: winner!.intent, dependencies: [dependency]})
    expect(row.fleetExclusiveReservation).toEqual(winner!)
    expect(f.rows.get('mini')!.resourceReservations).toEqual(winner!.claims)
    expect(f.writes).toHaveLength(1); expect(row).not.toHaveProperty('fleetBinding'); expect(row).not.toHaveProperty('input')
  } finally {for (const gate of gates.values()) gate.release()}
})
test('a failed host claim CAS leaves neither an admission nor a request receipt', async () => {
  const f = fixture({refuseFleetClaim: () => true}), row = fleetRequest('lost-host-cas'), original = structuredClone(row)
  f.requests.set(row.requestId, row)
  expect(await f.service.reserveFleet(row.requestId, row.fleetInputSha256!, 'air1', 'mac')).toBeNull()
  expect(row).toEqual(original); expect(f.rows.get('mini')!.resourceReservations).toEqual([]); expect(f.writes).toEqual([])
})
test('an unanswered portable authority claim survives until an exact terminal pre-execution cancellation, then only its original claims return', async () => {
  const f = fixture(), row = fleetRequest('cancelled'); f.requests.set(row.requestId, row)
  const receipt = await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')
  expect(receipt).toBeTruthy()
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toHaveLength(1)
  row.state = 'terminal'; row.fleetCancellation = {requestedAt: new Date(at).toISOString(), reason: 'cancelled before Actions binding'}
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  expect(row).not.toHaveProperty('input'); expect(row).not.toHaveProperty('fleetExclusiveExecutionBinding')
})
test('an authority answer lost after commit retains its exact portable winner for read-only retry', async () => {
  let lost = false
  const f = fixture({afterCommit() {if (!lost) {lost = true; throw Error('response lost after durable authority CAS')}}})
  f.requests.set('lost', fleetRequest('lost'))
  await expect(f.service.reserveFleet('lost', 'a'.repeat(64), 'air1', 'mac')).rejects.toThrow('response lost')
  const original = hostResourceReservationsSchema.parse(f.rows.get('mini')!.resourceReservations).filter(value => 'kind' in value)
  const recovered = await f.service.reserveFleet('lost', 'a'.repeat(64), 'air1', 'mac')
  expect(recovered!.claims).toEqual(original); expect(f.writes).toHaveLength(1)
  expect(await f.service.reserveFleet('lost', 'a'.repeat(64), 'air2', 'mac')).toBeNull()
})
test('lost authority answers are found before offer drift and only an exact terminal cancellation returns that winner', async () => {
  let lost = false
  const f = fixture({afterCommit() {if (!lost) {lost = true; throw Error('response lost after durable authority CAS')}}}), row = fleetRequest('lost')
  f.requests.set(row.requestId, row)
  await expect(f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')).rejects.toThrow('response lost')
  const original = hostResourceReservationsSchema.parse(f.rows.get('mini')!.resourceReservations), claim = original[0]!
  const other = exclusiveHostReservationSchema.parse({...claim, id: '43e32a8f-ae1e-4d4c-97f1-e0d922a7c21d', resourceId: 'another-account',
    owner: {id: 'other-request', kind: 'run'}, operationId: 'run:other-request'})
  f.rows.get('mini')!.resourceReservations = [...original, other]
  for (const host of f.rows.values()) delete host.snapshot.lanes[0]!.resources[0]!.exclusiveDependencies
  expect(await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')).toBeNull()
  expect(await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air2', 'mac')).toBeNull()
  expect(f.writes).toHaveLength(1); expect(f.rows.get('mini')!.resourceReservations).toEqual([...original, other])
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual([...original, other])
  row.state = 'terminal'; row.fleetCancellation = {requestedAt: new Date(at).toISOString(), reason: 'cancelled before executable binding'}
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual([other]); expect(f.writes).toHaveLength(2)
  expect(row).not.toHaveProperty('fleetExclusiveExecutionBinding'); expect(row).not.toHaveProperty('input')
})
test('a retained request receipt cannot recreate a missing authority claim or silently drop its dependency', async () => {
  const f = fixture(), row = fleetRequest('receipt'); f.requests.set(row.requestId, row)
  row.fleetExclusiveReservation = (await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac'))!
  f.rows.get('mini')!.resourceReservations = []
  expect(await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')).toBeNull()
  for (const host of f.rows.values()) delete host.snapshot.lanes[0]!.resources[0]!.exclusiveDependencies
  expect(await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')).toBeNull()
  expect(f.rows.get('mini')!.resourceReservations).toEqual([]); expect(f.writes).toHaveLength(1)
})
test('terminal cancellation racing the exclusive commit reconciles only that never-bound portable winner', async () => {
  const f = fixture({afterCommit(requests) {const request = requests.get('cancel-race')!; request.state = 'terminal'
    request.fleetCancellation = {requestedAt: new Date(at).toISOString(), reason: 'cancelled during authority write'}}})
  f.requests.set('cancel-race', fleetRequest('cancel-race'))
  expect(await f.service.reserveFleet('cancel-race', 'a'.repeat(64), 'air1', 'mac')).toBeNull()
  expect(f.rows.get('mini')!.resourceReservations).toEqual([]); expect(f.writes).toHaveLength(2)
})
test('bound preparation cancellation requires the exact source fence and retains claims after executable commit', async () => {
  const f = fixture(), row = fleetRequest('preparation-cancelled'); f.requests.set(row.requestId, row)
  const receipt = await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')
  const dispatchIntent = {requestId: row.requestId, laneId: 'mac'}, dispatchIntentSha256 = requestInputDigest(dispatchIntent)
  Object.assign(row, {state: 'terminal', hostId: 'air1', fleetBinding: {hostId: 'air1', laneId: 'mac'},
    dispatchIntent, dispatchIntentSha256: 'b'.repeat(64), preparationCancellation: {requestedAt: new Date(at).toISOString(), reason: 'source preparation cancelled'}})
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual(receipt!.claims)
  row.dispatchIntentSha256 = dispatchIntentSha256
  row.inputSha256 = 'e'.repeat(64)
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual(receipt!.claims)
  delete row.inputSha256
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
})
test('portable confirmation is read-only, tied to the actual executable mapping and refuses lost authority enrollment', async () => {
  const f = fixture(), row = fleetRequest('confirm'); f.requests.set(row.requestId, row)
  const reservation = (await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac'))!,
    input = frameworkRequestInputSchema.parse({routineId: 'account-google', definitionRevision: 'a'.repeat(40), routineSource: testRoutineSource(),
      platform: 'ios-on-mac', laneId: 'mac', build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
      resources: [{id: 'fixtures', kind: 'fixture-data', exclusiveDependencies: [dependency]}]}),
    binding = fleetResourceExecutionBinding(reservation, row.requestId, 'air1', 'd'.repeat(64), input, requestInputDigest(input))
  Object.assign(row, {hostId: 'air1', fleetBinding: {hostId: 'air1', laneId: 'mac'}, input, inputSha256: binding.executionInputSha256,
    dispatchIntentSha256: binding.dispatchIntentSha256, fleetExclusiveReservation: reservation, fleetExclusiveExecutionBinding: binding})
  let observation = {fleetExclusive: {reservation, binding}, controller: reservation.intent.controller}
  for (const state of ['idle', 'reserved', 'in-repair', 'out-of-service'] as const) {
    const borrower = f.observe('air1'), lane = borrower.snapshot.lanes[0]!
    lane.dispatchMode = 'paused'; lane.state = state
    lane.activity = state === 'idle' ? undefined : {generation: 2, owner: {id: 'boundary-or-fixer', kind: 'fixer'}}
    observation = {fleetExclusive: {reservation, binding}, controller: {incarnation: borrower.incarnation,
      generation: borrower.incarnationGeneration, sequence: borrower.sequence}}
    expect(await f.service.observe(observation, 'air1')).toMatchObject({status: 'reserved', claims: reservation.claims})
    expect(f.writes).toHaveLength(1)
  }
  const admission = structuredClone(row.fleetResourceAdmission!)
  row.fleetResourceAdmission!.dependencies = []
  await expect(f.service.observe(observation, 'air1')).rejects.toThrow('staged fleet admission')
  row.fleetResourceAdmission = admission
  row.fleetExclusiveExecutionBinding = {...binding, executionInputSha256: 'e'.repeat(64)}
  expect(await f.service.observe(observation, 'air1')).toMatchObject({status: 'unknown', claims: []})
  row.fleetExclusiveExecutionBinding = binding
  delete f.rows.get('mini')!.snapshot.lanes[0]!.resources[0]!.exclusiveDependencies
  expect(await f.service.observe(observation, 'air1')).toMatchObject({status: 'unknown', claims: []})
  expect(f.rows.get('mini')!.resourceReservations).toEqual(reservation.claims); expect(f.writes).toHaveLength(1)
})
test('portable return retains its authority until the original staged target and executable mapping both match', async () => {
  const f = fixture(), row = fleetRequest('return'); f.requests.set(row.requestId, row)
  const reservation = (await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac'))!,
    input = frameworkRequestInputSchema.parse({routineId: 'account-google', definitionRevision: 'a'.repeat(40), routineSource: testRoutineSource(),
      platform: 'ios-on-mac', laneId: 'mac', build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
      resources: [{id: 'fixtures', kind: 'fixture-data', exclusiveDependencies: [dependency]}]}),
    binding = fleetResourceExecutionBinding(reservation, row.requestId, 'air1', 'd'.repeat(64), input, requestInputDigest(input))
  Object.assign(row, {hostId: 'air1', fleetBinding: {hostId: 'air1', laneId: 'mac'}, input, inputSha256: binding.executionInputSha256,
    dispatchIntentSha256: binding.dispatchIntentSha256, fleetExclusiveReservation: reservation, fleetExclusiveExecutionBinding: binding})
  const borrower = f.observe('air1'), proof = returned(reservation.claims[0]!, borrower), {controller: _, ...normalReturn} = proof
  borrower.snapshot.resourceReservations = {claims: [], returns: [normalReturn]}
  const admission = row.fleetResourceAdmission!; delete row.fleetResourceAdmission
  await expect(f.service.giveBack(proof, 'air1')).rejects.toThrow('original committed executable binding')
  row.fleetResourceAdmission = {...admission, intent: {...admission.intent, hostId: 'air2'}}
  await expect(f.service.giveBack(proof, 'air1')).rejects.toThrow('staged fleet admission')
  expect(f.rows.get('mini')!.resourceReservations).toEqual(reservation.claims); expect(f.writes).toHaveLength(1)
  row.fleetResourceAdmission = admission
  expect(await f.service.giveBack(proof, 'air1')).toEqual({status: 'returned', claimId: reservation.claims[0]!.id})
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
})
test('executable input retains the portable account when Core acceptance is missing; cancellation alone cannot free device custody', async () => {
  const f = fixture(), row = fleetRequest('accepted-locally'); f.requests.set(row.requestId, row)
  const receipt = await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')
  row.state = 'terminal'; row.fleetCancellation = {requestedAt: new Date(at).toISOString(), reason: 'Core did not receive local acceptance'}
  row.inputSha256 = 'e'.repeat(64); f.requests.get(row.requestId)!.input = {original: 'executable'}
  await f.service.reconcileFleetCancellation(row.requestId)
  expect(f.rows.get('mini')!.resourceReservations).toEqual(receipt!.claims)
})
test('held authoring blocks its requested dependency while unrelated unclaimed capabilities retain no candidate target', async () => {
  const f = fixture(), row = fleetRequest('portable'); f.requests.set(row.requestId, row)
  const held = await f.service.acquire(intent('air2', 'held-authoring'), 'air2')
  expect(await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')).toBeNull()
  expect(f.rows.get('mini')!.resourceReservations).toEqual(held.claims)
  expect(row).not.toHaveProperty('fleetResourceAdmission')
  row.fleetPreparation!.requirements.resources[0]!.capabilities = ['clipboard']
  expect(await f.service.reserveFleet(row.requestId, 'a'.repeat(64), 'air1', 'mac')).toBeUndefined()
  expect(row).not.toHaveProperty('fleetResourceAdmission'); expect(row).not.toHaveProperty('fleetExclusiveReservation')
  expect(f.rows.get('mini')!.resourceReservations).toEqual(held.claims)
  expect(f.writes).toHaveLength(1)
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
test('one paused operator dispatch acquires only with its exact current durable request and definition receipt', async () => {
  const f = fixture(), host = f.rows.get('air1')!, localDispatch = {requestId: 'local-dispatch', inputSha256: 'a'.repeat(64), definitionSha256: 'd'.repeat(64)},
    original = {...intent('air1', localDispatch.requestId), operationId: `run:${localDispatch.requestId}`, localDispatch}
  host.snapshot.lanes[0]!.dispatchMode = 'paused'
  host.snapshot.resourceReservations = {claims: [], returns: [], dispatches: [localDispatch]}
  const acquired = await f.service.acquire(original, 'air1')
  expect(acquired.status).toBe('reserved'); expect(acquired.claims).toHaveLength(1)
  expect(acquired.claims[0]).toMatchObject({owner: original.owner, operationId: original.operationId, inputSha256: localDispatch.inputSha256})
  const current = f.observe('air1'); current.snapshot.resourceReservations = {claims: [], returns: []}
  current.snapshot.lanes[0]!.state = 'in-repair'; current.snapshot.lanes[0]!.activity = {generation: 2, owner: {id: 'fixer', kind: 'fixer'}}
  expect(await f.service.observe({intent: original, controller: {incarnation: current.incarnation,
    generation: current.incarnationGeneration, sequence: current.sequence}}, 'air1')).toMatchObject({status: 'reserved', claims: acquired.claims})
  expect(f.writes).toHaveLength(1)
})
test('a paused lane rejects missing, mismatched, stale or non-run local dispatch proof before authority writes', async () => {
  const dispatch = {requestId: 'local-dispatch', inputSha256: 'a'.repeat(64), definitionSha256: 'd'.repeat(64)}
  for (const kind of ['missing-intent', 'missing-receipt', 'request', 'owner', 'operation', 'input', 'definition', 'authoring', 'stale', 'foreign-owner', 'in-repair', 'out-of-service']) {
    const f = fixture(), host = f.rows.get('air1')!, value: ExclusiveResourceIntent =
      {...intent('air1', dispatch.requestId), operationId: `run:${dispatch.requestId}`, localDispatch: {...dispatch}}
    host.snapshot.lanes[0]!.dispatchMode = 'paused'
    host.snapshot.resourceReservations = {claims: [], returns: [], dispatches: [{...dispatch}]}
    if (kind === 'missing-intent') delete value.localDispatch
    if (kind === 'missing-receipt') host.snapshot.resourceReservations.dispatches = []
    if (kind === 'request') value.localDispatch!.requestId = 'different'
    if (kind === 'owner') value.owner.id = 'different'
    if (kind === 'operation') value.operationId = 'different'
    if (kind === 'input') value.inputSha256 = 'b'.repeat(64)
    if (kind === 'definition') value.localDispatch!.definitionSha256 = 'b'.repeat(64)
    if (kind === 'authoring') value.owner.kind = 'authoring'
    if (kind === 'stale') f.advance(120_001)
    if (kind === 'foreign-owner') {
      host.snapshot.lanes[0]!.state = 'reserved'; host.snapshot.lanes[0]!.activity = {generation: 2, owner: {id: 'another', kind: 'authoring'}}
    }
    if (kind === 'in-repair' || kind === 'out-of-service') {
      host.snapshot.lanes[0]!.state = kind; host.snapshot.lanes[0]!.activity = {generation: 2, owner: value.owner}
    }
    await expect(f.service.acquire(value, 'air1')).rejects.toThrow()
    expect(f.writes).toEqual([]); expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  }
})
test('the existing resource observation bounds local dispatch receipts and forbids duplicate request identities', () => {
  const dispatch = {requestId: 'local-dispatch', inputSha256: 'a'.repeat(64), definitionSha256: 'd'.repeat(64)}
  expect(resourceReservationObservationSchema.safeParse({claims: [], returns: []}).success).toBe(true)
  expect(resourceReservationObservationSchema.safeParse({claims: [], returns: [], dispatches: [dispatch]}).success).toBe(true)
  expect(resourceReservationObservationSchema.safeParse({claims: [], returns: [], dispatches: [dispatch, {...dispatch, definitionSha256: 'b'.repeat(64)}]}).success).toBe(false)
  expect(resourceReservationObservationSchema.safeParse({claims: [], returns: [], dispatches: Array.from({length: 101}, (_, index) => ({...dispatch, requestId: `dispatch-${index}`}))}).success).toBe(false)
})
test('claims persist beyond reporting expiry and halted repair; only later clean local return frees them', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!
  f.advance(600_000); f.observe('air2')
  expect((await f.service.acquire({...intent('air2'), controller: {...intent('air2').controller, sequence: 2}}, 'air2')).status).toBe('waiting')
  const host = f.observe('air1'), lane = host.snapshot.lanes[0]!
  lane.state = 'out-of-service'; lane.activity = {generation: 3, owner: {id: 'repair-owner', kind: 'fixer'}}
  await expect(f.service.giveBack(returned(claim, host), 'air1')).rejects.toThrow('recorded normal local release lineage')
  lane.state = 'idle'; delete lane.activity
  const proof = returned(claim, host); const {controller: _, ...normalReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [normalReturn]}
  await expect(f.service.giveBack(returned(claim, host, {originalOwner: {id: 'other', kind: 'run'}}), 'air1')).rejects.toThrow('recorded normal local release lineage')
  expect(await f.service.giveBack(returned(claim, host), 'air1')).toEqual({status: 'returned', claimId: claim.id})
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  expect((await f.service.acquire({...intent('air2'), controller: {...intent('air2').controller, sequence: 2}}, 'air2')).status).toBe('waiting')
  f.observe('mini')
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

test('checked fixer return preserves generation while freeing only its original account claim', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!, host = f.observe('air1')
  const original = {...claim.owner, generation: 1225}, fixer = {id: 'original-fixer', kind: 'fixer' as const, generation: 1226},
    boundary = {id: 'checked-return', kind: 'boundary-cleanup' as const, generation: 1226}
  const proof = returned(claim, host, {release: {eventId: `lane-release:${boundary.id}:${boundary.generation}`,
    owner: boundary, releasedAt: host.snapshot.observedAt, lineage: [original, fixer, boundary]}})
  const {controller: _, ...localReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [localReturn]}
  expect(await f.service.giveBack(proof, 'air1')).toEqual({status: 'returned', claimId: claim.id})
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  expect(await f.service.giveBack(proof, 'air1')).toEqual({status: 'returned', claimId: claim.id})
})

test('a later unrelated lane repair cannot retain an already returned account', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!, host = f.observe('air1')
  const original = {...claim.owner, generation: 1225}, fixer = {id: 'original-fixer', kind: 'fixer' as const, generation: 1226},
    boundary = {id: 'checked-return', kind: 'boundary-cleanup' as const, generation: 1226}
  const proof = returned(claim, host, {release: {eventId: `lane-release:${boundary.id}:${boundary.generation}`,
    owner: boundary, releasedAt: host.snapshot.observedAt, lineage: [original, fixer, boundary]}})
  const {controller: _, ...localReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [localReturn]}
  host.snapshot.lanes[0]!.state = 'out-of-service'
  host.snapshot.lanes[0]!.activity = {generation: 1239, owner: {id: 'later-gallery-fixer', kind: 'fixer'}}
  expect(await f.service.giveBack(proof, 'air1')).toEqual({status: 'returned', claimId: claim.id})
  expect(f.rows.get('mini')!.resourceReservations).toEqual([])
  expect(host.snapshot.lanes[0]!.activity.owner.id).toBe('later-gallery-fixer')
})

test('a recorded return still refuses a currently active original owner', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!, host = f.observe('air1')
  const proof = returned(claim, host), {controller: _, ...localReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [localReturn]}
  host.snapshot.lanes[0]!.state = 'running'
  host.snapshot.lanes[0]!.activity = {generation: 2, owner: {...claim.owner, requestId: claim.owner.id}}
  await expect(f.service.giveBack(proof, 'air1')).rejects.toThrow('recorded normal local release lineage')
  expect(f.rows.get('mini')!.resourceReservations).toEqual([claim])
})

test('a recorded return cannot move current custody to an earlier generation', async () => {
  const f = fixture(), claim = (await f.service.acquire(intent('air1'), 'air1')).claims[0]!, host = f.observe('air1')
  const boundary = {id: 'decreased-return', kind: 'boundary-cleanup' as const, generation: 1225}
  const proof = returned(claim, host, {release: {eventId: `lane-release:${boundary.id}:${boundary.generation}`,
    owner: boundary, releasedAt: host.snapshot.observedAt, lineage: [{...claim.owner, generation: 1225},
      {id: 'original-fixer', kind: 'fixer', generation: 1226}, boundary]}})
  const {controller: _, ...localReturn} = proof
  host.snapshot.resourceReservations = {claims: [], returns: [localReturn]}
  await expect(f.service.giveBack(proof, 'air1')).rejects.toThrow('recorded normal local release lineage')
  expect(f.rows.get('mini')!.resourceReservations).toEqual([claim])
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
  if ('kind' in proof.release) throw Error('Expected a normal lane release')
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
test('original lost acquisition observation is read-only under paused cleanup or fixer custody', async () => {
  const f = fixture(), original = intent('air1', 'held-authoring'), claim = (await f.service.acquire(original, 'air1')).claims[0]!
  for (const state of ['idle', 'reserved', 'in-repair', 'out-of-service'] as const) {
    const host = f.observe('air1'), lane = host.snapshot.lanes[0]!
    lane.dispatchMode = 'paused'; lane.state = state
    lane.activity = state === 'idle' ? undefined : {generation: 2, owner: {id: 'boundary-or-fixer', kind: 'fixer'}}
    const observed = await f.service.observe({intent: original, controller: {incarnation: host.incarnation,
      generation: host.incarnationGeneration, sequence: host.sequence}}, 'air1')
    expect(observed).toMatchObject({status: 'reserved', claims: [claim]})
    expect(f.writes).toHaveLength(1)
    await expect(f.service.acquire({...original, controller: {incarnation: host.incarnation,
      generation: host.incarnationGeneration, sequence: host.sequence}}, 'air1')).rejects.toThrow('selected idle lane')
    expect(await f.service.observe({intent: {...original, controller: {...original.controller, sequence: original.controller.sequence + 1}},
      controller: {incarnation: host.incarnation, generation: host.incarnationGeneration, sequence: host.sequence}}, 'air1'))
      .toMatchObject({status: 'unknown', claims: []})
  }
})
