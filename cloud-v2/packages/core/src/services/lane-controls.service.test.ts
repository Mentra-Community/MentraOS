import {expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {LaneControlsService, type LaneControlHost, type LaneControlRepository} from './lane-controls.service'
import type {LaneControlInput, LaneControlReceipt, LaneControlRecord} from '../types/lane-control.types'
import {requestInputDigest} from './test-request.service'
function fixture() {
  const now = Date.now()
  let collisions = 0
  let host: LaneControlHost = {hostId: 'air', laneControlVersion: 0, laneControls: [],
    observedAt: new Date(now), receivedAt: new Date(now), snapshot: {laneControls: {schemaVersion: 1, receipts: []}, lanes: [{id: 'phone', dispatchMode: 'automatic'}]}}
  const repository: LaneControlRepository = {async get(id) {return id === host.hostId ? structuredClone(host) : null},
    async replace(id, version, records) {if (collisions-- > 0 || id !== host.hostId || version !== host.laneControlVersion) return false
      host = {...host, laneControls: structuredClone(records), laneControlVersion: version + 1}; return true}}
  const service = new LaneControlsService(repository, () => now)
  const input = (action: LaneControlInput['action'], more: Partial<LaneControlInput> = {}): LaneControlInput =>
    ({operationId: randomUUID(), expiresAt: now + 120000, hostId: 'air', laneId: 'phone', action, ...more})
  const rows = () => host.laneControls as LaneControlRecord[]
  const receipt = (input: LaneControlInput, result: LaneControlReceipt['result']): LaneControlReceipt => ({operationId: input.operationId,
    hostId: input.hostId, laneId: input.laneId, inputSha256: requestInputDigest(rows().find(row => row.command.operationId === input.operationId)!.command),
    completedAt: new Date(now).toISOString(), result})
  return {service, input, rows, receipt, host: () => host, collide() {collisions = 1}, now}
}
test('submission keeps exact identity through CAS and lost responses and derives owner from the signed-in operator', async () => {
  const f = fixture(), pause = f.input('pause'); f.collide()
  const accepted = await f.service.submit(pause, 'alice')
  expect(await f.service.submit(pause, 'alice')).toEqual(accepted)
  expect(f.rows()).toHaveLength(1); expect(f.rows()[0]!.command.operatorId).toMatch(/^[a-f0-9]{64}$/)
  await expect(f.service.submit(pause, 'bob')).rejects.toThrow('identity changed')
  await expect(f.service.submit({...pause, action: 'resume'}, 'alice')).rejects.toThrow('identity changed')
  await expect(f.service.submit(f.input('resume', {hostId: 'other'}), 'alice')).rejects.toThrow('not found')
  await expect(f.service.submit(f.input('resume', {laneId: 'other'}), 'alice')).rejects.toThrow('not found')
  await expect(f.service.submit(f.input('resume', {expiresAt: f.now - 1}), 'alice')).rejects.toThrow('expired')
  expect((await f.service.list('air', 'bob')).controls).toEqual([])
})
test('accepted waiting reserve can be cancelled by its owner; release requires exact lane and generation', async () => {
  const f = fixture(), reserve = f.input('reserve', {purpose: 'Manual work'})
  await f.service.submit(reserve, 'alice')
  const waiting = {id: 'reservation', laneId: 'phone', generation: 0, state: 'waiting' as const, purpose: 'Manual work', requestedAt: new Date(f.now).toISOString()}
  await f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(reserve, {status: 'accepted', reservation: waiting})]})
  const release = f.input('release', {reservation: {id: waiting.id, generation: 0}})
  await expect(f.service.submit(release, 'bob')).rejects.toThrow('your current')
  await expect(f.service.submit({...release, reservation: {id: waiting.id, generation: 1}}, 'alice')).rejects.toThrow('your current')
  expect((await f.service.submit(release, 'alice')).action).toBe('release')
  expect(f.rows()).toHaveLength(2)
})
test('receipts fence wrong host, action and identity and older reservation observations never resurrect ownership', async () => {
  const f = fixture(), reserve = f.input('reserve', {purpose: 'Manual work'})
  await f.service.submit(reserve, 'alice')
  const reservation = {id: 'reservation', laneId: 'phone', generation: 1, state: 'granted' as const, purpose: 'Manual work', requestedAt: new Date(f.now).toISOString()}
  const original = f.receipt(reserve, {status: 'accepted', reservation})
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [{...original, hostId: 'other'}]})).rejects.toThrow('differs')
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(reserve, {status: 'accepted', mode: 'paused'})]})).rejects.toThrow('requested action')
  await f.service.exchange('air', {schemaVersion: 1, receipts: [original]})
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [{...original, result: {status: 'accepted', reservation: {...reservation, id: 'other'}}}]})).rejects.toThrow('identity')
  await f.service.exchange('air', {schemaVersion: 1, receipts: [{...original, result: {status: 'accepted', reservation: {...reservation, state: 'released'}}}]})
  await f.service.exchange('air', {schemaVersion: 1, receipts: [original]})
  expect(f.rows()[0]!.receipt!.result).toMatchObject({reservation: {state: 'released'}})
})
test('delivery retention is bounded and new work does not get blocked by terminal history', async () => {
  const f = fixture()
  for (let i = 0; i < 105; i++) {
    const pause = f.input('pause'); await f.service.submit(pause, 'alice')
    await f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(pause, {status: 'accepted', mode: 'paused'})]})
  }
  expect(f.rows()).toHaveLength(100)
  f.host().receivedAt = new Date(f.now - 120001)
  expect((await f.service.list('air', 'alice')).fresh).toBe(false)
  await expect(f.service.submit(f.input('resume'), 'alice')).rejects.toThrow('Refresh lane status')
})

