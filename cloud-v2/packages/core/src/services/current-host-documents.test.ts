import {expect, spyOn, test} from 'bun:test'
import {TestHostStateModel} from '../models/test-host-state.model'
import {hostStateSchema, TestHostStateService} from './test-host-state.service'
import type {TestHostHistoryRepository} from './test-host-history.repository'
import {advanceResourceLifecycleCursor} from './resource-lifecycle.service'
import {LaneControlsService, type LaneControlHost, type LaneControlRepository} from './lane-controls.service'

const at = '2026-10-27T18:00:00.000Z'
const binding = {version: 1527, revision: 'a'.repeat(40), installationId: 'accepted',
  configurationSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64), routineApiVersion: 110, publicApiSha256: 'd'.repeat(64)}
const process = {pid: 58275, startedAt: 'exact process birth'}
const snapshot = (generation = 1, sequence = 1) => ({hostId: 'air2', incarnation: `boot-${generation}`,
  incarnationGeneration: generation, sequence, observedAt: at, frameworkBinding: binding,
  frameworkAcceptedAt: at, frameworkProcess: process,
  lanes: [{id: 'android', platform: 'android', state: 'in-repair', dispatchMode: 'automatic', resources: [],
    activity: {generation: 1180, owner: {kind: 'fixer' as const, id: 'repair-1179'}}}],
  frameworkHistory: [{malformed: 'debug history cannot define current state'}],
  restoration: {attempts: [], diagnostics: 'legacy payload'},
  resourceLifecycle: {schemaVersion: 1, subjects: [], history: [{malformed: 'legacy event'}]},
})

test('current report validates live custody independently of malformed debug history', () => {
  const input = snapshot(), original = structuredClone(input), current = hostStateSchema.parse(input)
  expect(current.lanes[0].activity).toEqual(input.lanes[0].activity)
  expect(current.resourceLifecycle).toEqual({schemaVersion: 1, subjects: []})
  expect(current).not.toHaveProperty('frameworkHistory')
  expect(current).not.toHaveProperty('restoration')
  expect(input).toEqual(original)
  expect(() => hostStateSchema.parse({...input, lanes: [{...input.lanes[0], state: 'idle'}]})).toThrow('active custody')
  expect(() => hostStateSchema.parse({...input, frameworkProcess: undefined})).toThrow('process identity')
})

test('current cursor does not parse or retain debug events', () => {
  expect(advanceResourceLifecycleCursor({schemaVersion: 1, subjects: [], history: Array(10_000).fill({invalid: true})},
    {schemaVersion: 1, subjects: [], history: [{invalid: true}]})).toEqual({schemaVersion: 1, subjects: []})
})

test('current report retains only its owned halted repair and supports ordinary operator reopen delivery', async () => {
  const input = snapshot(), repair = {executionId: 'repair-1179', interruptionId: 'repair:android:1179', laneId: 'android',
    state: 'halted' as const, current: false, startedAt: at, finishedAt: at, haltDecisionId: 'halt:original'}
  input.lanes[0]!.state = 'out-of-service'
  input.restoration.attempts = [repair, {...repair, executionId: 'completed-old-repair'}] as never[]
  const current = hostStateSchema.parse({...input, laneControls: {schemaVersion: 1, receipts: [], reopenRepair: true}})
  expect(current.repairStatuses).toEqual([repair]); expect(current).not.toHaveProperty('restoration')
  const host: LaneControlHost = {hostId: current.hostId, receivedAt: new Date(at), observedAt: new Date(at),
    snapshot: current, laneControls: [], laneControlVersion: 0}
  const rows: LaneControlRepository = {async get(id) {return id === host.hostId ? structuredClone(host) : null},
    async replace(id, version, records) {if (id !== host.hostId || version !== host.laneControlVersion) return false
      host.laneControls = structuredClone(records); host.laneControlVersion!++; return true}}
  const result = await new LaneControlsService(rows, () => Date.parse(at)).submit({operationId: '70000000-0000-4000-8000-000000000001',
    hostId: host.hostId, laneId: 'android', action: 'reopen-repair', expiresAt: Date.parse(at) + 120_000,
    repair: {interruptionId: repair.interruptionId, expectedHaltDecisionId: repair.haltDecisionId,
      changedConditions: 'The operator observed the current machine state.'}}, 'operator')
  expect(result.action).toBe('reopen-repair'); expect(result).not.toHaveProperty('receipt')
  expect(host.laneControls).toHaveLength(1)
  expect(host.snapshot.lanes[0]!.activity?.owner.id).toBe(repair.executionId)
  expect(host.snapshot.resourceLifecycle).toEqual({schemaVersion: 1, subjects: []})
})

