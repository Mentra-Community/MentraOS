import {expect, test} from 'bun:test'
import {CandidateVerificationService, type CandidateWorkRecord} from './candidate-verification.service'
import {authoringWorkSchema} from '../types/routine-work.types'
import {requestInputDigest, TestRequestService, type StoredTestRequest, type TestRequestRepository} from './test-request.service'

const sourceRevision = 'c'.repeat(40)
const work = authoringWorkSchema.parse({schemaVersion: 1, workId: 'work:edit', kind: 'edit', routineId: 'notes',
  brief: {goal: 'Edit notes', stepsOrChanges: ['Open notes'], expected: ['Notes visible']},
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40)},
  target: {hostId: 'mini', laneId: 'android'}, requirements: {platform: 'android', glasses: [], capabilities: [], environment: []},
  build: {kind: 'android-apk', repository: 'Mentra-Community/MentraOS', headSha: 'b'.repeat(40), channel: 'pr', prNumber: 12,
    source: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 1},
    archive: {name: 'app.apk', url: 'https://example.com/app.apk', size: 10, sha256: 'd'.repeat(64)},
    receipt: {url: 'https://example.com/receipt.json', size: 10, sha256: 'e'.repeat(64)}}})
const verification = {workId: work.workId, attemptId: 3, sourceRevision}
const selected = {routineId: work.routineId, platform: 'android', definitionRevision: sourceRevision,
  laneId: work.target.laneId, build: work.build, resources: [], verification}
function accepted(): CandidateWorkRecord {
  const inputSha256 = requestInputDigest(work)
  return {hostId: 'mini', inputSha256, work, acceptance: {hostId: 'mini', inputSha256},
    status: {details: {workId: work.workId, hostId: 'mini', inputSha256, work, acceptedAt: '2026-10-05T10:00:00Z',
      state: 'verifying', sequence: 4, attemptId: 3, events: [], details: {sourceRevision,
        prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500',
        review: {sourceRevision, verdict: 'APPROVED', prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500',
          reviewUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500#pullrequestreview-44'}}}}}
}

test('candidate permits bind accepted host, current attempt, exact reviewed source and original build', async () => {
  let row = accepted()
  const service = new CandidateVerificationService(async () => row)
  await service.authorize(verification, 'mini', selected)
  for (const change of [
    () => {row.acceptance = undefined},
    () => {row.hostId = 'other'},
    () => {(row.status!.details as any).attemptId = 2},
    () => {(row.status!.details as any).state = 'passed'},
    () => {(row.status!.details as any).details.review.sourceRevision = 'f'.repeat(40)},
    () => {(row.status!.details as any).details.review.reviewUrl = 'https://github.com/other/repo/pull/500#pullrequestreview-44'},
  ]) {
    row = accepted(); change()
    await expect(service.authorize(verification, 'mini', selected)).rejects.toThrow('Candidate verification requires')
  }
  row = accepted()
  await expect(service.authorize(verification, 'other', selected)).rejects.toThrow('accepted current host')
  await expect(service.authorize(verification, 'mini', {...selected, build: {...work.build, headSha: 'f'.repeat(40)}}))
    .rejects.toThrow('accepted current host')
})

test('only authenticated candidate intake is admitted; retained local receipt reconciles after restoration', async () => {
  const rows = new Map<string, StoredTestRequest>()
  const repository = {async insert(row: StoredTestRequest) {
    if (rows.has(row.requestId)) throw Object.assign(Error('duplicate'), {code: 11000})
    rows.set(row.requestId, row)
  }, async get(id: string) {return rows.get(id) ?? null}} as TestRequestRepository
  let permit = true, authorizations = 0
  const service = new TestRequestService(repository, {async authorize() {authorizations++; if (!permit) throw Error('permit retired')}},
    async input => {expect(input.verification).toEqual(verification)})
  await expect(service.submit('candidate', 'mini', selected)).rejects.toThrow('authenticated assigned host')
  const receipt = {requestId: 'local:candidate', hostId: 'mini', inputSha256: requestInputDigest(selected), acceptedAt: '2026-10-05T10:00:00Z'}
  const admitted = await service.registerLocal(selected, receipt, 'mini')
  expect(admitted.catalogEligible).toBe(false)
  permit = false
  expect(await service.registerLocal(selected, receipt, 'mini')).toEqual(admitted)
  await expect(service.registerLocal(selected, {...receipt, requestId: 'local:another'}, 'mini')).rejects.toThrow('permit retired')
  expect(authorizations).toBe(2)
})