test('existing authenticated host-report route returns only that host controls and keeps the shared exchange strict', async()=>{
 const {createTestHostStateApi} = await import('../api/internal/test-host-state.api')
 const {TestHostStateService} = await import('./test-host-state.service')
 const f=fixture(), pause=f.input('pause');await f.service.submit(pause,'alice')
 class State extends TestHostStateService {override async report(input: unknown, hostId: string) {
  const {hostStateSchema}=await import('./test-host-state.service');const parsed=hostStateSchema.parse(input)
  if(parsed.hostId!==hostId) throw new Error('Wrong host')
  return {hostId,incarnation:parsed.incarnation,incarnationGeneration:parsed.incarnationGeneration,sequence:parsed.sequence}
 }}
 const token='a'.repeat(32), api=createTestHostStateApi(new State(),()=>JSON.stringify({air:token}),f.service)
 const value={hostId:'air',incarnation:'boot',incarnationGeneration:1,sequence:1,observedAt:new Date(f.now).toISOString(),
  lanes:[{id:'phone',platform:'android',dispatchMode:'automatic',state:'idle',resources:[]}],laneControls:{schemaVersion:1,receipts:[]}}
 const post=(body:unknown,authorization:string|null=token)=>api.request('/',{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:`Bearer ${authorization}`}:{})},body:JSON.stringify(body)})
 expect((await post(value,null)).status).toBe(401)
 const response=await post(value);expect(response.status).toBe(200)
 expect((await response.json() as {laneControls:{commands:unknown[]}}).laneControls.commands).toEqual([f.rows()[0]!.command])
 expect((await post({...value,laneControls:{schemaVersion:1,receipts:[],method:'lane.reset'}})).status).toBe(400)
})

test('returned reservation in a release receipt cannot be resurrected by an older retained reserve receipt', async()=>{
 const f=fixture(), reserve=f.input('reserve',{purpose:'Manual work'});await f.service.submit(reserve,'alice')
 const held={id:'held',laneId:'phone',generation:1,state:'granted' as const,purpose:'Manual work',requestedAt:new Date(f.now).toISOString()}
 await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(reserve,{status:'accepted',reservation:held})]})
 const release=f.input('release',{reservation:{id:'held',generation:1}});await f.service.submit(release,'alice')
 await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(release,{status:'accepted',reservation:{...held,state:'released'}})]})
 const newReserve=f.input('reserve',{purpose:'New work'})
 expect((await f.service.submit(newReserve,'alice')).operationId).toBe(newReserve.operationId)
})

