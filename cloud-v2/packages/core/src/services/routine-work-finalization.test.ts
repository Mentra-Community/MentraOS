import {expect, spyOn, test} from 'bun:test'
import {fixture, input} from './routine-work.service.test'
import {routineWorkStatusSchema, routineWorkVerificationSchema} from '../types/routine-work.types'
import type {RoutineWorkDelivery, RoutineWorkRepository} from './routine-work.service'
import {requestInputDigest} from './test-request.service'
import {testRoutineSource} from '../testing/framework-fixtures'
import {createRoutineWorkDeliveriesApi} from '../api/internal/routine-work.api'
import {RoutineWorkService} from './routine-work.service'
import {RoutineWorkModel} from '../models/routine-work.model'
import {testWriteConcern} from '../models/test-write-concern'
import {CandidateVerificationService} from './candidate-verification.service'

async function finalizationFixture(originalSequence = 4) {
  let now = Date.parse('2026-10-05T11:01:01.000Z'), reads = 0
  let candidate: {request: Record<string, unknown>; run: Record<string, unknown>} | null = null
  let afterCandidate = () => {}, beforeWrite = (_row: RoutineWorkDelivery) => {}
  const readCandidate = async () => {
    reads++; afterCandidate(); return structuredClone(candidate)
  }
  const f = fixture({now: () => now, passedCandidate: readCandidate, beforeVerificationWrite: row => beforeWrite(row)})
  const row = await f.service.submit(input)
  const accepted = {workId: row.workId, inputSha256: row.inputSha256, hostId: row.hostId, acceptedAt: '2026-10-05T10:00:00.000Z'}
  await f.service.accept(accepted, row.hostId)
  const details = {reason: 'Original source preservation refused', sourceRevision: 'c'.repeat(40), requestId: 'original-passed',
    prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601', review: {sourceRevision: 'c'.repeat(40),
      prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601',
      reviewUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601#pullrequestreview-21', verdict: 'APPROVED'}}
  const {acceptedAt: _, ...binding} = accepted
  const original = routineWorkStatusSchema.parse({...binding, eventId: 'original-finalize-failed', sequence: originalSequence, state: 'failed',
    details: {...accepted, work: row.work, attemptId: 2, state: 'failed', sequence: originalSequence, details,
      events: [{eventId: 'original-finalize-failed', sequence: originalSequence, state: 'failed', at: '2026-10-05T11:00:00.000Z', details}]}})
  await f.service.status(original, row.hostId)
  const runInput = {routineId: row.work.routineId, definitionRevision: details.sourceRevision, routineSource: testRoutineSource(details.sourceRevision),
    platform: 'android', laneId: row.work.target.laneId, build: row.work.build, resources: [],
    verification: {workId: row.workId, attemptId: 2, sourceRevision: details.sourceRevision}}
  const runInputSha256 = requestInputDigest(runInput)
  candidate = {request: {requestId: details.requestId, hostId: row.hostId, state: 'terminal', terminalStatus: 'pass',
    input: runInput, inputSha256: runInputSha256, runId: 'original-native-run'},
  run: {runId: 'original-native-run', requestId: details.requestId, hostId: row.hostId, routineId: row.work.routineId,
    definitionRevision: details.sourceRevision, outcome: 'pass', uploadsComplete: true, recordedPassingExample: true,
    recordingAssetId: 'original-recording', verification: runInput.verification, build: runInput.build}}
  const identity = {decisionId: 'finalize-original', inputSha256: 'd'.repeat(64), failureEventId: original.eventId,
    failureSha256: requestInputDigest(original), acceptedAt: '2026-10-05T11:01:00.000Z', deadline: '2026-10-05T11:31:00.000Z',
    previousFailure: {code: 'workspace-generated-unaccounted', reason: details.reason},
    finalization: {requestId: details.requestId, sourceRevision: details.sourceRevision, runInputSha256, operationId: 'original-completion',
      originalDeadline: row.fleetDeadline!.toISOString(), completionSha256: '1'.repeat(64), cacheProofSha256: '2'.repeat(64),
      candidateSha256: '3'.repeat(64), recordingSha256: '4'.repeat(64), restorationSha256: '5'.repeat(64)}}
  const event = routineWorkStatusSchema.parse({...original, eventId: identity.decisionId, sequence: originalSequence+1, state: 'verifying',
    details: {...original.details, state: 'verifying', sequence: originalSequence+1, events: [...original.details.events,
      {eventId: identity.decisionId, sequence: originalSequence+1, state: 'verifying', at: '2026-10-05T11:01:00.003Z', details}]}})
  const terminal = (state: 'passed' | 'cancelled') => {
    const resultUrl = 'https://admin.mentraglass.com/?testRun=original-native-run'
    const terminalDetails = {...details, summary: state === 'passed' ? 'Original source finalized' : 'Original retry cancelled',
      ...(state === 'passed' ? {completion: {sourceRevision: details.sourceRevision, reviewedRevision: details.sourceRevision,
        prUrl: details.prUrl, reviewUrl: details.review.reviewUrl, resultUrl, summary: 'Original source finalized'}, resultUrl} : {})}
    return routineWorkStatusSchema.parse({...event, eventId: `finalize-${state}`, sequence: originalSequence+2, state,
      details: {...event.details, state, sequence: originalSequence+2, details: terminalDetails, events: [...event.details.events,
        {eventId: `finalize-${state}`, sequence: originalSequence+2, state, at: '2026-10-05T11:02:00.000Z', details: terminalDetails}]}})
  }
  return {...f, row, original, identity, event, terminal, get candidate() {return candidate!},
    setCandidate(value: typeof candidate) {candidate = value}, setNow(value: number) {now = value}, get reads() {return reads},
    readCandidate, writeHook(row: RoutineWorkDelivery) {beforeWrite(row)},
    afterCandidate(value: () => void) {afterCandidate = value}, beforeWrite(value: (row: RoutineWorkDelivery) => void) {beforeWrite = value}}
}

test('finalization acknowledges its independent original candidate in a separate ledger and preserves terminal status', async () => {
  const f = await finalizationFixture()
  await expect(f.service.status(f.event, f.row.hostId)).rejects.toThrow('Terminal')
  expect(await f.service.verifyRecording({identity: f.identity, event: f.event}, f.row.hostId)).toEqual(f.event)
  const passed = f.terminal('passed')
  const wrongResult = structuredClone(passed)
  wrongResult.details.details.resultUrl = 'https://admin.mentraglass.com/?testRun=other-run'
  wrongResult.details.details.completion!.resultUrl = wrongResult.details.details.resultUrl
  await expect(f.service.verifyRecording({identity: f.identity, event: wrongResult}, f.row.hostId)).rejects.toThrow('result link')
  expect(await f.service.verifyRecording({identity: f.identity, event: passed}, f.row.hostId)).toEqual(passed)
  expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
  expect(f.rows.get(f.row.workId)!.verification!.status).toEqual(passed)
  const reads = f.reads
  f.setNow(Date.parse('2026-10-07T00:00:00Z'))
  f.rows.get(f.row.workId)!.fleetCancellation = {requestedAt: new Date().toISOString(), reason: 'Later cancellation'}
  f.setCandidate(null)
  expect(await f.service.verifyRecording({identity: f.identity, event: passed}, f.row.hostId)).toEqual(passed)
  expect(f.reads).toBe(reads)
  for (const key of ['cacheProofSha256', 'candidateSha256', 'recordingSha256', 'restorationSha256', 'completionSha256', 'runInputSha256'] as const)
    await expect(f.service.verifyRecording({identity: {...f.identity, finalization: {...f.identity.finalization, [key]: 'f'.repeat(64)}},
      event: passed}, f.row.hostId)).rejects.toThrow('identity')
  await expect(f.service.verifyRecording({identity: {...f.identity, finalization: {...f.identity.finalization,
    originalDeadline: '2026-10-06T10:00:00.000Z'}}, event: passed}, f.row.hostId)).rejects.toThrow('identity')
})
for (const mutation of ['absent', 'unpublished', 'failed', 'foreign-input', 'foreign-source', 'foreign-build', 'foreign-verification'] as const)
  test(`finalization refuses ${mutation} candidate evidence without a receipt`, async () => {
    const f = await finalizationFixture()
    if (mutation === 'absent') f.setCandidate(null)
    if (mutation === 'unpublished') f.candidate.run.uploadsComplete = false
    if (mutation === 'failed') f.candidate.request.terminalStatus = 'fail'
    if (mutation === 'foreign-input') f.candidate.request.inputSha256 = 'e'.repeat(64)
    if (mutation === 'foreign-source') f.candidate.run.definitionRevision = 'e'.repeat(40)
    if (mutation === 'foreign-build') f.candidate.run.build = {headSha: 'e'.repeat(40)}
    if (mutation === 'foreign-verification') f.candidate.run.verification = {workId: 'other', attemptId: 2, sourceRevision: 'c'.repeat(40)}
    await expect(f.service.verifyRecording({identity: f.identity, event: f.event}, f.row.hostId)).rejects.toThrow('independent')
    expect(f.rows.get(f.row.workId)!.verification).toBeUndefined()
    expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
  })
test('finalization cannot extend accepted work or initiate success after expiry or cancellation', async () => {
  for (const mode of ['host-extension', 'fleet-bound', 'expired', 'cancelled'] as const) {
    const f = await finalizationFixture(), identity = structuredClone(f.identity)
    if (mode === 'host-extension') identity.finalization.originalDeadline = '2026-10-07T10:00:00.000Z'
    if (mode === 'fleet-bound') {const row=f.rows.get(f.row.workId)!;row.fleetDeadline=new Date('2026-10-05T11:20:00Z');row.fleetInputSha256=requestInputDigest({selection:row.fleetSelection,deadline:row.fleetDeadline.toISOString()})}
    if (mode === 'expired') f.setNow(Date.parse('2026-10-05T11:32:00Z'))
    if (mode === 'cancelled') f.rows.get(f.row.workId)!.fleetCancellation = {requestedAt: '2026-10-05T11:01:00Z', reason: 'Original cancellation'}
    await expect(f.service.verifyRecording({identity, event: f.event}, f.row.hostId)).rejects.toThrow('expired or cancelled')
    expect(f.rows.get(f.row.workId)!.verification).toBeUndefined()
  }
  const f = await finalizationFixture()
  await f.service.verifyRecording({identity: f.identity, event: f.event}, f.row.hostId)
  f.rows.get(f.row.workId)!.fleetCancellation = {requestedAt: '2026-10-05T11:01:00Z', reason: 'Original cancellation'}
  await expect(f.service.verifyRecording({identity: f.identity, event: f.terminal('passed')}, f.row.hostId)).rejects.toThrow('cancelled')
  expect(await f.service.verifyRecording({identity: f.identity, event: f.terminal('cancelled')}, f.row.hostId)).toEqual(f.terminal('cancelled'))
  expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
})
for (const point of ['candidate-read', 'atomic-write'] as const)
  test(`finalization cancellation at ${point} refuses a new receipt`, async () => {
    const f = await finalizationFixture()
    const cancel = (row: RoutineWorkDelivery) => {row.fleetCancellation = {requestedAt: '2026-10-05T11:01:00Z', reason: 'Cancellation while verifying'}}
    if (point === 'candidate-read') f.afterCandidate(() => cancel(f.rows.get(f.row.workId)!)); else f.beforeWrite(cancel)
    await expect(f.service.verifyRecording({identity: f.identity, event: f.event}, f.row.hostId)).rejects.toThrow()
    expect(f.rows.get(f.row.workId)!.verification).toBeUndefined()
    expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
  })

test('authenticated finalization delivery reconciles lost ACK without rewriting the acknowledged failed status', async () => {
  const f = await finalizationFixture(), token = 'private-fixture-token'.repeat(2)
  const app = createRoutineWorkDeliveriesApi(f.service, () => JSON.stringify({mini: token}))
  const send = (path: string, body: unknown, credential = token) => app.request(`/work:one/${path}`, {
    method: 'POST', headers: {'authorization': `Bearer ${credential}`, 'content-type': 'application/json'}, body: JSON.stringify(body),
  })
  expect((await send('status', f.event)).status).toBe(409)
  expect((await send('recording-verification', {identity: f.identity, event: f.event}, 'foreign')).status).toBe(401)
  const response = await send('recording-verification', {identity: f.identity, event: f.event})
  expect(response.status).toBe(200)
  // The response is deliberately discarded after the existing ledger commits.
  f.setNow(Date.parse('2026-10-07T00:00:00Z')); f.setCandidate(null)
  expect(await (await send('recording-verification', {identity: f.identity, event: f.event})).json()).toEqual({receipt: f.event})
  const changed = structuredClone(f.identity); changed.finalization.originalDeadline = '2026-10-07T00:00:00.000Z'
  expect((await send('recording-verification', {identity: changed, event: f.event})).status).toBe(409)
  expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
})

test('Mongo finalization receipt CAS includes original cancellation authority', async () => {
  const f = await finalizationFixture()
  const chain = (read: () => unknown) => ({read() {return this}, readConcern() {return this}, lean: async () => read()})
  const find = spyOn(RoutineWorkModel, 'findOne').mockImplementation(() => chain(() => structuredClone(f.rows.get(f.row.workId))) as never)
  let attempted = false
  const write = spyOn(RoutineWorkModel, 'findOneAndUpdate').mockImplementation(((filter: unknown) => {
    attempted = true
    expect(filter).toMatchObject({workId: f.row.workId, fleetCancellation: {$exists: false}, status: f.original, verification: {$exists: false}})
    f.rows.get(f.row.workId)!.fleetCancellation = {requestedAt: '2026-10-05T11:01:00Z', reason: 'Concurrent cancellation'}
    return {lean: async () => null}
  }) as never)
  try {
    const service = new RoutineWorkService(undefined, undefined, undefined, {async publish() {}}, undefined,
      () => Date.parse('2026-10-05T11:01:01.000Z'), null, undefined, async () => structuredClone(f.candidate))
    await expect(service.verifyRecording({identity: f.identity, event: f.event}, f.row.hostId)).rejects.toThrow('raced')
    expect(attempted).toBe(true); expect(f.rows.get(f.row.workId)!.verification).toBeUndefined()
  } finally {write.mockRestore(); find.mockRestore()}
})

test('local registered work without fleet deadline uses only the accepted twenty-four-hour bound', async () => {
  const f = await finalizationFixture(), row = f.rows.get(f.row.workId)!
  delete row.fleetSelection; delete row.fleetInputSha256; delete row.fleetDeadline
  const identity = structuredClone(f.identity)
  identity.finalization.originalDeadline = '2026-10-06T10:00:00.000Z'
  expect(await f.service.verifyRecording({identity, event: f.event}, f.row.hostId)).toEqual(f.event)
  const fresh = await finalizationFixture(), local = fresh.rows.get(fresh.row.workId)!
  delete local.fleetSelection; delete local.fleetInputSha256; delete local.fleetDeadline
  const extended = structuredClone(fresh.identity)
  extended.finalization.originalDeadline = '2026-10-06T10:00:00.001Z'
  await expect(fresh.service.verifyRecording({identity: extended, event: fresh.event}, fresh.row.hostId)).rejects.toThrow('expired or cancelled')
  expect(local.verification).toBeUndefined()
})

async function reconciliationFixture(reason = 'Accumulated job details exceed the bounded allowance') {
  const f = await finalizationFixture(163)
  await f.service.verifyRecording({identity: f.identity, event: f.event}, f.row.hostId)
  const details = {...f.original.details.details, reason, summary: reason}
  const failed = routineWorkStatusSchema.parse({...f.event, eventId: 'parent-detail-limit', sequence: 165, state: 'failed',
    details: {...f.event.details, state: 'failed', sequence: 165, details, events: [...f.event.details.events,
      {eventId: 'parent-detail-limit', sequence: 165, state: 'failed', at: '2026-10-05T11:02:00.000Z', details}]}})
  await f.service.verifyRecording({identity: f.identity, event: failed}, f.row.hostId)
  const parent = structuredClone(f.rows.get(f.row.workId)!.verification!)
  let now = Date.parse('2026-10-05T12:00:01.000Z')
  f.setNow(now) // The original thirty-minute parent window has expired.
  const identity = {...f.identity, decisionId: 'reconcile-original-finalization', inputSha256: '6'.repeat(64),
    acceptedAt: '2026-10-05T12:00:00.000Z', deadline: '2026-10-05T12:30:00.000Z',
    previousFailure: {code: 'authoring-detail-limit', reason}, reconciliation: {parentIdentitySha256: requestInputDigest(parent.identity),
      parentFailureEventId: failed.eventId, parentFailureSequence: failed.sequence, parentFailureSha256: requestInputDigest(failed)}}
  const event = routineWorkStatusSchema.parse({...failed, eventId: identity.decisionId, sequence: 166, state: 'verifying',
    details: {...failed.details, state: 'verifying', sequence: 166, events: [...failed.details.events,
      {eventId: identity.decisionId, sequence: 166, state: 'verifying', at: '2026-10-05T12:00:00.003Z', details}]}})
  const terminal = (state: 'passed' | 'failed' | 'cancelled') => {
    const prior = state === 'failed' ? failed : f.terminal(state)
    return routineWorkStatusSchema.parse({...prior, eventId: `child-${state}`, sequence: 167,
      details: {...prior.details, sequence: 167, events: [...event.details.events,
        {eventId: `child-${state}`, sequence: 167, state, at: '2026-10-05T12:01:00.000Z', details: prior.details.details}]}})
  }
  const unexpected = async (): Promise<never> => {throw new Error('Reconciliation reached an unrelated operation')}
  const rows: RoutineWorkRepository = {async get(id) {return structuredClone(f.rows.get(id)??null)},
    insert: unexpected, accept: unexpected, queued: unexpected, updateStatus: unexpected,
    async updateVerification(value, original, previous, authority) {
      const row=f.rows.get(value.event.workId)
      if(row)f.writeHook(row)
      if(!row||row.fleetCancellation&&value.event.state!=='cancelled'||value.event.state!=='cancelled'&&now>Date.parse(value.identity.deadline)||
        requestInputDigest(row.status)!==requestInputDigest(original)||requestInputDigest(row.verification??null)!==requestInputDigest(previous??null)||
        requestInputDigest(row.work)!==requestInputDigest(authority!.work)||requestInputDigest(row.acceptance)!==requestInputDigest(authority!.acceptance)||
        row.fleetDeadline?.getTime()!==authority!.fleetDeadline?.getTime())return null
      const active=value.identity.reconciliation?previous?.reconciliation:previous
      const record={identity:structuredClone(value.identity),status:structuredClone(value.event),receipts:[...(active?.receipts??[]),
        {eventId:value.event.eventId,sequence:value.event.sequence,sha256:requestInputDigest(value.event)}]}
      if(value.identity.reconciliation)row.verification!.reconciliation=record;else row.verification=record
      return structuredClone(row)
    }}
  const service = new RoutineWorkService(rows, {resolve: unexpected, resolveNimoDiagnostic: unexpected}, {get: unexpected},
    {publish: unexpected}, {resolve: unexpected}, () => now, null, unexpected, f.readCandidate)
  return {...f, service, parent, failed, identity, event, terminal, get candidate() {return f.candidate}, get reads() {return f.reads},
    setNow(value: number) {now=value; f.setNow(value)}}
}

test('one reconciliation finalizes the same candidate after parent expiry and preserves every original receipt', async () => {
  const f=await reconciliationFixture(), parentBytes=JSON.stringify(f.parent), originalBytes=JSON.stringify(f.original)
  expect(await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)).toEqual(f.event)
  const passed=f.terminal('passed')
  expect(await f.service.verifyRecording({identity:f.identity,event:passed},f.row.hostId)).toEqual(passed)
  const row=f.rows.get(f.row.workId)!,{reconciliation,...parent}=row.verification!
  expect(JSON.stringify(parent)).toBe(parentBytes)
  expect(JSON.stringify(row.status)).toBe(originalBytes)
  expect(reconciliation!.status).toEqual(passed)
  expect(reconciliation!.receipts).toHaveLength(2)
})

