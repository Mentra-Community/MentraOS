import {TestHostStateModel} from "../models/test-host-state.model"
import {z} from 'zod'
import {
  frameworkDeploymentSchema,
  frameworkHistoryEntrySchema,
  type LaneRestorationList,
  type LaneOverviewList,
  laneActivitySchema,
  laneRepairStatusSchema,
  type LaneRepairStatus,
} from "../types/lane-restoration.types"
import {frameworkBindingSchema} from '../types/framework-version.types'
import {frameworkIdentitySchema} from '../types/framework-request.types'
import {glassesModelSchema, routinePlatformSchema} from '../types/routine-definition.types'
import {hostStateSchema} from "./test-host-state.service"
import {TestRunError} from "./test-result-error"

const HOST_LIMIT = 32
type StoredState = {
  snapshot: unknown
  receivedAt: Date
  frameworkHistory?: unknown[]
  deploymentObservation?: unknown
  deploymentReceivedAt?: Date
}
export interface LaneRestorationRepository {
  list(limit: number, hostId?: string): Promise<StoredState[]>
  overview(limit: number): Promise<StoredState[]>
}
export const laneOverviewFields = {
  'snapshot.hostId': 1, 'snapshot.observedAt': 1,
  'snapshot.lanes.id': 1, 'snapshot.lanes.platform': 1, 'snapshot.lanes.state': 1,
  'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.glasses.model': 1, 'snapshot.lanes.activity': 1,
  'snapshot.restoration.schemaVersion': 1, 'snapshot.restoration.attempts.executionId': 1,
  'snapshot.restoration.attempts.interruptionId': 1, 'snapshot.restoration.attempts.laneId': 1,
  'snapshot.restoration.attempts.state': 1, 'snapshot.restoration.attempts.current': 1,
  'snapshot.restoration.attempts.startedAt': 1, 'snapshot.restoration.attempts.finishedAt': 1,
  'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.deployment': 1,
  frameworkHistory: {$slice: -1}, receivedAt: 1, deploymentObservation: 1, deploymentReceivedAt: 1, _id: 0,
} as const
export class MongoLaneRestorationRepository implements LaneRestorationRepository {
  async overview(limit: number) {
    return await TestHostStateModel.find({}).select(laneOverviewFields).sort({hostId: 1}).limit(limit)
      .maxTimeMS(5_000).read('primary').readConcern('majority').lean() as StoredState[]
  }
  async list(limit: number, hostId?: string) {
    return (await TestHostStateModel.find(hostId ? {hostId} : {})
      .select({
        snapshot: 1,
        receivedAt: 1,
        frameworkHistory: 1,
        deploymentObservation: 1,
        deploymentReceivedAt: 1,
        _id: 0,
      })
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
  restoration: z.object({schemaVersion: z.literal(1), attempts: z.array(laneRepairStatusSchema).max(100)}).optional(),
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
/** Controller snapshots are observations, never permission to resume or start a repair agent. */
export class LaneRestorationService {
  constructor(
    private repository: LaneRestorationRepository = new MongoLaneRestorationRepository(),
    private now = Date.now,
  ) {}
  async overview(): Promise<LaneOverviewList> {
    const rows = await this.repository.overview(HOST_LIMIT + 1)
    const hosts = rows.slice(0, HOST_LIMIT).map(row => {
      const parsed = currentSnapshotSchema.safeParse(row.snapshot)
      if (!parsed.success || !Number.isFinite(row.receivedAt?.getTime()))
        throw new TestRunError(503, 'Stored current lane observation is unavailable.')
      const {hostId, observedAt, lanes, frameworkBinding, frameworkAcceptedAt, deployment, restoration} = parsed.data
      const updater = row.deploymentObservation ? frameworkDeploymentSchema.parse(row.deploymentObservation) : undefined
      const latestDeployment = updater ?? deployment
      return {hostId, observedAt, receivedAt: row.receivedAt.toISOString(),
        lanes: lanes.map(({glasses, ...lane}) => {
          const repair = repairForLane(lane, restoration?.attempts)
          return {...lane, ...(repair ? {repair} : {}),
            ...(glasses ? {glassesModels: [...new Set(glasses.map(value => value.model))].sort()} : {})}
        }),
        ...(frameworkBinding ? {frameworkBinding, frameworkAcceptedAt} : {}),
        ...(row.frameworkHistory?.length ? {frameworkCurrentInterval: frameworkHistoryEntrySchema.parse(row.frameworkHistory.at(-1))} : {}),
        ...(latestDeployment ? {deployment: latestDeployment, deploymentReceivedAt:
          latestDeployment === updater ? row.deploymentReceivedAt?.toISOString() : row.receivedAt.toISOString()} : {}),
      }
    })
    return {generatedAt: new Date(this.now()).toISOString(), freshForMs: 120_000, hosts, truncated: rows.length > HOST_LIMIT}
  }
  async list(hostId?: string): Promise<LaneRestorationList> {
    if (hostId !== undefined && !frameworkIdentitySchema.safeParse(hostId).success)
      throw new TestRunError(400, 'Invalid controller identity')
    const rows = await this.repository.list(hostId ? 1 : HOST_LIMIT + 1, hostId)
    const hosts = rows.slice(0, HOST_LIMIT).map((row) => {
      const parsed = hostStateSchema.safeParse(row.snapshot)
      if (!parsed.success || !Number.isFinite(row.receivedAt?.getTime()))
        throw new TestRunError(503, "Stored lane restoration observation is unavailable.")
      const {hostId, observedAt, lanes, restoration, frameworkBinding, frameworkAcceptedAt, deployment} = parsed.data
      const updater = row.deploymentObservation ? frameworkDeploymentSchema.parse(row.deploymentObservation) : undefined
      // The independently ordered updater owns its deployment projection once reported.
      // A delayed controller observation cannot overwrite it by claiming a later clock.
      const latestDeployment = updater ?? deployment
      return {
        hostId,
        observedAt,
        receivedAt: row.receivedAt.toISOString(),
        lanes: lanes.map(({id, platform, state, dispatchMode, glasses, activity}) => {
          const repair = repairForLane({id, activity}, restoration?.attempts)
          return {id, platform, state, dispatchMode,
            ...(glasses ? {glassesModels: [...new Set(glasses.map(value => value.model))].sort()} : {}),
            ...(activity ? {activity} : {}), ...(repair ? {repair} : {})}
        }),
        restoration: restoration ?? null,
        ...(frameworkBinding ? {frameworkBinding, frameworkAcceptedAt} : {}),
        frameworkHistory: (row.frameworkHistory ?? []).map((value) => frameworkHistoryEntrySchema.parse(value)),
        ...(latestDeployment
          ? {
              deployment: latestDeployment,
              deploymentReceivedAt:
                latestDeployment === updater ? row.deploymentReceivedAt?.toISOString() : row.receivedAt.toISOString(),
            }
          : {}),
      }
    })
    return {
      generatedAt: new Date(this.now()).toISOString(),
      freshForMs: 120_000,
      hosts,
      truncated: rows.length > HOST_LIMIT,
    }
  }
}
