import {z} from 'zod'
import {RoutineWorkModel} from '../models/routine-work.model'
import {testWriteConcern} from '../models/test-write-concern'
import {
  authoringWorkSchema,
  portableAuthoringWorkSchema,
  type PortableAuthoringWork,
  routineWorkRequestSchema,
  routineWorkAcceptanceSchema,
  routineWorkStatusSchema,
  routineWorkLocalRegistrationSchema,
  type AuthoringWork,
  type RoutineWorkRequest,
  type RoutineWorkStatus,
} from '../types/routine-work.types'
import {frameworkIdentitySchema} from '../types/framework-request.types'
import {GithubTestBuildGateway, type TestBuildGateway} from './test-builds.service'
import {selectedBuildInput} from '../types/test-build.types'
import {TestHostStateService} from './test-host-state.service'
import {GithubRoutineSourceGateway} from './routine-source-selection.service'
import {routineJobBindInputSchema, portableRequirementsSchema, type RoutineJobBinding, type PortableRequirements, routineJobActionsSchema, routineJobCompletionSchema, type RoutineJobCompletion} from '../types/routine-job.types'
import {compatibleRoutineLane, routineJobRouting, routineLaneDescriptorRevision} from './routine-job.service'
import {requestInputDigest, TestRequestConflict} from './test-request.service'
import {TestRunError} from './test-result-error'
import {RoutineWorkNotification} from './routine-work-notification'
import {GithubRoutineJobActions, type RoutineJobActions, routineActionsRetry, type RoutineActionsDispatch, cancelRoutineActions, type RoutineActionsCancellation} from './routine-job-actions.service'

