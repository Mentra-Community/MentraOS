import {advanceResourceLifecycleCursor} from './resource-lifecycle.service'
import {resourceIdleContractSchema,resourceLifecycleSchema} from '../types/resource-lifecycle.types'
import {recorderStorageObservationSchema} from '../types/recorder-storage.types'
import {exclusiveResourceDependenciesSchema, hostResourceReservationsSchema, resourceReservationObservationSchema, type HostResourceReservation} from '../types/resource-reservations.types'
import {laneControlExchangeSchema} from './lane-controls.service'
import {z} from "zod"
import {TestHostStateModel} from "../models/test-host-state.model"
import {testWriteConcern} from "../models/test-write-concern"
import {frameworkIdentitySchema} from "../types/framework-request.types"
import {glassesModelSchema, routineIdentitySchema, routinePlatformSchema} from "../types/routine-definition.types"
import {
  laneRestorationProjectionSchema,
  frameworkDeploymentSchema,
  frameworkHistoryEntrySchema,
  frameworkProcessSchema,
  type FrameworkHistoryEntry,
  laneActivitySchema,
} from "../types/lane-restoration.types"
import {frameworkBindingSchema} from "../types/framework-version.types"
import {permissionObservationsSchema} from "../types/resource-permissions.types"
import {TestRunError} from "./test-result-error"
import {routineQueuedBlockSchema, routineProgressSchema} from '../types/routine-progress.types'
import {TestRequestModel} from '../models/test-request.model'
const resource = z
  .object({
    id: frameworkIdentitySchema,
    kind: z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]),
    laneId: frameworkIdentitySchema.optional(),
    capabilities: z.array(routineIdentitySchema).max(30).optional(),
    permissionObservations: permissionObservationsSchema.optional(),
    storage: recorderStorageObservationSchema.optional(),
    idleContract: resourceIdleContractSchema.optional(),
    exclusiveDependencies: exclusiveResourceDependenciesSchema.optional(),
  })
  .strict().refine(value => !value.exclusiveDependencies || value.exclusiveDependencies.every(dependency =>
    value.capabilities?.includes(dependency.capability)), 'Exclusive dependencies must name an offered capability')
export const glassesInventorySchema = z
  .object({
    resourceId: frameworkIdentitySchema,
    deviceId: frameworkIdentitySchema,
    model: glassesModelSchema,
    capabilities: z.array(routineIdentitySchema).max(30),
  })
  .strict()
  .refine(
    (value) => new Set(value.capabilities).size === value.capabilities.length,
    "Offered glasses capabilities must be unique",
  )
