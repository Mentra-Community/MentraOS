import {createHash, timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import {caseIdSchema, caseMutationSchema, routineCaseSchema, type CaseActor, type CaseActivity, type CaseOccurrence,
  type CaseMutation, type CasePr, type FailureFollowUp, type RoutineCase, caseClaimOperationSchema} from '../types/routine-case.types'
import {routineCaseRepository, type RoutineCaseRepository} from './routine-case.repository'
import {TestRunError} from './test-result-error'
import {requestInputDigest} from './test-request.service'
import {RoutineCasePrReader, type CasePrReader} from './routine-case-pr.service'
import {RoutineFixProvenanceService} from './routine-fix-provenance.service'
import {createStorageService, type StorageService} from './storage/storage.service'

const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex')
/** Reuse the canonical case generation and branch claim. Operators never create an agent lease. */
export function authorizeCaseMutation(row: RoutineCase, actor: CaseActor, now: number) {
  if (actor.kind === 'operator') {
    if (!actor.id) throw new TestRunError(403, 'Authenticated testing operator required')
    return
  }
  const claim = row.claim
  if (!claim || claim.state !== 'running' || claim.owner !== actor.id || claim.generation !== actor.generation
    || claim.branchKey !== actor.branchKey || claim.anchorRunId !== actor.anchorRunId || Date.parse(claim.expiresAt) <= now
    || !timingSafeEqual(Buffer.from(claim.tokenSha256, 'hex'), Buffer.from(tokenDigest(actor.token), 'hex')))
    throw new TestRunError(409, 'This case claim is stale or belongs to another owner')
}
const actorId = (actor: CaseActor) => `${actor.kind}:${actor.id}`
const uniquePrs = (rows: CasePr[]) => {
  const identities = rows.map(row => `${row.repository}#${row.number}`)
  if (new Set(identities).size !== rows.length) throw new TestRunError(400, 'Duplicate intended fixing PR')
  return rows
}
export interface CaseVerificationReader {verify(occurrence: CaseOccurrence, requestId: string): Promise<{passed: boolean}>}
export interface CaseDetailArchive {write(value: unknown): Promise<{key: string; sha256: string; sizeBytes: number}>}
export const caseDetailArchive = (storage: Pick<StorageService, 'putObject'> = createStorageService()): CaseDetailArchive => ({
  async write(value) {
    const body = new TextEncoder().encode(JSON.stringify(value)), sha256 = createHash('sha256').update(body).digest('hex')
    const key = `testing/routine-case-activity/${sha256}.json`
    const saved = await storage.putObject({key, body, contentType: 'application/json'})
    if (saved.sha256 !== sha256 || saved.sizeBytes !== body.byteLength) throw new TestRunError(503, 'Case history archive was not verified')
    return {key, sha256, sizeBytes: body.byteLength}
  },
})
export function caseView(row: RoutineCase, now: number): FailureFollowUp['case'] {
  const {claim, ...safe} = row
  return {...safe, execution: claim ? {owner: claim.owner, generation: claim.generation,
    state: Date.parse(claim.expiresAt) <= now ? 'expired' : claim.state} : null}
}
/** Explicit metadata only. No runnable inbox, hardware claim, or inferred cause is created. */
export class RoutineCaseService {
  constructor(private readonly rows: RoutineCaseRepository = routineCaseRepository,
    private readonly archive: CaseDetailArchive = caseDetailArchive(),
    private readonly verification?: CaseVerificationReader, private readonly now = Date.now,
    private readonly availability: () => boolean = () => process.env.ROUTINE_CASE_API_ENABLED === 'true',
    private readonly prs: CasePrReader = new RoutineCasePrReader(),
    private readonly provenance: Pick<RoutineFixProvenanceService, 'recordedInputs'> = new RoutineFixProvenanceService()) {}
  assertAvailable() {if (!this.availability()) throw new TestRunError(503, 'Canonical case API awaits verified old-writer drain and finite conversion')}
  async detail(id: string, before = Number.MAX_SAFE_INTEGER, limit = 20): Promise<FailureFollowUp> {
    this.assertAvailable(); caseIdSchema.parse(id)
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new TestRunError(400, 'Invalid case activity page')
    const row = await this.rows.get(id)
    if (!row) throw new TestRunError(404, 'Failure follow-up was not found')
    const events = await this.rows.activity(id, before, limit + 1)
    return {case: caseView(row, this.now()), activity: events.slice(0, limit), nextBefore: events.length > limit ? events[limit - 1]!.revision : null}
  }
  async summaries(rootKeys: string[]) {
    this.assertAvailable()
    return (await this.rows.byRoots(rootKeys)).map(row => caseView(row, this.now()))
  }
  private async receipt(mutationId: string, digest: string, actor: string) {
    const receipt = await this.rows.operation(mutationId)
    if (!receipt) return null
    if (receipt.digest !== digest || receipt.actor !== actor) throw new TestRunError(409, 'Case mutation ID already has different inputs or actor')
    return this.detail(receipt.caseId)
  }
  async create(occurrence: CaseOccurrence, mutationId: string, actor: CaseActor,
    shared?: {caseId: string; revision: number; explanation: string}, intendedFix?: CasePr): Promise<FailureFollowUp> {
    this.assertAvailable(); z.string().uuid().parse(mutationId)
    const digest = requestInputDigest({occurrence, shared: shared ?? null, intendedFix: intendedFix ?? null}), who = actorId(actor)
    const receipt = await this.receipt(mutationId, digest, who); if (receipt) return receipt
    const existing = (await this.rows.byRoots([occurrence.rootKey]))[0]
    if (existing) {
      if (shared && shared.caseId !== existing.caseId) throw new TestRunError(409, 'Occurrence already belongs to a canonical case')
      authorizeCaseMutation(existing, actor, this.now())
      const next = routineCaseSchema.parse({...existing, revision: existing.revision + 1, updatedAt: new Date(this.now()).toISOString(),
        ...(intendedFix ? {intendedFixes: [...existing.intendedFixes.filter(pr => pr.repository !== intendedFix.repository || pr.number !== intendedFix.number), intendedFix]} : {})})
      return this.persist(existing, next, mutationId, digest, actor, intendedFix ? 'intended-fix' : 'create', intendedFix ? ['intendedFixes'] : [])
    }
    const previous = shared ? await this.rows.get(caseIdSchema.parse(shared.caseId)) : null
    if (shared && (!previous || previous.revision !== shared.revision || shared.explanation.trim().length < 12
      || previous.classification === 'undetermined' || !previous.diagnosis.trim() || !previous.evidence.length))
      throw new TestRunError(409, 'Shared cause requires current case revision and a demonstrated grouping explanation')
    if (previous) authorizeCaseMutation(previous, actor, this.now())
    else if (actor.kind !== 'operator') throw new TestRunError(403, 'Creating an unclaimed case requires authenticated operator authority')
    const at = new Date(this.now()).toISOString(), caseId = previous?.caseId ?? `mfc_${requestInputDigest(['unknown-v2', occurrence.rootKey])}`
    const next = routineCaseSchema.parse(previous ? {...previous, revision: previous.revision + 1, updatedAt: at,
      occurrences: [...previous.occurrences, occurrence], stage: previous.stage === 'verified' ? 'investigating' : previous.stage, intendedFixes: intendedFix ? [...previous.intendedFixes.filter(pr => pr.repository !== intendedFix.repository || pr.number !== intendedFix.number), intendedFix] : previous.intendedFixes} : {
      version: 2, caseId, revision: 0, generation: 0, classification: 'undetermined', diagnosis: '', evidence: [],
      stage: 'investigating', nextAction: '', owner: null, occurrences: [occurrence], intendedFixes: intendedFix ? [intendedFix] : [],
      prObservations: [], createdAt: at, updatedAt: at,
    })
    return this.persist(previous, next, mutationId, digest, actor, 'create', ['occurrences'], shared?.explanation)
  }
  async update(id: string, value: unknown, actor: CaseActor): Promise<FailureFollowUp> {
    this.assertAvailable(); caseIdSchema.parse(id)
    const input = caseMutationSchema.parse(value), who = actorId(actor), digest = requestInputDigest({caseId: id, input})
    const receipt = await this.receipt(input.mutationId, digest, who); if (receipt) return receipt
    const row = await this.rows.get(id)
    if (!row) throw new TestRunError(404, 'Failure follow-up was not found')
    authorizeCaseMutation(row, actor, this.now())
    if (input.revision !== row.revision) throw new TestRunError(409, 'Case changed; read its current revision')
    if (input.owner !== undefined && row.claim && input.owner !== row.owner)
      throw new TestRunError(409, 'Settle the current agent claim before changing the recorded owner')
    const next = await this.apply(row, input, actor)
    const changed = Object.keys(input).filter(key => !['revision', 'mutationId'].includes(key))
    return this.persist(row, next, input.mutationId, digest, actor, 'update', changed)
  }
  private async persist(previous: RoutineCase | null, next: RoutineCase, mutationId: string, digest: string,
    actor: CaseActor, kind: CaseActivity['kind'], changed: string[], grouping?: string, allowExpired = false, acquiring = false) {
    const who = actorId(actor)
    next.prObservations = next.prObservations.filter(observation => next.intendedFixes.some(pr => pr.repository === observation.repository && pr.number === observation.number))
    for (const pr of next.intendedFixes) if (!previous?.intendedFixes.some(old => old.repository === pr.repository && old.number === pr.number)) {
      const inputs = next.occurrences.some(value => value.verificationRequestIds.length || value.closure?.requestId)
        ? await this.provenance.recordedInputs(next.occurrences) : []
      const observation = await this.prs.observe(pr, {inputs, deadline: this.now() + 20_000, comparisonBudget: {remaining: 20}})
      next.prObservations = [...next.prObservations.filter(old => old.repository !== pr.repository || old.number !== pr.number), observation]
    }
    next = routineCaseSchema.parse(next)
    const detail = await this.archive.write({mutationId, actor: who, at: next.updatedAt, previous, next, ...(grouping ? {grouping} : {})})
    const event: CaseActivity = {caseId: next.caseId, revision: next.revision, mutationId, digest, actor: who,
      at: next.updatedAt, kind, changed, detail}
    // Archive writes may take time: check live authority again and fence it at the actual database write.
    if (previous && !allowExpired && !acquiring) authorizeCaseMutation(previous, actor, this.now())
    const fence = actor.kind === 'agent' && !acquiring ? {owner: actor.id, tokenSha256: tokenDigest(actor.token), generation: actor.generation,
      branchKey: actor.branchKey, anchorRunId: actor.anchorRunId, now: this.now(), allowExpired} : undefined
    try {
      if (await this.rows.commit(previous, next, event, fence)) return this.detail(next.caseId)
    } catch (error) {if ((error as {code?: number}).code !== 11000) throw error}
    const winner = await this.receipt(mutationId, digest, who); if (winner) return winner
    throw new TestRunError(409, 'Case changed; read its canonical case and current revision')
  }
  async reconcilePrs(id: string, value: unknown, actor: CaseActor) {
    this.assertAvailable(); caseIdSchema.parse(id)
    const input = z.object({mutationId: z.string().uuid(), revision: z.number().int().nonnegative().safe()}).strict().parse(value)
    const digest = requestInputDigest({caseId: id, reconcilePrs: input}), who = actorId(actor)
    const receipt = await this.receipt(input.mutationId, digest, who); if (receipt) return receipt
    const row = await this.rows.get(id)
    if (!row) throw new TestRunError(404, 'Failure follow-up was not found')
    authorizeCaseMutation(row, actor, this.now())
    if (row.revision !== input.revision) throw new TestRunError(409, 'Case changed; read its current revision')
    const inputs = await this.provenance.recordedInputs(row.occurrences), deadline = this.now() + 20_000, comparisonBudget = {remaining: 20}
    const prObservations = []
    for (const pr of row.intendedFixes) {
      const previous = row.prObservations.find(old => old.repository === pr.repository && old.number === pr.number)
      if (this.now() >= deadline && previous) {prObservations.push(previous); continue}
      prObservations.push(await this.prs.observe(pr, {inputs, deadline, comparisonBudget, previous}))
    }
    return this.persist(row, {...row, revision: row.revision + 1, updatedAt: new Date(this.now()).toISOString(), prObservations},
      input.mutationId, digest, actor, 'pr-observation', ['prObservations'])
  }
  /** Existing single-case claim; expiry never admits a different owner until its previous claim is settled. */
  async claim(id: string, value: unknown, owner: string): Promise<FailureFollowUp> {
    this.assertAvailable(); caseIdSchema.parse(id)
    const input = caseClaimOperationSchema.parse(value), digest = requestInputDigest({caseId: id, claim: input, owner}), who = `agent:${owner}`
    const receipt = await this.receipt(input.mutationId, digest, who); if (receipt) return receipt
    const row = await this.rows.get(id)
    if (!row) throw new TestRunError(404, 'Failure follow-up was not found')
    if (row.revision !== input.revision) throw new TestRunError(409, 'Case changed; read its current revision')
    const next = structuredClone(row), now = this.now()
    next.revision++; next.updatedAt = new Date(now).toISOString()
    const actor: CaseActor = {kind: 'agent', id: owner, token: input.token, generation: input.generation,
      branchKey: input.branchKey, anchorRunId: input.anchorRunId}
    if (input.action === 'acquire') {
      if (row.claim) throw new TestRunError(409, 'Settle the retained case claim before admitting another owner')
      if (input.generation !== row.generation + 1 || !row.occurrences.some(o => o.anchorRunId === input.anchorRunId && o.original.branchKey === input.branchKey))
        throw new TestRunError(409, 'Claim generation or original branch anchor does not match')
      next.generation = input.generation
      next.owner = owner
      next.claim = {owner, tokenSha256: tokenDigest(input.token), branchKey: input.branchKey, anchorRunId: input.anchorRunId,
        generation: next.generation, expiresAt: new Date(now + input.ttlSeconds * 1000).toISOString(), state: 'running'}
      // Authenticated host acquires only an unclaimed case. Its CAS fences the prior generation.
      return this.persist(row, next, input.mutationId, digest, actor, 'claim', ['claim', 'generation', 'owner'], undefined, false, true)
    }
    const claim = row.claim
    if (!claim || claim.owner !== owner || claim.generation !== input.generation || claim.branchKey !== input.branchKey || claim.anchorRunId !== input.anchorRunId
      || claim.tokenSha256 !== tokenDigest(input.token)) throw new TestRunError(409, 'Case claim belongs to another owner or generation')
    if (input.action === 'renew') {
      authorizeCaseMutation(row, actor, now)
      next.claim!.expiresAt = new Date(now + input.ttlSeconds * 1000).toISOString()
      return this.persist(row, next, input.mutationId, digest, actor, 'claim', ['claim'])
    }
    // Explicit settlement by the exact owner works after expiry; it never authorizes further case work.
    if (input.action === 'hold') next.claim!.state = 'held'
    else delete next.claim
    return this.persist(row, next, input.mutationId, digest, actor, input.action === 'release' ? 'release' : 'claim', ['claim'], input.reason, true)
  }
  private async apply(row: RoutineCase, input: CaseMutation, actor: CaseActor): Promise<RoutineCase> {
    const {mutationId: _operation, revision: _revision, verification, close, input: question, ...fields} = input
    const next = {...structuredClone(row), ...fields, revision: row.revision + 1, updatedAt: new Date(this.now()).toISOString()}
    if (question === null) delete next.input; else if (question) next.input = question
    if (next.stage === 'needs-input' && !next.input) throw new TestRunError(400, 'Needs input requires a recorded question and recipient')
    if (next.stage !== 'needs-input') delete next.input
    if (next.classification !== 'undetermined' && (!next.diagnosis.trim() || next.evidence.length === 0))
      throw new TestRunError(400, 'A demonstrated cause requires diagnosis and evidence')
    if (next.intendedFixes) uniquePrs(next.intendedFixes)
    for (const command of [verification, close]) if (command) {
      const occurrence = next.occurrences.find(o => o.occurrenceId === command.occurrenceId)
      if (!occurrence) throw new TestRunError(404, 'Original occurrence does not belong to this case')
      if (actor.kind === 'agent' && occurrence.original.branchKey !== actor.branchKey)
        throw new TestRunError(409, 'Agent claim belongs to a different original branch')
      if (command.requestId) {
        if (!this.verification) throw new TestRunError(503, 'Published verification reader is unavailable')
        const verified = await this.verification.verify(occurrence, command.requestId)
        if (command === close && close.kind === 'verified' && !verified.passed) throw new TestRunError(409, 'Verification is not a complete published passing linked run')
        if (!occurrence.verificationRequestIds.includes(command.requestId)) occurrence.verificationRequestIds.push(command.requestId)
      }
      if (command === close) {
        if (close.kind === 'verified' && (!close.requestId || next.classification === 'undetermined'))
          throw new TestRunError(400, 'A verified fix requires a demonstrated cause and linked passing run')
        occurrence.closure = {kind: close.kind, reason: close.reason, ...(close.requestId ? {requestId: close.requestId} : {}),
          at: next.updatedAt, actor: actorId(actor)}
      }
    }
    if (next.stage === 'verified' && next.occurrences.some(o => !o.closure))
      throw new TestRunError(409, 'Each original occurrence needs verification or an explicit closure reason')
    return routineCaseSchema.parse(next)
  }
}
