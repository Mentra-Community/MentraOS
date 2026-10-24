import {z} from 'zod'
import {TestRunGithubApp} from './test-run-github-app'
import {readTestMetadata} from './test-builds.service'
import {casePrSchema, casePrObservationSchema, type CasePr} from '../types/routine-case.types'
import {TestRunError} from './test-result-error'
import {routineFixComponents, type RoutineFixInput} from '../types/routine-fix-provenance.types'

type PrObservation = z.infer<typeof casePrObservationSchema>
/** Inputs are the newest recorded requests first, so the bounded comparison budget covers current verification first. */
export interface CasePrReadOptions {inputs: RoutineFixInput[]; deadline: number; previous?: PrObservation; comparisonBudget?: {remaining: number}}
export interface CasePrReader {observe(pr: CasePr, options?: CasePrReadOptions): Promise<PrObservation>}
/** Read-only, repository-scoped use of the existing testing GitHub App. Stored observations never imply deployment. */
export class RoutineCasePrReader implements CasePrReader {
  constructor(private readonly app = new TestRunGithubApp(), private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now) {}
  async observe(value: CasePr, options?: CasePrReadOptions) {
    const pr = casePrSchema.parse(value), deadline = options?.deadline ?? this.now() + 20_000
    const token = await this.app.token(pr.repository.endsWith('/MentraOS') ? 'checks' : 'harness', pr.repository)
    const read = async (path: string) => {
      const remaining = deadline - this.now()
      if (remaining <= 0) throw new TestRunError(503, 'Fixing PR observation is unavailable')
      const response = await this.transport(`https://api.github.com/repos/${pr.repository}/${path}`, {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        redirect: 'error', signal: AbortSignal.timeout(Math.min(20_000, remaining)),
      })
      if (response.status === 404) throw new TestRunError(404, 'Intended fixing PR was not found in the permitted repository')
      try {return JSON.parse(new TextDecoder().decode(await readTestMetadata(response, 2 * 1024 ** 2)))}
      catch {throw new TestRunError(503, 'Fixing PR observation is unavailable')}
    }
    const state = z.object({number: z.literal(pr.number), state: z.enum(['open', 'closed']), merged_at: z.string().datetime().nullable(),
      merge_commit_sha: casePrObservationSchema.shape.headSha.nullable().optional(),
      head: z.object({sha: casePrObservationSchema.shape.headSha})}).parse(await read(`pulls/${pr.number}`))
    const reviewSchema = z.object({user: z.object({login: z.string()}), state: z.string(), commit_id: z.string(), submitted_at: z.string().datetime().nullable()})
    const latest = new Map<string, z.infer<typeof reviewSchema>>()
    for (let page = 1; page <= 10; page++) {
      const reviews = z.array(reviewSchema).max(100).parse(await read(`pulls/${pr.number}/reviews?per_page=100&page=${page}`))
      for (const review of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review)
      if (reviews.length === 100 && page === 10) throw new TestRunError(503, 'Fixing PR review history exceeds its bounded inventory')
      if (reviews.length < 100) break
    }
    const decisions = [...latest.values()].filter(review => review.commit_id === state.head.sha).map(review => review.state)
    const sourceSha = state.merged_at ? state.merge_commit_sha : state.head.sha
    const sameSource = options?.previous?.headSha === state.head.sha && options.previous.mergeCommitSha === (state.merged_at ? state.merge_commit_sha : null)
    const inclusions: NonNullable<PrObservation['inclusions']> = sameSource ? [...options!.previous!.inclusions ?? []] : []
    let comparisons = 0
    const compared = new Map<string, 'included'|'not-included'|'unverified'>()
    const targets = [...new Map((options?.inputs ?? []).flatMap(input => routineFixComponents(input, pr.repository))
      .map(value => [`${value.component}:${value.revision}`, value])).values()]
    for (const target of targets) {
      if (!sourceSha || inclusions.some(value => value.component === target.component && value.revision === target.revision && value.sourceSha === sourceSha && value.state !== 'unverified')) continue
      // Shared request deadline plus a per-PR cap; stored immutable comparisons are reused on later refreshes.
      if (this.now() >= deadline) break
      let included: 'included'|'not-included'|'unverified' = 'unverified'
      if (target.revision === sourceSha) included = 'included'
      else if (compared.has(target.revision)) included = compared.get(target.revision)!
      else try {
        if (++comparisons > 10 || options?.comparisonBudget && options.comparisonBudget.remaining-- <= 0) break
        const comparison = z.object({status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
          base_commit: z.object({sha: casePrObservationSchema.shape.headSha})})
          .parse(await read(`compare/${sourceSha}...${target.revision}?per_page=1`))
        if (comparison.base_commit.sha === sourceSha) included = comparison.status === 'ahead' || comparison.status === 'identical' ? 'included' : 'not-included'
      } catch { /* Missing, forbidden or unavailable source comparison remains unknown. */ }
      compared.set(target.revision, included)
      const kept = inclusions.filter(value => value.component !== target.component || value.revision !== target.revision)
      inclusions.splice(0, inclusions.length, ...kept, {...target, sourceSha, state: included, observedAt: new Date(this.now()).toISOString()})
    }
    return casePrObservationSchema.parse({...pr, headSha: state.head.sha, state: state.merged_at ? 'merged' : state.state,
      mergeCommitSha: state.merged_at ? state.merge_commit_sha ?? null : null, inclusions: inclusions.slice(-20),
      review: decisions.includes('CHANGES_REQUESTED') ? 'changes-requested' : decisions.includes('APPROVED') ? 'approved' : 'pending',
      mergedAt: state.merged_at, observedAt: new Date(this.now()).toISOString()})
  }
}