const routingLaneSchema = z.object({
  id: frameworkIdentitySchema,
  descriptorRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  platform: routinePlatformSchema,
  dispatchMode: z.enum(['automatic', 'authoring', 'paused']),
  state: z.enum(['idle', 'running', 'reserved', 'in-repair', 'out-of-service', 'offline']),
  resources: z.array(resource),
  glasses: z.array(glassesInventorySchema).max(1).optional(),
}).strict().superRefine(validateLaneResources)
function validateLaneResources(lane: {resources: z.infer<typeof resource>[]; glasses?: z.infer<typeof glassesInventorySchema>[]}, ctx: z.RefinementCtx) {
  for (const resource of lane.resources) if (new Set(resource.capabilities ?? []).size !== (resource.capabilities ?? []).length)
    ctx.addIssue({code: "custom", message: "Resource capabilities must be unique"})
  if(new Set(lane.resources.map(resource=>resource.kind)).size!==lane.resources.length)
    ctx.addIssue({code:"custom",message:"A dispatch lane offers one provider per resource kind"})
  const ids = lane.resources.map((ref) => ref.id)
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({code: "custom", message: "Duplicate lane resource identity"})
  if (lane.glasses === undefined && lane.resources.some((ref) => ref.kind === "glasses"))
    ctx.addIssue({code: "custom", message: "Declared glasses resources require physical inventory"})
  if (lane.glasses !== undefined) {
    const offered = lane.glasses.map((value) => value.resourceId)
    if (
      new Set(offered).size !== offered.length ||
      new Set(lane.glasses.map((value) => value.deviceId)).size !== offered.length
    )
      ctx.addIssue({code: "custom", message: "Duplicate lane glasses identity"})
    if (
      lane.resources.filter((ref) => ref.kind === "glasses").some((ref) => !offered.includes(ref.id)) ||
      lane.glasses.some(
        (value) => !lane.resources.some((ref) => ref.id === value.resourceId && ref.kind === "glasses"),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Glasses inventory must exactly identify declared glasses resources",
      })
  }
}
function validateHostLaneInventory(snapshot: {lanes: z.infer<typeof routingLaneSchema>[]}, ctx: z.RefinementCtx) {
  if (new Set(snapshot.lanes.map((lane) => lane.id)).size !== snapshot.lanes.length)
    ctx.addIssue({code: "custom", message: "Duplicate host lane identity"})
  const byResource = new Map<string, string>(),
    byDevice = new Map<string, string>()
  const authorityByDependency = new Map<string, string>()
  for (const lane of snapshot.lanes) for (const resource of lane.resources) for (const dependency of resource.exclusiveDependencies ?? []) {
    const previous = authorityByDependency.get(dependency.resourceId)
    if (previous && previous !== dependency.authorityHostId)
      ctx.addIssue({code: 'custom', message: 'Shared resource must retain one authority across host lanes'})
    authorityByDependency.set(dependency.resourceId, dependency.authorityHostId)
  }
  for (const lane of snapshot.lanes)
    for (const glasses of lane.glasses ?? []) {
      const identity = JSON.stringify({deviceId: glasses.deviceId, model: glasses.model})
      if (
        (byResource.has(glasses.resourceId) && byResource.get(glasses.resourceId) !== identity) ||
        (byDevice.has(glasses.deviceId) && byDevice.get(glasses.deviceId) !== glasses.resourceId)
      )
        ctx.addIssue({
          code: "custom",
          message: "Shared physical glasses must retain one resource, device and model identity across lanes",
        })
      byResource.set(glasses.resourceId, identity)
      byDevice.set(glasses.deviceId, glasses.resourceId)
    }
}
const routingHostSchema = z.object({
  hostId: frameworkIdentitySchema,
  frameworkBinding: frameworkBindingSchema.optional(),
  lanes: z.array(routingLaneSchema).max(100),
}).strict().superRefine(validateHostLaneInventory)
export type RoutingTestHostState = z.infer<typeof routingHostSchema> & {receivedAt: string; authorityReservations?: HostResourceReservation[]}
// Permission observations remain fresh; only diagnostic/history fields are excluded at the database.
const routingStateProjection = {hostId: 1, receivedAt: 1, resourceReservations: 1, 'snapshot.hostId': 1, 'snapshot.frameworkBinding': 1,
  'snapshot.lanes.id': 1, 'snapshot.lanes.descriptorRevision': 1, 'snapshot.lanes.platform': 1,
  'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.resources': 1,
  'snapshot.lanes.glasses': 1, _id: 0} as const
