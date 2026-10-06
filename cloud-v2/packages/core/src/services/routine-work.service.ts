import {z} from 'zod'
import {RoutineWorkModel} from '../models/routine-work.model'
import {testWriteConcern} from '../models/test-write-concern'
import {
  authoringWorkSchema,
  routineWorkRequestSchema,
  routineWorkAcceptanceSchema,
  routineWorkStatusSchema,
  type AuthoringWork,
  type RoutineWorkRequest,
  type RoutineWorkStatus,
} from '../types/routine-work.types'
import {frameworkIdentitySchema} from '../types/framework-request.types'
import {GithubTestBuildGateway, type TestBuildGateway} from './test-builds.service'
import {selectedBuildInput} from '../types/test-build.types'
import {TestHostStateService} from './test-host-state.service'
import {requestInputDigest, TestRequestConflict} from './test-request.service'
import {TestRunError} from './test-result-error'
import {RoutineWorkNotification} from './routine-work-notification'

export interface RoutineWorkDelivery {
  workId: string
  requestSha256: string
  inputSha256: string
  hostId: string
  request: RoutineWorkRequest
  work: AuthoringWork
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
  updateStatus(event: RoutineWorkStatus): Promise<RoutineWorkDelivery | null>
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
  async accept(receipt) {
    return (await RoutineWorkModel.findOneAndUpdate(
      {workId: receipt.workId, hostId: receipt.hostId, inputSha256: receipt.inputSha256, acceptance: {$exists: false}},
      {$set: {acceptance: receipt}},
      {new: true, writeConcern: testWriteConcern},
    ).lean()) as RoutineWorkDelivery | null
  },
  async updateStatus(event) {
    return (await RoutineWorkModel.findOneAndUpdate(
      {
        'workId': event.workId,
        'hostId': event.hostId,
        'inputSha256': event.inputSha256,
        'acceptance': {$exists: true},
        'statusReceipts.eventId': {$ne: event.eventId},
        'status.state': {$nin: ['passed', 'failed', 'cancelled']},
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

export class RoutineWorkService {
  constructor(
    private readonly rows: RoutineWorkRepository = repository,
    private readonly builds: Pick<TestBuildGateway, 'resolve'> = new GithubTestBuildGateway(),
    private readonly hosts: Pick<TestHostStateService, 'get'> = new TestHostStateService(),
    private readonly notifications: Pick<RoutineWorkNotification, 'publish'> = new RoutineWorkNotification(),
  ) {}
  private sameRequest(row: RoutineWorkDelivery, input: RoutineWorkRequest) {
    if (row.requestSha256 !== requestInputDigest(input) || row.inputSha256 !== requestInputDigest(row.work))
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
      return row
    }
    if (input.buildSource.channel !== 'pr' || input.buildSource.prNumber !== input.origin.prNumber)
      throw new TestRunError(409, 'Authoring request build differs from its originating PR')
    try {
      const platform = input.requirements.platform === 'mac' ? 'ios-on-mac' : 'android'
      const [build, host] = await Promise.all([
        this.builds.resolve(input.buildSource, platform),
        this.hosts.get(input.target.hostId),
      ])
      if (
        !build ||
        build.availability !== 'available' ||
        !build.archive ||
        !build.receipt ||
        build.headSha !== input.origin.headSha
      )
        throw new TestRunError(409, 'The exact originating PR build is not published')
      if (
        !host ||
        host.hostId !== input.target.hostId ||
        !host.lanes.some((lane) => lane.id === input.target.laneId && lane.platform === platform)
      )
        throw new TestRunError(409, 'The requested host/lane platform is not enrolled')
      const {buildSource: _, ...fields} = input
      const work = authoringWorkSchema.parse({
        ...fields,
        build: {
          ...selectedBuildInput(build, platform),
          ...(build.manifest ? {manifest: build.manifest, manifestSha256: build.manifestSha256} : {}),
        },
      })
      const row: RoutineWorkDelivery = {
        workId: work.workId,
        hostId: work.target.hostId,
        request: input,
        requestSha256: requestInputDigest(input),
        work,
        inputSha256: requestInputDigest(work),
        reporting: {nextProgressAt: new Date(), history: []},
      }
      await this.rows.insert(row)
      const retained = (await this.rows.get(row.workId)) ?? row
      await this.notify(retained)
      return retained
    } catch (error) {
      const winner = await this.rows.get(input.workId)
      if (winner) {
        const row = this.sameRequest(winner, input)
        await this.notify(row)
        return row
      }
      throw error
    }
  }
  async inspect(workId: string) {
    if (!frameworkIdentitySchema.safeParse(workId).success) throw new TestRunError(400, 'Invalid authoring identity')
    const row = await this.rows.get(workId)
    if (!row) throw new TestRunError(404, 'Authoring work was not found')
    return row
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
    return {
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
    if (row.hostId !== hostId || row.inputSha256 !== receipt.inputSha256)
      throw new TestRequestConflict('Authoring acceptance changed its owner or input')
    const accepted = (await this.rows.accept(receipt)) ?? (await this.inspect(receipt.workId))
    if (requestInputDigest(accepted.acceptance) !== requestInputDigest(receipt))
      throw new TestRequestConflict('Authoring acceptance differs from its original receipt')
    await this.notify(accepted)
    return accepted.acceptance
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
      ['passed', 'failed', 'cancelled'].includes(row.status?.state ?? '') &&
      !row.statusReceipts?.some(
        (receipt) => receipt.eventId === event.eventId && receipt.sha256 === requestInputDigest(event),
      )
    )
      throw new TestRequestConflict('Terminal authoring work cannot be replaced by a later status')
    const updated = (await this.rows.updateStatus(event)) ?? (await this.inspect(event.workId))
    const receipt = updated.statusReceipts?.find((receipt) => receipt.eventId === event.eventId)
    if (!receipt || receipt.sequence !== event.sequence || receipt.sha256 !== requestInputDigest(event))
      throw new TestRequestConflict('Authoring status is stale or changed its original event')
    // The durable host receipt acknowledges state, not GitHub availability.
    // The existing publisher retains and retries its own comment intent.
    await this.notify(updated)
    return event
  }
}