test('a current finalization child never authorizes another candidate through the existing admission service',async()=>{
  const f=await reconciliationFixture()
  await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
  const service=new CandidateVerificationService(async()=>({...structuredClone(f.rows.get(f.row.workId)!),hostId:f.row.hostId,
    work:f.row.work}),
    ()=>Date.parse('2026-10-05T12:00:01.000Z'))
  const selected=f.candidate.request.input as {verification:{workId:string;attemptId:number;sourceRevision:string};
    routineId:string;definitionRevision:string;platform:string;laneId:string;build:unknown}
  await expect(service.authorize(selected.verification,f.row.hostId,selected)).rejects.toThrow('accepted current host')
})

for(const reason of ['Job details exceed the bounded allowance','Unrelated completion failure'])
  test(`reconciliation predecessor cause is source-bound: ${reason}`,async()=>{
    const f=await reconciliationFixture(reason)
    const result=f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
    if(reason.startsWith('Job details'))expect(await result).toEqual(f.event)
    else await expect(result).rejects.toThrow('predecessor')
  })

for(const mutation of ['root-event','root-digest','parent-identity','parent-event','parent-sequence','parent-digest','parent-receipt',
  'parent-not-failed','candidate-pin','wrong-candidate','no-candidate','wrong-reason','decision-gap','future-decision','direct-success'] as const)
  test(`reconciliation refuses ${mutation} before changing its parent`,async()=>{
    const f=await reconciliationFixture(),identity=structuredClone(f.identity),event=structuredClone(f.event)
    if(mutation==='root-event')identity.failureEventId=f.failed.eventId
    if(mutation==='root-digest')identity.failureSha256=requestInputDigest(f.failed)
    if(mutation==='parent-identity')identity.reconciliation.parentIdentitySha256='e'.repeat(64)
    if(mutation==='parent-event')identity.reconciliation.parentFailureEventId=f.original.eventId
    if(mutation==='parent-sequence')identity.reconciliation.parentFailureSequence--
    if(mutation==='parent-digest')identity.reconciliation.parentFailureSha256='e'.repeat(64)
    if(mutation==='parent-receipt')f.rows.get(f.row.workId)!.verification!.receipts.pop()
    if(mutation==='parent-not-failed')f.rows.get(f.row.workId)!.verification!.status.state='passed'
    if(mutation==='candidate-pin')identity.finalization.candidateSha256='e'.repeat(64)
    if(mutation==='wrong-candidate')f.candidate.run.outcome='fail'
    if(mutation==='no-candidate')f.setCandidate(null)
    if(mutation==='wrong-reason')identity.previousFailure.reason='Other cause'
    if(mutation==='decision-gap'){event.sequence++;event.details.sequence++;event.details.events.at(-1)!.sequence++}
    if(mutation==='future-decision')event.details.events.at(-1)!.at='2026-10-05T12:00:02.000Z'
    const before=structuredClone(f.rows.get(f.row.workId))
    await expect(f.service.verifyRecording({identity,event:mutation==='direct-success'?f.terminal('passed'):event},f.row.hostId)).rejects.toThrow()
    expect(f.rows.get(f.row.workId)).toEqual(before)
  })