const routineAvailability = z
  .object({
    routineId: routineIdentitySchema,
    definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
    available: z.boolean(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
export const hostStateSchema = z
  .object({
    hostId: frameworkIdentitySchema,
    incarnation: frameworkIdentitySchema,
    incarnationGeneration: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe(),
    observedAt: z.string().datetime({offset: true}),
    lanes: z
      .array(
        z
          .object({
            id: frameworkIdentitySchema,
            descriptorRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
            platform: routinePlatformSchema,
            dispatchMode: z.enum(["automatic", "authoring", "paused"]),
            state: z.enum(["idle", "running", "reserved", "in-repair", "out-of-service", "offline"]),
            activity: laneActivitySchema.optional(),
            progress: routineProgressSchema.optional(),
            waiting: z.array(routineQueuedBlockSchema).max(100).optional(),
            resources: z.array(resource),
            glasses: z.array(glassesInventorySchema).max(1).optional(),
            routineAvailability: z.array(routineAvailability).max(1000).optional(),
          })
          .strict()
          .superRefine((lane, ctx) => {
            if (lane.activity && ['idle', 'offline'].includes(lane.state))
              ctx.addIssue({code: 'custom', message: 'Idle or offline lane cannot report active custody'})
            if (lane.progress && (lane.activity?.owner.kind !== 'run' ||
                lane.activity.owner.id !== lane.progress.requestId || lane.activity.generation !== lane.progress.ownerGeneration))
              ctx.addIssue({code: 'custom', message: 'Routine progress must identify the current run owner'})
            const keys = lane.routineAvailability?.map((row) => `${row.routineId}:${row.definitionRevision}`) ?? []
            if (new Set(keys).size !== keys.length)
              ctx.addIssue({code: "custom", message: "Duplicate lane routine availability identity"})
            validateLaneResources(lane, ctx)
          }),
      )
      .max(100),
    resourceLifecycle: resourceLifecycleSchema.optional(),
    laneControls: laneControlExchangeSchema.optional(),
    resourceReservations: resourceReservationObservationSchema.optional(),
    restoration: laneRestorationProjectionSchema.optional(),
    frameworkBinding: frameworkBindingSchema.optional(),
    frameworkAcceptedAt: z.string().datetime({offset: true}).optional(),
    frameworkProcess: frameworkProcessSchema.optional(),
    deployment: frameworkDeploymentSchema.optional(),
    frameworkHistory: z.array(frameworkHistoryEntrySchema).max(100).optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      [snapshot.frameworkBinding, snapshot.frameworkAcceptedAt, snapshot.frameworkProcess].filter(
        (value) => value !== undefined,
      ).length %
        3 !==
      0
    )
      ctx.addIssue({code: "custom", message: "Actual framework requires accepted time and process identity"})
    const history = snapshot.frameworkHistory ?? []
    if (
      new Set(history.map((value) => value.incarnation)).size !== history.length ||
      new Set(history.map((value) => value.incarnationGeneration)).size !== history.length
    )
      ctx.addIssue({code: "custom", message: "Accepted framework history must have unique controller incarnations"})
    for (const interval of history)
      if (
        interval.incarnationGeneration === snapshot.incarnationGeneration &&
        interval.incarnation !== snapshot.incarnation
      )
        ctx.addIssue({
          code: "custom",
          message: "Framework history current generation differs from reporting incarnation",
        })
    for (const lane of snapshot.lanes) if (lane.progress && (lane.progress.controllerIncarnation !== snapshot.incarnation ||
        lane.progress.sequence !== snapshot.sequence || lane.progress.observedAt !== snapshot.observedAt))
      ctx.addIssue({code: 'custom', message: 'Routine progress differs from its controller observation'})
    if (snapshot.restoration?.attempts.some((attempt) => !snapshot.lanes.some((lane) => lane.id === attempt.laneId)))
      ctx.addIssue({code: "custom", message: "Restoration attempt names an unknown host lane"})
    const storage = snapshot.lanes.flatMap(lane => lane.resources.flatMap(resource => resource.storage ? [resource.storage] : []))
    if (storage.some(value => Date.parse(value.observedAt) > Date.parse(snapshot.observedAt) || JSON.stringify(value) !== JSON.stringify(storage[0])))
      ctx.addIssue({code: 'custom', message: 'Recorder offers must share one measured host disk pool'})
    for (const lane of snapshot.lanes) if (lane.waiting?.some(value => Date.parse(value.observedAt) > Date.parse(snapshot.observedAt)) ||
      new Set(lane.waiting?.map(value => value.requestId)).size !== (lane.waiting?.length ?? 0))
      ctx.addIssue({code: 'custom', message: 'Queued blocker observations must have unique identities and actual past timestamps'})
    if (snapshot.resourceLifecycle && [...snapshot.resourceLifecycle.subjects.map(subject=>subject.observedAt),
        ...snapshot.resourceLifecycle.history.map(event=>event.at)].some(at=>at!==null && Date.parse(at)>Date.parse(snapshot.observedAt)))
      ctx.addIssue({code: 'custom', message: 'Resource observation is newer than host observation'})
    if (snapshot.resourceLifecycle?.subjects.some(subject => subject.subject.authorityHostId !== snapshot.hostId))
      ctx.addIssue({code: "custom", message: "Resource lifecycle must be reported by its authority host"})
    validateHostLaneInventory(snapshot, ctx)
  })
export type TestHostState = z.infer<typeof hostStateSchema>
const frameworkStopSchema = z.object({
  installationId: frameworkIdentitySchema,
  process: frameworkProcessSchema,
  observedAt: z.string().datetime({offset: true}),
}).strict()
type FrameworkStop = z.infer<typeof frameworkStopSchema>
const sameStoppedProcess = (stop: FrameworkStop, installationId: string, process: FrameworkStop['process']) =>
  stop.installationId === installationId && stop.process.pid === process.pid && stop.process.startedAt === process.startedAt
function reconcileFrameworkStops(history: FrameworkHistoryEntry[], stops: FrameworkStop[]) {
  for (const stop of stops) {
    const matching = history.filter(value => sameStoppedProcess(stop, value.binding.installationId, value.process))
    const interval = matching.filter(value => Date.parse(value.effectiveAt) <= Date.parse(stop.observedAt))
      .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt) || b.incarnationGeneration - a.incarnationGeneration)[0]
      ?? matching.sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt))[0]
    if (!interval) continue
    if (Date.parse(stop.observedAt) < Date.parse(interval.effectiveAt))
      throw new TestRunError(409, "Observed framework stop precedes its accepted startup")
    if (!interval.endedAt || (interval.endReason === 'accepted-replacement' && Date.parse(stop.observedAt) <= Date.parse(interval.endedAt))) {
      interval.endedAt = stop.observedAt
      interval.endReason = 'observed-stop'
    }
  }
}
export const updaterDeploymentSchema = z
  .object({
    hostId: frameworkIdentitySchema,
    producer: z.literal("framework-updater"),
    generation: z.number().int().positive().safe(),
    sequence: z.number().int().positive().safe(),
    deployment: frameworkDeploymentSchema,
    stopped: frameworkStopSchema.optional(),
  })
  .strict()
