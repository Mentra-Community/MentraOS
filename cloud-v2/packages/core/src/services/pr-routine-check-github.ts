import {z} from 'zod'
import {TestRunGithubApp} from './test-run-github-app'
import {readTestMetadata} from './test-builds.service'
import {TestRunError} from './test-result-error'
import {ROUTINE_CHECK_NAME, ROUTINE_CHECK_REPOSITORY, type CheckPayload, type PrRoutineContext} from '../types/pr-routine-check.types'

const positive = z.number().int().positive().safe()
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const prSchema = z.object({number: positive, state: z.string(), head: z.object({sha, ref: z.string(),
  repo: z.object({full_name: z.string()}).nullable()}), base: z.object({ref: z.string()}),
  labels: z.array(z.object({name: z.string()}))})
const checkSchema = z.object({id: positive, name: z.string(), head_sha: sha, external_id: z.string().nullable(),
  app: z.object({id: positive})})
export interface PrRoutineGithub {
  context(number: number): Promise<PrRoutineContext>
  permission(actor: string): Promise<boolean>
  ownedCheck(id: number, headSha: string, externalId: string): Promise<boolean>
  deliver(checkId: number | undefined, payload: CheckPayload, allowCreate?: boolean): Promise<number>
  requestBuild(platform: 'android' | 'ios-on-mac', context: PrRoutineContext): Promise<void>
}
/** All writes use the existing testing App, constrained to this repository. */
export class GithubPrRoutineChecks implements PrRoutineGithub {
  constructor(private readonly app = new TestRunGithubApp(), private readonly transport: typeof fetch = fetch) {}
  private async api(path: string, init: RequestInit = {}, scope: 'checks' | 'source' = 'checks', deadline = Date.now() + 20_000) {
    try {
      if (Date.now() >= deadline) throw new Error('Metadata deadline')
      const response = await this.transport(`https://api.github.com/repos/${ROUTINE_CHECK_REPOSITORY}/${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))), headers: {
          Authorization: `Bearer ${await this.app.token(scope)}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? {'Content-Type': 'application/json'} : {})},
      })
      if (response.status === 204) return null
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await readTestMetadata(response, 4 * 1024 ** 2)))
    } catch {throw new TestRunError(503, 'Routine check GitHub delivery is unavailable; the retained operation will reconcile')}
  }
  async context(number: number): Promise<PrRoutineContext> {
    positive.parse(number)
    const deadline = Date.now() + 90_000
    const pr = prSchema.parse(await this.api(`pulls/${number}`, {}, 'checks', deadline)), peers: number[] = []
    // GitHub checks are SHA-scoped. An incomplete list cannot establish unique ownership.
    for (let page = 1; page <= 10; page++) {
      const rows = z.array(prSchema).max(100).parse(await this.api(`pulls?state=open&per_page=100&page=${page}`, {}, 'checks', deadline))
      peers.push(...rows.filter(row => row.head.sha === pr.head.sha && ['dev', 'staging'].includes(row.base.ref))
        .map(row => row.number))
      if (rows.length < 100) return {number: pr.number, headSha: pr.head.sha, baseRef: pr.base.ref,
        headRef: pr.head.ref, sameRepository: pr.head.repo?.full_name === ROUTINE_CHECK_REPOSITORY,
        open: pr.state === 'open', labels: pr.labels.map(row => row.name).filter(value => value.startsWith('routine:')).sort(),
        peers: [...new Set(peers)].sort((a, b) => a - b)}
    }
    throw new TestRunError(503, 'PR contexts exceed the bounded ownership inventory')
  }
  async permission(actor: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(actor)) return false
    const value = z.object({permission: z.string()}).parse(await this.api(`collaborators/${encodeURIComponent(actor)}/permission`))
    return ['admin', 'maintain', 'write'].includes(value.permission)
  }
  async ownedCheck(id: number, headSha: string, externalId: string) {
    const check = checkSchema.parse(await this.api(`check-runs/${positive.parse(id)}`))
    return check.name === ROUTINE_CHECK_NAME && check.app.id === this.app.applicationId &&
      check.head_sha === headSha && check.external_id === externalId
  }
  async deliver(checkId: number | undefined, payload: CheckPayload, allowCreate = false): Promise<number> {
    if (checkId) {
      if (!await this.ownedCheck(checkId, payload.head_sha, payload.external_id)) {
        // External IDs advance at the generation fence; ownership must still be the same App/name/head.
        const check = checkSchema.parse(await this.api(`check-runs/${checkId}`))
        if (check.app.id !== this.app.applicationId || check.name !== ROUTINE_CHECK_NAME || check.head_sha !== payload.head_sha)
          throw new TestRunError(409, 'Routine check ownership differs from its retained receipt')
      }
      const {head_sha: _, ...update} = payload
      return checkSchema.parse(await this.api(`check-runs/${checkId}`, {method: 'PATCH', body: JSON.stringify(update)})).id
    }
    // Reconcile a lost create acknowledgement before attempting the same intended create.
    const rows = z.object({total_count: z.number().int().nonnegative(), check_runs: z.array(checkSchema).max(100)}).parse(
      await this.api(`commits/${payload.head_sha}/check-runs?check_name=${encodeURIComponent(ROUTINE_CHECK_NAME)}&filter=all&per_page=100`))
    if (rows.total_count !== rows.check_runs.length) throw new TestRunError(503, 'Routine check history is incomplete')
    const matches = rows.check_runs.filter(row => row.app.id === this.app.applicationId && row.external_id?.split(':')[0] === payload.external_id.split(':')[0])
    if (matches.length > 1) throw new TestRunError(409, 'Routine check creation is ambiguous')
    if (matches[0]) return this.deliver(matches[0].id, payload)
    if (!allowCreate) throw new TestRunError(503, 'An uncertain check creation has no visible receipt; it will reconcile without repeating the create')
    return checkSchema.parse(await this.api('check-runs', {method: 'POST', body: JSON.stringify(payload)})).id
  }
  async requestBuild(platform: 'android' | 'ios-on-mac', context: PrRoutineContext) {
    // The existing ASG producer owns the matching immutable OTA manifest.
    await this.api('actions/workflows/mentra-asg-client-build.yml/dispatches', {
      method: 'POST', body: JSON.stringify({ref: 'dev', inputs: {routine_pr: String(context.number),
        routine_head_sha: context.headSha, routine_base: context.baseRef}})}, 'source')
    await this.api(`actions/workflows/${platform === 'android' ? 'mentra-app-android-build.yml' : 'mentra-app-ios-build.yml'}/dispatches`, {
      method: 'POST', body: JSON.stringify({ref: 'dev', inputs: {routine_pr: String(context.number),
        routine_head_sha: context.headSha, routine_base: context.baseRef}})}, 'source')
  }
}
