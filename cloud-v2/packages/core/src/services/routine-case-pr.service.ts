import {z} from 'zod'
import {TestRunGithubApp} from './test-run-github-app'
import {readTestMetadata} from './test-builds.service'
import {casePrSchema, casePrObservationSchema, type CasePr} from '../types/routine-case.types'
import {TestRunError} from './test-result-error'

export interface CasePrReader {observe(pr: CasePr): Promise<z.infer<typeof casePrObservationSchema>>}
/** Read-only, repository-scoped use of the existing testing GitHub App. Stored observations never imply deployment. */
export class RoutineCasePrReader implements CasePrReader {
  constructor(private readonly app = new TestRunGithubApp(), private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now) {}
  async observe(value: CasePr) {
    const pr = casePrSchema.parse(value), deadline = this.now() + 20_000
    const token = await this.app.token(pr.repository.endsWith('/MentraOS') ? 'checks' : 'harness')
    const read = async (path: string) => {
      const remaining = deadline - this.now()
      if (remaining <= 0) throw new TestRunError(503, 'Fixing PR observation is unavailable')
      const response = await this.transport(`https://api.github.com/repos/${pr.repository}/pulls/${pr.number}${path}`, {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        redirect: 'error', signal: AbortSignal.timeout(Math.min(20_000, remaining)),
      })
      if (response.status === 404) throw new TestRunError(404, 'Intended fixing PR was not found in the permitted repository')
      try {return JSON.parse(new TextDecoder().decode(await readTestMetadata(response, 2 * 1024 ** 2)))}
      catch {throw new TestRunError(503, 'Fixing PR observation is unavailable')}
    }
    const state = z.object({number: z.literal(pr.number), state: z.enum(['open', 'closed']), merged_at: z.string().datetime().nullable(),
      head: z.object({sha: casePrObservationSchema.shape.headSha})}).parse(await read(''))
    const reviewSchema = z.object({user: z.object({login: z.string()}), state: z.string(), commit_id: z.string(), submitted_at: z.string().datetime().nullable()})
    const latest = new Map<string, z.infer<typeof reviewSchema>>()
    for (let page = 1; page <= 10; page++) {
      const reviews = z.array(reviewSchema).max(100).parse(await read(`/reviews?per_page=100&page=${page}`))
      for (const review of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review)
      if (reviews.length === 100 && page === 10) throw new TestRunError(503, 'Fixing PR review history exceeds its bounded inventory')
      if (reviews.length < 100) break
    }
    const decisions = [...latest.values()].filter(review => review.commit_id === state.head.sha).map(review => review.state)
    return casePrObservationSchema.parse({...pr, headSha: state.head.sha, state: state.merged_at ? 'merged' : state.state,
      review: decisions.includes('CHANGES_REQUESTED') ? 'changes-requested' : decisions.includes('APPROVED') ? 'approved' : 'pending',
      mergedAt: state.merged_at, observedAt: new Date(this.now()).toISOString()})
  }
}
