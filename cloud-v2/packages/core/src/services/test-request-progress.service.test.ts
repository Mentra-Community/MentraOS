import {expect, test} from 'bun:test'
import {TestRequestProgressService} from './test-request-progress.service'
import {requestInputDigest, type StoredRequest} from './test-request.service'
import {matchingRoutineProgress, routineProgressSchema} from '../types/routine-progress.types'
import {testRoutineSource} from '../testing/framework-fixtures'
import type {RoutineEnrollment} from '../types/routine-definition.types'

function fixture() {
  const steps = [{id: 'open', instruction: 'Open miniapp', expected: 'Miniapp opens'},
    {id: 'close', instruction: 'Close miniapp', expected: 'Home is visible'},
    {id: 'verify-home', instruction: 'Verify Home', expected: 'Home remains visible'}]
  const input = {routineId: 'miniapps', routineSource: testRoutineSource(), definitionRevision: 'a'.repeat(40), platform: 'android',
    laneId: 'phone', resources: [], build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)}}
  const requestId = 'run-one', inputSha256 = requestInputDigest(input)
  const row = {requestId, hostId: 'host-one', state: 'accepted', input, inputSha256,
    hostReceipt: {requestId, hostId: 'host-one', inputSha256, acceptedAt: '2026-10-03T00:58:00Z'}} as StoredRequest
  const progress = routineProgressSchema.parse({requestId, requestDigest: inputSha256, ownerGeneration: 7,
    controllerIncarnation: 'boot-one', sequence: 9, phase: 'test', currentStep: {id: 'close', index: 1},
    completedSteps: 1, totalSteps: 3, startedAt: '2026-10-03T00:58:00Z', lastProgressAt: '2026-10-03T00:59:00Z',
    observedAt: '2026-10-03T01:00:00Z'})
  const host = {incarnation: 'boot-one', sequence: 9, receivedAt: '2026-10-03T01:00:00Z', lane: {id: 'phone', activity: {generation: 7,
    owner: {kind: 'run' as const, id: requestId, requestId}}, progress}}
  const definition = {routineId: 'miniapps', platform: 'android', definitionRevision: input.definitionRevision,
    definition: {title: 'Open and close miniapps', steps}} as RoutineEnrollment
  definition.definitionSha256 = requestInputDigest(definition.definition)
  const calls: unknown[][] = []
  const service = new TestRequestProgressService({async progressObservation(...args) {calls.push(args); return host}},
    {async getExact(...args) {calls.push(args); return definition}}, () => Date.parse('2026-10-03T01:00:02Z'))
  return {row, progress, host, definition, steps, calls, service}
}

test('ordinary request live details use its exact definition and authenticated current owner without a result', async () => {
  const f = fixture(), live = await f.service.get(f.row)
  expect(live).toEqual({progress: f.progress, receivedAt: f.host.receivedAt, observationAgeMs: 2000, title: f.definition.definition.title,
    steps: f.steps.map(({id, instruction}) => ({id, instruction}))})
  expect(f.calls).toEqual([['host-one', 'phone'], ['miniapps', 'android', 'a'.repeat(40)]])
})

test('live observation rejects another request, digest, owner, incarnation, sequence or definition step', () => {
  const f = fixture(), ids = f.steps.map(step => step.id)
  for (const change of [{requestId: 'other'}, {requestDigest: 'e'.repeat(64)}, {ownerGeneration: 8},
    {controllerIncarnation: 'old-boot'}, {sequence: 8}, {totalSteps: 4}, {currentStep: {id: 'unknown', index: 1}}]) {
    expect(matchingRoutineProgress(f.host, {...f.host.lane, progress: {...f.progress, ...change}}, f.row, ids)).toBeUndefined()
  }
  expect(matchingRoutineProgress(f.host, {...f.host.lane, activity: undefined}, f.row, ids)).toBeUndefined()
  expect(matchingRoutineProgress(f.host, {...f.host.lane, activity: {generation: 7, owner: {kind: 'fixer', id: 'run-one'}}}, f.row, ids)).toBeUndefined()
})

test('preparation is observable before product steps begin and does not claim completed results', () => {
  const f = fixture(), preparation = {...f.progress, phase: 'preparation' as const, currentStep: undefined, completedSteps: 0, totalSteps: 0}
  expect(matchingRoutineProgress(f.host, {...f.host.lane, progress: preparation}, f.row, f.steps.map(step => step.id))).toEqual(preparation)
})

test('queued work, unaccepted input, changed input, missing progress and unverifiable definitions never gain live status', async () => {
  for (const change of [{hostReceipt: undefined}, {inputSha256: 'f'.repeat(64)}, {input: null}, {state: 'terminal'}]) {
    const f = fixture()
    expect(await f.service.get({...f.row, ...change} as StoredRequest)).toBeUndefined()
    expect(f.calls).toHaveLength(0)
  }
  const f = fixture()
  f.host.lane.progress = undefined as never
  expect(await f.service.get(f.row)).toBeUndefined()
  expect(f.calls).toEqual([['host-one', 'phone']])
  const g = fixture()
  g.definition.definitionSha256 = 'f'.repeat(64)
  expect(await g.service.get(g.row)).toBeUndefined()
})
test('accepted queued disk blocker is displayed without inventing running progress or step completion',async()=>{
 const f=fixture(),waiting={requestId:f.row.requestId,requestDigest:f.row.inputSha256!,acceptedAt:f.row.hostReceipt!.acceptedAt,
  observedAt:'2026-10-03T00:59:00Z',code:'storage-capacity' as const,reason:'Available disk cannot cover estimated output plus 2 GB margin'}
 const host={...f.host,lane:{id:'phone',waiting:[waiting]}}
 const service=new TestRequestProgressService({async progressObservation(){return host}},undefined,()=>Date.parse('2026-10-03T01:00:02Z'))
 expect(await service.get(f.row)).toEqual(waiting)
 for(const change of [{requestId:'other'},{requestDigest:'f'.repeat(64)},{acceptedAt:'2026-10-03T00:57:00Z'},{observedAt:'2026-10-03T01:00:03Z'}]){
  host.lane.waiting=[{...waiting,...change}];expect(await service.get(f.row)).toBeUndefined()
 }
})