test('reconciliation strict wire cannot broaden admission or nest another child',async()=>{
  const f=await reconciliationFixture()
  for(const identity of [
    {...f.identity,reconciliation:undefined},
    {...f.identity,previousFailure:{...f.identity.previousFailure,code:'workspace-generated-unaccounted'}},
    {...f.identity,admission:{requestId:'local:1792508226360:other',originalAdmissionExpiresAt:1792508226360}},
    {...f.identity,reconciliation:{...f.identity.reconciliation,reconciliation:f.identity.reconciliation}},
  ])expect(routineWorkVerificationSchema.safeParse({identity,event:f.event}).success).toBe(false)
})

test('reconciliation requires current cancellation and deadline authority for each new event',async()=>{
  for(const mode of ['expired-child','expired-work','cancelled','cancel-after-decision','expired-after-decision'] as const){
    const f=await reconciliationFixture()
    if(mode.endsWith('after-decision'))await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
    if(mode.startsWith('expired'))f.setNow(Date.parse(mode==='expired-work'?'2026-10-07T00:00:00Z':'2026-10-05T12:31:00Z'))
    if(mode.startsWith('cancel'))f.rows.get(f.row.workId)!.fleetCancellation={requestedAt:'2026-10-05T12:00:00Z',reason:'Current cancellation'}
    await expect(f.service.verifyRecording({identity:f.identity,event:mode.endsWith('after-decision')?f.terminal('passed'):f.event},f.row.hostId)).rejects.toThrow()
    expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
  }
})