export interface RoutineWorkDelivery {
  workId: string
  requestSha256: string
  inputSha256: string
  hostId?: string
  request: RoutineWorkRequest | AuthoringWork
  work: AuthoringWork | PortableAuthoringWork
  fleetSelection?: PortableAuthoringWork
  fleetInputSha256?: string
  fleetDeadline?: Date
  fleetBinding?: RoutineJobBinding
  fleetCancellation?: {requestedAt: string; reason: string}
  fleetDispatch?: RoutineActionsDispatch
  fleetActionsCancellation?: RoutineActionsCancellation
  fleetActions?: Array<{actionsRunId: string; recordedAt: string}>
  dispatchCompletion?: RoutineJobCompletion
  createdAt?: Date
  acceptance?: z.infer<typeof routineWorkAcceptanceSchema>
  status?: RoutineWorkStatus
  statusReceipts?: Array<{eventId: string; sequence: number; sha256: string}>
  reporting?: import('./routine-work-reporting').RoutineWorkReporting
}
export interface RoutineWorkRepository {
  get(id: string): Promise<RoutineWorkDelivery | null>
  insert(row: RoutineWorkDelivery): Promise<void>
  queued(hostId: string, after: {createdAt: Date; workId: string} | null, limit: number): Promise<RoutineWorkDelivery[]>
  accept(receipt: z.infer<typeof routineWorkAcceptanceSchema>): Promise<RoutineWorkDelivery | null>
  updateStatus(event: RoutineWorkStatus, previous?: RoutineWorkStatus): Promise<RoutineWorkDelivery | null>
  bind?(workId: string, inputSha256: string, binding: RoutineJobBinding, work: AuthoringWork, now: Date): Promise<RoutineWorkDelivery | null>
  pending?(limit: number, now: Date): Promise<RoutineWorkDelivery[]>
  dispatchCompletions?(hostId: string, limit: number): Promise<RoutineWorkDelivery[]>
  dispatch?(workId: string, previous: RoutineWorkDelivery['fleetDispatch'], value: NonNullable<RoutineWorkDelivery['fleetDispatch']>): Promise<RoutineWorkDelivery | null>
  actions?(workId: string, inputSha256: string, value: {actionsRunId: string; recordedAt: string}): Promise<RoutineWorkDelivery | null>
  complete?(workId: string, hostId: string, inputSha256: string, receipt: RoutineJobCompletion): Promise<RoutineWorkDelivery | null>
  cancellationProgress?(workId: string, inputSha256: string, value: RoutineActionsCancellation, completedRunIds?: string[]): Promise<RoutineWorkDelivery | null>
  cancellations?(hostId: string, limit: number): Promise<RoutineWorkDelivery[]>
  cancel?(workId: string, inputSha256: string, cancellation: NonNullable<RoutineWorkDelivery['fleetCancellation']>): Promise<RoutineWorkDelivery | null>
}
const repository: RoutineWorkRepository = {
  async get(workId) {
    return (await RoutineWorkModel.findOne({workId})
      .read('primary')
      .readConcern('majority')
      .lean()) as RoutineWorkDelivery | null
  },
  async insert(row) {
    await RoutineWorkModel.create([row], {writeConcern: testWriteConcern})
  },
  async queued(hostId, after, limit) {
    return (await RoutineWorkModel.find({
      hostId,
      acceptance: {$exists: false},
      fleetCancellation: {$exists: false},
      ...(after
        ? {$or: [{createdAt: {$gt: after.createdAt}}, {createdAt: after.createdAt, workId: {$gt: after.workId}}]}
        : {}),
    })
      .sort({createdAt: 1, workId: 1})
      .limit(limit)
      .read('primary')
      .readConcern('majority')
      .lean()) as RoutineWorkDelivery[]
  },
  async pending(limit, now) {
    const ready = new Date(now.getTime() - 30_000).toISOString()
    return await RoutineWorkModel.find({fleetSelection: {$exists: true}, $or: [
      {fleetCancellation: {$exists: true}, 'fleetActionsCancellation.settled': {$ne: true},
        $or: [{fleetActionsCancellation: {$exists: false}}, {'fleetActionsCancellation.checkedAt': {$lte: ready}}]},
      {fleetCancellation: {$exists: false}, $or: [{fleetDeadline: {$lte: now}, dispatchCompletion: {$exists: false}},
        {fleetBinding: {$exists: false}, $or: [{fleetDispatch: {$exists: false}}, {'fleetDispatch.attempts': {$lt: 20},
          'fleetDispatch.lastAttemptAt': {$lte: ready}, $or: [{'fleetDispatch.checkedAt': {$exists: false}}, {'fleetDispatch.checkedAt': {$lte: ready}}]}]}]},
    ]}).sort({createdAt: 1, workId: 1}).limit(limit).read('primary').readConcern('majority').lean() as unknown as RoutineWorkDelivery[]
  },
  async dispatchCompletions(hostId, limit) {
    return await RoutineWorkModel.find({hostId, fleetBinding: {$exists: true}, dispatchCompletion: {$exists: false}})
      .sort({createdAt: 1, workId: 1}).limit(limit).read('primary').readConcern('majority').lean() as unknown as RoutineWorkDelivery[]
  },
  async dispatch(workId, previous, fleetDispatch) {
    return await RoutineWorkModel.findOneAndUpdate({workId, fleetDispatch: previous ?? {$exists: false},
      fleetBinding: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: new Date()}}, {$set: {fleetDispatch}},
      {new: true, writeConcern: testWriteConcern}).lean() as unknown as RoutineWorkDelivery | null
  },
  async actions(workId, fleetInputSha256, value) {
    return await RoutineWorkModel.findOneAndUpdate({workId, fleetInputSha256, 'fleetActions.actionsRunId': {$ne: value.actionsRunId},
      $expr: {$lt: [{$size: {$ifNull: ['$fleetActions', []]}}, 20]}}, {$push: {fleetActions: value}},
      {new: true, writeConcern: testWriteConcern}).lean() as unknown as RoutineWorkDelivery | null
  },
  async complete(workId, hostId, inputSha256, dispatchCompletion) {
    return await RoutineWorkModel.collection.findOneAndUpdate({workId, hostId, inputSha256, fleetBinding: {$exists: true},
      dispatchCompletion: {$exists: false}}, {$set: {dispatchCompletion, updatedAt: new Date()}},
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as RoutineWorkDelivery | null
  },
  async cancellationProgress(workId, fleetInputSha256, fleetActionsCancellation, completedRunIds) {
    return await RoutineWorkModel.findOneAndUpdate({workId, fleetInputSha256, fleetCancellation: {$exists: true},
      ...(fleetActionsCancellation.settled ? {$expr: {$setIsSubset: [{$ifNull: ['$fleetActions.actionsRunId', []]}, {$literal: completedRunIds ?? []}]}} : {})},
      {$set: {fleetActionsCancellation}}, {new: true, writeConcern: testWriteConcern}).lean() as unknown as RoutineWorkDelivery | null
  },
  async cancellations(hostId, limit) {
    return await RoutineWorkModel.find({hostId, fleetCancellation: {$exists: true}, 'status.state': {$nin: ['passed', 'failed', 'cancelled']}})
      .sort({updatedAt: 1, workId: 1}).limit(limit).read('primary').readConcern('majority').lean() as unknown as RoutineWorkDelivery[]
  },
  async bind(workId, fleetInputSha256, fleetBinding, work, now) {
    return await RoutineWorkModel.collection.findOneAndUpdate({workId, fleetInputSha256, hostId: {$exists: false},
      fleetBinding: {$exists: false}, fleetCancellation: {$exists: false}, fleetDeadline: {$gt: now}},
      {$set: {hostId: fleetBinding.hostId, fleetBinding, work, inputSha256: requestInputDigest(work), updatedAt: now}},
      {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as RoutineWorkDelivery | null
  },
  async cancel(workId, fleetInputSha256, fleetCancellation) {
    return await RoutineWorkModel.collection.findOneAndUpdate({workId, fleetInputSha256, fleetCancellation: {$exists: false}},
      {$set: {fleetCancellation, updatedAt: new Date()}}, {returnDocument: 'after', writeConcern: testWriteConcern}) as unknown as RoutineWorkDelivery | null
  },
  async accept(receipt) {
    return (await RoutineWorkModel.findOneAndUpdate(
      {workId: receipt.workId, hostId: receipt.hostId, inputSha256: receipt.inputSha256, acceptance: {$exists: false}, fleetCancellation: {$exists: false}},
      {$set: {acceptance: receipt}},
      {new: true, writeConcern: testWriteConcern},
    ).lean()) as RoutineWorkDelivery | null
  },
  async updateStatus(event, previous) {
    return (await RoutineWorkModel.findOneAndUpdate(
      {
        'workId': event.workId,
        'hostId': event.hostId,
        'inputSha256': event.inputSha256,
        'acceptance': {$exists: true},
        'statusReceipts.eventId': {$ne: event.eventId},
        // Bind the entire observed status, including its sequence and terminal
        // outcome. A concurrent status must not pass this earlier inspection.
        'status': previous ?? {$exists: false},
        '$or': [{status: {$exists: false}}, {'status.sequence': {$lt: event.sequence}}],
      },
      {
        $set: {status: event},
        $push: {statusReceipts: {eventId: event.eventId, sequence: event.sequence, sha256: requestInputDigest(event)}},
      },
      {new: true, writeConcern: testWriteConcern},
    ).lean()) as RoutineWorkDelivery | null
  },
}

const terminalState = (state?: string) => ['passed', 'failed', 'cancelled'].includes(state ?? '')
function terminalOutcome(event: RoutineWorkStatus) {
  const {progress: _, ...details} = event.details.details
  return {state: event.state, attemptId: event.details.attemptId ?? null, details}
}

export class RoutineWorkService {
  constructor(
    private readonly rows: RoutineWorkRepository = repository,
    private readonly builds: Pick<TestBuildGateway, 'resolve'> = new GithubTestBuildGateway(),
    private readonly hosts: Pick<TestHostStateService, 'get'> & Partial<Pick<TestHostStateService, 'list'>> = new TestHostStateService(),
    private readonly notifications: Pick<RoutineWorkNotification, 'publish'> = new RoutineWorkNotification(),
    private readonly sources: Pick<GithubRoutineSourceGateway, 'resolve'> = new GithubRoutineSourceGateway(),
    private readonly now: () => number = Date.now,
    private readonly actionsTransport: RoutineJobActions | null = rows === repository ? new GithubRoutineJobActions() : null,
  ) {}
  private sameRequest(row: RoutineWorkDelivery, input: RoutineWorkRequest) {
    if (row.requestSha256 !== requestInputDigest(input) || row.inputSha256 !== requestInputDigest(row.work) || row.fleetSelection && row.fleetInputSha256 !== requestInputDigest({selection: row.fleetSelection, deadline: row.fleetDeadline!.toISOString()}))
      throw new TestRequestConflict('Authoring retry changed its frozen brief/source/build or target')
    return row
  }
  private async notify(row: RoutineWorkDelivery) {
    try {
      await this.notifications.publish(row)
    } catch {
      console.error('Authoring receipt retained; PR notification unavailable', row.workId)
    }
  }
  async report(row: RoutineWorkDelivery) {
    try {
      await this.notifications.publish(row)
    } catch {
      throw new TestRunError(
        503,
        'Authoring report is retained; verify the GitHub App source-PR comment permission and retry the same work',
      )
    }
  }
  async submit(value: unknown) {
    const parsed = routineWorkRequestSchema.safeParse(value)
    if (!parsed.success) throw new TestRunError(400, 'Invalid authoring work request')
    const input = parsed.data,
      existing = await this.rows.get(input.workId)
    if (existing) {
      const row = this.sameRequest(existing, input)
      await this.notify(row)
      return this.deliver(row)
    }
    if (input.buildSource.channel !== 'pr' || input.buildSource.prNumber !== input.origin.prNumber)
      throw new TestRunError(409, 'Authoring request build differs from its originating PR')
    try {
      const platform = input.requirements.platform === 'mac' ? 'ios-on-mac' : 'android'
      const [build, revision] = await Promise.all([
        this.builds.resolve(input.buildSource, platform),
        this.sources.resolve(input.source.revision),
      ])
      if (
        !build ||
        build.availability !== 'available' ||
        !build.archive ||
        !build.receipt ||
        build.headSha !== input.origin.headSha
      )
        throw new TestRunError(409, 'The exact originating PR build is not published')
      const {buildSource: _, deadline: _deadline, ...fields} = input
      const work = portableAuthoringWorkSchema.parse({
        ...fields, source: {...fields.source, revision},
        build: {
          ...selectedBuildInput(build, platform),
          ...(build.manifest ? {manifest: build.manifest, manifestSha256: build.manifestSha256} : {}),
        },
      })
      const deadline = new Date(input.deadline ?? this.now() + 3 * 3600_000)
      if (deadline.getTime() <= this.now() || deadline.getTime() > this.now() + 3 * 3600_000)
        throw new TestRunError(400, 'Authoring job deadline must be within three hours')
      const row: RoutineWorkDelivery = {
        workId: work.workId,
        fleetSelection: work, fleetDeadline: deadline,
        fleetInputSha256: requestInputDigest({selection: work, deadline: deadline.toISOString()}),
        request: input,
        requestSha256: requestInputDigest(input),
        work,
        inputSha256: requestInputDigest(work),
        reporting: {nextProgressAt: new Date(), history: []},
      }
      await this.rows.insert(row)
      const retained = (await this.rows.get(row.workId)) ?? row
      await this.notify(retained)
      return this.deliver(retained)
    } catch (error) {
      const winner = await this.rows.get(input.workId)
      if (winner) {
        const row = this.sameRequest(winner, input)
        await this.notify(row)
        return this.deliver(row)
      }
      throw error
    }
  }
  async inspect(workId: string) {
    if (!frameworkIdentitySchema.safeParse(workId).success) throw new TestRunError(400, 'Invalid authoring identity')
    const row = await this.rows.get(workId)
    if (!row) throw new TestRunError(404, 'Authoring work was not found')
    if (row.inputSha256 !== requestInputDigest(row.work) || row.fleetSelection && (!row.fleetDeadline || row.fleetInputSha256 !== requestInputDigest({selection: row.fleetSelection, deadline: row.fleetDeadline.toISOString()})))
      throw new TestRunError(503, 'Stored authoring exact inputs are unavailable')
    return row
  }
  private async discover(row: RoutineWorkDelivery) {
    if (!this.actionsTransport?.runs || !row.fleetDispatch) return []
    const runs = await this.actionsTransport.runs(row.workId, row.fleetDispatch.firstAttemptAt ?? row.createdAt?.toISOString() ?? row.fleetDispatch.lastAttemptAt)
    for (const run of runs) if (!row.fleetActions?.some(value => value.actionsRunId === run.actionsRunId)) {
      row = await this.rows.actions?.(row.workId, row.fleetInputSha256!, {actionsRunId: run.actionsRunId, recordedAt: new Date(this.now()).toISOString()}) ?? await this.inspect(row.workId)
      if (!row.fleetActions?.some(value => value.actionsRunId === run.actionsRunId)) throw new TestRunError(503, 'Authoring Actions delivery history exceeds its bound')
    }
    return runs
  }
  private async deliver(row: RoutineWorkDelivery): Promise<RoutineWorkDelivery> {
    if (!this.actionsTransport || !row.fleetSelection || !row.fleetDeadline || row.fleetBinding || row.fleetCancellation || this.now() >= row.fleetDeadline.getTime()) return row
    const previous = row.fleetDispatch
    if (previous && this.now() - Date.parse(previous.checkedAt ?? previous.lastAttemptAt) < 30_000) return row
    let runs
    try {runs = await this.discover(row)} catch (error) {
      if (previous) await this.rows.dispatch?.(row.workId, previous, {...previous, checkedAt: new Date(this.now()).toISOString(), error: 'Authoring Actions run discovery is unavailable'})
      return this.inspect(row.workId)
    }
    if (!routineActionsRetry(previous, runs, this.now())) {
      if (previous) await this.rows.dispatch?.(row.workId, previous, {...previous, checkedAt: new Date(this.now()).toISOString()})
      return this.inspect(row.workId)
    }
    if (!this.rows.dispatch) throw new TestRunError(503, 'Authoring Actions dispatch storage is unavailable')
    const receipt = {attempts: (previous?.attempts ?? 0) + 1, firstAttemptAt: previous?.firstAttemptAt ?? new Date(this.now()).toISOString(), lastAttemptAt: new Date(this.now()).toISOString(), checkedAt: new Date(this.now()).toISOString()}
    if (!await this.rows.dispatch(row.workId, previous, receipt)) return this.inspect(row.workId)
    try {
      await this.actionsTransport.dispatch(row.workId)
      return await this.rows.dispatch(row.workId, receipt, {...receipt, acknowledgedAt: new Date(this.now()).toISOString()}) ?? await this.inspect(row.workId)
    } catch {
      await this.rows.dispatch(row.workId, receipt, {...receipt, error: 'GitHub authoring delivery is unavailable; retry the retained job'})
      return this.inspect(row.workId)
    }
  }
  async reconcilePending(): Promise<void> {
    const pending = await this.rows.pending?.(20, new Date(this.now())) ?? []
    await Promise.allSettled(pending.map(row => this.observation(row.workId)))
  }
  async actions(jobId: string, value: unknown): Promise<unknown> {
    const input = routineJobActionsSchema.parse(value), row = await this.inspect(jobId)
    if (!row.fleetInputSha256 || input.inputSha256 !== row.fleetInputSha256 || !this.rows.actions)
      throw new TestRequestConflict('Authoring Actions receipt changed its exact inputs')
    const saved = await this.rows.actions(jobId, input.inputSha256, {actionsRunId: input.actionsRunId, recordedAt: new Date(this.now()).toISOString()}) ?? await this.inspect(jobId)
    if (!saved.fleetActions?.some(run => run.actionsRunId === input.actionsRunId)) throw new TestRequestConflict('Authoring Actions delivery receipt limit reached')
    if (saved.fleetCancellation) {
      await this.rows.cancellationProgress?.(jobId, input.inputSha256, {checkedAt: new Date(0).toISOString(), settled: false})
      await Promise.allSettled([this.actionsTransport?.cancel(input.actionsRunId)])
    }
    return this.observation(jobId)
  }
  async complete(jobId: string, hostId: string, value: unknown): Promise<RoutineJobCompletion> {
    const input = routineJobCompletionSchema.parse(value), row = await this.inspect(jobId)
    if (row.hostId !== hostId || !row.fleetBinding || input.inputSha256 !== row.inputSha256)
      throw new TestRequestConflict('Authoring completion differs from its bound owner or work')
    if (row.dispatchCompletion) {
      if (requestInputDigest(row.dispatchCompletion) !== requestInputDigest(input)) throw new TestRequestConflict('Authoring completion changed its retained custody receipt')
      return row.dispatchCompletion
    }
    if (!this.rows.complete) throw new TestRunError(503, 'Authoring dispatch completion storage is unavailable')
    const saved = await this.rows.complete(jobId, hostId, input.inputSha256, input) ?? await this.inspect(jobId)
    if (requestInputDigest(saved.dispatchCompletion) !== requestInputDigest(input)) throw new TestRequestConflict('Authoring completion changed its retained custody receipt')
    return saved.dispatchCompletion!
  }
  private requirements(work: PortableAuthoringWork): PortableRequirements {
    return portableRequirementsSchema.parse({platform: work.requirements.platform === 'mac' ? 'ios-on-mac' : 'android',
      resources: work.requirements.resources,
      ...(work.requirements.glasses.length ? {glasses: {models: work.requirements.glasses, capabilities: work.requirements.capabilities}} : {})})
  }
  async preparation(jobId: string) {
    const row = await this.inspect(jobId)
    if (!row.fleetSelection || !row.fleetDeadline || !row.fleetInputSha256) throw new TestRunError(404, 'Authoring fleet job was not found')
    const requirements = this.requirements(row.fleetSelection)
    const routing = routineJobRouting(requirements, await this.hosts.list?.() ?? [], this.now(), row.fleetSelection.target)
    return {jobId, kind: 'author' as const, inputSha256: row.fleetInputSha256, deadline: row.fleetDeadline.toISOString(),
      ...routing,
      ...(row.fleetSelection.target ? {target: row.fleetSelection.target} : {}), state: row.fleetBinding ? row.status?.state ?? 'bound' : row.fleetCancellation ? 'terminal' : 'awaiting-runner',
      selection: row.fleetSelection, prepared: {requirements}}
  }
  async bind(jobId: string, hostId: string, value: unknown): Promise<{binding: RoutineJobBinding; execute: boolean; observation: unknown}> {
    const input = routineJobBindInputSchema.parse(value), row = await this.inspect(jobId)
    if (!row.fleetSelection || input.inputSha256 !== row.fleetInputSha256) throw new TestRequestConflict('Authoring binding changed its exact input')
    if (row.fleetBinding) return {binding: row.fleetBinding, execute: !row.fleetCancellation && !row.dispatchCompletion && this.now() < row.fleetDeadline!.getTime() && row.fleetBinding.hostId === hostId
      && row.fleetBinding.laneId === input.laneId && row.fleetBinding.actionsJobId === input.actionsJobId
      && row.fleetBinding.actionsRunId === input.actionsRunId, observation: await this.observation(jobId)}
    if (row.fleetCancellation || this.now() >= row.fleetDeadline!.getTime()) throw new TestRequestConflict('Cancelled or expired authoring job cannot bind')
    const host = await this.hosts.get(hostId), lane = host?.lanes.find(lane => lane.id === input.laneId), target = row.fleetSelection.target
    if (!host || host.hostId !== hostId || !Number.isFinite(Date.parse(host.receivedAt)) || this.now() - Date.parse(host.receivedAt) > 120_000
      || !lane || lane.state !== 'idle' || lane.dispatchMode !== 'automatic' || lane.descriptorRevision !== input.descriptorRevision
      || routineLaneDescriptorRevision(lane) !== input.descriptorRevision || target?.hostId && target.hostId !== hostId
      || target?.laneId && target.laneId !== input.laneId || !compatibleRoutineLane(this.requirements(row.fleetSelection), lane))
      throw new TestRequestConflict('Selected host has no current accepting compatible authoring lane descriptor')
    const binding: RoutineJobBinding = {jobId, requestId: jobId, hostId, laneId: input.laneId,
      descriptorRevision: input.descriptorRevision, actionsJobId: input.actionsJobId, actionsRunId: input.actionsRunId, boundAt: new Date(this.now()).toISOString()}
    const work = authoringWorkSchema.parse({...row.fleetSelection, target: {hostId, laneId: input.laneId}})
    if (!this.rows.bind) throw new TestRunError(503, 'Authoring binding persistence is unavailable')
    const saved = await this.rows.bind(jobId, input.inputSha256, binding, work, new Date(this.now())) ?? await this.inspect(jobId)
    if (!saved.fleetBinding) throw new TestRequestConflict('Authoring job was cancelled or expired before binding')
    return this.bind(jobId, hostId, input)
  }
  async cancel(jobId: string, input: unknown): Promise<unknown> {
    const parsed = z.object({reason: z.string().trim().min(1).max(2000)}).strict().parse(input), row = await this.inspect(jobId)
    if (!row.fleetInputSha256 || !this.rows.cancel) throw new TestRunError(404, 'Authoring fleet job was not found')
    const saved = await this.rows.cancel(jobId, row.fleetInputSha256, row.fleetCancellation ?? {requestedAt: new Date(this.now()).toISOString(), reason: parsed.reason}) ?? await this.inspect(jobId)
    await this.cancelActions(saved)
    return this.observation(jobId)
  }
  private async cancelActions(row: RoutineWorkDelivery): Promise<void> {
    if (row.fleetActionsCancellation?.settled || row.fleetActionsCancellation && this.now() - Date.parse(row.fleetActionsCancellation.checkedAt) < 30_000) return
    const progress = await cancelRoutineActions({transport: this.actionsTransport, jobId: row.workId, dispatch: row.fleetDispatch, now: this.now(),
      known: [...(row.fleetActions?.map(run => run.actionsRunId) ?? []), ...(row.fleetBinding ? [row.fleetBinding.actionsRunId] : [])],
      retain: async run => {
        const saved = await this.rows.actions?.(row.workId, row.fleetInputSha256!, {actionsRunId: run.actionsRunId, recordedAt: new Date(this.now()).toISOString()}) ?? await this.inspect(row.workId)
        if (!saved.fleetActions?.some(value => value.actionsRunId === run.actionsRunId)) throw new TestRunError(503, 'Authoring Actions delivery history exceeds its bound')
      }})
    const {completedRunIds, ...receipt} = progress
    await this.rows.cancellationProgress?.(row.workId, row.fleetInputSha256!, receipt, completedRunIds)
  }
  async observation(jobId: string): Promise<unknown> {
    let row = await this.inspect(jobId)
    if (!row.fleetSelection || !row.fleetDeadline) throw new TestRunError(404, 'Authoring fleet job was not found')
    if (!row.fleetCancellation && this.now() >= row.fleetDeadline.getTime() && !row.dispatchCompletion)
      return this.cancel(jobId, {reason: 'Authoring job reached its completion deadline.'})
    row = await this.deliver(row)
    if (row.fleetCancellation) {
      await this.cancelActions(row)
      row = await this.inspect(jobId)
    }
    return {jobId, kind: 'author' as const, inputSha256: row.fleetInputSha256, boundInputSha256: row.inputSha256, deadline: row.fleetDeadline!.toISOString(),
      state: row.status?.state ?? (row.fleetCancellation && !row.fleetBinding ? 'terminal' : row.fleetBinding ? 'bound' : 'awaiting-runner'),
      ...(row.fleetBinding ? {binding: row.fleetBinding} : {}), ...(row.fleetCancellation ? {waitingReason: row.fleetCancellation.reason} : {}),
      terminal: row.fleetBinding ? !!row.dispatchCompletion : !!row.fleetCancellation,
      ...(row.dispatchCompletion ? {dispatchCompletion: row.dispatchCompletion, cleanupDisposition: row.dispatchCompletion.disposition} : {}),
      actionsRuns: row.fleetActions ?? [],
      ...(row.status ? {result: row.status} : {}), ...(row.fleetCancellation ? {cancellation: row.fleetCancellation, actionsCancellation: row.fleetActionsCancellation} : {})}
  }
  async queued(hostId: string, cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TestRunError(400, 'Invalid authoring delivery limit')
    let after: {createdAt: Date; workId: string} | null = null
    if (cursor) {
      try {
        const parsed = z
          .object({
            hostId: frameworkIdentitySchema,
            workId: frameworkIdentitySchema,
            createdAt: z.string().datetime({offset: true}),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
        if (parsed.hostId !== hostId) throw new Error('foreign cursor')
        after = {workId: parsed.workId, createdAt: new Date(parsed.createdAt)}
      } catch {
        throw new TestRunError(400, 'Invalid host authoring delivery cursor')
      }
    }
    const found = await this.rows.queued(hostId, after, limit + 1),
      jobs = found.slice(0, limit),
      last = jobs.at(-1)
    const cancellations = this.rows.cancellations ? await this.rows.cancellations(hostId, 100) : []
    const completions = await this.rows.dispatchCompletions?.(hostId, 100) ?? []
    return {
      dispatchCompletions: completions.map(row => ({workId: row.workId, inputSha256: row.inputSha256, laneId: row.fleetBinding!.laneId})),
      cancellations: cancellations.map(row => ({workId: row.workId, inputSha256: row.inputSha256, ...row.fleetCancellation!})),
      jobs: jobs.map(({workId, inputSha256, hostId, work, createdAt}) => ({
        workId,
        inputSha256,
        hostId,
        work,
        createdAt,
      })),
      nextCursor:
        found.length > limit && last?.createdAt
          ? Buffer.from(
              JSON.stringify({hostId, workId: last.workId, createdAt: last.createdAt.toISOString()}),
            ).toString('base64url')
          : null,
    }
  }
  async accept(value: unknown, hostId: string) {
    const parsed = routineWorkAcceptanceSchema.safeParse(value)
    if (!parsed.success || parsed.data.hostId !== hostId) throw new TestRunError(400, 'Invalid authoring acceptance')
    const receipt = parsed.data,
      row = await this.inspect(receipt.workId)
    if (row.fleetCancellation || row.hostId !== hostId || row.inputSha256 !== receipt.inputSha256)
      throw new TestRequestConflict('Authoring acceptance changed its owner or input')
    const accepted = (await this.rows.accept(receipt)) ?? (await this.inspect(receipt.workId))
    if (requestInputDigest(accepted.acceptance) !== requestInputDigest(receipt))
      throw new TestRequestConflict('Authoring acceptance differs from its original receipt')
    await this.notify(accepted)
    return accepted.acceptance
  }
  async registerLocal(value: unknown, hostId: string) {
    const parsed = routineWorkLocalRegistrationSchema.safeParse(value)
    if (!parsed.success || parsed.data.receipt.hostId !== hostId)
      throw new TestRunError(400, 'Invalid local authoring registration')
    const {work, receipt} = parsed.data
    if (requestInputDigest(work) !== receipt.inputSha256)
      throw new TestRequestConflict('Local authoring registration changed its accepted input')
    const assertSame = (row: RoutineWorkDelivery) => {
      if (row.hostId !== hostId || row.inputSha256 !== receipt.inputSha256 ||
          requestInputDigest(row.work) !== receipt.inputSha256 || row.work.origin || row.fleetSelection ||
          row.requestSha256 !== receipt.inputSha256 || requestInputDigest(row.request) !== receipt.inputSha256 ||
          requestInputDigest(row.acceptance) !== requestInputDigest(receipt))
        throw new TestRequestConflict('Local authoring registration conflicts with its immutable work or acceptance')
      return row.acceptance!
    }
    const existing = await this.rows.get(work.workId)
    if (existing) return assertSame(existing)
    // The existing unique work ID and majority write retain admission and receipt
    // together. This is an observation of local acceptance, never fleet delivery.
    const row: RoutineWorkDelivery = {workId: work.workId, hostId, work, request: work,
      inputSha256: receipt.inputSha256, requestSha256: receipt.inputSha256, acceptance: receipt}
    try {await this.rows.insert(row)} catch (error) {
      const winner = await this.rows.get(work.workId)
      if (winner) return assertSame(winner)
      throw error
    }
    return assertSame(await this.inspect(work.workId))
  }
  async status(value: unknown, hostId: string) {
    const parsed = routineWorkStatusSchema.safeParse(value)
    if (!parsed.success || parsed.data.hostId !== hostId) throw new TestRunError(400, 'Invalid authoring status event')
    const event = parsed.data,
      row = await this.inspect(event.workId)
    if (row.hostId !== hostId || row.inputSha256 !== event.inputSha256 || !row.acceptance)
      throw new TestRequestConflict('Authoring status has no matching accepted owner')
    if (
      requestInputDigest(event.details.work) !== row.inputSha256 ||
      event.details.acceptedAt !== row.acceptance.acceptedAt
    )
      throw new TestRequestConflict('Authoring job projection changed its accepted work')
    if (
      terminalState(row.status?.state) &&
      !row.statusReceipts?.some(
        (receipt) => receipt.eventId === event.eventId && receipt.sha256 === requestInputDigest(event),
      )
    ) {
      if (!row.status || !row.status.details.attemptId || event.sequence <= row.status.sequence ||
          requestInputDigest(terminalOutcome(event)) !== requestInputDigest(terminalOutcome(row.status)))
        throw new TestRequestConflict('Terminal authoring outcome cannot be replaced by a later status')
    }
    const updated = (await this.rows.updateStatus(event, row.status)) ?? (await this.inspect(event.workId))
    const receipt = updated.statusReceipts?.find((receipt) => receipt.eventId === event.eventId)
    if (!receipt || receipt.sequence !== event.sequence || receipt.sha256 !== requestInputDigest(event))
      throw new TestRequestConflict('Authoring status is stale or changed its original event')
    // The durable host receipt acknowledges state, not GitHub availability.
    // The existing publisher retains and retries its own comment intent.
    await this.notify(updated)
    return event
  }
}