test('terminal reservation observation survives history churn without leaking an active reserve record', async()=>{
 const f=fixture(), reserve=f.input('reserve',{purpose:'Manual work'});await f.service.submit(reserve,'alice')
 const held={id:'held',laneId:'phone',generation:1,state:'granted' as const,purpose:'Manual work',requestedAt:new Date(f.now).toISOString()}
 await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(reserve,{status:'accepted',reservation:held})]})
 const release=f.input('release',{reservation:{id:'held',generation:1}});await f.service.submit(release,'alice')
 const finished=await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(release,{status:'accepted',reservation:{...held,state:'released'}})]})
 expect(finished.commands).toEqual([])
 for(let i=0;i<105;i++){
  const pause=f.input('pause');await f.service.submit(pause,'alice')
  await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(pause,{status:'accepted',mode:'paused'})]})
 }
 expect((await f.service.submit(f.input('reserve',{purpose:'Again'}),'alice')).action).toBe('reserve')
})
test('99 unresolved commands leave one slot after dropping terminal history', async()=>{
 const f=fixture()
 f.host().snapshot.lanes=Array.from({length:101},(_,i)=>({id:`lane-${i}`,dispatchMode:'automatic'}))
 const terminal=f.input('pause',{laneId:'lane-100'});await f.service.submit(terminal,'alice')
 await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(terminal,{status:'accepted',mode:'paused'})]})
 for(let i=0;i<99;i++)await f.service.submit(f.input('pause',{laneId:`lane-${i}`}), 'alice')
 expect((await f.service.submit(f.input('pause',{laneId:'lane-99'}),'alice')).laneId).toBe('lane-99')
 expect(f.rows()).toHaveLength(100)
})

test('bounded command admission always preserves return space for every accepted reservation, including cleanup in flight',async()=>{
 const f=fixture();f.host().snapshot.lanes=Array.from({length:100},(_,i)=>({id:`lane-${i}`,dispatchMode:'automatic'}))
 const held:Array<{id:string,laneId:string,generation:number,state:'granted',purpose:string,requestedAt:string}>=[]
 for(let i=0;i<50;i++){
  const reserve=f.input('reserve',{laneId:`lane-${i}`,purpose:'Manual work'});await f.service.submit(reserve,'alice')
  const reservation={id:`held-${i}`,laneId:reserve.laneId,generation:1,state:'granted' as const,purpose:'Manual work',requestedAt:new Date(f.now).toISOString()};held.push(reservation)
  await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(reserve,{status:'accepted',reservation})]})
 }
 await expect(f.service.submit(f.input('reserve',{laneId:'lane-50',purpose:'Extra'}),'alice')).rejects.toThrow('retain space for release')
 await expect(f.service.submit(f.input('pause',{laneId:'lane-50'}),'alice')).rejects.toThrow('retain space for release')
 for(const reservation of held){
  const release=f.input('release',{laneId:reservation.laneId,reservation:{id:reservation.id,generation:1}})
  await f.service.submit(release,'alice')
  await f.service.exchange('air',{schemaVersion:1,receipts:[f.receipt(release,{status:'accepted',reservation:{...reservation,state:'returning'}})]})
 }
 expect(f.rows()).toHaveLength(100)
 expect(f.rows().filter(row=>row.command.action==='release')).toHaveLength(50)
})

function halted(f: ReturnType<typeof fixture>) {
  const repair = {executionId: 'fixer:original', interruptionId: 'repair:phone:98', laneId: 'phone',
    state: 'halted' as const, current: false, startedAt: new Date(f.now - 1000).toISOString(),
    finishedAt: new Date(f.now).toISOString(), haltDecisionId: 'halt:original'}
  f.host().snapshot.laneControls = {schemaVersion: 1, receipts: [], reopenRepair: true}
  f.host().snapshot.lanes = [{id: 'phone', state: 'out-of-service', dispatchMode: 'automatic',
    activity: {generation: 99, owner: {id: repair.executionId, kind: 'fixer'}}}]
  f.host().snapshot.restoration = {attempts: [repair]}
  return {repair, input: f.input('reopen-repair', {repair: {interruptionId: repair.interruptionId,
    expectedHaltDecisionId: repair.haltDecisionId, changedConditions: 'I allowed the requested microphone permission.'}})}
}