test('delayed cancellation delivery preserves its original in-window event without extending child authority',async()=>{
  const f=await reconciliationFixture()
  await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
  const cancelled=f.terminal('cancelled')
  f.setNow(Date.parse('2026-10-07T00:00:00Z'))
  f.rows.get(f.row.workId)!.fleetCancellation={requestedAt:'2026-10-05T12:01:00Z',reason:'Original in-window cancellation'}
  const postWindow=structuredClone(cancelled)
  postWindow.details.events.at(-1)!.at='2026-10-05T12:30:00.001Z'
  await expect(f.service.verifyRecording({identity:f.identity,event:postWindow},f.row.hostId)).rejects.toThrow('original retry window')
  expect(await f.service.verifyRecording({identity:f.identity,event:cancelled},f.row.hostId)).toEqual(cancelled)
  expect(f.rows.get(f.row.workId)!.verification!.status).toEqual(f.failed)
  expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
})

test('a sealed child permits only exact saved ACK reconciliation and never a second decision or terminal replacement',async()=>{
  for(const state of ['passed','failed','cancelled'] as const){
    const f=await reconciliationFixture()
    await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
    const terminal=f.terminal(state)
    await f.service.verifyRecording({identity:f.identity,event:terminal},f.row.hostId)
    const before=structuredClone(f.rows.get(f.row.workId)!.verification),reads=f.reads
    f.setNow(Date.parse('2026-10-07T00:00:00Z')); f.setCandidate(null)
    f.rows.get(f.row.workId)!.fleetCancellation={requestedAt:'2026-10-07T00:00:00Z',reason:'Later cancellation'}
    expect(await f.service.verifyRecording({identity:f.identity,event:terminal},f.row.hostId)).toEqual(terminal)
    expect(await f.service.verifyRecording({identity:f.parent.identity,event:f.failed},f.row.hostId)).toEqual(f.failed)
    expect(f.reads).toBe(reads)
    await expect(f.service.verifyRecording({identity:{...f.identity,decisionId:'another-decision'},event:f.event},f.row.hostId)).rejects.toThrow('identity')
    const changed=structuredClone(terminal);changed.details.details.summary='Changed terminal'
    await expect(f.service.verifyRecording({identity:f.identity,event:changed},f.row.hostId)).rejects.toThrow('original event')
    expect(f.rows.get(f.row.workId)!.verification).toEqual(before)
  }
})

