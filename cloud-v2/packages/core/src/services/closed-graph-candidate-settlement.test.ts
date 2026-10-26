import {expect, spyOn, test} from 'bun:test'
import {isDeepStrictEqual} from 'node:util'
import {TestRequestModel} from '../models/test-request.model'
import {exclusiveHostReservationSchema} from '../types/resource-reservations.types'
import {routingGraphFixture} from './backend-candidate-preparation.test-support'
import {candidateSettlement} from './backend-candidate-preparation'
import {routineJobRepository} from './routine-job.service'
import {requestInputDigest} from './test-request.service'

async function closedOriginal() {
  const f = routingGraphFixture('ios-on-mac')
  await f.service.preparation('job-one')
  f.settleGraph('unknown')
  const host = f.hosts[0]!, pending = f.row.fleetCandidatePreparation!, receipt = host.resourceReservations!.candidatePrerequisites![0]!
  for (const check of receipt.graphChecks!) {
    check.outcome = 'unknown'
    const subject = host.resourceLifecycle!.subjects.find(value => value.subject.id === check.resourceId)!
    subject.status = 'unknown'; subject.idle.outcome = 'unknown'
  }
  const original = structuredClone(pending), originalReceipt = structuredClone(receipt), releasedAt = f.now
  f.advance(2)
  host.frameworkBinding = {...host.frameworkBinding!, version: host.frameworkBinding!.version + 1,
    revision: 'e'.repeat(40), installationId: 'accepted-current-fixture'}
  host.incarnation = 'accepted-current'; host.incarnationGeneration++
  host.frameworkAcceptedAt = new Date(releasedAt + 1).toISOString()
  host.frameworkProcess = {pid: 1001, startedAt: 'Tue Oct 20 05:00:01 2026'}
  host.frameworkHistory = [{binding: host.frameworkBinding, incarnation: host.incarnation,
    incarnationGeneration: host.incarnationGeneration, process: host.frameworkProcess,
    effectiveAt: host.frameworkAcceptedAt, observedAt: host.observedAt}]
  return {f, host, original, originalReceipt}
}

test('fully returned original UNKNOWN settles through the real service after accepted source replacement and tries the alternate', async () => {
  const {f, host, original, originalReceipt} = await closedOriginal(), saved = structuredClone(f.row)
  // The production archive writer runs; only its MongoDB CAS is a CPU seam.
  f.rows.settleCandidatePreparation = routineJobRepository.settleCandidatePreparation!
  const write = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any, update: any) => {
    expect(filter.fleetCandidatePreparation).toEqual(f.row.fleetCandidatePreparation)
    expect(filter.fleetInputSha256).toBe(saved.fleetInputSha256)
    expect(filter.fleetBinding).toEqual({$exists: false})
    expect(filter.hostId).toEqual({$exists: false})
    expect(filter.fleetResourceAdmission).toEqual({$exists: false})
    expect(filter.fleetDeadline).toBeUndefined()
    expect(Object.keys(update.$set).sort()).toEqual(['fleetCandidatePreparations', 'updatedAt'])
    if (!isDeepStrictEqual(filter.fleetCandidatePreparation, f.row.fleetCandidatePreparation)) return null as any
    f.row = {...f.row, ...structuredClone(update.$set), fleetCandidatePreparation: undefined}
    return structuredClone(f.row) as any
  })
  try {
    await f.service.preparation('job-one')
    expect(write).toHaveBeenCalledTimes(1)
    expect(f.row.fleetCandidatePreparations?.[0]).toEqual({...original, settlement: originalReceipt})
    expect(f.row.fleetCandidatePreparation?.hostId).toBe('air2')
    expect(f.row.fleetCandidatePreparation?.candidate.attemptId).not.toBe(original.candidate.attemptId)
    expect(host.resourceReservations!.candidatePrerequisites).toEqual([originalReceipt])
    expect(f.bindWrites).toBe(0); expect(f.row.fleetBinding).toBeUndefined()
    for (const key of ['requestId', 'fleetSelection', 'fleetSelectionSha256', 'fleetPreparation', 'fleetInputSha256', 'fleetDeadline'] as const)
      expect(f.row[key]).toEqual(saved[key])
  } finally {write.mockRestore()}
})

test('later unowned subject observations cannot erase the already returned original UNKNOWN', async () => {
  const {f, host, originalReceipt} = await closedOriginal()
  for (const subject of host.resourceLifecycle!.subjects) {
    subject.generation++
    subject.idle.acceptedCheck = {...subject.idle.acceptedCheck!, operationId: 'later-current-check',
      subjectGeneration: subject.generation, resultSha256: 'f'.repeat(64)}
  }
  expect(candidateSettlement(f.row.fleetCandidatePreparation!, host, [], f.now)).toEqual(originalReceipt)
})

