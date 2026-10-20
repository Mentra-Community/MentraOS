import {expect, spyOn, test} from 'bun:test'
import {fixture, input} from './routine-work.service.test'
import {routineWorkStatusSchema} from '../types/routine-work.types'
import type {RoutineWorkDelivery} from './routine-work.service'
import {requestInputDigest} from './test-request.service'
import {testRoutineSource} from '../testing/framework-fixtures'
import {createRoutineWorkDeliveriesApi} from '../api/internal/routine-work.api'
import {RoutineWorkService} from './routine-work.service'
import {RoutineWorkModel} from '../models/routine-work.model'

async function finalizationFixture() {
  let now = Date.parse('2026-10-05T11:01:01.000Z'), reads = 0
  let candidate: {request: Record<string, unknown>; run: Record<string, unknown>} | null = null
  let afterCandidate = () => {}, beforeWrite = (_row: RoutineWorkDelivery) => {}
  const f = fixture({now: () => now, passedCandidate: async () => {
    reads++; afterCandidate(); return structuredClone(candidate)
  }, beforeVerificationWrite: row => beforeWrite(row)})
  const row = await f.service.submit(input)
  const accepted = {workId: row.workId, inputSha256: row.inputSha256, hostId: row.hostId, acceptedAt: '2026-10-05T10:00:00.000Z'}
  await f.service.accept(accepted, row.hostId)
  const details = {reason: 'Original source preservation refused', sourceRevision: 'c'.repeat(40), requestId: 'original-passed',
    prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601', review: {sourceRevision: 'c'.repeat(40),
      prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601',
      reviewUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/601#pullrequestreview-21', verdict: 'APPROVED'}}
  const {acceptedAt: _, ...binding} = accepted
  const original = routineWorkStatusSchema.parse({...binding, eventId: 'original-finalize-failed', sequence: 4, state: 'failed',
    details: {...accepted, work: row.work, attemptId: 2, state: 'failed', sequence: 4, details,
      events: [{eventId: 'original-finalize-failed', sequence: 4, state: 'failed', at: '2026-10-05T11:00:00.000Z', details}]}})
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
  const event = routineWorkStatusSchema.parse({...original, eventId: identity.decisionId, sequence: 5, state: 'verifying',
    details: {...original.details, state: 'verifying', sequence: 5, events: [...original.details.events,
      {eventId: identity.decisionId, sequence: 5, state: 'verifying', at: '2026-10-05T11:01:00.003Z', details}]}})
  const terminal = (state: 'passed' | 'cancelled') => {
    const resultUrl = 'https://admin.mentraglass.com/?testRun=original-native-run'
    const terminalDetails = {...details, summary: state === 'passed' ? 'Original source finalized' : 'Original retry cancelled',
      ...(state === 'passed' ? {completion: {sourceRevision: details.sourceRevision, reviewedRevision: details.sourceRevision,
        prUrl: details.prUrl, reviewUrl: details.review.reviewUrl, resultUrl, summary: 'Original source finalized'}, resultUrl} : {})}
    return routineWorkStatusSchema.parse({...event, eventId: `finalize-${state}`, sequence: 6, state,
      details: {...event.details, state, sequence: 6, details: terminalDetails, events: [...event.details.events,
        {eventId: `finalize-${state}`, sequence: 6, state, at: '2026-10-05T11:02:00.000Z', details: terminalDetails}]}})
  }
  return {...f, row, original, identity, event, terminal, get candidate() {return candidate!},
    setCandidate(value: typeof candidate) {candidate = value}, setNow(value: number) {now = value}, get reads() {return reads},
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