test('authenticated reconciliation uses the existing route and returns exact lost acknowledgements after expiry',async()=>{
  const f=await reconciliationFixture(),token='private-reconciliation-fixture-token'.repeat(2)
  const app=createRoutineWorkDeliveriesApi(f.service,()=>JSON.stringify({mini:token}))
  const send=(body:unknown,credential=token,path=f.row.workId)=>app.request(`/${path}/recording-verification`,{
    method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify(body)})
  expect((await send({identity:f.identity,event:f.event},'foreign')).status).toBe(401)
  expect((await send({identity:f.identity,event:f.event},token,'another-work')).status).toBe(400)
  expect((await send({identity:f.identity,event:f.event})).status).toBe(200)
  const passed=f.terminal('passed')
  expect((await send({identity:f.identity,event:passed})).status).toBe(200)
  f.setNow(Date.parse('2026-10-07T00:00:00Z'));f.setCandidate(null)
  expect(await(await send({identity:f.identity,event:passed})).json()).toEqual({receipt:passed})
  expect((await send({identity:{...f.identity,deadline:'2026-10-05T12:30:00.001Z'},event:passed})).status).toBe(400)
  expect(f.rows.get(f.row.workId)!.status).toEqual(f.original)
  expect(f.rows.get(f.row.workId)!.verification!.status).toEqual(f.failed)
})