test('accepted host CAS removes legacy histories, survives failed debug delivery and preserves current claims on restart', async () => {
  const claim = {kind: 'exclusive', id: 'b40ad384-3fbd-4b3a-ad82-9e8aa7b535e3',
    authorityHostId: 'air2', borrowerHostId: 'air2', laneId: 'android', resourceId: 'phone',
    operationId: 'repair-1179', owner: {kind: 'fixer' as const, id: 'repair-1179'},
    inputSha256: 'e'.repeat(64), intentSha256: 'f'.repeat(64), controllerIncarnation: 'boot-1',
    controllerGeneration: 1, borrowerSequence: 1, reservedAt: at}
  let row: Record<string, any> = {hostId: 'air2', incarnation: 'boot-1', incarnationGeneration: 1, sequence: 1,
    snapshot: snapshot(), receivedAt: new Date(at), resourceReservations: [claim], resourceReservationVersion: 7,
    frameworkHistory: Array(10_000).fill({invalid: true}), frameworkStopReceipts: [{invalid: true}],
    resourceLifecycleCursor: {schemaVersion: 1, subjects: [], history: [{invalid: true}]}}
  const selections: Record<string, any>[] = [], writes: Record<string, any>[] = [], debug: unknown[] = []
  const query = (value: () => any) => {
    const q = {select(fields: Record<string, any>) {selections.push(fields); return q}, read() {return q},
      readConcern() {return q}, setOptions() {return q}, async lean() {return structuredClone(value())}}
    return q
  }
  const read = spyOn(TestHostStateModel, 'findOne').mockImplementation((() => query(() => row)) as never)
  const write = spyOn(TestHostStateModel, 'findOneAndUpdate').mockImplementation(((filter: Record<string, any>, update: Record<string, any>) => query(() => {
    expect(filter).toMatchObject({hostId: row.hostId, incarnation: row.incarnation,
      incarnationGeneration: row.incarnationGeneration, sequence: row.sequence})
    writes.push(update)
    row = {...row, ...update.$set}
    for (const name of Object.keys(update.$unset ?? {})) delete row[name]
    return row
  })) as never)
  const history: TestHostHistoryRepository = {async debug(value) {debug.push(value); throw new Error('debug store unavailable')},
    async detail() {throw new Error('current acceptance must not read debug')}}
  try {
    const service = new TestHostStateService(() => Date.parse(at), undefined, history)
    await expect(service.report(snapshot(1, 2), 'air2')).resolves.toMatchObject({sequence: 2})
    await expect(service.report({...snapshot(2, 1), frameworkProcess: {pid: 60000, startedAt: 'new exact birth'}}, 'air2'))
      .resolves.toMatchObject({incarnationGeneration: 2, sequence: 1})
    expect(row.resourceReservations).toEqual([claim])
    expect(row.resourceReservationVersion).toBe(7)
    expect(row.snapshot.lanes[0].activity.owner).toEqual(claim.owner)
    expect(row).not.toHaveProperty('frameworkHistory')
    expect(row).not.toHaveProperty('frameworkStopReceipts')
    expect(row.snapshot).not.toHaveProperty('restoration')
    expect(row.snapshot.resourceLifecycle).toEqual({schemaVersion: 1, subjects: []})
    expect(row.resourceLifecycleCursor).toEqual({schemaVersion: 1, subjects: []})
    expect(debug).toHaveLength(3)
    expect(writes).toHaveLength(2)
    expect(selections.filter(value => value.frameworkHistory || value.frameworkStopReceipts || value.resourceLifecycleCursor)).toEqual([])
    await expect(service.report({...snapshot(2, 2), frameworkBinding: {...binding, revision: 'e'.repeat(40)}}, 'air2'))
      .rejects.toThrow('accepted identity changed')
    expect(writes).toHaveLength(2)
  } finally {read.mockRestore(); write.mockRestore()}
})
