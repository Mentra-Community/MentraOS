import {createHash} from 'node:crypto'
import {ROUTINE_CHECK_NAME, ROUTINE_CHECK_REPOSITORY, type CheckPayload, type PrRoutineAttempt,
  type PrRoutineCheck, type PrRoutineCheckRow, type PrRoutineContext, type PrRoutineMember} from '../types/pr-routine-check.types'
import {RoutineJobService} from './routine-job.service'
import {RoutineDispatchService} from './routine-dispatch.service'
import {RoutineDefinitionService} from './routine-definition.service'
import {GithubTestBuildGateway} from './test-builds.service'
import {TestRequestService, requestInputDigest} from './test-request.service'
import {FrameworkResultService} from './framework-result.service'
import {TestSuiteService} from './test-suite.service'
import {TestRerunService} from './test-rerun.service'
import {TestHostStateService} from './test-host-state.service'
import {TestRunError} from './test-result-error'
import {frameworkRequestInputSchema} from '../types/framework-request.types'
import type {StoredRoutineJob} from '../types/routine-job.types'
import {GithubRoutineSourceGateway} from './routine-source-selection.service'
import {GithubPrRoutineChecks, type PrRoutineGithub} from './pr-routine-check-github'
import {prRoutineCheckRepository, type PrRoutineCheckRepository} from './pr-routine-check.repository'

const digest = (value: unknown) => requestInputDigest(value)
export const prRoutineGateId = (headSha: string) => `pr-check-${createHash('sha256').update(`${ROUTINE_CHECK_REPOSITORY}:${headSha}`).digest('hex')}`
const selectionKey = (context: PrRoutineContext) => digest({number: context.number, headSha: context.headSha,
  baseRef: context.baseRef, sameRepository: context.sameRepository, labels: context.labels, peers: context.peers})
const externalId = (gate: Pick<PrRoutineCheck, 'gateId' | 'coverageGeneration' | 'attempt'>) =>
  `${gate.gateId}:${gate.coverageGeneration}:${gate.attempt.generation}`
const iso = (time: number) => new Date(time).toISOString()
const id = (gate: PrRoutineCheck, memberId: string) => `pr-routine-${digest({gate: gate.gateId,
  coverage: gate.coverageGeneration, attempt: gate.attempt.generation, memberId})}`