for(const point of ['candidate-read','atomic-write'] as const)
  for(const mutation of ['cancel','expiry','parent','root'] as const)
    test(`reconciliation ${mutation} race at ${point} refuses a new receipt`,async()=>{
      const f=await reconciliationFixture()
      const change=(row:RoutineWorkDelivery)=>{
        if(mutation==='cancel')row.fleetCancellation={requestedAt:'2026-10-05T12:00:00Z',reason:'Concurrent cancellation'}
        if(mutation==='expiry')f.setNow(Date.parse('2026-10-05T12:30:00.001Z'))
        if(mutation==='parent')row.verification!.status.details.details.summary='Concurrent parent mutation'
        if(mutation==='root')row.status!.details.details.summary='Concurrent root mutation'
      }
      if(point==='candidate-read')f.afterCandidate(()=>change(f.rows.get(f.row.workId)!));else f.beforeWrite(change)
      await expect(f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)).rejects.toThrow()
      expect(f.rows.get(f.row.workId)!.verification!.reconciliation).toBeUndefined()
    })

test('parent and child share one hundred receipts while exact saved events still reconcile',async()=>{
  const f=await reconciliationFixture(),row=f.rows.get(f.row.workId)!
  while(row.verification!.receipts.length<99){const sequence=100+row.verification!.receipts.length
    row.verification!.receipts.push({eventId:`historical-parent-${sequence}`,sequence,sha256:'a'.repeat(64)})}
  const parentBytes=JSON.stringify(row.verification)
  await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
  expect(row.verification!.receipts.length+row.verification!.reconciliation!.receipts.length).toBe(100)
  expect(await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)).toEqual(f.event)
  await expect(f.service.verifyRecording({identity:f.identity,event:f.terminal('passed')},f.row.hostId)).rejects.toThrow('bounded event')
  const {reconciliation,...parent}=row.verification!
  expect(JSON.stringify(parent)).toBe(parentBytes)
  expect(reconciliation!.status).toEqual(f.event)
})

