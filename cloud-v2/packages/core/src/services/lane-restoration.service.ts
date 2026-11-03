import {TestHostStateModel} from "../models/test-host-state.model"
import {z} from 'zod'
import {
  frameworkDeploymentSchema,
  frameworkHistoryEntrySchema,
  frameworkProcessSchema,
  type LaneRestorationList,
  type LaneOverviewList,
  laneActivitySchema,
  laneRepairStatusSchema,
  type LaneRepairStatus,
} from "../types/lane-restoration.types"
import {frameworkBindingSchema} from '../types/framework-version.types'
import {frameworkIdentitySchema} from '../types/framework-request.types'
import {glassesModelSchema, routinePlatformSchema} from '../types/routine-definition.types'
import {TestRunError} from "./test-result-error"
import {testHostHistoryRepository, type TestHostHistoryRepository} from './test-host-history.repository'
import {laneRestorationProjectionSchema} from '../types/lane-restoration.types'
import {currentFrameworkStopProjection, currentOwnedRepairProjection} from './test-host-state.service'

const HOST_LIMIT = 32
type StoredState = {
  snapshot: unknown
  frameworkCurrentStop?: unknown
  laneControls?: unknown
  receivedAt: Date
  deploymentObservation?: unknown
  deploymentReceivedAt?: Date
}
export interface LaneRestorationRepository {
  list(limit: number, hostId?: string): Promise<StoredState[]>
  overview(limit: number, timeoutMS?: number): Promise<StoredState[]>
}
export const laneOverviewFields = {
  'snapshot.hostId': 1, 'snapshot.observedAt': 1,
  'snapshot.lanes.id': 1, 'snapshot.lanes.platform': 1, 'snapshot.lanes.state': 1,
  'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.glasses.model': 1, 'snapshot.lanes.activity': 1,
  'snapshot.repairStatuses': currentOwnedRepairProjection,
  'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1,
  'snapshot.incarnation':1,'snapshot.incarnationGeneration':1,frameworkCurrentStop:currentFrameworkStopProjection,'snapshot.deployment': 1,
  'laneControls.command.operationId': 1, 'laneControls.command.hostId': 1, 'laneControls.command.laneId': 1,
  'laneControls.command.action': 1, 'laneControls.command.expiresAt': 1, 'laneControls.operatorLabel': 1,
  'laneControls.receipt.result.status': 1, 'laneControls.receipt.result.reservation': 1,
  receivedAt: 1, deploymentObservation: 1, deploymentReceivedAt: 1, _id: 0,
} as const
export class MongoLaneRestorationRepository implements LaneRestorationRepository {
  async overview(limit: number, timeoutMS = 5_000) {
    return await TestHostStateModel.find({}).select(laneOverviewFields).sort({hostId: 1}).limit(limit)
      .setOptions({timeoutMS, maxTimeMS: timeoutMS}).read('primary').readConcern('majority').lean() as StoredState[]
  }
  async list(limit: number, hostId?: string) {
    return (await TestHostStateModel.find(hostId ? {hostId} : {})
      .select(laneOverviewFields)
      .sort({hostId: 1})
      .limit(limit)
      .maxTimeMS(5_000)
      .read("primary")
      .readConcern("majority")
      .lean()) as StoredState[]
  }
}
const currentSnapshotSchema = z.object({
  hostId: frameworkIdentitySchema, observedAt: z.string().datetime({offset: true}),
  lanes: z.array(z.object({id: frameworkIdentitySchema, platform: routinePlatformSchema,
    state: z.enum(['idle', 'running', 'reserved', 'in-repair', 'out-of-service', 'offline']),
    dispatchMode: z.enum(['automatic', 'authoring', 'paused']), activity: laneActivitySchema.optional(),
    glasses: z.array(z.object({model: glassesModelSchema})).max(1).optional(),
  }).superRefine((lane, ctx) => {
    if (lane.activity && ['idle', 'offline'].includes(lane.state))
      ctx.addIssue({code: 'custom', message: 'Idle or offline lane cannot report active custody'})
  })).max(100),
  frameworkBinding: frameworkBindingSchema.optional(), frameworkAcceptedAt: z.string().datetime({offset: true}).optional(),
  deployment: frameworkDeploymentSchema.optional(),
  repairStatuses: z.array(laneRepairStatusSchema).max(100).optional(),
}).superRefine((snapshot, ctx) => {
  if (new Set(snapshot.lanes.map(lane => lane.id)).size !== snapshot.lanes.length)
    ctx.addIssue({code: 'custom', message: 'Duplicate lane identity'})
  if ((snapshot.frameworkBinding === undefined) !== (snapshot.frameworkAcceptedAt === undefined))
    ctx.addIssue({code: 'custom', message: 'Accepted framework requires its recorded acceptance time'})
})
function repairForLane(lane: {id: string; activity?: z.infer<typeof laneActivitySchema>}, attempts: LaneRepairStatus[] = []) {
  if (lane.activity?.owner.kind !== 'fixer') return undefined
  const matches = attempts.filter(attempt => attempt.executionId === lane.activity!.owner.id && attempt.laneId === lane.id)
  return matches.length === 1 ? laneRepairStatusSchema.parse(matches[0]) : undefined
}
/** Display the accepted current process without deriving state from debug. */
function currentFrameworkDisplay(row:StoredState) {
 const snapshot=z.object({hostId:frameworkIdentitySchema,incarnation:frameworkIdentitySchema,
  incarnationGeneration:z.number().int().positive().safe(),observedAt:z.string().datetime({offset:true}),
  frameworkBinding:frameworkBindingSchema,frameworkAcceptedAt:z.string().datetime({offset:true}),frameworkProcess:frameworkProcessSchema}).safeParse(row.snapshot)
 if(!snapshot.success)return
 const value=snapshot.data,stop=row.frameworkCurrentStop===undefined?undefined:z.object({installationId:frameworkIdentitySchema,
  process:frameworkProcessSchema,observedAt:z.string().datetime({offset:true})}).strict().safeParse(row.frameworkCurrentStop)
 if(stop&&!stop.success)return
 const matching=stop?.success&&stop.data.installationId===value.frameworkBinding.installationId&&
  stop.data.process.pid===value.frameworkProcess.pid&&stop.data.process.startedAt===value.frameworkProcess.startedAt
 const current=frameworkHistoryEntrySchema.safeParse({binding:value.frameworkBinding,process:value.frameworkProcess,
  incarnation:value.incarnation,incarnationGeneration:value.incarnationGeneration,effectiveAt:value.frameworkAcceptedAt,observedAt:value.observedAt,
  ...(matching?{endedAt:stop.data.observedAt,endReason:'observed-stop'}:{})})
 return current.success?current.data:undefined
}
// Core owns the authenticated display identity; it never enters the controller command or its digest.
const reservationDisplayRecordsSchema = z.array(z.object({
  command: z.object({operationId: z.string().uuid(), hostId: frameworkIdentitySchema, laneId: frameworkIdentitySchema,
    action: z.string(), expiresAt: z.number().int().positive().safe()}),
  operatorLabel: z.string().min(1).max(320).optional(),
  receipt: z.object({result: z.object({status: z.string(), reservation: z.object({
    laneId: frameworkIdentitySchema, generation: z.number().int().nonnegative().safe(), state: z.string(),
  }).optional()})}).optional(),
})).max(100)
function reservationDisplay(lane: {id: string; state: string; activity?: z.infer<typeof laneActivitySchema>}, hostId: string, records: unknown) {
  if (lane.state !== 'reserved' || lane.activity?.owner.kind !== 'authoring') return {}
  const parsed = reservationDisplayRecordsSchema.safeParse(records ?? [])
  if (!parsed.success) return {}
  const matches = parsed.data.filter(row => row.command.action === 'reserve' && row.command.hostId === hostId &&
    row.command.laneId === lane.id && lane.activity!.owner.id === `authoring:local:${row.command.expiresAt}:${row.command.operationId}` &&
    row.receipt?.result.status === 'accepted' && row.receipt.result.reservation?.laneId === lane.id &&
    row.receipt.result.reservation.state === 'granted' && row.receipt.result.reservation.generation === lane.activity!.generation)
  return matches.length === 1 ? {reservedBy: matches[0].operatorLabel ?? null} : {}
}
/** Controller snapshots are observations, never permission to resume or start a repair agent. */
export class LaneRestorationService {
  constructor(
    private repository: LaneRestorationRepository = new MongoLaneRestorationRepository(),
    private now = Date.now,
    private history: TestHostHistoryRepository = testHostHistoryRepository,
  ) {}
  async overview(deadline = this.now() + 5_000): Promise<LaneOverviewList> {
    const timeoutMS = Math.min(5_000, deadline - this.now())
    if (timeoutMS <= 0) throw new TestRunError(503, 'Current lane query timed out.')
    const rows = await this.repository.overview(HOST_LIMIT + 1, timeoutMS)
    const hosts = rows.slice(0, HOST_LIMIT).map(row => {
      const parsed = currentSnapshotSchema.safeParse(row.snapshot)
      if (!parsed.success || !Number.isFinite(row.receivedAt?.getTime()))
        throw new TestRunError(503, 'Stored current lane observation is unavailable.')
      const {hostId, observedAt, lanes, frameworkBinding, frameworkAcceptedAt, deployment, repairStatuses} = parsed.data
      const frameworkCurrentInterval=currentFrameworkDisplay(row)
      const updater = row.deploymentObservation ? frameworkDeploymentSchema.parse(row.deploymentObservation) : undefined
      const latestDeployment = updater ?? deployment
      return {hostId, observedAt, receivedAt: row.receivedAt.toISOString(),
        lanes: lanes.map(({glasses, ...lane}) => {
          const repair = repairForLane(lane, repairStatuses)
          return {...lane, ...reservationDisplay(lane, hostId, row.laneControls), ...(repair ? {repair} : {}),
            ...(glasses ? {glassesModels: [...new Set(glasses.map(value => value.model))].sort()} : {})}
        }),
        ...(frameworkBinding ? {frameworkBinding, frameworkAcceptedAt} : {}),
        ...(frameworkCurrentInterval?{frameworkCurrentInterval}:{}),
        ...(latestDeployment ? {deployment: latestDeployment, deploymentReceivedAt:
          latestDeployment === updater ? row.deploymentReceivedAt?.toISOString() : row.receivedAt.toISOString()} : {}),
      }
    })
    return {generatedAt: new Date(this.now()).toISOString(), freshForMs: 120_000, hosts, truncated: rows.length > HOST_LIMIT}
  }
  async list(hostId?: string): Promise<LaneRestorationList> {
    if (hostId !== undefined && !frameworkIdentitySchema.safeParse(hostId).success)
      throw new TestRunError(400, 'Invalid controller identity')
    const requestedHostId = hostId
    const rows = await this.repository.list(hostId ? 1 : HOST_LIMIT + 1, hostId)
    const hosts = await Promise.all(rows.slice(0, HOST_LIMIT).map(async (row) => {
      const parsed = currentSnapshotSchema.safeParse(row.snapshot)
      if (!parsed.success || !Number.isFinite(row.receivedAt?.getTime()))
        throw new TestRunError(503, "Stored lane restoration observation is unavailable.")
      const {hostId, observedAt, lanes, repairStatuses, frameworkBinding, frameworkAcceptedAt, deployment} = parsed.data
      // Only an explicit host detail asks for debug history. Archive failure
      // cannot change the current lane/owner observation.
      const debug = hostId === requestedHostId ? await this.history.detail(hostId).catch(() => null) : null
      const frameworkCurrentInterval=currentFrameworkDisplay(row)
      const restored = laneRestorationProjectionSchema.safeParse(debug?.restoration)
      const frameworkHistory = Array.isArray(debug?.frameworkHistory) ? debug.frameworkHistory.flatMap(value => {
        const entry = frameworkHistoryEntrySchema.safeParse(value)
        return entry.success ? [entry.data] : []
      }) : undefined
      const updater = row.deploymentObservation ? frameworkDeploymentSchema.parse(row.deploymentObservation) : undefined
      // The independently ordered updater owns its deployment projection once reported.
      // A delayed controller observation cannot overwrite it by claiming a later clock.
      const latestDeployment = updater ?? deployment
      return {
        hostId,
        observedAt,
        receivedAt: row.receivedAt.toISOString(),
        lanes: lanes.map(({id, platform, state, dispatchMode, glasses, activity}) => {
          const repair = repairForLane({id, activity}, repairStatuses)
          return {id, platform, state, dispatchMode,
            ...reservationDisplay({id, state, activity}, hostId, row.laneControls),
            ...(glasses ? {glassesModels: [...new Set(glasses.map(value => value.model))].sort()} : {}),
            ...(activity ? {activity} : {}), ...(repair ? {repair} : {})}
        }),
        restoration: restored.success ? restored.data : null,
        ...(frameworkBinding ? {frameworkBinding, frameworkAcceptedAt} : {}),
        ...(frameworkCurrentInterval?{frameworkCurrentInterval}:{}),
        ...(frameworkHistory ? {frameworkHistory} : {}),
        ...(latestDeployment
          ? {
              deployment: latestDeployment,
              deploymentReceivedAt:
                latestDeployment === updater ? row.deploymentReceivedAt?.toISOString() : row.receivedAt.toISOString(),
            }
          : {}),
      }
    }))
    return {
      generatedAt: new Date(this.now()).toISOString(),
      freshForMs: 120_000,
      hosts,
      truncated: rows.length > HOST_LIMIT,
    }
  }
}