const terminalStatuses = ['pass', 'failed', 'setup-failed', 'teardown-failed', 'not-run', 'cancelled', 'incomplete']
/** Public definition copy is bounded and cannot carry URLs, paths, credentials or contact identifiers. */
export function routineCheckPublicName(value: string, fallback: string) {
  return value.length <= 160 && !/[\r\n<>@]|https?:|(?:Bearer|token|password|secret|serial|BSSID|SSID)\b|(?:\/Users\/|\/private\/|[a-f0-9]{32})/i.test(value)
    ? value.replace(/[|`*_\[\]\\]/g, '\\$&') : fallback
}
const adminBase = () => {
  try {const url = new URL(process.env.ADMIN_URL ?? process.env.CLOUD_ADMIN_CONSOLE_URL ?? 'https://admin.mentraglass.com/'); return url.protocol === 'https:' ? url.origin : 'https://admin.mentraglass.com'}
  catch {return 'https://admin.mentraglass.com'}
}
const adminUrl = (gate: PrRoutineCheck) => gate.attempt.suiteId
  ? `${adminBase()}/?testSuite=${encodeURIComponent(gate.attempt.suiteId)}`
  : gate.attempt.members[0]?.requestId ? `${adminBase()}/?testRun=${encodeURIComponent(gate.attempt.members[0].requestId)}`
    : `https://github.com/${ROUTINE_CHECK_REPOSITORY}/pull/${gate.context.number}`

export function routineCheckPayload(gate: PrRoutineCheck, now: number): CheckPayload {
  const attempt = gate.attempt, done = !!attempt.conclusion
  const rows = attempt.members.map(member => {
    const progress = member.progress, stale = !progress || now - Date.parse(progress.observedAt) > 60_000
    const step = progress?.currentStep, name = step && member.stepIds[step.index] === step.id
      ? member.stepNames[step.index] : undefined
    const stage = member.settled ? member.status : stale ? 'Progress unavailable' : progress!.phase.replace(/-/g, ' ')
    return `| ${member.title} | ${member.laneLabel ?? member.platform} | ${member.status === 'pass' && !member.publicationComplete ? 'publishing evidence' : member.status} | ${member.waitReason ?? stage}${name ? `: ${name} (${step!.index + 1}/${member.stepIds.length})` : ''}${progress ? ` · ${Math.max(0, Math.floor(((stale ? Date.parse(progress.observedAt) : now) - Date.parse(progress.startedAt)) / 1000))}s · observed ${progress.observedAt}` : ''} |`
  })
  const coverage = attempt.members.length ? `Selected ${attempt.members.length} routine/platform member(s) at ${gate.routineRevision ?? 'pending source'}.`
    : gate.selectionError ?? (gate.context.labels.length ? 'Preparing selected routine coverage.' : 'No routine tests requested.')
  const stopping = attempt.cancellation && !done ? '\nCancellation requested; ordinary cleanup and containment are still settling.' : ''
  const summary = [coverage, gate.selectionError ? `Selection failed: ${gate.selectionError}` : '', stopping,
    rows.length ? '\n| Routine | Platform | Result | Current activity |\n|---|---|---|---|\n' + rows.join('\n') : '',
    `\nAccepted ${attempt.acceptedAt}; deadline ${attempt.deadline}.`, `\n[Results and diagnostics](${adminUrl(gate)})`].filter(Boolean).join('\n')
  return {name: ROUTINE_CHECK_NAME, head_sha: gate.headSha, external_id: gate.checkExternalId,
    status: done ? 'completed' : attempt.cancellation || attempt.members.some(member => member.progress && !member.waitReason || ['running', 'accepted'].includes(member.status)) ? 'in_progress' : 'queued', ...(attempt.conclusion ? {conclusion: attempt.conclusion} : {}),
    started_at: attempt.acceptedAt, ...(attempt.finishedAt ? {completed_at: attempt.finishedAt} : {}), details_url: adminUrl(gate),
    output: {title: done ? attempt.conclusion === 'success' ? 'Routine tests passed' : 'Routine tests did not pass' :
      attempt.cancellation ? 'Routine tests are stopping' : 'Routine tests in progress', summary},
    ...(!done && !attempt.cancellation ? {actions: [{label: 'Cancel', description: 'Request cancellation and ordinary cleanup', identifier: 'cancel' as const}]} : {})}
}

export class PrRoutineCheckService {
  constructor(private readonly rows: PrRoutineCheckRepository = prRoutineCheckRepository,
    private readonly github: PrRoutineGithub = new GithubPrRoutineChecks(),
    private readonly jobs: Pick<RoutineJobService, 'freezeSelection' | 'submitFrozen' | 'cancel'> = new RoutineJobService(),
    private readonly catalog: Pick<RoutineDispatchService, 'catalog'> = new RoutineDispatchService(),
    private readonly definitions: Pick<RoutineDefinitionService, 'getExact'> = new RoutineDefinitionService(),
    private readonly builds: Pick<GithubTestBuildGateway, 'inventory'> = new GithubTestBuildGateway(),
    private readonly requests: Pick<TestRequestService, 'get'> = new TestRequestService(),
    private readonly results: Pick<FrameworkResultService, 'summary'> = new FrameworkResultService(),
    private readonly suites: Pick<TestSuiteService, 'create' | 'bind' | 'complete'> = new TestSuiteService(),
    private readonly reruns: Pick<TestRerunService, 'preview' | 'submit' | 'history'> = new TestRerunService(),
    private readonly hosts: Pick<TestHostStateService, 'get'> = new TestHostStateService(),
    private readonly now: () => number = Date.now,
    private readonly sources: Pick<GithubRoutineSourceGateway, 'resolve'> = new GithubRoutineSourceGateway()) {}
  private attempt(generation: number): PrRoutineAttempt {
    const acceptedAt = iso(this.now())
    return {generation, acceptedAt, deadline: iso(this.now() + 3 * 3600_000), members: []}
  }
  async intake(number: number, deliveryId: string, eventDigest: string) {
    const context = await this.github.context(number), gateId = prRoutineGateId(context.headSha)
    await this.rows.event(deliveryId, eventDigest, gateId)
    const attempt = this.attempt(1), key = selectionKey(context), predecessors = await this.rows.predecessors(number, gateId)
    const value: PrRoutineCheck = {gateId, headSha: context.headSha, context, selectionKey: key, coverageGeneration: 1,
      attempt, retired: [], controls: [], predecessors, checkExternalId: `${gateId}:1:1`, reporting: {nextAt: iso(this.now())}}
    const pending = routineCheckPayload(value, this.now())
    value.reporting.intended = {revision: 0, payload: pending, digest: digest(pending)}
    await this.rows.insert(value, new Date(this.now()))
    await this.deliver(gateId)
    await Promise.allSettled(predecessors.map(id => this.reconcile(id)))
    await this.reconcile(gateId, context)
    return {gateId}
  }
  async control(input: {deliveryId: string; digest: string; gateId: string; checkId: number; externalId: string;
    headSha: string; kind: 'rerun' | 'cancel'; actor: string}) {
    const row = await this.rows.get(input.gateId)
    const retained = row?.payload.controls.find(control => control.id === input.deliveryId)
    if (retained) {
      await this.rows.event(input.deliveryId, input.digest, input.gateId, input)
      return {gateId: input.gateId, accepted: true}
    }
    if (!row || row.payload.headSha !== input.headSha || row.payload.checkId !== input.checkId ||
        row.payload.checkExternalId !== input.externalId) throw new TestRunError(409, 'Control targets an obsolete routine check')
    if (!await this.github.ownedCheck(input.checkId, input.headSha, input.externalId) || !await this.github.permission(input.actor))
      throw new TestRunError(409, 'Routine check control requires repository write permission and its owning App')
    const context = await this.github.context(row.payload.context.number)
    if (!context.open || context.headSha !== input.headSha || selectionKey(context) !== row.payload.selectionKey)
      throw new TestRunError(409, 'Routine check context changed; reconcile the current PR first')
    await this.rows.event(input.deliveryId, input.digest, input.gateId, input)
    const claimed = await this.rows.claim(input.gateId, new Date(this.now()))
    if (!claimed) throw new TestRunError(503, 'Routine check is reconciling; retry the same delivery')
    const gate = structuredClone(claimed.payload)
    if (gate.checkExternalId !== input.externalId) {await this.rows.save(claimed, gate, new Date(this.now())); throw new TestRunError(409, 'Control generation changed')}
    if (!gate.controls.some(row => row.id === input.deliveryId)) {
      if (gate.controls.length >= 100) throw new TestRunError(409, 'Routine control history reached its bound')
      gate.controls.push({id: input.deliveryId, kind: input.kind, generation: gate.attempt.generation, actor: input.actor})
      if (input.kind === 'cancel' && !gate.attempt.conclusion) gate.attempt.cancellation ??= {kind: 'cancel', requestedAt: iso(this.now())}
      if (input.kind === 'rerun' && gate.attempt.conclusion) {
        await this.latestMembers(gate.attempt)
        if (gate.attempt.members.some(member => member.requestId && !member.settled)) {
          gate.controls = gate.controls.filter(control => control.id !== input.deliveryId)
          await this.rows.save(claimed, gate, new Date(this.now()))
          throw new TestRunError(409, 'Previous routine ownership is still settling')
        }
        gate.retired.push(gate.attempt)
        gate.attempt = {...this.attempt(gate.attempt.generation + 1), suiteId: gate.attempt.suiteId, suiteStartedAt: gate.attempt.suiteStartedAt ?? gate.attempt.acceptedAt,
          members: gate.attempt.members.map(member => ({...member, progress: undefined}))}
        gate.checkExternalId = externalId(gate)
        delete gate.reporting.intended; delete gate.reporting.deliveredDigest
        const previous = gate.retired.at(-1)!
        const all = previous.conclusion === 'success'
        gate.attempt.rerun = {id: `pr-rerun-${digest({gateId: gate.gateId, generation: gate.attempt.generation})}`,
          memberIds: previous.members.filter(member => all || member.status !== 'pass' || !member.publicationComplete).map(member => member.memberId),
          linkedMemberIds: previous.members.filter(member => member.originalRequestId).map(member => member.memberId)}
      }
      gate.reporting.nextAt = iso(this.now())
      const pending = routineCheckPayload(gate, this.now())
      gate.reporting.intended = {revision: claimed.revision + 1, payload: pending, digest: digest(pending)}
    }
    if (!await this.rows.save(claimed, gate, new Date(this.now()))) throw new TestRunError(503, 'Control storage changed; retry the same delivery')
    await this.deliver(input.gateId)
    await this.reconcile(input.gateId)
    return {gateId: input.gateId, accepted: true}
  }
  private async select(gate: PrRoutineCheck) {
    const context = gate.context
    if (!context.open) {gate.attempt.cancellation = {kind: 'closed', requestedAt: iso(this.now())}; return}
    if (context.peers.length > 1 || context.peers.length === 1 && context.peers[0] !== context.number) {gate.selectionError = 'Several open PRs share this head; choose one PR context.'; return}
    const ids = context.labels.map(value => value.slice('routine:'.length))
    if (!ids.length) {gate.selectionComplete = true; return}
    if (!context.sameRepository || !['dev', 'staging'].includes(context.baseRef)) {
      gate.selectionError = 'Selected coverage requires a same-repository PR targeting dev or staging.'; return
    }
    if (ids.length > 30 || new Set(ids).size !== ids.length || ids.some(value => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(value))) {
      gate.selectionError = 'Routine selection is invalid or exceeds 30 routines.'; return
    }
    const selected = await this.catalog.catalog(gate.routineRevision, ids)
    gate.routineRevision = selected.routineRevision
    const members: PrRoutineMember[] = []
    for (const routineId of ids) {
      const description = selected.routines.find(row => row.routineId === routineId)
      if (!description?.platforms?.length) {gate.selectionError = 'Exact routine platform description is unavailable.'; return}
      for (const platform of description.platforms) {
        const definition = await this.definitions.getExact(routineId, platform, gate.routineRevision, true)
        if (!definition || definition.definitionSha256 !== digest(definition.definition)) {gate.selectionError = 'Exact routine definition is unavailable.'; return}
        members.push({memberId: `${routineId}.${platform}`, routineId, platform,
          title: routineCheckPublicName(definition.definition.title, routineId),
          stepIds: definition.definition.steps.map(step => step.id),
          stepNames: definition.definition.steps.map(step => routineCheckPublicName(step.instruction, step.id)),
          status: 'waiting for app build', publicationComplete: false, settled: false})
      }
    }
    gate.attempt.members = members; gate.selectionComplete = true
    if (gate.attempt.members.length >= 2) gate.attempt.suiteId = `pr-suite-${digest({gateId: gate.gateId, coverage: gate.coverageGeneration})}`
  }
  private async observe(member: PrRoutineMember) {
    if (!member.requestId) return
    const request = await this.requests.get(member.requestId)
    if (!request) {member.status = 'admission pending'; member.settled = false; return}
    const job = request as unknown as StoredRoutineJob
    if (member.selection && digest(job.fleetSelection) !== digest(member.selection)) throw new TestRunError(503, 'PR routine immutable admission changed')
    const logicalHosts: Record<string, string> = {'testing-air-1': 'Air 1', 'testing-air-2': 'Air 2',
      'testing-pro-1': 'Pro 1', 'mini-controller': 'Mini', 'mentras-mac-mini': 'Mini'}
    if (request.hostId) member.laneLabel = `${logicalHosts[request.hostId] ?? 'Assigned host'} ${member.platform === 'android' ? 'Android' : 'Mac'}`
    const preparation = job.preparation?.code
    member.waitReason = job.state === 'awaiting-runner' ? 'Waiting for a compatible lane' :
      job.state === 'awaiting-source' ? 'Preparing routine source' : preparation === 'framework-unavailable' ? 'Waiting for required framework' : undefined
    let result
    try {result = await this.results.summary(member.requestId)} catch (error) {if (!(error instanceof TestRunError && error.status === 404)) throw error}
    if (result && (result.routineId !== member.routineId || result.platform !== member.platform ||
        result.definitionRevision !== member.selection?.routineRevision || result.build.headSha !== member.selection?.build.headSha))
      throw new TestRunError(503, 'PR result differs from its selected source')
    member.status = result?.outcome ?? request.terminalStatus ?? request.state
    member.publicationComplete = result?.uploadsComplete === true && result.evidenceStatus === 'complete'
    member.settled = !!job.dispatchCompletion || !job.fleetBinding && request.state === 'terminal' ||
      !!request.hostRejection && !request.hostReceipt || !!job.preparationRejection || !!job.preparationCancellation
    if (job.publicationFailure) {member.status = 'incomplete'; member.publicationComplete = false}
    delete member.progress
    const input = frameworkRequestInputSchema.safeParse(request.input)
    if (request.hostId && request.inputSha256 && input.success) {
      const host = await this.hosts.get(request.hostId), lane = host?.lanes.find(lane => lane.id === input.data.laneId), progress = lane?.progress
      if (host && progress && lane!.activity?.owner.kind === 'run' && lane!.activity.owner.id === member.requestId &&
          progress.requestId === member.requestId && progress.requestDigest === request.inputSha256 &&
          progress.ownerGeneration === lane!.activity.generation && progress.controllerIncarnation === host.incarnation &&
          progress.sequence === host.sequence && progress.totalSteps === member.stepIds.length &&
          (!progress.currentStep || member.stepIds[progress.currentStep.index] === progress.currentStep.id)) member.progress = progress
    }
  }
  private async latestMembers(attempt: PrRoutineAttempt) {
    for (const member of attempt.members) {
      if (!member.originalRequestId && member.requestId && await this.requests.get(member.requestId)) member.originalRequestId = member.requestId
      if (!member.originalRequestId) continue
      const parent = attempt.suiteId ? {suiteId: attempt.suiteId} : {requestId: member.originalRequestId}
      const history = await this.reruns.history(parent, attempt.suiteId ? member.memberId : member.originalRequestId, undefined, 1)
      const latest = history.attempts[0]
      if (latest?.requestId && latest.requestId !== member.requestId) {
        const request = await this.requests.get(latest.requestId) as unknown as StoredRoutineJob | null
        if (!request?.fleetSelection || !member.selection ||
            digest({...request.fleetSelection, requestId: member.selection.requestId}) !== digest(member.selection))
          throw new TestRunError(409, 'Latest linked attempt changed the selected source; reconcile its history')
        member.requestId = latest.requestId; member.selection = request.fleetSelection
      }
      await this.observe(member)
    }
  }
  private async cancel(attempt: PrRoutineAttempt) {
    for (const member of attempt.members) delete member.containmentPending
    // Cancel every accepted linked child, including one admitted outside this check.
    for (const member of attempt.members.filter(member => member.originalRequestId)) {
      const parent = attempt.suiteId ? {suiteId: attempt.suiteId} : {requestId: member.originalRequestId!}
      let before: number | undefined
      for (let page = 0; page < 4; page++) {
        const history = await this.reruns.history(parent, attempt.suiteId ? member.memberId : member.originalRequestId!, before, 25)
        for (const child of history.attempts) if (child.requestId && child.requestId !== member.requestId) {
          await this.jobs.cancel(child.requestId, {reason: `PR routine check ${attempt.cancellation!.kind}`})
          const request = await this.requests.get(child.requestId) as unknown as StoredRoutineJob | null
          if (request && !request.dispatchCompletion && !!request.fleetBinding && !request.hostRejection && !request.preparationCancellation && !request.preparationRejection)
            member.containmentPending = true
        }
        if (!history.nextBefore) break
        if (page === 3) throw new TestRunError(503, 'Linked cancellation history exceeds its bounded page')
        before = history.nextBefore
      }
    }
    for (const member of attempt.members) if (member.requestId && !member.settled) {
      try {await this.jobs.cancel(member.requestId, {reason: `PR routine check ${attempt.cancellation!.kind}`})}
      catch (error) {if (!(error instanceof TestRunError && error.status === 404)) throw error}
      await this.observe(member)
    }
    for (const member of attempt.members) {
      if (member.requestId && !await this.requests.get(member.requestId)) {member.settled = true; member.status = 'not-run'}
      if (member.containmentPending) member.settled = false
    }
  }
  private async freezeAdmissions(gate: PrRoutineCheck) {
    const attempt = gate.attempt
    let changed = false
    const sources = new Map<string, Awaited<ReturnType<GithubTestBuildGateway['inventory']>>>()
    for (const member of attempt.members) {
      if (!member.selection) {
        if (!sources.has(member.platform)) sources.set(member.platform, await this.builds.inventory({channel: 'pr', pr: gate.context.number, platform: member.platform}, true))
        const eligible = sources.get(member.platform)!.filter(build => build.headSha === gate.headSha && build.availability === 'available')
          .sort((a, b) => b.source.buildRunId - a.source.buildRunId)
        if (!eligible[0]) {
          const newest = sources.get(member.platform)!.filter(build => build.headSha === gate.headSha && build.source.channel === 'pr')
            .sort((a, b) => b.source.buildRunId - a.source.buildRunId)[0]
          if (newest?.producerStatus === 'failed' && !gate.buildRequests?.[member.platform]) {
            member.status = 'not-run'; member.settled = true; member.waitReason = 'App build failed or was cancelled'; continue
          }
          gate.buildRequests ??= {}
          if (!gate.buildRequests[member.platform]) {
            gate.buildRequests[member.platform] = {state: 'intended', requestedAt: iso(this.now())}; changed = true
          }
          continue
        }
        member.requestId = id(gate, member.memberId)
        member.selection = await this.jobs.freezeSelection({requestId: member.requestId, routineId: member.routineId,
          platform: member.platform, routineRevision: gate.routineRevision, source: eligible[0].source})
        changed = true
      }
    }
    return changed
  }
  private async admit(gate: PrRoutineCheck) {
    const attempt = gate.attempt
    if (attempt.suiteId) await this.suites.create({suiteId: attempt.suiteId, channel: 'pr', trigger: 'pr', startedAt: attempt.suiteStartedAt ?? attempt.acceptedAt,
      build: {headSha: gate.headSha}, members: attempt.members.map(member => ({memberId: member.memberId,
        routineId: member.routineId, platform: member.platform, definitionRevision: gate.routineRevision}))})
    for (const member of attempt.members) {
      if (!member.selection || member.status === 'not-run' || attempt.rerun && member.originalRequestId) continue
      try {
        await this.jobs.submitFrozen(member.selection, attempt.deadline)
        member.originalRequestId ??= member.requestId
        if (attempt.suiteId && (!attempt.rerun || !attempt.rerun.linkedMemberIds?.includes(member.memberId)))
          await this.suites.bind(attempt.suiteId, member.memberId, {requestId: member.requestId!})
        await this.observe(member)
      } catch {
        member.status = 'admission pending'; member.settled = false
        gate.reporting.error = 'A member admission is unavailable; independent members continue and the retained identity will retry.'
      }
    }
  }
  private async rerun(gate: PrRoutineCheck) {
    const attempt = gate.attempt, previous = gate.retired.at(-1)!, plan = attempt.rerun!
    // Existing linked history owns every real retry. Never manufacture an original for a failed admission.
    const selected = attempt.members.filter(member => plan.memberIds.includes(member.memberId)), admitted = selected.filter(member => plan.linkedMemberIds?.includes(member.memberId))
    if (admitted.length) {
      const parent = attempt.suiteId ? {suiteId: attempt.suiteId} : {requestId: admitted[0]!.originalRequestId!}
      if (!plan.previewDigest) {
        const preview = await this.reruns.preview({rerunId: plan.id, parent, deadline: attempt.deadline,
          selection: {memberIds: attempt.suiteId ? admitted.map(member => member.memberId) : [admitted[0]!.originalRequestId!]},
          reason: 'GitHub routine check re-run'}, gate.controls.at(-1)!.actor)
        plan.previewDigest = preview.previewDigest
        for (const value of preview.plan.members) {
          const member = admitted.find(member => attempt.suiteId ? member.memberId === value.memberId : member.originalRequestId === value.memberId)!
          member.requestId = value.requestId; member.selection = value.selection; member.status = 'admission pending'; member.settled = false; member.publicationComplete = false
        }
      }
      await this.reruns.submit({rerunId: plan.id, previewDigest: plan.previewDigest})
    }
    for (const member of selected.filter(member => !plan.linkedMemberIds?.includes(member.memberId) && !member.originalRequestId)) {
      if (member.requestId && await this.requests.get(member.requestId)) {member.originalRequestId = member.requestId; await this.observe(member); return}
      // A new attempt gets a new immutable request identity; failed pre-admission is not a linked original.
      if (member.requestId && member.requestId !== id(gate, member.memberId)) {delete member.requestId; delete member.selection}
      member.settled = false; member.publicationComplete = false
    }
    if (await this.freezeAdmissions(gate)) return
    await this.admit(gate)
    for (const member of attempt.members) await this.observe(member)
  }
  async reconcile(gateId: string, suppliedContext?: PrRoutineContext) {
    const row = await this.rows.claim(gateId, new Date(this.now()))
    if (!row) return
    const gate = structuredClone(row.payload)
    let nextAt = this.now() + 15_000
    try {
      const context = suppliedContext ?? await this.github.context(gate.context.number)
      if (context.headSha !== gate.headSha || !context.open) {
        gate.attempt.cancellation ??= {kind: context.open ? 'superseded' : 'closed', requestedAt: iso(this.now())}
        if (gate.attempt.conclusion && gate.attempt.conclusion !== 'timed_out') {gate.attempt.conclusion = 'cancelled'; gate.attempt.finishedAt = iso(this.now())}
      }
      else if (selectionKey(context) !== gate.selectionKey) {
        gate.retired.push({...gate.attempt, cancellation: {kind: 'superseded', requestedAt: iso(this.now())}})
        gate.context = context; gate.selectionKey = selectionKey(context); gate.coverageGeneration++
        gate.attempt = this.attempt(1); delete gate.routineRevision; delete gate.selectionError; delete gate.selectionComplete; delete gate.buildRequests
        gate.checkExternalId = externalId(gate); gate.reporting = {nextAt: iso(this.now())}
        const pending = routineCheckPayload(gate, this.now())
        gate.reporting.intended = {revision: row.revision + 1, payload: pending, digest: digest(pending)}
        if (await this.rows.save(row, gate, new Date(this.now()))) await this.deliver(gateId)
        return
      }
      for (const retired of gate.retired.filter(attempt => attempt.cancellation && attempt.members.some(member => !member.settled))) await this.cancel(retired)
      let predecessorsSettled = true
      for (const id of gate.predecessors ?? []) {
        const previous = await this.rows.get(id)
        if (previous && [previous.payload.attempt, ...previous.payload.retired].some(attempt => attempt.members.some(member => member.requestId && !member.settled))) predecessorsSettled = false
      }
      if (gate.attempt.conclusion && gate.attempt.cancellation) await this.cancel(gate.attempt)
      if (!gate.attempt.conclusion) {
        if (this.now() >= Date.parse(gate.attempt.deadline)) gate.attempt.cancellation ??= {kind: 'timeout', requestedAt: iso(this.now())}
        if (gate.attempt.cancellation) {
          await this.cancel(gate.attempt)
          if (gate.attempt.cancellation.kind === 'timeout' || gate.attempt.members.every(member => !member.requestId || member.settled)) {
            gate.attempt.conclusion = gate.attempt.cancellation.kind === 'timeout' ? 'timed_out' : 'cancelled'; gate.attempt.finishedAt = iso(this.now())
          }
        } else {
          if (!gate.selectionComplete && !gate.selectionError && !gate.attempt.rerun) {
            if (!gate.routineRevision && gate.context.labels.length) {
              gate.routineRevision = await this.sources.resolve()
              await this.rows.save(row, gate, new Date(this.now()))
              return
            }
            try {await this.select(gate)} catch (error) {
              if (error instanceof TestRunError && [400, 422].includes(error.status)) gate.selectionError = 'Selected routine is unavailable in the frozen source.'
              else throw error
            }
            await this.rows.save(row, gate, new Date(this.now()))
            return
          }
          if (gate.selectionError) {gate.attempt.conclusion = 'failure'; gate.attempt.finishedAt = iso(this.now())}
          else if (!gate.attempt.members.length) {gate.attempt.conclusion = 'success'; gate.attempt.finishedAt = iso(this.now())}
          else if (predecessorsSettled && !gate.retired.some(attempt => attempt.cancellation && attempt.members.some(member => !member.settled))) {
            if (gate.attempt.rerun) await this.rerun(gate); else {
              if (await this.freezeAdmissions(gate)) {await this.rows.save(row, gate, new Date(this.now())); return}
              for (const platform of ['android', 'ios-on-mac'] as const) if (gate.buildRequests?.[platform]?.state === 'intended') {
                // One durable dispatch intent. An uncertain acknowledgement is reconciled by publication history, never blindly resent.
                gate.buildRequests[platform]!.state = 'answered'
                if (!await this.rows.save(row, gate, new Date(this.now()))) return
                await this.github.requestBuild(platform, gate.context)
                return
              }
              await this.admit(gate)
            }
            if (gate.attempt.members.every(member => member.settled && terminalStatuses.includes(member.status) &&
                (member.status !== 'pass' || member.publicationComplete))) {
              if (gate.attempt.suiteId && !gate.attempt.rerun) await this.suites.complete(gate.attempt.suiteId, {finishedAt: iso(this.now())})
              gate.attempt.conclusion = gate.attempt.members.every(member => member.status === 'pass' && member.publicationComplete) ? 'success' : 'failure'
              gate.attempt.finishedAt = iso(this.now())
            }
          }
        }
      }
      const payload = routineCheckPayload(gate, this.now()), hash = digest(payload)
      if (gate.reporting.deliveredDigest !== hash && (this.now() >= Date.parse(gate.reporting.nextAt) || gate.attempt.conclusion || gate.attempt.cancellation)) {
        gate.reporting.intended = {revision: row.revision + 1, payload, digest: hash}
        // Save intent before external delivery; a restarted Core retries the same identity/payload.
        if (!await this.rows.save(row, gate, new Date(this.now()))) return
        return this.deliver(gateId)
      }
    } catch (error) {
      gate.reporting.error = 'Routine check reconciliation is unavailable; retained work will retry.'
      nextAt = this.now() + 30_000
    }
    await this.rows.save(row, gate, new Date(nextAt))
  }
  private async deliver(gateId: string, allowCreate = false) {
    const row = await this.rows.claim(gateId, new Date(this.now()))
    if (!row) return
    const gate = structuredClone(row.payload), intended = gate.reporting.intended
    if (!intended) {await this.rows.save(row, gate, new Date(this.now() + 15_000)); return}
    if (!gate.checkId && !gate.createAttempted) {
      gate.createAttempted = true
      if (await this.rows.save(row, gate, new Date(this.now()))) await this.deliver(gateId, true)
      return
    }
    try {
      if (intended.payload.conclusion === 'success') {
        const context = await this.github.context(gate.context.number)
        if (!context.open || context.headSha !== gate.headSha || selectionKey(context) !== gate.selectionKey) {
          delete gate.reporting.intended
          await this.rows.save(row, gate, new Date(this.now()))
          return
        }
      }
      if (row.lease && this.now() > new Date(row.lease.expiresAt).getTime() - 90_000)
        throw new TestRunError(503, 'GitHub delivery exceeded its retained lease budget')
      gate.checkId = await this.github.deliver(gate.checkId, intended.payload, allowCreate)
      gate.reporting.deliveredDigest = intended.digest; gate.reporting.deliveredAt = iso(this.now())
      gate.reporting.nextAt = iso(this.now() + 15_000); delete gate.reporting.intended; delete gate.reporting.error
    } catch {gate.reporting.error = 'GitHub App check delivery is unavailable; verify checks:write and webhook installation.'}
    await this.rows.save(row, gate, new Date(this.now() + 15_000))
  }
  async tick() {
    const due = await this.rows.due(new Date(this.now()))
    await Promise.allSettled(due.map(async gateId => {
      const row = await this.rows.get(gateId)
      if (row?.payload.reporting.intended) await this.deliver(gateId)
      else await this.reconcile(gateId)
    }))
  }
  async detail(gateId: string) {return this.rows.get(gateId)}
}
