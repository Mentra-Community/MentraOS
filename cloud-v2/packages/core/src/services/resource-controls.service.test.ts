import {expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {LaneControlsService, type LaneControlHost, type LaneControlRepository} from './lane-controls.service'
import type {ResourceControlInput, ResourceControlReceipt, ResourceControlRecord} from '../types/lane-control.types'
import {resourceLifecycleSubjectSchema, type ResourceLifecycleSubject} from '../types/resource-lifecycle.types'
import {requestInputDigest} from './test-request.service'

function fixture() {
  let now = Date.now(), collision = false, canonicalOverride: Partial<ResourceLifecycleSubject> | undefined
  const at = () => new Date(now).toISOString()
  let subject: ResourceLifecycleSubject = resourceLifecycleSubjectSchema.parse({
    subject: {kind: 'resource', id: 'phone-exact', authorityHostId: 'air'}, generation: 7, status: 'idle',
    observedAt: at(), receivedAt: at(), current: true, reason: null, owner: null,
    idle: {contractVersion: 'phone-v1', outcome: 'passed', checkedAt: at(), acceptedCheck: {
      operationId: 'check-original', subjectGeneration: 7, resultSha256: 'a'.repeat(64), acceptedAt: at()},
      qualifiedScope: {kind: 'same-controller', controllerId: 'installed-air'}, evidenceRefs: []},
    repair: {configured: true, state: 'none'}, supportedActions: ['reserve', 'release', 'check', 'mark-out-of-service'],
    resource: {kind: 'phone', capabilities: ['android'], memberships: [{hostId: 'air', laneId: 'android'},
      {hostId: 'air', laneId: 'mac'}], dependencies: [], placement: 'installed'},
  })
  let host: LaneControlHost = {hostId: 'air', laneControlVersion: 0, laneControls: [], receivedAt: new Date(now),
    observedAt: new Date(now), snapshot: {laneControls: {schemaVersion: 1, receipts: [], resourceControls: true},
      lanes: [{id: 'android', dispatchMode: 'automatic'}, {id: 'mac', dispatchMode: 'automatic'}],
      resourceLifecycle: {schemaVersion: 1, subjects: [subject], history: []}}}
  const rows = () => host.laneControls as ResourceControlRecord[]
  const repository: LaneControlRepository = {
    async get(id) {return id === host.hostId ? structuredClone(host) : null},
    async replace(id, version, records) {
      if (collision) {collision = false; return false}
      if (id !== host.hostId || version !== host.laneControlVersion) return false
      host = {...host, laneControls: structuredClone(records), laneControlVersion: version + 1}; return true
    },
  }
  const resources = {async detail(id: string) {
    if (id !== subject.subject.id) throw new Error('Unknown resource')
    return {generatedAt: at(), subject: structuredClone({...subject, ...canonicalOverride}), coverage: 'latest authority observation'}
  }}
  const service = new LaneControlsService(repository, () => now, resources)
  const input = (action: ResourceControlInput['action'], more: Partial<ResourceControlInput> = {}): ResourceControlInput => ({
    operationId: randomUUID(), expiresAt: now + 120_000, hostId: 'air', subject: {resourceId: 'phone-exact', subjectGeneration: 7},
    action, ...(action === 'reserve' ? {purpose: 'Borrow phone'} : {}), ...more,
  })
  const receipt = (request: ResourceControlInput, result: ResourceControlReceipt['result']): ResourceControlReceipt => ({
    operationId: request.operationId, hostId: request.hostId, subject: request.subject, completedAt: at(),
    inputSha256: requestInputDigest(rows().find(row => row.command.operationId === request.operationId)!.command), result,
  })
  const reservation = (state: 'waiting' | 'granted' | 'returning' | 'released' | 'cancelled' = 'waiting', generation = 0) => ({
    id: 'manual-exact', resourceId: 'phone-exact', generation, state, purpose: 'Borrow phone', requestedAt: at(),
  })
  return {service, input, receipt, reservation, rows, host: () => host, subject: () => subject,
    changeSubject(value: Partial<ResourceLifecycleSubject>) {
      subject = {...subject, ...value}; host.snapshot.resourceLifecycle = {schemaVersion: 1, subjects: [subject], history: []}
    }, overrideCanonical(value: Partial<ResourceLifecycleSubject>) {canonicalOverride = value},
    collide() {collision = true}, advance(ms: number) {now += ms},
    reportUnchangedSubject() {
      host.receivedAt = new Date(now); host.observedAt = new Date(now)
      subject = {...subject, receivedAt: at()}
      host.snapshot.resourceLifecycle = {schemaVersion: 1, subjects: [subject], history: []}
    }}
}

test('fresh host reports keep unchanged resource controls available after the physical transition ages', async () => {
  const f = fixture(), original = structuredClone(f.subject())
  f.advance(180_001); f.reportUnchangedSubject()
  const view = await f.service.listResource('phone-exact', 'alice')
  expect(view.fresh).toBe(true)
  expect(f.subject().observedAt).toBe(original.observedAt)
  expect(f.subject().idle).toEqual(original.idle)
  expect(f.subject().owner).toBeNull()
  const check = f.input('check')
  expect((await f.service.submit(check, 'alice')).action).toBe('check')
  expect(f.rows()).toHaveLength(1)
  expect(f.subject().generation).toBe(original.generation)
  expect(f.subject().owner).toBeNull()
})

test('unchanged resource controls still require valid timestamps and fresh current authority', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.changeSubject({observedAt: null}),
    (f: ReturnType<typeof fixture>) => f.changeSubject({observedAt: new Date(f.host().observedAt.getTime() + 5001).toISOString()}),
    (f: ReturnType<typeof fixture>) => f.changeSubject({current: false}),
    (f: ReturnType<typeof fixture>) => {f.host().receivedAt = new Date(f.host().receivedAt.getTime() - 120_001)},
    (f: ReturnType<typeof fixture>) => {f.host().observedAt = new Date(f.host().observedAt.getTime() - 120_001)},
    (f: ReturnType<typeof fixture>) => f.overrideCanonical({receivedAt: new Date(f.host().receivedAt.getTime() - 1).toISOString()}),
  ]) {
    const f = fixture(); f.advance(180_001); f.reportUnchangedSubject(); invalidate(f)
    await expect(f.service.submit(f.input('check'), 'alice')).rejects.toThrow()
    expect(f.rows()).toEqual([])
  }
})