export type ReceivedTestHostState = TestHostState & {receivedAt: string; frameworkHistory?: FrameworkHistoryEntry[]}
const deploymentCursor = (row: {deploymentGeneration?: number; deploymentSequence?: number}) => ({
  deploymentGeneration: row.deploymentGeneration ?? {$exists: false},
  deploymentSequence: row.deploymentSequence ?? {$exists: false},
})
// Host snapshots contain repair diagnostics; reporting needs only their accepted cursor and history.
const reportingStateProjection = {hostId: 1, incarnation: 1, incarnationGeneration: 1, sequence: 1,
  deploymentGeneration: 1, deploymentSequence: 1, frameworkHistory: 1, frameworkStopReceipts: 1, 'snapshot.resourceLifecycle': 1, resourceLifecycleCursor: 1} as const
async function retryHostStateWrite<T>(write: () => Promise<T | undefined>, conflict: string): Promise<T> {
  // Only an atomic write collision returns undefined; semantic conflicts and database errors propagate.
  for (let attempt = 0; attempt < 3; attempt++) {
    const receipt = await write()
    if (receipt !== undefined) return receipt
  }
  throw new TestRunError(409, conflict)
}
export class TestHostStateService {
  constructor(private readonly now: () => number = Date.now) {}
  async report(input: unknown, hostId: string) {
    const snapshot = hostStateSchema.parse(input)
    return retryHostStateWrite(
      () => this.reportSnapshot(snapshot, hostId),
      'Controller snapshot advanced concurrently; retry current observation',
    )
  }
  private async reportSnapshot(snapshot: TestHostState, hostId: string) {
    if (snapshot.hostId !== hostId) throw new TestRunError(409, "Host snapshot differs from authenticated controller")
    for (const lane of snapshot.lanes) for (const waiting of lane.waiting ?? []) {
      const request = await TestRequestModel.findOne({requestId: waiting.requestId, hostId, inputSha256: waiting.requestDigest,
        'input.laneId': lane.id, 'hostReceipt.requestId': waiting.requestId, 'hostReceipt.hostId': hostId,
        'hostReceipt.inputSha256': waiting.requestDigest, 'hostReceipt.acceptedAt': waiting.acceptedAt}).select({requestId: 1})
        .read('primary').readConcern('majority').setOptions({timeoutMS: 10_000}).lean()
      if (!request) throw new TestRunError(409, 'Queued blocker differs from its authenticated accepted request')
    }
    for (const lane of snapshot.lanes) if (lane.progress) {
      const request = await TestRequestModel.findOne({requestId: lane.progress.requestId, hostId,
        inputSha256: lane.progress.requestDigest, 'input.laneId': lane.id,
        'hostReceipt.requestId': lane.progress.requestId, 'hostReceipt.hostId': hostId,
        'hostReceipt.inputSha256': lane.progress.requestDigest}).select({requestId: 1})
        .read('primary').readConcern('majority').setOptions({timeoutMS: 10_000}).lean()
      if (!request) throw new TestRunError(409, 'Routine progress differs from its authenticated accepted request')
    }
    const current = await TestHostStateModel.findOne({hostId}).select(reportingStateProjection).lean()
    if (current) {
      if (
        snapshot.incarnationGeneration === current.incarnationGeneration &&
        snapshot.incarnation !== current.incarnation
      )
        throw new TestRunError(409, "Controller incarnation generation belongs to another process")
      if (
        snapshot.incarnationGeneration < current.incarnationGeneration ||
        (snapshot.incarnationGeneration === current.incarnationGeneration && snapshot.sequence <= current.sequence)
      )
        return {
          hostId,
          incarnation: current.incarnation,
          incarnationGeneration: current.incarnationGeneration,
          sequence: current.sequence,
        }
    }
    const resourceLifecycleCursor = advanceResourceLifecycleCursor(
      current?.resourceLifecycleCursor ?? current?.snapshot?.resourceLifecycle, snapshot.resourceLifecycle,
    )
    const filter = current
      ? {
          hostId,
          incarnation: current.incarnation,
          incarnationGeneration: current.incarnationGeneration,
          sequence: current.sequence,
          ...deploymentCursor(current),
        }
      : {hostId, incarnationGeneration: {$exists: false}}
    const history: FrameworkHistoryEntry[] = (current?.frameworkHistory ?? []).map((value) =>
      frameworkHistoryEntrySchema.parse(value),
    )
    const stops = (current?.frameworkStopReceipts ?? []).map(value => frameworkStopSchema.parse(value))
    for (const interval of snapshot.frameworkHistory ?? []) {
      if (interval.incarnationGeneration > snapshot.incarnationGeneration)
        throw new TestRunError(409, "Framework history names a future controller generation")
      const prior = history.find((value) => value.incarnation === interval.incarnation)
      if (prior) {
        if (
          JSON.stringify(prior.binding) !== JSON.stringify(interval.binding) ||
          JSON.stringify(prior.process) !== JSON.stringify(interval.process) ||
          prior.effectiveAt !== interval.effectiveAt ||
          prior.incarnationGeneration !== interval.incarnationGeneration
        )
          throw new TestRunError(409, "Durable framework history changed accepted identity")
        if (!prior.endedAt && interval.endedAt) {
          prior.endedAt = interval.endedAt
          prior.endReason = interval.endReason
        }
      } else history.push(frameworkHistoryEntrySchema.parse(interval))
    }
    history.sort((a, b) => a.incarnationGeneration - b.incarnationGeneration)
    // A late history-bearing restart may already have inserted the successor. Move the process stop
    // to its applicable interval while preserving the earlier controller replacement boundary.
    for (let index = 1; index < history.length; index++) {
      const prior = history[index - 1]!, next = history[index]!
      if (prior.endReason === 'observed-stop' && Date.parse(prior.endedAt!) >= Date.parse(next.effectiveAt) &&
        sameStoppedProcess({installationId: prior.binding.installationId, process: prior.process, observedAt: prior.endedAt!},
          next.binding.installationId, next.process)) {
        prior.endedAt = next.effectiveAt
        prior.endReason = 'accepted-replacement'
      }
    }
    if (snapshot.frameworkBinding) {
      const last = history.at(-1),
        same =
          last &&
          JSON.stringify(last.binding) === JSON.stringify(snapshot.frameworkBinding) &&
          last.incarnation === snapshot.incarnation
      if (last?.incarnation === snapshot.incarnation && !same)
        throw new TestRunError(409, "Framework binding cannot change within a controller incarnation")
      if (same) {
        if (
          JSON.stringify(last.process) !== JSON.stringify(snapshot.frameworkProcess) ||
          last.effectiveAt !== snapshot.frameworkAcceptedAt
        )
          throw new TestRunError(409, "Framework accepted identity changed within one controller incarnation")
        if (last.endedAt)
          throw new TestRunError(409, "A controller observed stopped cannot assert another running observation")
        last.observedAt = snapshot.observedAt
      } else {
        const sharedStoppedProcess = last?.endReason === 'observed-stop' && snapshot.frameworkProcess &&
          sameStoppedProcess({installationId: last.binding.installationId, process: last.process, observedAt: last.endedAt!},
            snapshot.frameworkBinding.installationId, snapshot.frameworkProcess) &&
          Date.parse(snapshot.frameworkAcceptedAt!) >= Date.parse(last.effectiveAt) &&
          Date.parse(snapshot.frameworkAcceptedAt!) <= Date.parse(last.endedAt!)
        if (last && !sharedStoppedProcess && Date.parse(snapshot.frameworkAcceptedAt!) < Date.parse(last.endedAt ?? last.effectiveAt))
          throw new TestRunError(409, "Framework replacement precedes the last accepted interval")
        if (last && (!last.endedAt || sharedStoppedProcess)) {
          last.endedAt = snapshot.frameworkAcceptedAt
          last.endReason = "accepted-replacement"
        }
        history.push(
          frameworkHistoryEntrySchema.parse({
            binding: snapshot.frameworkBinding,
            incarnation: snapshot.incarnation,
            incarnationGeneration: snapshot.incarnationGeneration,
            process: snapshot.frameworkProcess,
            effectiveAt: snapshot.frameworkAcceptedAt,
            observedAt: snapshot.observedAt,
          }),
        )
      }
    }
    // Startup/history may arrive after the updater already acknowledged the exact process's stop.
    reconcileFrameworkStops(history, stops)
    try {
      const saved = await TestHostStateModel.findOneAndUpdate(
        filter,
        {
          $set: {
            hostId,
            incarnation: snapshot.incarnation,
            incarnationGeneration: snapshot.incarnationGeneration,
            sequence: snapshot.sequence,
            observedAt: new Date(snapshot.observedAt),
            receivedAt: new Date(this.now()),
            snapshot,
            frameworkHistory: history.slice(-100),
            ...(resourceLifecycleCursor ? {resourceLifecycleCursor} : {}),
          },
        },
        {upsert: !current, new: true, writeConcern: testWriteConcern},
      ).select({hostId: 1, incarnation: 1, incarnationGeneration: 1, sequence: 1}).lean()
      if (!saved) return undefined
      return {
        hostId,
        incarnation: saved.incarnation,
        incarnationGeneration: saved.incarnationGeneration,
        sequence: saved.sequence,
      }
    } catch (error) {
      if (!current && (error as {code?: number}).code === 11000)
        return undefined
      throw error
    }
  }
  /** Routing needs current offers, not controller repair history or run progress. */
  async list(): Promise<RoutingTestHostState[]> {
    let credentials: unknown;
    try {credentials = JSON.parse(process.env.TEST_HOST_TOKENS ?? 'null')} catch {credentials = null}
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return [];
    const hostIds = Object.entries(credentials).filter(([hostId, token]) => frameworkIdentitySchema.safeParse(hostId).success &&
      typeof token === 'string' && token.length >= 32).map(([hostId]) => hostId);
    if (hostIds.length > 100) throw new TestRunError(503, 'Enrolled host inventory exceeds its bound');
    const rows = await TestHostStateModel.find({hostId: {$in: hostIds}}).select(routingStateProjection).limit(100)
      .read('primary').readConcern('majority').lean();
    return rows.map(row => {
      const snapshot = routingHostSchema.parse(row.snapshot);
      if (snapshot.hostId !== row.hostId) throw new TestRunError(503, 'Routing snapshot differs from enrolled host');
      // The existing authority retains selected, preparing and unknown custody until
      // its normal reconciliation proves return. No request-history scan is needed.
      const authorityReservations = hostResourceReservationsSchema.parse(row.resourceReservations ?? []);
      return {...snapshot, receivedAt: z.date().parse(row.receivedAt).toISOString(), authorityReservations};
    });
  }
  async get(hostId: string): Promise<ReceivedTestHostState | null> {
    const row = await TestHostStateModel.findOne({hostId}).lean()
    return row
      ? {
          ...hostStateSchema.parse(row.snapshot),
          receivedAt: row.receivedAt.toISOString(),
          frameworkHistory: (row.frameworkHistory ?? []).map((value) => frameworkHistoryEntrySchema.parse(value)),
        }
      : null
  }
  /** Source preparation needs the accepted current framework, without device or repair diagnostics. */
  async frameworkObservation(hostId: string) {
    const row = await TestHostStateModel.findOne({hostId}).select({hostId: 1, receivedAt: 1,
      'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.observedAt': 1, 'snapshot.frameworkBinding': 1,
      'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1, frameworkHistory: 1, _id: 0})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean();
    const parsed = z.object({hostId: frameworkIdentitySchema, receivedAt: z.date(), snapshot: z.object({
      hostId: frameworkIdentitySchema, incarnation: frameworkIdentitySchema, observedAt: z.string().datetime({offset: true}),
      frameworkBinding: frameworkBindingSchema, frameworkAcceptedAt: z.string().datetime({offset: true}),
      frameworkProcess: frameworkProcessSchema}), frameworkHistory: z.array(frameworkHistoryEntrySchema).max(100)}).safeParse(row);
    if (!parsed.success || parsed.data.hostId !== hostId || parsed.data.snapshot.hostId !== hostId) return null;
    const {snapshot, frameworkHistory, receivedAt} = parsed.data, current = frameworkHistory.at(-1);
    if (!current || current.endedAt || current.incarnation !== snapshot.incarnation ||
      JSON.stringify(current.binding) !== JSON.stringify(snapshot.frameworkBinding) ||
      JSON.stringify(current.process) !== JSON.stringify(snapshot.frameworkProcess) || current.effectiveAt !== snapshot.frameworkAcceptedAt) return null;
    return {binding: snapshot.frameworkBinding, receivedAt: receivedAt.toISOString(), observedAt: snapshot.observedAt};
  }
  /** Run details need one lane's observation, never the host's repair history or diagnostics. */
  async progressObservation(hostId: string, laneId: string) {
    const row = await TestHostStateModel.findOne({hostId}).select({'snapshot.incarnation': 1, 'snapshot.sequence': 1,
      'snapshot.lanes.id': 1, 'snapshot.lanes.activity': 1, 'snapshot.lanes.progress': 1, 'snapshot.lanes.waiting': 1, receivedAt: 1, _id: 0})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean()
    const parsed = z.object({incarnation: frameworkIdentitySchema, sequence: z.number().int().nonnegative().safe(),
      lanes: z.array(z.object({id: frameworkIdentitySchema, activity: laneActivitySchema.optional(),
        progress: routineProgressSchema.optional(), waiting: z.array(routineQueuedBlockSchema).max(100).optional()})).max(100)}).safeParse(row?.snapshot)
    const receivedAt = z.date().safeParse(row?.receivedAt)
    if (!parsed.success || !receivedAt.success) return null
    const lane = parsed.data.lanes.find(value => value.id === laneId)
    return lane ? {incarnation: parsed.data.incarnation, sequence: parsed.data.sequence,
      receivedAt: receivedAt.data.toISOString(), lane} : null
  }
  async reportDeployment(input: unknown, hostId: string) {
    const observation = updaterDeploymentSchema.parse(input)
    return retryHostStateWrite(
      () => this.reportDeploymentObservation(observation, hostId),
      'Host deployment observation advanced concurrently',
    )
  }
  private async reportDeploymentObservation(observation: z.infer<typeof updaterDeploymentSchema>, hostId: string) {
    if (observation.hostId !== hostId)
      throw new TestRunError(409, "Deployment observation differs from authenticated host")
    const current = await TestHostStateModel.findOne({hostId}).select(reportingStateProjection).lean()
    if (!current) throw new TestRunError(409, "Controller host enrollment must exist before updater observations")
    if (
      observation.generation < (current.deploymentGeneration ?? 0) ||
      (observation.generation === (current.deploymentGeneration ?? 0) &&
        observation.sequence <= (current.deploymentSequence ?? 0))
    )
      return {hostId, generation: current.deploymentGeneration ?? 0, sequence: current.deploymentSequence ?? 0}
    const history: FrameworkHistoryEntry[] = (current.frameworkHistory ?? []).map((value) =>
      frameworkHistoryEntrySchema.parse(value),
    )
    const stops = (current.frameworkStopReceipts ?? []).map(value => frameworkStopSchema.parse(value))
    const stop = observation.stopped
    if (stop && !stops.some(value => sameStoppedProcess(value, stop.installationId, stop.process))) stops.push(stop)
    reconcileFrameworkStops(history, stops)
    const saved = await TestHostStateModel.findOneAndUpdate(
      {
        hostId,
        incarnation: current.incarnation,
        incarnationGeneration: current.incarnationGeneration,
        sequence: current.sequence,
        ...deploymentCursor(current),
      },
      {
        $set: {
          deploymentGeneration: observation.generation,
          deploymentSequence: observation.sequence,
          deploymentObservation: observation.deployment,
          deploymentReceivedAt: new Date(this.now()),
          frameworkHistory: history,
          // Same bound as accepted history; unmatched receipts survive delayed controller delivery.
          frameworkStopReceipts: stops.slice(-100),
        },
      },
      {new: true, writeConcern: testWriteConcern},
    ).select({deploymentGeneration: 1, deploymentSequence: 1}).lean()
    if (!saved) return undefined
    return {hostId, generation: saved.deploymentGeneration ?? 0, sequence: saved.deploymentSequence ?? 0}
  }
}