test('recovery uses the existing signed-in delivery and records repair custody rather than scheduling success', async () => {
  const f = fixture(), {input} = halted(f)
  expect((await f.service.list('air', 'alice')).reopenRepair).toBe(true)
  const accepted = await f.service.submit(input, 'alice')
  expect(await f.service.submit(input, 'alice')).toEqual(accepted)
  expect(f.rows()).toHaveLength(1)
  expect(f.rows()[0]!.command.repair).toEqual(input.repair)
  const result = {status: 'accepted' as const, repair: {interruptionId: input.repair!.interruptionId,
    laneId: 'phone', status: 'in-repair' as const, generation: 100, fixerExecutionId: 'fixer:next'}}
  await expect(f.service.exchange('air', {schemaVersion: 1, reopenRepair: true,
    receipts: [f.receipt(input, {...result, mode: 'automatic'})]})).rejects.toThrow('requested action')
  await expect(f.service.exchange('air', {schemaVersion: 1, receipts: [f.receipt(input,
    {...result, repair: {...result.repair, interruptionId: 'repair:foreign'}})]})).rejects.toThrow('requested action')
  await f.service.exchange('air', {schemaVersion: 1, reopenRepair: true, receipts: [f.receipt(input, result)]})
  expect((await f.service.list('air', 'alice')).controls[0]!.receipt!.result).toEqual(result)
  expect(f.host().snapshot.lanes[0]!.state).toBe('out-of-service')
  expect(f.host().snapshot.lanes[0]!.dispatchMode).toBe('automatic')
})

test('recovery admission refuses old halt, changed repair, active fixer, missing halt and unsupported controller', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.laneControls = {schemaVersion: 1, receipts: []}},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.lanes[0]!.state = 'in-repair'},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.lanes[0]!.activity!.owner.id = 'fixer:other'},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.restoration!.attempts[0]!.state = 'working'},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.restoration!.attempts[0]!.current = true},
    (f: ReturnType<typeof fixture>) => {delete f.host().snapshot.restoration!.attempts[0]!.haltDecisionId},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.restoration!.attempts[0]!.haltDecisionId = 'halt:new'},
    (f: ReturnType<typeof fixture>) => {f.host().snapshot.restoration!.attempts.push({...f.host().snapshot.restoration!.attempts[0]!})},
  ]) {
    const f = fixture(), {input} = halted(f); change(f)
    await expect(f.service.submit(input, 'alice')).rejects.toThrow()
    expect(f.rows()).toEqual([])
  }
  const f = fixture(), {input} = halted(f)
  await expect(f.service.submit({...input, repair: {...input.repair!, changedConditions: '   '}}, 'alice')).rejects.toThrow()
  await expect(f.service.submit({...input, action: 'resume'}, 'alice')).rejects.toThrow()
  await expect(f.service.submit({...input, repair: {...input.repair!, assumeReady: true}}, 'alice')).rejects.toThrow()
})

test('admin email stays in Core metadata and never changes authenticated command delivery or retries', async () => {
  const f = fixture(), input = f.input('reserve', {purpose: 'Manual work'})
  const first = await f.service.submit(input, 'alice-id', 'alice@example.com')
  expect(f.rows()[0].operatorLabel).toBe('alice@example.com')
  expect(f.rows()[0].command).not.toHaveProperty('operatorLabel')
  expect(await f.service.submit(input, 'alice-id', 'new-address@example.com')).toEqual(first)
  expect(f.rows()[0].operatorLabel).toBe('alice@example.com')
  const delivery = await f.service.exchange('air', {schemaVersion: 1, receipts: []})
  expect(delivery.commands).toEqual([f.rows()[0].command])
  expect(JSON.stringify(delivery)).not.toContain('alice@example.com')
  expect(JSON.stringify(await f.service.list('air', 'alice-id'))).not.toContain('alice@example.com')
  await expect(f.service.submit({...input, operatorLabel: 'spoof@example.com'}, 'alice-id')).rejects.toThrow()
  await expect(f.service.submit(input, 'bob-id', 'alice@example.com')).rejects.toThrow('identity changed')
})

test('authorized credential and user-ID labels can reserve without an email address', async () => {
  for (const label of ['credential:operator-key', 'usr_no_email']) {
    const f = fixture(), input = f.input('reserve', {purpose: 'Manual work'})
    await f.service.submit(input, 'authenticated-id', label)
    expect(f.rows()[0].operatorLabel).toBe(label)
    expect(f.rows()[0].command).not.toHaveProperty('operatorLabel')
    expect((await f.service.exchange('air', {schemaVersion: 1, receipts: []})).commands).toEqual([f.rows()[0].command])
  }
})