test('a terminal child cannot be replaced and a new parent event cannot advance its sealed predecessor',async()=>{
  const f=await reconciliationFixture()
  await f.service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)
  await f.service.verifyRecording({identity:f.identity,event:f.terminal('failed')},f.row.hostId)
  const passed=f.terminal('passed')
  passed.sequence=168;passed.details.sequence=168;passed.details.events.at(-1)!.sequence=168
  await expect(f.service.verifyRecording({identity:f.identity,event:passed},f.row.hostId)).rejects.toThrow('terminal result')
  const parentEvent=structuredClone(f.failed)
  parentEvent.eventId='later-parent-event';parentEvent.sequence=168;parentEvent.details.sequence=168
  parentEvent.details.events.push({eventId:parentEvent.eventId,sequence:168,state:'failed',at:'2026-10-05T11:03:00.000Z',details:parentEvent.details.details})
  await expect(f.service.verifyRecording({identity:f.parent.identity,event:parentEvent},f.row.hostId)).rejects.toThrow('sealed parent')
})

test('Mongo reconciliation CAS preserves the complete parent and atomically fences cancellation and server expiry',async()=>{
  const f=await reconciliationFixture()
  const chain=(read:()=>unknown)=>({read(){return this},readConcern(){return this},lean:async()=>read()})
  const find=spyOn(RoutineWorkModel,'findOne').mockImplementation(()=>chain(()=>structuredClone(f.rows.get(f.row.workId))) as never)
  let writes=0,mode:'success'|'cancel'|'expire'|'parent'|'identity'='success'
  const write=spyOn(RoutineWorkModel,'findOneAndUpdate').mockImplementation(((filter:Record<string,unknown>,update:Record<string,any>,options:unknown)=>{
    writes++
    const row=f.rows.get(f.row.workId)!,previous=structuredClone(row.verification!)
    expect(filter).toMatchObject({workId:f.row.workId,hostId:f.row.hostId,inputSha256:f.row.inputSha256,
      fleetCancellation:{$exists:false},status:f.original,verification:previous,
      acceptance:f.rows.get(f.row.workId)!.acceptance,work:f.rows.get(f.row.workId)!.work,
      fleetDeadline:f.rows.get(f.row.workId)!.fleetDeadline,fleetInputSha256:f.rows.get(f.row.workId)!.fleetInputSha256,
      $expr:{$lte:['$$NOW',{$literal:new Date(f.identity.deadline)}]}})
    expect(options).toEqual({new:true,writeConcern:testWriteConcern})
    expect(Object.keys(update.$set)).toEqual(['verification.reconciliation'])
    expect(update.$set['verification.reconciliation'].identity).toEqual(f.identity)
    if(mode==='cancel')row.fleetCancellation={requestedAt:'2026-10-05T12:00:00Z',reason:'Concurrent cancellation'}
    if(mode==='parent')row.verification!.receipts.push({eventId:'concurrent-parent',sequence:10,sha256:'a'.repeat(64)})
    if(mode==='identity'){
      row.verification!.reconciliation=structuredClone(update.$set['verification.reconciliation'])
      row.verification!.reconciliation!.identity.inputSha256='e'.repeat(64)
    }
    if(mode!=='success')return{lean:async()=>null}
    row.verification!.reconciliation=structuredClone(update.$set['verification.reconciliation'])
    return{lean:async()=>structuredClone(row)}
  }) as never)
  const now=()=>Date.parse('2026-10-05T12:00:01.000Z')
  const service=new RoutineWorkService(undefined,undefined,undefined,{async publish(){}},undefined,now,null,undefined,
    async()=>structuredClone(f.candidate))
  try{
    expect(await service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)).toEqual(f.event)
    const {reconciliation,...parent}=f.rows.get(f.row.workId)!.verification!
    expect(parent).toEqual(f.parent)
    for(const raced of ['cancel','expire','parent','identity'] as const){
      mode=raced
      f.rows.get(f.row.workId)!.verification=structuredClone(f.parent)
      delete f.rows.get(f.row.workId)!.fleetCancellation
      await expect(service.verifyRecording({identity:f.identity,event:f.event},f.row.hostId)).rejects.toThrow('raced')
      if(raced!=='identity')expect(f.rows.get(f.row.workId)!.verification!.reconciliation).toBeUndefined()
    }
    expect(writes).toBe(5)
  }finally{write.mockRestore();find.mockRestore()}
})
