import {testRoutineSource} from "../testing/framework-fixtures"
import {expect, spyOn, test} from 'bun:test'
import {GithubRoutineMergeGateway, RoutineMergeEligibilityService, type CandidatePromotion} from './routine-merge-eligibility.service'
import {RoutineDefinitionService, type RoutineDefinitionRepository} from './routine-definition.service'
import {requestInputDigest} from './test-request.service'
import type {RoutineEnrollment} from '../types/routine-definition.types'
import {TestRunGithubApp} from './test-run-github-app'
import {RoutineWorkModel} from '../models/routine-work.model'
import {RoutineDefinitionModel} from '../models/routine-definition.model'
import {TestRequestModel} from '../models/test-request.model'
import {TestRunModel} from '../models/test-run.model'
import {authoringWorkSchema, type RoutineWorkStatus} from '../types/routine-work.types'
import {RoutineWorkService, type RoutineWorkRepository} from './routine-work.service'

function enrollment(revision: string, verification?: RoutineEnrollment['verification']): RoutineEnrollment {
  const definition: RoutineEnrollment['definition'] = {
    id: 'notes',
    minimumRoutineApiVersion: 1,
    title: 'Notes',
    purpose: 'Verify notes',
    platforms: ['android'],
    entry: 'home',
    account: 'lane',
    requires: [],
    requirements: [],
    fixtures: [],
    steps: [{id: 'open', instruction: 'Open notes', expected: 'Notes visible'}],
    execution: {resourceKinds: ['phone', 'app', 'recorder']},
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision, path: 'routines/notes/routine.ts'},
  }
  return {
    routineId: 'notes',
    platform: 'android',
    definitionRevision: revision,
    routineSource: testRoutineSource(revision),
    definitionSha256: requestInputDigest(definition),
    definition,
    ...(verification ? {verification} : {}),
  }
}

test('candidate edit cannot become current or public example until normal merged enrollment; squash keeps actual run SHA', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), merged = 'c'.repeat(40)
  const candidate = enrollment(b, {workId: 'work:edit', attemptId: 3, sourceRevision: b})
  const records = new Map<string, {row: RoutineEnrollment; ordinary: boolean; order: number}>()
  let order = 0, mergedPr = false, promotionCalls = 0, eligible = false
  const oldExample = {definitionRevision: a, runId: 'prior-pass'}, candidateExample = {definitionRevision: b, runId: 'candidate-pass'}
  const pending: CandidatePromotion = {requestId: candidateExample.runId, workId: 'work:edit', attemptId: 3,
    sourceRevision: b, prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500', definition: candidate.definition}
  const repository: RoutineDefinitionRepository = {
    async enroll(row) {
      const previous = records.get(row.definitionRevision)
      if (previous && previous.row.definitionSha256 !== row.definitionSha256) throw Error('immutable definition changed')
      if (!previous) records.set(row.definitionRevision, {row, ordinary: !row.verification, order: ++order})
      else if (!row.verification && !previous.ordinary) {previous.ordinary = true; previous.order = ++order}
    },
    async current() {return [...records.values()].filter(v => v.ordinary).sort((x, y) => y.order - x.order).slice(0, 1).map(v => v.row)},
    async getCurrent() {return (await this.current())[0] ?? null},
    async getExact(_routine, _platform, revision) {
      return records.get(revision)?.row ?? null
    },
  }
  const promotion = new RoutineMergeEligibilityService({async candidates() {return [pending]},
    async promote() {promotionCalls++; eligible = true}}, {async merged(_url, head, installed) {
      expect(head).toBe(b); expect(installed).not.toBe(b); return mergedPr
    }})
  const service = new RoutineDefinitionService(repository, {async authorize() {}}, promotion)
  await service.enroll(enrollment(a))
  await service.enroll(candidate, 'mini')
  expect((await service.getCurrent('notes', 'android'))!.definitionRevision).toBe(a)
  expect(eligible ? candidateExample : oldExample).toEqual(oldExample)
  // Normal enrollment while the edit remains open cannot expose its passing run.
  await service.enroll(enrollment('d'.repeat(40)))
  expect(eligible).toBe(false)
  mergedPr = true
  const changed = enrollment('e'.repeat(40));
  changed.definition.steps[0]!.expected = 'Different behavior'
  changed.definitionSha256 = requestInputDigest(changed.definition)
  await service.enroll(changed)
  expect(eligible).toBe(false)
  await service.enroll(enrollment(merged))
  expect(eligible).toBe(true)
  expect((await service.getCurrent('notes', 'android'))!.definitionRevision).toBe(merged)
  expect(candidateExample.definitionRevision).toBe(b)
  expect(candidate.definitionSha256).toBe(requestInputDigest(candidate.definition))
  expect(promotionCalls).toBe(1)
  // Retrying an old ordinary registration cannot move it ahead of the merged source.
  await service.enroll(enrollment(a))
  expect((await service.getCurrent('notes', 'android'))!.definitionRevision).toBe(merged)
})

