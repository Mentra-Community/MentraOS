import {expect, test} from 'bun:test'
import {createRoutineWorkDeliveriesApi} from '../api/internal/routine-work.api'
import {authoringWorkSchema, routineWorkStatusSchema} from '../types/routine-work.types'
import {CandidateVerificationService} from './candidate-verification.service'
import {RoutineWorkService, type RoutineWorkDelivery, type RoutineWorkRepository} from './routine-work.service'
import {requestInputDigest} from './test-request.service'

const work = authoringWorkSchema.parse({schemaVersion: 1, workId: 'local-work', kind: 'edit', routineId: 'flow',
  brief: {goal: 'Diagnose the original failure', stepsOrChanges: ['Inspect saved diagnostics'], expected: ['Keep original outcome']},
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40)},
  target: {hostId: 'host', laneId: 'phone'}, requirements: {platform: 'android', glasses: [], resources: [{kind: "app", capabilities: []}, {kind: "recorder", capabilities: []}, {kind: "phone", capabilities: []}], environment: []},
  build: {kind: 'android-apk', repository: 'Mentra-Community/MentraOS', headSha: 'b'.repeat(40), channel: 'dev',
    releaseIdentity: '3.3.0-dev.719', source: {channel: 'dev', buildRunId: 42, publicationAttempt: 1},
    archive: {name: 'app.apk', url: 'https://artifactscdn.mentraglass.com/app.apk', sha256: 'c'.repeat(64), size: 100},
    receipt: {url: 'https://artifactscdn.mentraglass.com/receipt.json', sha256: 'd'.repeat(64), size: 50}}})