for (const gap of ['partial-return', 'changed-release', 'unclosed-work', 'missing-receipt', 'missing-current-history',
  'changed-current-process', 'changed-current-controller', 'changed-current-binding', 'changed-accepted-time', 'ended-current',
  'stale-host', 'stale-observation', 'release-after-acceptance', 'changed-original-generation', 'foreign-authority', 'foreign-owner',
  'live-claim', 'changed-original-input'] as const)
  test(`historical original UNKNOWN stays pending with ${gap}`, async () => {
    const {f, host} = await closedOriginal(), pending = f.row.fleetCandidatePreparation!
    if (gap === 'partial-return') pending.resourceReturns!.pop()
    if (gap === 'changed-release') (pending.resourceReturns![0] as any).release.operationId = 'unrelated-check'
    if (gap === 'unclosed-work') (host.resourceReservations!.candidatePrerequisites![0] as any).hostWorkSettled = false
    if (gap === 'missing-receipt') host.resourceReservations!.candidatePrerequisites = []
    if (gap === 'missing-current-history') host.frameworkHistory = []
    if (gap === 'changed-current-process') host.frameworkProcess = {...host.frameworkProcess!, pid: 9999}
    if (gap === 'changed-current-controller') host.incarnationGeneration++
    if (gap === 'changed-current-binding') host.frameworkBinding = {...host.frameworkBinding!, installationId: 'unaccepted-installation'}
    if (gap === 'changed-accepted-time') host.frameworkAcceptedAt = host.observedAt
    if (gap === 'ended-current') host.frameworkHistory![0]!.endedAt = host.observedAt
    if (gap === 'stale-host') host.receivedAt = new Date(f.now - 120_001).toISOString()
    if (gap === 'stale-observation') host.observedAt = new Date(f.now - 120_001).toISOString()
    if (gap === 'release-after-acceptance') (pending.resourceReturns![0] as any).release.releasedAt = host.observedAt
    if (gap === 'changed-original-generation') (pending.resourceReturns![0] as any).release.subjectGeneration++
    if (gap === 'foreign-authority') host.resourceLifecycle!.subjects[0]!.subject.authorityHostId = 'foreign'
    if (gap === 'foreign-owner') host.resourceLifecycle!.subjects[0]!.owner = {id: 'live-reader', kind: 'run', generation: 1, hostId: host.hostId}
    if (gap === 'live-claim') host.authorityReservations = [{...exclusiveHostReservationSchema.parse(pending.resourceClaims![0]),
      owner: {id: 'live-native-reader', kind: 'run'}, prerequisite: undefined, resourceCheck: undefined}]
    if (gap === 'changed-original-input') pending.target.definitionSha256 = requestInputDigest('foreign-definition')
    const saved = structuredClone(f.row)
    await f.service.preparation('job-one')
    expect(f.row).toEqual(saved); expect(f.bindWrites).toBe(0)
  })

test('returned positive cannot use the historical UNKNOWN ingestion path after source replacement', async () => {
  const {f, host} = await closedOriginal(), receipt = host.resourceReservations!.candidatePrerequisites![0]!
  receipt.outcome = 'qualified'
  for (const check of receipt.graphChecks!) check.outcome = 'passed'
  const saved = structuredClone(f.row)
  await f.service.preparation('job-one')
  expect(f.row).toEqual(saved); expect(f.bindWrites).toBe(0)
})

test('lost original archive CAS leaves the original pending and cannot start another candidate', async () => {
  const {f} = await closedOriginal(), saved = structuredClone(f.row)
  f.rows.settleCandidatePreparation = routineJobRepository.settleCandidatePreparation!
  const write = spyOn(TestRequestModel.collection, 'findOneAndUpdate').mockImplementation(async (filter: any) => {
    expect(filter.fleetCandidatePreparation).toEqual(saved.fleetCandidatePreparation)
    expect(filter.fleetInputSha256).toBe(saved.fleetInputSha256)
    return null as any
  })
  try {
    await f.service.preparation('job-one')
    expect(write).toHaveBeenCalledTimes(1)
    expect(f.row).toEqual(saved); expect(f.bindWrites).toBe(0)
  } finally {write.mockRestore()}
})

test('original deadline expiry permits only historical UNKNOWN ingestion, without another candidate or grant', async () => {
  const {f, original, originalReceipt} = await closedOriginal(), deadline = structuredClone(f.row.fleetDeadline)
  f.advance(deadline.getTime() - f.now + 1)
  await f.service.preparation('job-one')
  expect(f.row.fleetCandidatePreparations?.[0]).toEqual({...original, settlement: originalReceipt})
  expect(f.row.fleetCandidatePreparation).toBeUndefined()
  expect(f.row.fleetDeadline).toEqual(deadline); expect(f.bindWrites).toBe(0)
  expect(f.row.fleetBinding).toBeUndefined(); expect(f.writes).toBe(1)
})
