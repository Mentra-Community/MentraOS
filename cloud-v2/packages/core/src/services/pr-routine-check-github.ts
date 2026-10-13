import {z} from 'zod'
import {isRoutineCheckLabel} from '../types/pr-rerun-label.types'
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
const deliveredCheckSchema = checkSchema.extend({status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z.string().nullable(), completed_at: z.string().datetime().nullable()})
export class PrBuildDispatchFailure extends Error {
  constructor(readonly uncertain: boolean) {super(uncertain ? 'Producer dispatch acceptance is uncertain; reconcile existing runs' : 'Producer dispatch was rejected before acceptance')}
}
export interface PrRoutineGithub {
  context(number: number): Promise<PrRoutineContext>
  permission(actor: string): Promise<boolean>
  ownedCheck(id: number, headSha: string, externalId: string): Promise<boolean>
  deliver(checkId: number | undefined, payload: CheckPayload, allowCreate?: boolean): Promise<number>
  findCheck(payload: CheckPayload): Promise<number | undefined>
  producer(platform: 'android' | 'ios-on-mac' | 'asg', context: PrRoutineContext, operationId: string): Promise<{id: number; failed: boolean} | undefined>
  requestBuild(platform: 'android' | 'ios-on-mac' | 'asg', context: PrRoutineContext, operationId: string): Promise<void>
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
      if (rows.length < 100) {
        const labels = pr.labels.map(row => row.name).filter(isRoutineCheckLabel).sort(), linked = labels.filter(label => label.startsWith('rerun:'))
        const labelActors: Record<string, string> = {}, labelEvents: Record<string, number> = {}
        if (linked.length) {
          const eventSchema = z.object({id: positive, event: z.string(), actor: z.object({login: z.string()}).nullable(), label: z.object({name: z.string()}).optional()})
          for (let eventsPage = 1; eventsPage <= 10; eventsPage++) {
            const events = z.array(eventSchema).max(100).parse(await this.api(`issues/${number}/events?per_page=100&page=${eventsPage}`, {}, 'checks', deadline))
            for (const event of events) if (event.label && linked.includes(event.label.name)) {
              if (event.event === 'labeled' && event.actor) {labelActors[event.label.name] = event.actor.login; labelEvents[event.label.name] = event.id}
              if (event.event === 'unlabeled') {delete labelActors[event.label.name]; delete labelEvents[event.label.name]}
            }
            if (events.length < 100) break
            if (eventsPage === 10) throw new TestRunError(503, 'Rerun label authority exceeds the bounded event inventory')
          }
        }
        return {number: pr.number, headSha: pr.head.sha, baseRef: pr.base.ref,
        headRef: pr.head.ref, sameRepository: pr.head.repo?.full_name === ROUTINE_CHECK_REPOSITORY,
        open: pr.state === 'open', labels, ...(linked.length ? {labelActors, labelEvents} : {}),
        peers: [...new Set(peers)].sort((a, b) => a - b)}
      }
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
      const owned = await this.findCheck(payload)
      if (owned && owned !== checkId) throw new TestRunError(409, 'Routine check receipt differs from its retained owner')
      if (!await this.ownedCheck(checkId, payload.head_sha, payload.external_id))
        throw new TestRunError(409, 'Routine check ownership differs from its retained receipt')
      const {head_sha: _, ...update} = payload
      return this.deliveryReceipt(await this.api(`check-runs/${checkId}`, {method: 'PATCH', body: JSON.stringify(update)}), payload, checkId)
    }
    const existing = await this.findCheck(payload)
    if (existing) return this.deliver(existing, payload)
    if (!allowCreate) throw new TestRunError(503, 'An uncertain check creation has no visible receipt; it will reconcile without repeating the create')
    return this.deliveryReceipt(await this.api('check-runs', {method: 'POST', body: JSON.stringify(payload)}), payload)
  }
  private deliveryReceipt(value: unknown, payload: CheckPayload, checkId?: number) {
    const check = deliveredCheckSchema.parse(value)
    if ((checkId && check.id !== checkId) || check.app.id !== this.app.applicationId || check.name !== payload.name ||
        check.head_sha !== payload.head_sha || check.external_id !== payload.external_id || check.status !== payload.status ||
        check.conclusion !== (payload.conclusion ?? null) ||
        (payload.status !== 'completed' ? check.completed_at !== null :
          !check.completed_at || payload.completed_at &&
            Math.floor(Date.parse(check.completed_at) / 1000) !== Math.floor(Date.parse(payload.completed_at) / 1000)))
      throw new TestRunError(503, 'GitHub did not retain the intended routine check state; the same delivery will reconcile')
    return check.id
  }
  async findCheck(payload: CheckPayload) {
    const schema = z.object({total_count: z.number().int().nonnegative().safe(), check_runs: z.array(checkSchema).max(100)})
    const seen = new Set<number>(), matches: Array<z.infer<typeof checkSchema>> = [], deadline = Date.now() + 20_000
    let total: number | undefined
    for (let page = 1; page <= 10; page++) {
      const rows = schema.parse(await this.api(`commits/${payload.head_sha}/check-runs?check_name=${encodeURIComponent(ROUTINE_CHECK_NAME)}&filter=all&per_page=100&page=${page}`, {}, 'checks', deadline))
      if (rows.total_count > 1000) throw new TestRunError(503, 'Routine check history exceeds its bounded reconciliation inventory')
      if (total !== undefined && rows.total_count !== total) throw new TestRunError(503, 'Routine check history changed during reconciliation')
      total = rows.total_count
      for (const row of rows.check_runs) {
        if (seen.has(row.id)) throw new TestRunError(503, 'Routine check history changed during reconciliation')
        seen.add(row.id)
        if (row.app.id === this.app.applicationId && row.external_id === payload.external_id) matches.push(row)
      }
      if (matches.length > 1) throw new TestRunError(409, 'Routine check creation is ambiguous')
      if (matches[0] && (matches[0].name !== ROUTINE_CHECK_NAME || matches[0].head_sha !== payload.head_sha)) throw new TestRunError(409, 'Routine check ownership differs from its retained receipt')
      if (seen.size === total) return matches[0]?.id
      if (seen.size > total || rows.check_runs.length < 100) throw new TestRunError(503, 'Routine check history is incomplete')
    }
    throw new TestRunError(503, 'Routine check history exceeds its bounded reconciliation inventory')
  }
  async producer(platform: 'android' | 'ios-on-mac' | 'asg', context: PrRoutineContext, operationId: string) {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new TestRunError(400, 'Invalid retained producer operation')
    const name = platform === 'asg' ? 'mentra-asg-client-build.yml' : platform === 'android' ? 'mentra-app-android-build.yml' : 'mentra-app-ios-build.yml'
    const title = `Routine PR #${context.number} ${context.headSha} ${context.baseRef} ${operationId}`
    const schema = z.object({id: positive, display_title: z.string(), path: z.string(), event: z.string(), head_branch: z.string(),
      status: z.string(), conclusion: z.string().nullable(), repository: z.object({full_name: z.string()}), head_repository: z.object({full_name: z.string()})})
    const matches: Array<z.infer<typeof schema>> = [], seen = new Set<number>(), deadline = Date.now() + 90_000
    for (let page = 1; page <= 5; page++) {
      const rows = z.object({workflow_runs: z.array(schema).max(100)}).parse(await this.api(`actions/workflows/${name}/runs?event=workflow_dispatch&branch=dev&per_page=100&page=${page}`, {}, 'source', deadline)).workflow_runs
      for (const row of rows) {
        if (seen.has(row.id)) throw new TestRunError(503, 'Producer history changed during reconciliation')
        seen.add(row.id)
        if (row.display_title === title && row.path === `.github/workflows/${name}` && row.event === 'workflow_dispatch' && row.head_branch === 'dev' &&
          row.repository.full_name === ROUTINE_CHECK_REPOSITORY && row.head_repository.full_name === ROUTINE_CHECK_REPOSITORY) matches.push(row)
      }
      if (matches.length > 1) throw new TestRunError(409, 'Producer dispatch receipts are ambiguous')
      if (rows.length < 100) return matches[0] ? {id: matches[0].id, failed: matches[0].status === 'completed' && matches[0].conclusion !== 'success'} : undefined
    }
    throw new TestRunError(503, 'Producer history exceeds its bounded reconciliation inventory')
  }
  async requestBuild(platform: 'android' | 'ios-on-mac' | 'asg', context: PrRoutineContext, operationId: string) {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw new TestRunError(400, 'Invalid retained producer operation')
    // Each native producer has its own retained dispatch intent. No second builder.
    for (const name of [platform === 'asg' ? 'mentra-asg-client-build.yml' : platform === 'android' ? 'mentra-app-android-build.yml' : 'mentra-app-ios-build.yml']) {
      let token: string
      try {token = await this.app.token('source')} catch {throw new PrBuildDispatchFailure(false)}
      let response: Response
      try {
        response = await this.transport(`https://api.github.com/repos/${ROUTINE_CHECK_REPOSITORY}/actions/workflows/${name}/dispatches`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
            Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28'}, body: JSON.stringify({ref: 'dev', inputs: {
              routine_pr: String(context.number), routine_head_sha: context.headSha, routine_base: context.baseRef, routine_operation: operationId}}),
        })
      } catch {throw new PrBuildDispatchFailure(true)}
      if (![202, 204].includes(response.status)) throw new PrBuildDispatchFailure(response.status >= 500)
    }
  }
}