const receipt = {workId: work.workId, inputSha256: requestInputDigest(work), hostId: 'host', acceptedAt: '2026-10-08T14:00:00Z'}
function fixture(insertFailure: 'none' | 'lost-ack' = 'none') {
  const rows = new Map<string, RoutineWorkDelivery>()
  let inserts = 0, forbidden = 0
  const unexpected = async (): Promise<never> => {forbidden++; throw new Error('Local registration invoked fleet preparation/delivery')}
  const repository: RoutineWorkRepository = {async get(id) {return structuredClone(rows.get(id) ?? null)},
    async insert(row) {inserts++; if (rows.has(row.workId)) throw new Error('duplicate'); rows.set(row.workId, structuredClone(row));
      if (insertFailure === 'lost-ack') throw new Error('lost insert ACK')},
    async queued(hostId) {return [...rows.values()].filter(row => row.hostId === hostId && !row.acceptance)},
    accept: unexpected,
    async updateStatus(event, previous) {const row = rows.get(event.workId)!
      if (requestInputDigest(row.status ?? null) !== requestInputDigest(previous ?? null) || row.statusReceipts?.some(r => r.eventId === event.eventId) ||
          row.status && row.status.sequence >= event.sequence) return null
      row.status = structuredClone(event); (row.statusReceipts ??= []).push({eventId: event.eventId, sequence: event.sequence, sha256: requestInputDigest(event)})
      return structuredClone(row)},
  }
  const service = new RoutineWorkService(repository, {resolve: unexpected}, {get: unexpected}, {publish: unexpected},
    {resolve: unexpected}, Date.now, {dispatch: unexpected, cancel: unexpected})
  return {rows, service, get inserts() {return inserts}, get forbidden() {return forbidden}}
}
test('host local registration retains exact original acceptance without delivery and retries remain immutable', async () => {
  const f = fixture()
  expect(await f.service.registerLocal({work, receipt}, 'host')).toEqual(receipt)
  expect(await f.service.registerLocal({work, receipt}, 'host')).toEqual(receipt)
  expect(f.inserts).toBe(1); expect(f.forbidden).toBe(0)
  expect(await f.service.queued('host', undefined, 10)).toMatchObject({jobs: []})
  expect(f.rows.get(work.workId)).toMatchObject({work, request: work, inputSha256: receipt.inputSha256, requestSha256: receipt.inputSha256, acceptance: receipt})
  await expect(f.service.registerLocal({work, receipt: {...receipt, acceptedAt: '2026-10-08T14:01:00Z'}}, 'host')).rejects.toThrow('conflicts')
  const changed = {...work, brief: {...work.brief, goal: 'Changed'}}
  await expect(f.service.registerLocal({work: changed, receipt: {...receipt, inputSha256: requestInputDigest(changed)}}, 'host')).rejects.toThrow('conflicts')
  expect(f.rows.get(work.workId)!.acceptance).toEqual(receipt)
})
test('lost insert response and concurrent identical registrations recover the one retained acceptance', async () => {
  const f = fixture('lost-ack')
  expect(await Promise.all([f.service.registerLocal({work, receipt}, 'host'), f.service.registerLocal({work, receipt}, 'host')]))
    .toEqual([receipt, receipt])
  expect(f.rows.size).toBe(1); expect(f.forbidden).toBe(0)
})
test('local registration rejects impersonation, changed digest, fabricated origin and collisions with existing fleet work', async () => {
  const f = fixture()
  await expect(f.service.registerLocal({work, receipt}, 'other-host')).rejects.toMatchObject({status: 400})
  await expect(f.service.registerLocal({work, receipt: {...receipt, inputSha256: '0'.repeat(64)}}, 'host')).rejects.toThrow('accepted input')
  await expect(f.service.registerLocal({work: {...work, origin: {repository: 'Mentra-Community/MentraOS', prNumber: 1, headSha: 'b'.repeat(40)}}, receipt}, 'host'))
    .rejects.toMatchObject({status: 400})
  expect(f.inserts).toBe(0)
  await f.service.registerLocal({work, receipt}, 'host')
  f.rows.get(work.workId)!.fleetSelection = {} as any
  await expect(f.service.registerLocal({work, receipt}, 'host')).rejects.toThrow('conflicts')
})
test('registered local status authorizes only the same current reviewed attempt and original exact build', async () => {
  const f = fixture(); await f.service.registerLocal({work, receipt}, 'host')
  const revision = 'e'.repeat(40), prUrl = 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/12'
  const {acceptedAt: _, ...identity} = receipt
  const event = routineWorkStatusSchema.parse({...identity, eventId: 'source-reviewed', sequence: 7, state: 'verifying',
    details: {...receipt, work, sequence: 7, state: 'verifying', attemptId: 3, events: [],
      details: {sourceRevision: revision, prUrl, review: {sourceRevision: revision, prUrl, reviewUrl: `${prUrl}#pullrequestreview-42`, verdict: 'APPROVED'}}}})
  await f.service.status(event, 'host')
  const authority = new CandidateVerificationService(async id => f.rows.get(id) as any)
  const binding = {workId: work.workId, attemptId: 3, sourceRevision: revision}
  const selected = {routineId: 'flow', platform: 'android', definitionRevision: revision, laneId: 'phone', build: work.build}
  await authority.authorize(binding, 'host', selected)
  await expect(authority.authorize({...binding, attemptId: 2}, 'host', selected)).rejects.toMatchObject({status: 409})
  await expect(authority.authorize(binding, 'other-host', selected)).rejects.toMatchObject({status: 409})
  await expect(authority.authorize(binding, 'host', {...selected, build: {...work.build, headSha: 'f'.repeat(40)}})).rejects.toMatchObject({status: 409})
})
test('registration retries preserve an already cancelled outcome instead of readmitting or changing its status', async () => {
  const f = fixture(); await f.service.registerLocal({work, receipt}, 'host')
  const {acceptedAt: _, ...identity} = receipt
  const event = routineWorkStatusSchema.parse({...identity, eventId: 'cancelled', sequence: 2, state: 'cancelled',
    details: {...receipt, work, sequence: 2, state: 'cancelled', attemptId: 1, events: [], details: {reason: 'Original job stopped'}}})
  await f.service.status(event, 'host')
  expect(await f.service.registerLocal({work, receipt}, 'host')).toEqual(receipt)
  expect(f.rows.get(work.workId)!.status).toEqual(event)
  expect(f.inserts).toBe(1); expect(f.forbidden).toBe(1) // Only the existing status notification was attempted.
})
test('local registration HTTP uses existing host credentials, strict envelopes and bounded bodies', async () => {
  const f = fixture(), token = 't'.repeat(40), app = createRoutineWorkDeliveriesApi(f.service, () => JSON.stringify({host: token}))
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'}
  expect((await app.request('/local', {method: 'POST', body: '{}'})).status).toBe(401)
  expect((await app.request('/local', {method: 'POST', headers, body: '{'})).status).toBe(400)
  expect((await app.request('/local', {method: 'POST', headers, body: ' '.repeat(256 * 1024 + 4097)})).status).toBe(413)
  expect((await app.request('/local', {method: 'POST', headers, body: JSON.stringify({work, receipt, origin: 'fabricated'})})).status).toBe(400)
  const result = await app.request('/local', {method: 'POST', headers, body: JSON.stringify({work, receipt})})
  expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store')
  expect(await result.json()).toEqual({receipt}); expect(f.forbidden).toBe(0)
  expect((await app.request('/local', {method: 'POST', headers,
    body: JSON.stringify({work, receipt: {...receipt, acceptedAt: '2026-10-08T14:01:00Z'}})})).status).toBe(409)
})