test('canonical retained raw claim overrides same-generation idle local action flags without hiding the original operation', async () => {
  for (const action of ['check', 'reserve'] as const) {
    for (const override of [
      {supportedActions: []},
      {owner: {id: 'retained-raw-reader', kind: 'boundary-cleanup' as const, generation: null, hostId: 'air', laneId: 'android'}},
    ]) {
      const blocked = fixture()
      blocked.overrideCanonical(override)
      expect(blocked.subject().status).toBe('idle')
      expect(blocked.subject().supportedActions).toContain(action)
      await expect(blocked.service.submit(blocked.input(action), 'alice')).rejects.toThrow()
      expect(blocked.rows()).toEqual([])
      const f = fixture(), original = f.input(action)
      const accepted = await f.service.submit(original, 'alice')
      f.overrideCanonical(override)
      expect(f.subject().status).toBe('idle')
      expect(f.subject().supportedActions).toContain(action)
      expect(await f.service.submit(original, 'alice')).toEqual(accepted)
      expect(f.rows()).toHaveLength(1)
    }
  }
})

test('resource delivery uses one canonical subject across two lanes and preserves exact intent after a lost response', async () => {
  const f = fixture(), reserve = f.input('reserve'); f.collide()
  const delivered = await f.service.submit(reserve, 'alice')
  expect(delivered).not.toHaveProperty('laneId'); expect(delivered.receipt).toBeUndefined()
  expect(f.rows()).toHaveLength(1); expect(f.rows()[0]!.command.operatorId).toMatch(/^[a-f0-9]{64}$/)
  f.advance(180_000)
  expect(await f.service.submit(reserve, 'alice')).toEqual(delivered)
  await expect(f.service.submit(reserve, 'bob')).rejects.toThrow('identity changed')
  await expect(f.service.submit({...reserve, purpose: 'Changed intent'}, 'alice')).rejects.toThrow('identity changed')
  expect(f.rows()).toHaveLength(1)
})

test('fresh canonical generation and installed controller support are required for a new resource action', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => {f.advance(120_001)},
    (f: ReturnType<typeof fixture>) => {f.changeSubject({current: false})},
    (f: ReturnType<typeof fixture>) => {f.changeSubject({generation: 8, status: 'checking'})},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.laneControls = {schemaVersion: 1, receipts: []}},
    (f: ReturnType<typeof fixture>) => {f.changeSubject({supportedActions: []})},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.resourceLifecycle = {schemaVersion: 1, subjects: [], history: []}},
  ]) {
    const f = fixture(), check = f.input('check'); invalidate(f)
    await expect(f.service.submit(check, 'alice')).rejects.toThrow(); expect(f.rows()).toEqual([])
  }
  const f = fixture()
  await expect(f.service.submit(f.input('check', {hostId: 'other'}), 'alice')).rejects.toThrow()
  expect(f.rows()).toEqual([])
})

