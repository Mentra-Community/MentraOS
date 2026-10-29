import {expect, test, spyOn} from 'bun:test'
import {testFrameworkBinding} from '../testing/framework-fixtures'
import {resourceControlRecordSchema, type ResourceControlRecord} from '../types/lane-control.types'
import {resourceIdleContractSchema, type ResourceLifecycleSubject} from '../types/resource-lifecycle.types'
import type {StoredRoutineJob} from '../types/routine-job.types'
import {resourceBlocker, resourceCandidateBlocker, type ResourceReadinessHost} from './resource-readiness'
import {routineJobRouting} from './routine-job.service'
import {TestHostStateService} from './test-host-state.service'
import {TestHostStateModel} from '../models/test-host-state.model'
import {routineResourceBlocker, type ResourceReservationHost} from './resource-reservations.service'

const oldAt = Date.parse('2026-10-25T11:04:05.662Z'), now = Date.parse('2026-10-25T13:07:34.133Z')
const at = (value: number) => new Date(value).toISOString(), id = 'host:app', laneId = 'mac'
const oldOperation = '10000000-0000-4000-8000-000000000001', currentOperation = '10000000-0000-4000-8000-000000000002'

function fixture() {
  const contract = resourceIdleContractSchema.parse({version: 'baseline', maximumAgeMs: 120_000,
    qualifiedScope: {kind: 'same-controller', controllerId: 'host'}, conditions: ['managed-writers-absent'], repairConfigured: true})
  const subject: ResourceLifecycleSubject = {subject: {kind: 'resource', id, authorityHostId: 'host'}, generation: 1250,
    current: true, status: 'idle', owner: null, observedAt: at(now), receivedAt: at(now), reason: null,
    idle: {contractVersion: contract.version, outcome: 'passed', checkedAt: '2026-10-25T13:07:27.343Z',
      qualifiedScope: contract.qualifiedScope, evidenceRefs: [], acceptedCheck: {operationId: currentOperation,
        subjectGeneration: 1250, resultSha256: 'b'.repeat(64), acceptedAt: '2026-10-25T13:07:34.071Z'}},
    repair: {configured: true, state: 'none'}, supportedActions: ['mark-out-of-service'],
    resource: {kind: 'app', capabilities: ['relaunch'], memberships: [{hostId: 'host', laneId}], dependencies: [], placement: 'installed'}}
  const control = resourceControlRecordSchema.parse({command: {operationId: oldOperation, hostId: 'host',
    subject: {resourceId: id, subjectGeneration: 1238}, action: 'check', expiresAt: oldAt + 120_000, operatorId: 'a'.repeat(64)},
    receipt: {operationId: oldOperation, hostId: 'host', subject: {resourceId: id, subjectGeneration: 1238},
      inputSha256: 'c'.repeat(64), completedAt: at(oldAt), result: {status: 'accepted', check: {
        operationId: oldOperation, resourceId: id, generation: 1240, state: 'unknown'}}}})
  const host: ResourceReadinessHost = {hostId: 'host', receivedAt: at(now), resourceControlRecords: [control], authorityReservations: [],
    snapshot: {hostId: 'host', observedAt: at(now), laneControls: {schemaVersion: 1, receipts: [], resourceControls: true},
      lanes: [{id: laneId, platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic', resources: [{id, kind: 'app', capabilities: ['relaunch'], idleContract: contract}]}],
      resourceLifecycle: {schemaVersion: 1, subjects: [subject]}}}
  return {host, subject, control, contract}
}
function check(control: ResourceControlRecord) {
  const result = control.receipt!.result
  if (result.status !== 'accepted' || !result.check) throw new Error('Expected accepted Check fixture')
  return result.check
}

test('an automatic authenticated returned PASS supersedes an older UNKNOWN without rewriting it or requiring a manual control', () => {
  const f = fixture(), before = structuredClone(f.host)
  expect(resourceCandidateBlocker(f.host, id, now)).toBeUndefined()
  expect(resourceBlocker(f.host, id, now)).toBeUndefined()
  expect(f.host).toEqual(before)
  expect(check(f.control).state).toBe('unknown')
})

test('the later manual receipt can follow baseline acceptance by31ms without becoming another readiness gate', () => {
  const f = fixture(), later = structuredClone(f.control)
  later.command.operationId = currentOperation; later.command.subject.subjectGeneration = 1247
  later.receipt!.operationId = currentOperation; later.receipt!.subject.subjectGeneration = 1247
  later.receipt!.completedAt = '2026-10-25T13:07:34.102Z'
  Object.assign(check(later), {operationId: currentOperation, generation: 1250, state: 'settled'})
  f.host.resourceControlRecords = [f.control, later]
  expect(resourceCandidateBlocker(f.host, id, now)).toBeUndefined()
})

test.each(['phone', 'glasses'] as const)('an unchanged returned %s baseline is usable without renewing its physical timestamps', kind => {
  for (const updateSubject of [false, true]) {
    const f = fixture(), later = now + 120_001
    f.host.snapshot.lanes[0]!.resources[0]!.kind = kind; f.subject.resource!.kind = kind
    f.host.receivedAt = at(later); f.host.snapshot.observedAt = at(later)
    if (updateSubject) f.subject.observedAt = at(later)
    const original = structuredClone(f.host)
    expect(resourceCandidateBlocker(f.host, id, later)).toBeUndefined()
    expect(resourceBlocker(f.host, id, later)).toBeUndefined()
    expect(f.host).toEqual(original)
  }
})
test.each(['app', 'recorder', 'fixture-data', 'audio', 'browser'] as const)('an unchanged returned %s baseline remains available after its check ages', kind => {
  const f = fixture(), later = now + 24 * 60 * 60 * 1000
  f.host.snapshot.lanes[0]!.resources[0]!.kind = kind; f.subject.resource!.kind = kind
  f.host.receivedAt = at(later); f.host.snapshot.observedAt = at(later); f.subject.observedAt = at(later)
  const before = structuredClone(f.host)
  expect(resourceCandidateBlocker(f.host, id, later)).toBeUndefined()
  expect(resourceBlocker(f.host, id, later)).toBeUndefined()
  expect(f.host).toEqual(before)
})
test.each(['app', 'phone', 'glasses'] as const)('an aged %s baseline cannot override withdrawn lifecycle support', kind => {
  const f = fixture(), later = now + 24 * 60 * 60 * 1000
  f.host.snapshot.lanes[0]!.resources[0]!.kind = kind; f.subject.resource!.kind = kind
  f.host.receivedAt = at(later); f.host.snapshot.observedAt = at(later); f.subject.observedAt = at(later)
  f.subject.status = 'out-of-service'; f.subject.repair.configured = false; f.subject.supportedActions = []
  f.subject.reason = {code: 'repair-runtime-missing', message: 'Original provider runtime was withdrawn'}
  expect(resourceCandidateBlocker(f.host, id, later)?.code).toBe('resource-idle-proof-unavailable')
  expect(resourceBlocker(f.host, id, later)?.code).toBe('resource-idle-proof-unavailable')
})

test('a newer accepted return supersedes an old delayed receipt without ordering independent clocks', () => {
  const f = fixture()
  f.control.receipt!.completedAt = '2026-10-25T13:07:34.102Z'
  expect(Date.parse(f.subject.idle.checkedAt!)).toBeLessThan(Date.parse(f.control.receipt!.completedAt))
  expect(Date.parse(f.subject.idle.acceptedCheck!.acceptedAt)).toBeLessThan(Date.parse(f.control.receipt!.completedAt))
  expect(resourceCandidateBlocker(f.host, id, now)).toBeUndefined()
})

test('an undelivered manual check still blocks a conflicting new request', () => {
  const f = fixture(); delete f.control.receipt
  expect(resourceCandidateBlocker(f.host, id, now)?.code).toBe('resource-operator-restriction')
  expect(resourceBlocker(f.host, id, now)?.code).toBe('resource-operator-restriction')
})

test.each(['intended', 'active', 'unknown', 'settled'] as const)('a completed %s Check receipt never replaces current resource state', state => {
  const f = fixture(); check(f.control).state = state; check(f.control).generation = f.subject.generation + 1
  const before = structuredClone(f.host)
  expect(resourceCandidateBlocker(f.host, id, now)).toBeUndefined()
  expect(resourceBlocker(f.host, id, now)).toBeUndefined()
  expect(f.host).toEqual(before)
})

test.each(['failed', 'unknown', 'not-checked', 'unqualified', 'contract', 'scope', 'accepted-generation', 'missing-accepted',
  'foreign-authority', 'not-current', 'owner', 'repair', 'stale-host', 'future-host', 'observed-after-received',
  'future-check', 'accepted-before-check', 'accepted-after-observation', 'cursor-regression', 'cursor-authority'] as const)(
  'a historical UNKNOWN cannot waive %s current return proof', changed => {
    const f = fixture()
    if (changed === 'failed' || changed === 'unknown' || changed === 'not-checked') {f.subject.status = 'unknown'; f.subject.idle.outcome = changed}
    if (changed === 'unqualified') {f.subject.status = 'unknown'; f.subject.idle.qualifiedScope = {kind: 'unqualified'}}
    if (changed === 'contract') f.subject.idle.contractVersion = 'foreign-contract'
    if (changed === 'scope') f.subject.idle.qualifiedScope = {kind: 'same-controller', controllerId: 'foreign'}
    if (changed === 'accepted-generation') {f.subject.status = 'unknown'; f.subject.idle.acceptedCheck!.subjectGeneration--}
    if (changed === 'missing-accepted') {f.subject.status = 'unknown'; f.subject.idle.acceptedCheck = null}
    if (changed === 'foreign-authority') f.subject.subject.authorityHostId = 'foreign'
    if (changed === 'not-current') f.subject.current = false
    if (changed === 'owner') {f.subject.status = 'reserved'; f.subject.owner = {kind: 'boundary-cleanup', id: 'original-writer', generation: 1250, hostId: 'host', laneId}}
    if (changed === 'repair') f.subject.repair.state = 'running'
    if (changed === 'stale-host') f.host.receivedAt = at(now - 120_001)
    if (changed === 'future-host') f.host.receivedAt = at(now + 1)
    if (changed === 'observed-after-received') f.host.snapshot.observedAt = at(now + 1)
    if (changed === 'future-check') f.subject.idle.checkedAt = at(now + 1)
    if (changed === 'accepted-before-check') f.subject.idle.acceptedCheck!.acceptedAt = at(Date.parse(f.subject.idle.checkedAt!) - 1)
    if (changed === 'accepted-after-observation') f.subject.idle.acceptedCheck!.acceptedAt = at(now + 1)
    if (changed === 'cursor-regression' || changed === 'cursor-authority') {
      const previous = structuredClone(f.subject)
      if (changed === 'cursor-regression') {previous.generation++; previous.idle.acceptedCheck!.subjectGeneration++}
      else previous.subject.authorityHostId = 'foreign'
      f.host.resourceLifecycleCursor = {schemaVersion: 1, subjects: [previous], history: []}
    }
    expect(resourceCandidateBlocker(f.host, id, now) === undefined).toBe(changed === 'unknown' || changed === 'not-checked')
    expect(resourceBlocker(f.host, id, now)).toBeDefined()
  })

test.each(['waiting', 'granted', 'returning'] as const)('an actual %s operator reservation remains restrictive', state => {
  const f = fixture(), reservation = structuredClone(f.control)
  reservation.command.action = 'reserve'; reservation.command.purpose = 'Existing custody'
  reservation.receipt!.result = {status: 'accepted', reservation: {id: 'reservation', resourceId: id, generation: 1,
    state, purpose: 'Existing custody', requestedAt: at(oldAt)}}
  f.host.resourceControlRecords = [f.control, reservation]
  expect(resourceCandidateBlocker(f.host, id, now)?.code).toBe('resource-operator-restriction')
})

test('an outstanding exact resource claim survives a newer reported PASS', () => {
  const f = fixture()
  f.host.authorityReservations = [{kind: 'exclusive', id: '10000000-0000-4000-8000-000000000003', resourceId: id,
    authorityHostId: 'host', borrowerHostId: 'host', laneId, operationId: oldOperation,
    intentSha256: 'd'.repeat(64), inputSha256: 'e'.repeat(64), owner: {kind: 'boundary-cleanup', id: 'unknown-original'},
    controllerIncarnation: 'original-controller', controllerGeneration: 1, borrowerSequence: 1, reservedAt: at(oldAt)}]
  const before = structuredClone(f.host.authorityReservations)
  expect(resourceCandidateBlocker(f.host, id, now)?.code).toBe('resource-owned')
  expect(f.host.authorityReservations).toEqual(before)
})

test('ordinary admission uses current returned physical proof rather than an old per-request graph', () => {
  const f = fixture(), snapshot = {...f.host.snapshot, frameworkBinding: testFrameworkBinding(), resourceReservations: {resourceReadiness: true as const}},
    routingHost = {...snapshot, receivedAt: at(now), authorityReservations: [], resourceControlRecords: f.host.resourceControlRecords},
    requirements = {platform: 'ios-on-mac' as const, resources: [{kind: 'app' as const, capabilities: ['relaunch']}]}
  expect(routineJobRouting(requirements, [routingHost], now, undefined, undefined, true).waitingReason).toBeUndefined()
  const row = {requestId: 'original', fleetInputSha256: 'f'.repeat(64), fleetSelection: {build: {headSha:'a'.repeat(40)}}, fleetDeadline: new Date(now + 60000), fleetPreparation: {requirements},
    fleetCandidatePreparations: [{target: {purpose: {kind: 'resource-readiness', resourceId: id,
      resources: [{id, kind: 'app', authorityHostId: 'host', subjectGeneration: 1250, contractVersion: 'baseline', capabilities: ['relaunch']}]}}}]} as unknown as StoredRoutineJob
  const host = {...f.host, snapshot, receivedAt: new Date(now), incarnation: 'controller', incarnationGeneration: 1, sequence: 1,
    laneControls: f.host.resourceControlRecords, resourceReservations: []} as unknown as ResourceReservationHost
  expect(routineResourceBlocker(host, row, laneId, now)).toBeUndefined()
})


test('current resource readiness does not parse retained debug history', () => {
  const f = fixture()
  f.host.resourceLifecycleCursor = {schemaVersion: 1, subjects: [structuredClone(f.subject)],
    history: [{id: 'old-diagnostic', unrecordedLegacyShape: true}]}
  const before = structuredClone(f.host)
  expect(resourceCandidateBlocker(f.host, id, now)).toBeUndefined()
  expect(resourceBlocker(f.host, id, now)).toBeUndefined()
  expect(f.host).toEqual(before)
})


test('the current host query and ordinary matcher ignore legacy debug arrays but retain current custody', async () => {
  const f = fixture(), selections: Record<string, number>[] = []
  const legacyHistory = Array.from({length: 10000}, (_, id) => ({id: `legacy-${id}`, obsoleteDiagnostic: true}))
  const snapshot = {...f.host.snapshot, resourceLifecycle: {...f.host.snapshot.resourceLifecycle!, history: legacyHistory}}
  const find = spyOn(TestHostStateModel, 'find').mockImplementation((() => {
    const query = {select(fields: Record<string, number>) {selections.push(fields); return query},
      limit() {return query}, read() {return query}, readConcern() {return query},
      async lean() {return [{hostId: 'host', snapshot: {...structuredClone(snapshot), resourceLifecycle: {...snapshot.resourceLifecycle, subjects: [structuredClone(f.subject)]}}, receivedAt: new Date(now),
        laneControls: f.host.resourceControlRecords, resourceReservations: f.host.authorityReservations,
        resourceLifecycleCursor: {schemaVersion: 1, subjects: [f.subject], history: legacyHistory}}]}}
    return query
  }) as never)
  const previous = process.env.TEST_HOST_TOKENS
  process.env.TEST_HOST_TOKENS = JSON.stringify({host: 't'.repeat(32)})
  try {
    const [host] = await new TestHostStateService().list()
    expect(host.resourceLifecycle).toEqual(f.host.snapshot.resourceLifecycle)
    expect(host.resourceLifecycleCursor).toEqual({schemaVersion: 1, subjects: [f.subject]})
    expect(Object.keys(selections[0]!).some(key => key === 'resourceLifecycleCursor' || key === 'snapshot.resourceLifecycle' || key.includes('history'))).toBe(false)
    const requirements = {platform: 'ios-on-mac' as const, resources: [{kind: 'app' as const, capabilities: ['relaunch']}]}
    expect(routineJobRouting(requirements, [host], now).waitingReason).toBeUndefined()
    f.subject.owner = {id: 'current-writer', kind: 'boundary-cleanup', hostId: 'host', generation: 1250}
    f.subject.status = 'checking'; f.subject.idle.outcome = 'unknown'
    const [owned] = await new TestHostStateService().list()
    expect(routineJobRouting(requirements, [owned], now).waitingReason).toBeDefined()
    expect(owned.resourceLifecycle!.subjects[0]!.owner?.id).toBe('current-writer')
  } finally {
    find.mockRestore()
    if (previous === undefined) delete process.env.TEST_HOST_TOKENS; else process.env.TEST_HOST_TOKENS = previous
  }
})