test('normal merge provenance requires frozen PR head and merged commit ancestry, including squash', async () => {
  const candidate = 'a'.repeat(40), squash = 'b'.repeat(40), installed = 'c'.repeat(40)
  let merged = false, head = candidate, status = 'ahead', calls = 0
  const gateway = new GithubRoutineMergeGateway({async token() {return 'private-test-only'}} as unknown as TestRunGithubApp,
    async url => {calls++; return Response.json(String(url).includes('/pulls/') ?
      {merged, merge_commit_sha: squash, head: {sha: head, repo: {full_name: 'Mentra-Community/Mentra-Automated-Testing'}}} : {status})})
  const pr = 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500'
  expect(await gateway.merged(pr, candidate, installed)).toBe(false); expect(calls).toBe(1)
  merged = true; head = installed
  expect(await gateway.merged(pr, candidate, installed)).toBe(false)
  head = candidate
  expect(await gateway.merged(pr, candidate, installed)).toBe(true)
  status = 'diverged'
  expect(await gateway.merged(pr, candidate, installed)).toBe(false)
  status = 'behind'
  expect(await gateway.merged(pr, candidate, installed)).toBe(false)
  expect(await gateway.merged(pr, candidate, squash)).toBe(true)
})

test('promotion retries an interrupted run-first update without losing candidate discovery or its tested revision', async () => {
  const sourceRevision = 'a'.repeat(40), mergedRevision = 'b'.repeat(40)
  const candidate = enrollment(sourceRevision, {workId: 'work:edit', attemptId: 3, sourceRevision})
  const work = authoringWorkSchema.parse({schemaVersion: 1, workId: 'work:edit', kind: 'edit', routineId: 'notes',
    brief: {goal: 'Edit notes', stepsOrChanges: ['Open notes'], expected: ['Notes visible']},
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: sourceRevision},
    target: {hostId: 'mini', laneId: 'android'}, requirements: {platform: 'android', glasses: [], capabilities: [], environment: []},
    build: {kind: 'android-apk', repository: 'Mentra-Community/MentraOS', headSha: 'c'.repeat(40), channel: 'pr', prNumber: 12,
      source: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 1},
      archive: {name: 'app.apk', url: 'https://example.com/app.apk', size: 10, sha256: 'd'.repeat(64)},
      receipt: {url: 'https://example.com/receipt.json', size: 10, sha256: 'e'.repeat(64)}}})
  const inputSha256 = requestInputDigest(work), prUrl = 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500'
  const acceptedAt = '2026-10-05T10:00:00Z', resultUrl = 'https://admin.dev.mentraglass.com/?testRun=local:candidate'
  const review = {sourceRevision, verdict: 'APPROVED' as const, prUrl, reviewUrl: prUrl + '#pullrequestreview-44'}
  const completion = {sourceRevision, reviewedRevision: sourceRevision, prUrl, reviewUrl: review.reviewUrl,
    resultUrl, summary: 'Recorded steps passed, source restored and workspace disposed.'}
  const event = {workId: work.workId, hostId: 'mini', inputSha256, eventId: 'terminal:one', sequence: 4, state: 'passed' as const,
    details: {workId: work.workId, hostId: 'mini', inputSha256, work, acceptedAt, state: 'passed' as const,
      sequence: 4, attemptId: 3, events: [], details: {sourceRevision, prUrl, requestId: 'local:candidate', resultUrl, review, completion}}}
  const job = {workId: work.workId, hostId: 'mini', inputSha256, work,
    acceptance: {workId: work.workId, hostId: 'mini', inputSha256, acceptedAt},
    status: undefined as typeof event | undefined, statusReceipts: [] as Array<{eventId: string; sequence: number; sha256: string}>}
  const intake = new RoutineWorkService({async get() {return structuredClone(job)}, async updateStatus(value: RoutineWorkStatus) {
    job.status = value as typeof event; job.statusReceipts.push({eventId: value.eventId, sequence: value.sequence, sha256: requestInputDigest(value)})
    return structuredClone(job)
  }} as unknown as RoutineWorkRepository, undefined, undefined, {async publish() {}})
  // Use the actual terminal acceptance boundary before testing normal merged enrollment.
  await intake.status(event, 'mini')
  expect(job.status?.details.attemptId).toBe(candidate.verification!.attemptId)
  expect(job.status?.details.details.review).toEqual(review)
  const request = {requestId: 'local:candidate', hostId: 'mini', catalogEligible: false,
    input: {routineId: 'notes', platform: 'android', definitionRevision: sourceRevision, verification: candidate.verification}}
  const chain = (read: () => unknown) => ({read() {return this}, readConcern() {return this}, lean: async () => read()})
  const requests = spyOn(TestRequestModel, 'find').mockImplementation(
    () => chain(() => (request.catalogEligible ? [] : [request])) as any,
  )
  const jobs = spyOn(RoutineWorkModel, 'findOne').mockReturnValue(chain(() => job) as any)
  const definitions = spyOn(RoutineDefinitionModel, 'findOne').mockReturnValue(chain(() =>
    ({...candidate, candidateBindings: [candidate.verification]})) as any)
  let runEligible = false, interruptRequestWrite = true
  const order: string[] = []
  const runUpdate = spyOn(TestRunModel, 'updateOne').mockImplementation((_filter: unknown, change?: any) => {
    order.push('run'); expect(change).toEqual({$set: {catalogEligible: true}}); runEligible = true
    return Promise.resolve({matchedCount: 1}) as any
  })
  const requestUpdate = spyOn(TestRequestModel, 'updateOne').mockImplementation((_filter: unknown, change?: any) => {
    order.push('request'); expect(change).toEqual({$set: {catalogEligible: true}})
    if (interruptRequestWrite) return Promise.reject(Error('interrupted write')) as any
    request.catalogEligible = true; return Promise.resolve({matchedCount: 1}) as any
  })
  try {
    const service = new RoutineMergeEligibilityService(undefined, {async merged() {return true}})
    await expect(service.enroll(enrollment(mergedRevision))).rejects.toThrow('interrupted write')
    expect(runEligible).toBe(true); expect(request.catalogEligible).toBe(false)
    interruptRequestWrite = false
    await service.enroll(enrollment(mergedRevision))
    expect(order).toEqual(['run', 'request', 'run', 'request'])
    expect(request.catalogEligible).toBe(true)
    expect(candidate.definition.source.revision).toBe(sourceRevision)
    expect(request.input.definitionRevision).toBe(sourceRevision)
  } finally {requests.mockRestore(); jobs.mockRestore(); definitions.mockRestore(); runUpdate.mockRestore(); requestUpdate.mockRestore()}
})