test('reservation delivery does not grant custody and an existing owner remains untouched while it waits', async () => {
  const f = fixture(), owner = {id: 'original-job', kind: 'run' as const, generation: 7, hostId: 'air', laneId: 'android'}
  f.changeSubject({status: 'active', owner})
  const reserve = f.input('reserve'); await f.service.submit(reserve, 'alice')
  await f.service.exchange('air', {schemaVersion: 1, resourceControls: true,
    receipts: [f.receipt(reserve, {status: 'accepted', reservation: f.reservation()})]})
  expect((await f.service.listResource('phone-exact', 'alice')).controls[0]?.receipt?.result).toMatchObject({reservation: {state: 'waiting'}})
  expect(f.subject().owner).toEqual(owner)
  expect((await f.service.listResource('phone-exact', 'bob')).controls).toEqual([])
})

test('release requires the exact signed-in operator reservation and cannot steal another lane or generation', async () => {
  const f = fixture(), reserve = f.input('reserve'); await f.service.submit(reserve, 'alice')
  await f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(reserve, {status: 'accepted', reservation: f.reservation()})]})
  const release = f.input('release', {reservation: {id: 'manual-exact', generation: 0}})
  await expect(f.service.submit(release, 'bob')).rejects.toThrow('your current')
  await expect(f.service.submit({...release, reservation: {id: 'manual-exact', generation: 1}}, 'alice')).rejects.toThrow('your current')
  expect((await f.service.submit(release, 'alice')).action).toBe('release')
})

test('returned resource reservation cannot be resurrected by an older reserve acknowledgement', async () => {
  const f = fixture(), reserve = f.input('reserve'); await f.service.submit(reserve, 'alice')
  const original = f.receipt(reserve, {status: 'accepted', reservation: f.reservation('granted', 9)})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [original]})
  const release = f.input('release', {reservation: {id: 'manual-exact', generation: 9}})
  await f.service.submit(release, 'alice')
  await f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(release,
    {status: 'accepted', reservation: f.reservation('released', 9)})]})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [original]})
  expect((await f.service.listResource('phone-exact', 'alice')).controls.every(row =>
    row.receipt?.result.status === 'accepted' && row.receipt.result.reservation?.state === 'released')).toBe(true)
  expect((await f.service.submit(f.input('reserve'), 'alice')).action).toBe('reserve')
})

test('pending action fences conflicting resource delivery and forged controller receipts are rejected', async () => {
  const f = fixture(), check = f.input('check'); await f.service.submit(check, 'alice')
  await expect(f.service.submit(f.input('reserve'), 'bob')).rejects.toThrow('awaiting')
  const exact = f.receipt(check, {status: 'accepted', check: {operationId: check.operationId,
    resourceId: 'phone-exact', generation: 7, state: 'active'}})
  for (const wrong of [
    {...exact, hostId: 'other'}, {...exact, inputSha256: 'b'.repeat(64)},
    {...exact, subject: {...exact.subject, subjectGeneration: 8}},
    f.receipt(check, {status: 'accepted', reservation: f.reservation()}),
    f.receipt(check, {status: 'accepted', check: {operationId: check.operationId, resourceId: 'other', generation: 7, state: 'settled'}}),
  ]) await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [wrong]})).rejects.toThrow()
  expect(f.rows()[0]?.receipt).toBeUndefined()
  await f.service.exchange('air', {schemaVersion: 1, receipts: [exact]})
  expect(f.rows()[0]?.receipt?.result).toMatchObject({check: {state: 'active'}})
})

test('unknown check observation stays retained until actual settlement and older active observations cannot revive it', async () => {
  const f = fixture(), check = f.input('check'); await f.service.submit(check, 'alice')
  const result = (state: 'active' | 'unknown' | 'settled') => f.receipt(check, {status: 'accepted', check: {
    operationId: check.operationId, resourceId: 'phone-exact', generation: 7, state}})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [result('unknown')]})
  expect((await f.service.exchange('air', {schemaVersion: 1, receipts: []})).commands).toHaveLength(1)
  await f.service.exchange('air', {schemaVersion: 1, receipts: [result('active')]})
  expect(f.rows()[0]?.receipt?.result).toMatchObject({check: {state: 'unknown'}})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [result('settled')]})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [result('active')]})
  expect((await f.service.exchange('air', {schemaVersion: 1, receipts: []})).commands).toEqual([])
  expect(f.rows()[0]?.receipt?.result).toMatchObject({check: {state: 'settled'}})
})

test('manual out-of-service action retains an existing writer and accepts only its exact resource result', async () => {
  const f = fixture(), owner = {id: 'unknown-writer', kind: 'run' as const, generation: 7, hostId: 'air', laneId: 'android'}
  f.changeSubject({status: 'active', owner})
  const mark = f.input('mark-out-of-service', {reason: 'Borrowing this device'}); await f.service.submit(mark, 'alice')
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(mark, {status: 'accepted',
    resource: {resourceId: 'other', generation: 8, status: 'out-of-service'}})]})).rejects.toThrow('requested action')
  await f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(mark, {status: 'accepted',
    resource: {resourceId: 'phone-exact', generation: 8, status: 'out-of-service'}})]})
  expect(f.subject().owner).toEqual(owner)
})


