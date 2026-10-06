import {z} from 'zod'
import {RoutineDefinitionModel} from '../models/routine-definition.model'
import {RoutineWorkModel} from '../models/routine-work.model'
import {TestRequestModel} from '../models/test-request.model'
import {TestRunModel} from '../models/test-run.model'
import {testWriteConcern} from '../models/test-write-concern'
import type {RoutineEnrollment} from '../types/routine-definition.types'
import {candidateVerificationSchema} from '../types/candidate-verification.types'
import {authoringJobViewSchema} from '../types/routine-work.types'
import {requestInputDigest} from './test-request.service'
import {TestRunGithubApp} from './test-run-github-app'
import {readTestMetadata} from './test-builds.service'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const pull = z.object({merged: z.boolean(), merge_commit_sha: sha.nullable(),
  head: z.object({sha, repo: z.object({full_name: z.literal('Mentra-Community/Mentra-Automated-Testing')})})})

/** Only normal source enrollment checks merge provenance; candidates never promote themselves. */
export class GithubRoutineMergeGateway {
  constructor(private readonly app = new TestRunGithubApp(),
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  private async get(path: string): Promise<unknown> {
    try {
      const response = await this.transport(`https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/${path}`, {
        redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
          Authorization: `Bearer ${await this.app.token('harness')}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'},
      })
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readTestMetadata(response, 256 * 1024)))
    } catch {throw new Error('Routine merge provenance is unavailable; retry normal source enrollment')}
  }
  async merged(prUrl: string, reviewedRevision: string, enrolledRevision: string): Promise<boolean> {
    const number = /^https:\/\/github\.com\/Mentra-Community\/Mentra-Automated-Testing\/pull\/([1-9]\d*)$/.exec(prUrl)?.[1]
    if (!number || !sha.safeParse(reviewedRevision).success || !sha.safeParse(enrolledRevision).success) return false
    const pr = pull.parse(await this.get(`pulls/${number}`))
    if (!pr.merged || !pr.merge_commit_sha || pr.head.sha !== reviewedRevision) return false
    if (pr.merge_commit_sha === enrolledRevision) return true
    const comparison = z.object({status: z.enum(['ahead', 'behind', 'identical', 'diverged'])})
      .parse(await this.get(`compare/${pr.merge_commit_sha}...${enrolledRevision}?per_page=1`))
    return comparison.status === 'ahead' || comparison.status === 'identical'
  }
}

export interface CandidatePromotion {
  requestId: string; workId: string; attemptId: number; sourceRevision: string; prUrl: string
  definition: RoutineEnrollment['definition']
}
export interface RoutineMergeRepository {
  candidates(row: RoutineEnrollment): Promise<CandidatePromotion[]>
  promote(candidate: CandidatePromotion): Promise<void>
}
const repository: RoutineMergeRepository = {
  async candidates(row) {
    const requests = await TestRequestModel.find({catalogEligible: false, 'input.routineId': row.routineId,
      'input.platform': row.platform, 'input.verification.workId': {$type: 'string'}, state: 'terminal', terminalStatus: 'pass'})
      .read('primary').readConcern('majority').lean()
    const found: CandidatePromotion[] = []
    for (const request of requests) {
      const input = request.input as {definitionRevision: string; verification: {workId: string; attemptId: number; sourceRevision: string}}
      const parsed = candidateVerificationSchema.safeParse(input.verification)
      if (!parsed.success) continue
      const binding = parsed.data
      const [job, definition] = await Promise.all([
        RoutineWorkModel.findOne({workId: binding.workId}).read('primary').readConcern('majority').lean(),
        RoutineDefinitionModel.findOne({routineId: row.routineId, platform: row.platform,
          definitionRevision: binding.sourceRevision}).read('primary').readConcern('majority').lean(),
      ])
      const view = authoringJobViewSchema.safeParse(job?.status?.details)
      const review = view.success ? view.data.details.review : undefined
      if (view.success && job?.acceptance?.hostId === request.hostId && job.hostId === request.hostId &&
          job.acceptance.inputSha256 === job.inputSha256 && requestInputDigest(job.work) === job.inputSha256 &&
          view.data.workId === binding.workId && view.data.hostId === request.hostId &&
          view.data.inputSha256 === job.inputSha256 && view.data.state === 'passed' && view.data.attemptId === binding.attemptId &&
          view.data.details.requestId === request.requestId && review?.sourceRevision === binding.sourceRevision &&
          review.verdict === 'APPROVED' && review.prUrl === view.data.details.prUrl && definition &&
          definition.definitionRevision === input.definitionRevision &&
          requestInputDigest(definition.definition) === definition.definitionSha256 &&
          (definition.candidateBindings as unknown[] | undefined)?.some(value => requestInputDigest(value) === requestInputDigest(binding)))
        found.push({requestId: request.requestId, ...binding, prUrl: review.prUrl,
          definition: definition.definition as RoutineEnrollment['definition']})
    }
    return found
  },
  async promote(candidate) {
    const identity = {requestId: candidate.requestId, 'input.verification.workId': candidate.workId,
      'input.verification.attemptId': candidate.attemptId, 'input.verification.sourceRevision': candidate.sourceRevision}
    // The request remains discoverable until the run update settles, making a partial retry safe.
    const run = await TestRunModel.updateOne({requestId: candidate.requestId, 'verification.workId': candidate.workId,
      'verification.attemptId': candidate.attemptId, 'verification.sourceRevision': candidate.sourceRevision},
      {$set: {catalogEligible: true}}, {writeConcern: testWriteConcern})
    if (run.matchedCount !== 1) throw new Error('Candidate run eligibility did not settle; retry normal source enrollment')
    const request = await TestRequestModel.updateOne(identity, {$set: {catalogEligible: true}}, {writeConcern: testWriteConcern})
    if (request.matchedCount !== 1) throw new Error('Candidate request eligibility did not settle; retry normal source enrollment')
  },
}
export class RoutineMergeEligibilityService {
  constructor(private readonly rows: RoutineMergeRepository = repository,
    private readonly github: Pick<GithubRoutineMergeGateway, 'merged'> = new GithubRoutineMergeGateway()) {}
  async enroll(row: RoutineEnrollment) {
    const semantic = (definition: RoutineEnrollment['definition']) => {
      const {revision: _, ...source} = definition.source
      return requestInputDigest({...definition, source})
    }
    for (const candidate of await this.rows.candidates(row)) {
      if (semantic(candidate.definition) === semantic(row.definition) &&
          await this.github.merged(candidate.prUrl, candidate.sourceRevision, row.definitionRevision))
        await this.rows.promote(candidate)
    }
  }
}