test('an immediately granted generation-zero reservation returns through its exact original authority', async () => {
  const f = fixture(), reserve = f.input('reserve')
  await f.service.submit(reserve, 'alice')
  const granted = f.receipt(reserve, {status: 'accepted', reservation: f.reservation('granted', 0)})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [granted]})
  const release = f.input('release', {reservation: {id: 'manual-exact', generation: 0}})
  await expect(f.service.submit({...release, reservation: {id: 'manual-exact', generation: 1}}, 'alice')).rejects.toThrow('your current')
  await f.service.submit(release, 'alice')
  const returning = f.receipt(release, {status: 'accepted', reservation: f.reservation('returning', 0)})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [returning]})
  expect((await f.service.listResource('phone-exact', 'alice')).controls.every(row =>
    row.receipt?.result.status === 'accepted' && row.receipt.result.reservation?.state === 'returning')).toBe(true)
  const released = {...returning, result: {status: 'accepted' as const, reservation: f.reservation('released', 0)}}
  await f.service.exchange('air', {schemaVersion: 1, receipts: [released]})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [granted, returning]})
  expect((await f.service.listResource('phone-exact', 'alice')).controls.every(row =>
    row.receipt?.result.status === 'accepted' && row.receipt.result.reservation?.state === 'released')).toBe(true)
  expect((await f.service.submit(f.input('reserve'), 'alice')).action).toBe('reserve')
})


test('delayed zero-generation active observation cannot erase the original known grant fence', async () => {
  const f = fixture(), reserve = f.input('reserve')
  await f.service.submit(reserve, 'alice')
  const original = f.receipt(reserve, {status: 'accepted', reservation: f.reservation('granted', 0)})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [original]})
  const actual = {...original, result: {status: 'accepted' as const, reservation: f.reservation('granted', 9)}}
  await f.service.exchange('air', {schemaVersion: 1, receipts: [actual]})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [original]})
  expect((await f.service.listResource('phone-exact', 'alice')).controls[0]?.receipt?.result).toMatchObject({reservation: {generation: 9, state: 'granted'}})
  const conflicting = {...actual, result: {status: 'accepted' as const, reservation: f.reservation('granted', 10)}}
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [conflicting]})).rejects.toThrow('generation or terminal decision changed')
  const release = f.input('release', {reservation: {id: 'manual-exact', generation: 9}})
  await expect(f.service.submit({...release, reservation: {id: 'manual-exact', generation: 0}}, 'alice')).rejects.toThrow('your current')
  await f.service.submit(release, 'alice')
  await f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(release, {status: 'accepted', reservation: f.reservation('released', 9)})]})
})


test('returning zero keeps the retained nonzero constraint outside its exact controller receipt', async () => {
  const f = fixture(), reserve = f.input('reserve')
  await f.service.submit(reserve, 'alice')
  const waiting = f.receipt(reserve, {status: 'accepted', reservation: f.reservation('waiting', 0)})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [waiting]})
  const release = f.input('release', {reservation: {id: 'manual-exact', generation: 0}})
  await f.service.submit(release, 'alice')
  const granted = {...waiting, result: {status: 'accepted' as const, reservation: f.reservation('granted', 9)}}
  await f.service.exchange('air', {schemaVersion: 1, receipts: [granted]})
  const returning = f.receipt(release, {status: 'accepted', reservation: f.reservation('returning', 0)})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [returning]})
  const retained = structuredClone(f.rows())
  expect(retained.every(row => row.reservationGenerationConstraint === 9)).toBe(true)
  expect(retained.find(row => row.command.operationId === release.operationId)?.receipt).toEqual(returning)
  expect((await f.service.listResource('phone-exact', 'alice')).controls.every(row => row.reservationGenerationConstraint === 9)).toBe(true)
  const forgedGeneration = {...granted, result: {status: 'accepted' as const, reservation: f.reservation('returning', 10)}}
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [forgedGeneration]})).rejects.toThrow('generation or terminal decision changed')
  expect(f.rows()).toEqual(retained)
  const released = {...returning, result: {status: 'accepted' as const, reservation: f.reservation('released', 0)}}
  await f.service.exchange('air', {schemaVersion: 1, receipts: [released]})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [granted, returning]})
  expect(f.rows().every(row => row.reservationGenerationConstraint === 9)).toBe(true)
  expect(f.rows().every(row => row.receipt?.result.status === 'accepted' && row.receipt.result.reservation?.generation === 0 && row.receipt.result.reservation.state === 'released')).toBe(true)
})
