import {createLogger} from '@mentra/cloud-shared/logger'
import type {ResourceReservationHost} from './resource-reservations.service'
import {advanceResourceLifecycleCursor} from './resource-lifecycle.service'
import {resourceIdleContractSchema,resourceLifecycleCurrentSchema} from '../types/resource-lifecycle.types'
import {recorderStorageObservationSchema} from '../types/recorder-storage.types'
import {exclusiveResourceDependenciesSchema, hostResourceReservationsSchema, isExclusiveHostReservation, resourceReservationObservationSchema, type HostResourceReservation} from '../types/resource-reservations.types'
import {laneControlExchangeSchema} from '../types/lane-control.types'
import type {ResourceReadinessAuthority} from './resource-readiness'
import {z} from "zod"
import {TestHostStateModel} from "../models/test-host-state.model"
import {testWriteConcern} from "../models/test-write-concern"
import {frameworkIdentitySchema} from "../types/framework-request.types"
import {glassesModelSchema, routineIdentitySchema, routinePlatformSchema} from "../types/routine-definition.types"
import {
  frameworkDeploymentSchema,
  frameworkHistoryEntrySchema,
  frameworkProcessSchema,
  type FrameworkHistoryEntry,
  laneActivitySchema,
  laneRepairStatusSchema,
} from "../types/lane-restoration.types"
import {frameworkBindingSchema} from "../types/framework-version.types"
import {permissionObservationsSchema} from "../types/resource-permissions.types"
import {backendConnectivityObservationSchema} from '../types/backend-connectivity.types'
import {routineQualificationTargetSchema} from '../types/routine-job.types'
import {TestRunError} from "./test-result-error"
import {routineQueuedBlockSchema, routineProgressSchema} from '../types/routine-progress.types'
import {TestRequestModel} from '../models/test-request.model'
import {isDeepStrictEqual} from 'node:util'
import {preparationFrameworkAdmissionSchema, type PreparationFrameworkAdmission, type PreparationFrameworkEffect} from '../types/routine-dispatch.types'
import {currentAcceptedFramework, testHostHistoryRepository,
  type TestHostHistoryRepository} from './test-host-history.repository'
const logger = createLogger('core').child({component: 'test-host-state'})
const resource = z
  .object({
    id: frameworkIdentitySchema,
    kind: z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]),
    laneId: frameworkIdentitySchema.optional(),
    capabilities: z.array(routineIdentitySchema).max(30).optional(),
    permissionObservations: permissionObservationsSchema.optional(),
    backendConnectivity: backendConnectivityObservationSchema.optional(),
    storage: recorderStorageObservationSchema.optional(),
    idleContract: resourceIdleContractSchema.optional(),
    exclusiveDependencies: exclusiveResourceDependenciesSchema.optional(),
  })
  .strict().refine(value => !value.exclusiveDependencies || value.exclusiveDependencies.every(dependency =>
    value.capabilities?.includes(dependency.capability)), 'Exclusive dependencies must name an offered capability')
  .refine(value => !value.backendConnectivity || value.kind === 'phone' && value.backendConnectivity.phoneResourceId === value.id &&
    value.capabilities?.includes('backend-connectivity'), 'Backend observation must identify its installed phone capability')
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
  activity: laneActivitySchema.optional(),
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
function validateHostLaneInventory(snapshot: {lanes: z.infer<typeof routingLaneSchema>[]; resources?: z.infer<typeof resource>[]}, ctx: z.RefinementCtx) {
  const independent = snapshot.resources ?? [];
  if (new Set(independent.map(value => value.id)).size !== independent.length ||
    independent.some(value => value.laneId !== undefined || snapshot.lanes.some(lane => lane.resources.some(member => member.id === value.id))))
    ctx.addIssue({code: 'custom', message: 'Independent canonical resource inventory must be unique and have no lane membership'});
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
  incarnation: frameworkIdentitySchema.optional(),
  incarnationGeneration: z.number().int().positive().safe().optional(),
  frameworkBinding: frameworkBindingSchema.optional(),
  resourceReservations: z.object({resourceReadiness: z.literal(true).optional()}).strict().optional(),
  resourceLifecycle: resourceLifecycleCurrentSchema.optional(),
  observedAt: z.string().datetime({offset: true}).optional(),
  laneControls: laneControlExchangeSchema.optional(),
  resources: z.array(resource).max(100).optional(),
  lanes: z.array(routingLaneSchema).max(100),
}).strict().superRefine(validateHostLaneInventory)
export type RoutingTestHostState = z.infer<typeof routingHostSchema> & ResourceReadinessAuthority & {receivedAt: string; authorityReservations?: HostResourceReservation[]}
// Permission observations remain fresh; only diagnostic/history fields are excluded at the database.
const routingStateProjection = {hostId: 1, receivedAt: 1, resourceReservations: 1, laneControls: 1,
  'resourceLifecycleCursor.schemaVersion': 1, 'resourceLifecycleCursor.subjects': 1,
  'snapshot.resourceReservations.resourceReadiness': 1, 'snapshot.observedAt': 1, 'snapshot.laneControls': 1, 'snapshot.hostId': 1, 'snapshot.frameworkBinding': 1,
  'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1,
  'snapshot.resourceLifecycle.schemaVersion': 1, 'snapshot.resourceLifecycle.subjects': 1, 'snapshot.resources': 1,
  'snapshot.lanes.id': 1, 'snapshot.lanes.descriptorRevision': 1, 'snapshot.lanes.platform': 1,
  'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1, 'snapshot.lanes.resources': 1,
  'snapshot.lanes.glasses': 1, _id: 0} as const
const routineAvailability = z
  .object({
    routineId: routineIdentitySchema,
    definitionRevision: z.string().regex(/^[a-f0-9]{40}$/),
    available: z.boolean(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
function currentHostInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const {frameworkHistory: _history, restoration, ...current} = input as Record<string, any>
  const attempts = restoration && Array.isArray(restoration.attempts) ? restoration.attempts : undefined
  const ownedRepairs = new Set((Array.isArray(current.lanes) ? current.lanes : []).flatMap((lane: any) =>
    lane?.activity?.owner?.kind === 'fixer' ? [lane.activity.owner.id] : []))
  return {...current, ...(attempts && current.repairStatuses === undefined ? {repairStatuses: attempts.filter((attempt: any) => attempt?.current || ownedRepairs.has(attempt?.executionId)).map((attempt: any) =>
    Object.fromEntries(['executionId', 'interruptionId', 'laneId', 'state', 'current', 'startedAt', 'finishedAt', 'haltDecisionId']
      .filter(key => attempt[key] !== undefined).map(key => [key, attempt[key]])))} : {})}
}
export const hostStateSchema = z.preprocess(currentHostInput, z
  .object({
    hostId: frameworkIdentitySchema,
    incarnation: frameworkIdentitySchema,
    incarnationGeneration: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe(),
    observedAt: z.string().datetime({offset: true}),
    resources: z.array(resource).max(100).optional(),
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
    resourceLifecycle: resourceLifecycleCurrentSchema.optional(),
    laneControls: laneControlExchangeSchema.optional(),
    resourceReservations: resourceReservationObservationSchema.optional(),
    repairStatuses: z.array(laneRepairStatusSchema).max(100).optional(),
    frameworkBinding: frameworkBindingSchema.optional(),
    frameworkAcceptedAt: z.string().datetime({offset: true}).optional(),
    frameworkProcess: frameworkProcessSchema.optional(),
    deployment: frameworkDeploymentSchema.optional(),
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
    for (const lane of snapshot.lanes) if (lane.progress && (lane.progress.controllerIncarnation !== snapshot.incarnation ||
        lane.progress.sequence !== snapshot.sequence || lane.progress.observedAt !== snapshot.observedAt))
      ctx.addIssue({code: 'custom', message: 'Routine progress differs from its controller observation'})
    if (snapshot.repairStatuses?.some((attempt) => !snapshot.lanes.some((lane) => lane.id === attempt.laneId)))
      ctx.addIssue({code: "custom", message: "Restoration attempt names an unknown host lane"})
    const storage = snapshot.lanes.flatMap(lane => lane.resources.flatMap(resource => resource.storage ? [resource.storage] : []))
    if (storage.some(value => Date.parse(value.observedAt) > Date.parse(snapshot.observedAt) || JSON.stringify(value) !== JSON.stringify(storage[0])))
      ctx.addIssue({code: 'custom', message: 'Recorder offers must share one measured host disk pool'})
    for (const lane of snapshot.lanes) if (lane.waiting?.some(value => Date.parse(value.observedAt) > Date.parse(snapshot.observedAt)) ||
      new Set(lane.waiting?.map(value => value.requestId)).size !== (lane.waiting?.length ?? 0))
      ctx.addIssue({code: 'custom', message: 'Queued blocker observations must have unique identities and actual past timestamps'})
    if (snapshot.resourceLifecycle?.subjects.some(subject=>subject.observedAt!==null && Date.parse(subject.observedAt)>Date.parse(snapshot.observedAt)))
      ctx.addIssue({code: 'custom', message: 'Resource observation is newer than host observation'})
    if (snapshot.resourceLifecycle?.subjects.some(subject => subject.subject.authorityHostId !== snapshot.hostId))
      ctx.addIssue({code: "custom", message: "Resource lifecycle must be reported by its authority host"})
    const local = (snapshot.resourceReservations?.localPrerequisites ?? []).map(value => routineQualificationTargetSchema.safeParse(value))
    local.forEach((value, index) => {
      if (!value.success) for (const issue of value.error.issues)
        ctx.addIssue({...issue, path: ['resourceReservations', 'localPrerequisites', index, ...issue.path]})
    })
    if (local.some(value => !value.success || !value.data.local || value.data.hostId !== snapshot.hostId ||
      !snapshot.lanes.some(lane => lane.id === value.data.laneId && lane.platform === 'android')) ||
      new Set(local.flatMap(value => value.success ? [value.data.jobId] : [])).size !== local.length ||
      new Set(local.flatMap(value => value.success ? [value.data.laneId] : [])).size !== local.length)
      ctx.addIssue({code: 'custom', message: 'Local prerequisites must retain unique original inputs on their authority host'})
    validateHostLaneInventory(snapshot, ctx)
  }))
export type TestHostState = z.infer<typeof hostStateSchema>
const frameworkStopSchema = z.object({
  installationId: frameworkIdentitySchema,
  process: frameworkProcessSchema,
  observedAt: z.string().datetime({offset: true}),
}).strict()
type FrameworkStop = z.infer<typeof frameworkStopSchema>
// Optional telemetry can omit framework metadata. Retain its last accepted
// identity for custody continuity, never as evidence that an omitted report is available.
const frameworkAcceptedIdentitySchema=z.object({frameworkBinding:frameworkBindingSchema,
  frameworkProcess:frameworkProcessSchema,frameworkAcceptedAt:z.string().datetime({offset:true}),
  incarnation:frameworkIdentitySchema,incarnationGeneration:z.number().int().positive().safe()}).strict()
// Unaccepted process points are operational state. Unknown matching metadata
// must still refuse acceptance; unrelated points never validate current state.
const frameworkUnacceptedStopsSchema=z.array(z.unknown()).max(100)
const firstMatchingStop = (installationId: unknown, processId: unknown, processBirth: unknown) => ({$arrayElemAt:[
  {$filter:{input:{$cond:[{$isArray:'$frameworkStopReceipts'},'$frameworkStopReceipts',[]]},as:'stop',cond:{$and:[
    ...[installationId,processId,processBirth].map(value=>({$ne:[{$ifNull:[value,null]},null]})),
    {$eq:['$$stop.installationId',installationId]},{$eq:['$$stop.process.pid',processId]},
    {$eq:['$$stop.process.startedAt',processBirth]},
  ]}}},0,
]})
// Select one exact process point from an old document; no event array crosses
// the current read boundary. The next authenticated writer retains it below.
const acceptedFrameworkField=(field:string)=>({$ifNull:[`$snapshot.${field}`,`$frameworkAcceptedIdentity.${field}`]})
export const currentFrameworkStopProjection={$cond:[{$and:[
  {$eq:['$frameworkCurrentStop.installationId',acceptedFrameworkField('frameworkBinding.installationId')]},
  {$eq:['$frameworkCurrentStop.process.pid',acceptedFrameworkField('frameworkProcess.pid')]},
  {$eq:['$frameworkCurrentStop.process.startedAt',acceptedFrameworkField('frameworkProcess.startedAt')]},
  {$ne:[{$ifNull:[acceptedFrameworkField('frameworkBinding.installationId'),null]},null]},
]},'$frameworkCurrentStop',firstMatchingStop(acceptedFrameworkField('frameworkBinding.installationId'),
  acceptedFrameworkField('frameworkProcess.pid'),acceptedFrameworkField('frameworkProcess.startedAt'))]}
const legacyStopTime={$convert:{input:'$$stop.observedAt',to:'date',onError:null,onNull:null}}
const legacyUnacceptedStops={$filter:{input:{$cond:[{$isArray:'$frameworkStopReceipts'},'$frameworkStopReceipts',[]]},as:'stop',cond:{$and:[
  ...['installationId','process.pid','process.startedAt'].map(field=>({$ne:[{$ifNull:[`$$stop.${field}`,null]},null]})),
  {$not:[{$and:[{$eq:['$$stop.installationId',acceptedFrameworkField('frameworkBinding.installationId')]},
    {$eq:['$$stop.process.pid',acceptedFrameworkField('frameworkProcess.pid')]},{$eq:['$$stop.process.startedAt',acceptedFrameworkField('frameworkProcess.startedAt')]}]}]},
  {$or:[{$eq:[legacyStopTime,null]},{$gte:[legacyStopTime,{$convert:{input:acceptedFrameworkField('frameworkAcceptedAt'),to:'date',onError:null,onNull:null}}]}]},
]}}}
function exactStop(value:unknown, installationId:string,process:FrameworkStop['process']) {
 const stop=value as Partial<FrameworkStop>|null
 return stop?.installationId===installationId&&stop.process?.pid===process.pid&&stop.process.startedAt===process.startedAt
}
function unacceptedStopPoints(value:unknown) {
 const points=z.array(z.unknown()).max(200).parse(value??[]),distinct=new Map<string,unknown>()
 for(const point of points) {
  const stop=point as Partial<FrameworkStop>|null,key=JSON.stringify([stop?.installationId,stop?.process?.pid,stop?.process?.startedAt])
  if(!distinct.has(key)||!frameworkStopSchema.safeParse(distinct.get(key)).success&&frameworkStopSchema.safeParse(point).success)distinct.set(key,point)
 }
 return frameworkUnacceptedStopsSchema.parse([...distinct.values()])
}
/** The updater's latest unresolved stop is current process state. It is
 * consumed by the matching delayed acceptance, never an event replay. */
function currentFrameworkInterval(row: {snapshot?: Record<string, any>; incarnation?: string; incarnationGeneration?: number;
  frameworkAcceptedIdentity?:unknown;frameworkCurrentStop?: unknown;legacyFrameworkInterval?:unknown}) {
  const hasSnapshot=Boolean(row.snapshot?.frameworkBinding)
  const identity=hasSnapshot||row.frameworkAcceptedIdentity===undefined?undefined:
    frameworkAcceptedIdentitySchema.parse(row.frameworkAcceptedIdentity)
  // Only authenticated writer reads select this single legacy operational point.
  // A current scalar wins over same-generation debug; a later old writer's
  // authentic acceptance remains the fence when its latest telemetry omitted it.
  const legacy=!hasSnapshot&&row.legacyFrameworkInterval&&(!identity||
    (row.legacyFrameworkInterval as FrameworkHistoryEntry).incarnationGeneration>identity.incarnationGeneration)
    ? frameworkHistoryEntrySchema.parse({...row.legacyFrameworkInterval as Record<string,unknown>,observedAt:row.snapshot?.observedAt}):undefined
  const snapshot=hasSnapshot?row.snapshot:identity
  if(!snapshot?.frameworkBinding&&!legacy) return undefined
  const interval=legacy??currentAcceptedFramework({...snapshot,observedAt:row.snapshot?.observedAt??snapshot?.frameworkAcceptedAt,
    incarnation:hasSnapshot?row.incarnation??snapshot?.incarnation:snapshot?.incarnation,
    incarnationGeneration:hasSnapshot?row.incarnationGeneration??snapshot?.incarnationGeneration:snapshot?.incarnationGeneration} as Parameters<typeof currentAcceptedFramework>[0])!
  const stop=row.frameworkCurrentStop===undefined?undefined:frameworkStopSchema.parse(row.frameworkCurrentStop)
  return stop&&sameStoppedProcess(stop,interval.binding.installationId,interval.process)
    ? frameworkHistoryEntrySchema.parse({...interval,endedAt:stop.observedAt,endReason:'observed-stop'}) : interval
}
const sameStoppedProcess = (stop: FrameworkStop, installationId: string, process: FrameworkStop['process']) =>
  stop.installationId === installationId && stop.process.pid === process.pid && stop.process.startedAt === process.startedAt
const acceptedIdentity = (interval:FrameworkHistoryEntry)=>({frameworkBinding:interval.binding,
  frameworkProcess:interval.process,frameworkAcceptedAt:interval.effectiveAt,
  incarnation:interval.incarnation,incarnationGeneration:interval.incarnationGeneration})
const observedIntervalStop = (interval:FrameworkHistoryEntry|undefined)=>interval?.endReason==='observed-stop'&&interval.endedAt
  ? frameworkStopSchema.parse({installationId:interval.binding.installationId,process:interval.process,observedAt:interval.endedAt}):undefined
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
export type ReceivedTestHostState = TestHostState & ResourceReadinessAuthority & {receivedAt: string;
  frameworkCurrentStop?: FrameworkStop; frameworkHistory?: FrameworkHistoryEntry[]; authorityReservations?: HostResourceReservation[]}
// Old documents keep their owned repair inside restoration diagnostics. Select
// only current owner-linked fields until the normal report extracts them.
export const currentOwnedRepairProjection={$ifNull:['$snapshot.repairStatuses',{$map:{
  input:{$filter:{input:{$cond:[{$isArray:'$snapshot.restoration.attempts'},'$snapshot.restoration.attempts',[]]},
    as:'repair',cond:{$in:[['$$repair.laneId','$$repair.executionId'],{$map:{
      input:{$filter:{input:'$snapshot.lanes',as:'lane',cond:{$eq:['$$lane.activity.owner.kind','fixer']}}},
      as:'lane',in:['$$lane.id','$$lane.activity.owner.id'],
    }}]}}},as:'repair',in:Object.fromEntries(
      ['executionId','interruptionId','laneId','state','current','startedAt','finishedAt','haltDecisionId']
        .map(field=>[field,`$$repair.${field}`])),
}}]}
export const currentHostStateProjection = {hostId: 1, incarnation: 1, incarnationGeneration: 1, sequence: 1,
  receivedAt: 1, resourceReservations: 1, laneControls: 1, frameworkCurrentStop: currentFrameworkStopProjection,
  'resourceLifecycleCursor.schemaVersion': 1, 'resourceLifecycleCursor.subjects': 1,
  'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1, 'snapshot.sequence': 1,
  'snapshot.observedAt': 1, 'snapshot.resources': 1, 'snapshot.lanes.id': 1, 'snapshot.lanes.platform': 1,
  'snapshot.lanes.descriptorRevision': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.dispatchMode': 1,
  'snapshot.lanes.resources': 1, 'snapshot.lanes.glasses': 1, 'snapshot.lanes.activity': 1,
  'snapshot.lanes.progress': 1, 'snapshot.lanes.waiting': 1, 'snapshot.lanes.routineAvailability': 1, 'snapshot.repairStatuses': currentOwnedRepairProjection,
  'snapshot.resourceLifecycle.schemaVersion': 1, 'snapshot.resourceLifecycle.subjects': 1,
  'snapshot.laneControls': 1, 'snapshot.resourceReservations': 1, 'snapshot.frameworkBinding': 1,
  'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1, 'snapshot.deployment': 1, _id: 0} as const
const deploymentCursor = (row: {deploymentGeneration?: number; deploymentSequence?: number}) => ({
  deploymentGeneration: row.deploymentGeneration ?? {$exists: false},
  deploymentSequence: row.deploymentSequence ?? {$exists: false},
})
// Current reporting never loads journal or repair debug payloads.
const reportingCurrentFields = {hostId: 1, incarnation: 1, incarnationGeneration: 1, sequence: 1,
  deploymentGeneration: 1, deploymentSequence: 1, frameworkAcceptedIdentity: 1, frameworkCurrentStop: 1, frameworkUnacceptedStops: 1,
  'snapshot.observedAt': 1, 'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1,
  'snapshot.resourceLifecycle.schemaVersion': 1, 'snapshot.resourceLifecycle.subjects': 1,
  'resourceLifecycleCursor.schemaVersion': 1, 'resourceLifecycleCursor.subjects': 1} as const
// Before extraction an old writer may already have omitted optional metadata.
// Retain one accepted tuple by its monotonic controller generation, not a
// diagnostic replay. No legacy event array crosses the writer read boundary.
const legacyAcceptedFrameworkProjection={$let:{vars:{point:{$reduce:{
  input:{$cond:[{$isArray:'$frameworkHistory'},'$frameworkHistory',[]]},initialValue:null,
  in:{$cond:[{$and:[{$lte:['$$this.incarnationGeneration','$incarnationGeneration']},
    {$gt:['$$this.incarnationGeneration',{$ifNull:['$$value.incarnationGeneration',0]}]}]},'$$this','$$value']},
}}},in:{$cond:[{$ne:['$$point',null]},Object.fromEntries(
  ['binding','process','incarnation','incarnationGeneration','effectiveAt','endedAt','endReason'].map(field=>[field,`$$point.${field}`])),null]}}}
// Older writers retained their first exact stop in a bounded array. At this
// ordinary writer boundary project only the relevant current process point;
// unrelated diagnostic entries are neither returned nor validated.
const reportingStateProjection = (incoming?: TestHostState) => ({...reportingCurrentFields,
  legacyFrameworkInterval:legacyAcceptedFrameworkProjection,
  frameworkCurrentStop:currentFrameworkStopProjection,
  frameworkUnacceptedStops:{$concatArrays:[{$ifNull:['$frameworkUnacceptedStops',[]]},legacyUnacceptedStops]},
  ...(incoming?.frameworkBinding&&incoming.frameworkProcess?{incomingFrameworkStop:firstMatchingStop(
    {$literal:incoming.frameworkBinding.installationId},{$literal:incoming.frameworkProcess.pid},{$literal:incoming.frameworkProcess.startedAt})}:{}),
})

async function retryHostStateWrite<T>(write: () => Promise<T | undefined>, conflict: string): Promise<T> {
  // Only an atomic write collision returns undefined; semantic conflicts and database errors propagate.
  for (let attempt = 0; attempt < 3; attempt++) {
    const receipt = await write()
    if (receipt !== undefined) return receipt
  }
  throw new TestRunError(409, conflict)
}
const recorderReturnLogger = createLogger('core').child({service: 'recorder-return'})
export class TestHostStateService {
  constructor(private readonly now: () => number = Date.now, private readonly onAccepted?: (host: ResourceReservationHost) => Promise<unknown>,
    private readonly history: TestHostHistoryRepository = testHostHistoryRepository) {}
  async report(input: unknown, hostId: string) {
    const snapshot = hostStateSchema.parse(input)
    const receipt = await retryHostStateWrite(
      () => this.reportSnapshot(snapshot, hostId),
      'Controller snapshot advanced concurrently; retry current observation',
    )
    const raw = input as Record<string, any>
    // Reporting current state does not await, parse or depend on debug delivery.
    void this.history.debug({hostId, incarnationGeneration: snapshot.incarnationGeneration, sequence: snapshot.sequence,
      receivedAt: new Date(this.now()), payload: {
        ...(Array.isArray(raw.frameworkHistory) ? {frameworkHistory: raw.frameworkHistory.slice(-100)} : {}),
        ...(Array.isArray(raw.resourceLifecycle?.history) ? {resourceHistory: raw.resourceLifecycle.history.slice(-200)} : {}),
        ...(raw.restoration ? {restoration: raw.restoration} : {}),
      }}).catch(error => logger.warn({hostId, error}, 'Host debug history delivery failed'))
    return receipt
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
    const current = await TestHostStateModel.findOne({hostId}).select(reportingStateProjection(snapshot)).lean()
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
    const prior = current ? currentFrameworkInterval(current) : undefined
    const unaccepted=unacceptedStopPoints(current?.frameworkUnacceptedStops)
    const incomingStop=unaccepted.find(stop=>snapshot.frameworkBinding&&snapshot.frameworkProcess&&
      exactStop(stop,snapshot.frameworkBinding.installationId,snapshot.frameworkProcess))??
      (current as {incomingFrameworkStop?:unknown}|null)?.incomingFrameworkStop
    const interval = currentFrameworkInterval({snapshot,frameworkCurrentStop:incomingStop??current?.frameworkCurrentStop})
    const retainedStops=interval?unaccepted.filter(stop=>!exactStop(stop,interval.binding.installationId,interval.process)&&
      !(frameworkStopSchema.safeParse(stop).success&&Date.parse((stop as FrameworkStop).observedAt)<Date.parse(interval.effectiveAt))):unaccepted
    if (prior && interval && prior.incarnation === interval.incarnation &&
      (!isDeepStrictEqual(prior.binding, interval.binding) || !isDeepStrictEqual(prior.process, interval.process) ||
        prior.effectiveAt !== interval.effectiveAt || prior.endedAt))
      throw new TestRunError(409, 'Framework accepted identity changed or stopped within one controller incarnation')
    if (prior && interval && prior.endedAt &&
      sameStoppedProcess({installationId: prior.binding.installationId, process: prior.process, observedAt: prior.endedAt},
        interval.binding.installationId, interval.process))
      throw new TestRunError(409, 'A controller observed stopped cannot assert another running observation')
    if (prior && interval && prior.incarnation !== interval.incarnation &&
      Date.parse(interval.effectiveAt) < Date.parse(prior.endedAt ?? prior.effectiveAt))
      throw new TestRunError(409, 'Framework replacement precedes the last accepted interval')
    const accepted=interval??prior,retainedStop=observedIntervalStop(accepted)
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
            ...(accepted?{frameworkAcceptedIdentity:acceptedIdentity(accepted)}:{}),
            frameworkUnacceptedStops:retainedStops,
            ...(retainedStop?{frameworkCurrentStop:retainedStop}:{}),
            ...(resourceLifecycleCursor ? {resourceLifecycleCursor} : {}),
          },
          $unset: {frameworkHistory: '',
            ...(accepted?{frameworkStopReceipts:''}:{}),
            ...(interval && !interval.endedAt ? {frameworkCurrentStop:''} : {})},
        },
        // The parsed envelope and patch above are server-constructed. Preserve
        // unsets for retired schema paths without restoring those stored fields.
        {upsert: !current, new: true, strict: false, writeConcern: testWriteConcern},
      ).select({hostId: 1, incarnation: 1, incarnationGeneration: 1, sequence: 1, receivedAt: 1,
        laneControlVersion: 1, resourceReservationVersion: 1, resourceReservations: 1}).lean()
      if (!saved) return undefined
      if(interval&&(!prior||prior.incarnation!==interval.incarnation)) {
        const finished=prior&&!prior.endedAt?{...prior,endedAt:interval.effectiveAt,endReason:'accepted-replacement'}:prior
        void this.history.debug({hostId,incarnationGeneration:snapshot.incarnationGeneration,sequence:snapshot.sequence,
          receivedAt:new Date(this.now()),payload:{frameworkHistory:[...(finished?[finished]:[]),interval]}})
          .catch(error=>logger.warn({hostId,error},'Accepted framework debug delivery failed'))
      }
      // Reuse the accepted current snapshot. Its exact host/version CAS still fences a later writer.
      const claims = hostResourceReservationsSchema.safeParse(saved.resourceReservations ?? [])
      if (this.onAccepted && claims.success && claims.data.some(claim => !isExclusiveHostReservation(claim)))
        void this.onAccepted({...saved, snapshot} as ResourceReservationHost).catch(() =>
          recorderReturnLogger.warn({hostId}, 'Recorder return remains pending after accepted host report'))
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
      return {...snapshot, receivedAt: z.date().parse(row.receivedAt).toISOString(), authorityReservations,
        ...(row.laneControls === undefined ? {} : {resourceControlRecords: row.laneControls}),
        ...(row.resourceLifecycleCursor === undefined ? {} : {resourceLifecycleCursor: resourceLifecycleCurrentSchema.parse(row.resourceLifecycleCursor)})};
    });
  }
  /** Current selected-host state. Debug and source journals have separate readers. */
  async get(hostId: string): Promise<ReceivedTestHostState | null> {
    const row = await TestHostStateModel.findOne({hostId}).select(currentHostStateProjection)
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean()
    if (!row) return null
    return {...hostStateSchema.parse(row.snapshot),
      authorityReservations: hostResourceReservationsSchema.parse(row.resourceReservations ?? []),
      ...(row.laneControls === undefined ? {} : {resourceControlRecords: row.laneControls}),
      ...(row.resourceLifecycleCursor === undefined ? {} : {resourceLifecycleCursor: resourceLifecycleCurrentSchema.parse(row.resourceLifecycleCursor)}),
      ...(row.frameworkCurrentStop ? {frameworkCurrentStop: frameworkStopSchema.parse(row.frameworkCurrentStop)} : {}),
      receivedAt: row.receivedAt.toISOString()}
  }
  /** Preparation validates only the accepted current source identity. */
  async frameworkObservation(hostId: string) {
    const row = await TestHostStateModel.findOne({hostId}).select({hostId: 1, receivedAt: 1,
      frameworkCurrentStop:currentFrameworkStopProjection, 'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1,
      'snapshot.observedAt': 1, 'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1, _id: 0})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean()
    const snapshot = z.object({hostId: frameworkIdentitySchema, incarnation: frameworkIdentitySchema,
      incarnationGeneration: z.number().int().positive().safe(), observedAt: z.string().datetime({offset: true}),
      frameworkBinding: frameworkBindingSchema, frameworkAcceptedAt: z.string().datetime({offset: true}),
      frameworkProcess: frameworkProcessSchema}).safeParse(row?.snapshot)
    const receivedAt = z.date().safeParse(row?.receivedAt)
    if (!snapshot.success || !receivedAt.success || row?.hostId !== hostId || snapshot.data.hostId !== hostId) return null
    const parsedInterval = frameworkHistoryEntrySchema.safeParse(currentFrameworkInterval({...row,snapshot:snapshot.data}))
    const interval = parsedInterval.success ? parsedInterval.data : undefined
    if (!interval || interval.endedAt || interval.incarnation !== snapshot.data.incarnation ||
      interval.incarnationGeneration !== snapshot.data.incarnationGeneration ||
      !isDeepStrictEqual(interval.binding, snapshot.data.frameworkBinding) || !isDeepStrictEqual(interval.process, snapshot.data.frameworkProcess) ||
      interval.effectiveAt !== snapshot.data.frameworkAcceptedAt) return null
    return {binding: snapshot.data.frameworkBinding, receivedAt: receivedAt.data.toISOString(), observedAt: snapshot.data.observedAt}
  }
  async preparationFrameworkAdmission(hostId: string, requestId: string) {
    const row = await TestHostStateModel.findOne({hostId}).select({preparationFrameworkAdmissions: 1, _id: 0})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean();
    return z.array(preparationFrameworkAdmissionSchema).max(100).parse(row?.preparationFrameworkAdmissions ?? [])
      .find(value => value.requestId === requestId);
  }
  /** The host CAS admits a floor observation; the separate request CAS remains effect/cancellation authority. */
  async admitPreparationFramework(hostId: string, requestId: string, dispatchIntentSha256: string,
    requestFenceSha256: string, minimum: number, effect: PreparationFrameworkEffect, responseBinding?: z.infer<typeof frameworkBindingSchema>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await TestHostStateModel.findOne({hostId}).select({hostId: 1, incarnation: 1, incarnationGeneration: 1, sequence: 1,
        deploymentGeneration: 1, deploymentSequence: 1, receivedAt: 1,
        'snapshot.hostId': 1, 'snapshot.incarnation': 1, 'snapshot.incarnationGeneration': 1, 'snapshot.sequence': 1,
        'snapshot.observedAt': 1, 'snapshot.frameworkBinding': 1, 'snapshot.frameworkAcceptedAt': 1, 'snapshot.frameworkProcess': 1, frameworkCurrentStop:currentFrameworkStopProjection,
        preparationFrameworkAdmissions: 1, preparationFrameworkAdmissionVersion: 1})
        .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean();
      const admissions = z.array(preparationFrameworkAdmissionSchema).max(100).parse(row?.preparationFrameworkAdmissions ?? []);
      const existing = admissions.find(value => value.requestId === requestId);
      if (existing) {
        if (existing.dispatchIntentSha256 !== dispatchIntentSha256 || existing.requestFenceSha256 !== requestFenceSha256 ||
          !isDeepStrictEqual(existing.effect, effect) || responseBinding && !isDeepStrictEqual(existing.binding, responseBinding))
          throw new TestRunError(409, 'Framework preparation admission changed its original request effect');
        return existing;
      }
      const snapshot = z.object({hostId: frameworkIdentitySchema, incarnation: frameworkIdentitySchema,
        incarnationGeneration: z.number().int().positive().safe(), sequence: z.number().int().nonnegative().safe(),
        observedAt: z.string().datetime({offset: true}), frameworkBinding: frameworkBindingSchema,
        frameworkAcceptedAt: z.string().datetime({offset: true}), frameworkProcess: frameworkProcessSchema}).safeParse(row?.snapshot),
        receivedAt = z.date().safeParse(row?.receivedAt);
      const interval = frameworkHistoryEntrySchema.safeParse(row && snapshot.success ? currentFrameworkInterval({...row,snapshot:snapshot.data}) : undefined),
        current = interval.success ? interval.data : undefined;
      const now = this.now();
      if (!row || !snapshot.success || !receivedAt.success || snapshot.data.hostId !== hostId ||
        row.incarnation !== snapshot.data.incarnation || row.incarnationGeneration !== snapshot.data.incarnationGeneration || row.sequence !== snapshot.data.sequence ||
        !snapshot.data.frameworkBinding || snapshot.data.frameworkBinding.version < minimum || !current || current.endedAt ||
        current.incarnation !== row.incarnation || !isDeepStrictEqual(current.binding, snapshot.data.frameworkBinding) ||
        !isDeepStrictEqual(current.process, snapshot.data.frameworkProcess) || current.effectiveAt !== snapshot.data.frameworkAcceptedAt ||
        responseBinding && !isDeepStrictEqual(responseBinding, snapshot.data.frameworkBinding) ||
        ![receivedAt.data.getTime(), Date.parse(snapshot.data.observedAt)].every(at => Number.isFinite(at) && at <= now && now - at <= 120_000))
        throw new TestRunError(409, `Waiting for framework ${minimum}: preparation requires its fresh accepted host binding`);
      // Only authoritative request settlement releases a reconciliation slot; age never does.
      const settled = admissions.length ? await TestRequestModel.find({requestId: {$in: admissions.map(value => value.requestId)},
        state: {$in: ['queued', 'accepted', 'running', 'terminal']}}).select({requestId: 1, hostId: 1, dispatchIntentSha256: 1}).limit(100)
        .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() : [];
      const retained = admissions.filter(value => !settled.some(request => request.requestId === value.requestId &&
        request.hostId === hostId && request.dispatchIntentSha256 === value.dispatchIntentSha256));
      if (retained.length >= 100) throw new TestRunError(409, 'Waiting for framework preparation reconciliation: 100 original requests remain unresolved');
      const admission: PreparationFrameworkAdmission = preparationFrameworkAdmissionSchema.parse({requestId, dispatchIntentSha256,
        requestFenceSha256, effect, binding: snapshot.data.frameworkBinding, incarnation: row.incarnation,
        incarnationGeneration: row.incarnationGeneration, sequence: row.sequence,
        ...(row.deploymentGeneration !== undefined ? {deploymentGeneration: row.deploymentGeneration} : {}),
        ...(row.deploymentSequence !== undefined ? {deploymentSequence: row.deploymentSequence} : {}),
        receivedAt: receivedAt.data.toISOString(), observedAt: snapshot.data.observedAt, admittedAt: new Date(now).toISOString()});
      const saved = await TestHostStateModel.findOneAndUpdate({hostId, incarnation: row.incarnation,
        incarnationGeneration: row.incarnationGeneration, sequence: row.sequence, ...deploymentCursor(row),
        receivedAt: row.receivedAt,
        preparationFrameworkAdmissionVersion: row.preparationFrameworkAdmissionVersion ?? {$exists: false}},
        {$set: {preparationFrameworkAdmissions: [...retained, admission]}, $inc: {preparationFrameworkAdmissionVersion: 1}},
        {new: true, writeConcern: testWriteConcern}).select({hostId: 1}).setOptions({timeoutMS: 5000}).lean();
      if (saved) return admission;
    }
    throw new TestRunError(409, 'Framework preparation observation advanced concurrently; retry the unchanged effect');
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
    const current = await TestHostStateModel.findOne({hostId}).select(reportingStateProjection()).lean()
    if (!current) throw new TestRunError(409, "Controller host enrollment must exist before updater observations")
    if (
      observation.generation < (current.deploymentGeneration ?? 0) ||
      (observation.generation === (current.deploymentGeneration ?? 0) &&
        observation.sequence <= (current.deploymentSequence ?? 0))
    )
      return {hostId, generation: current.deploymentGeneration ?? 0, sequence: current.deploymentSequence ?? 0}
    const stop = observation.stopped
    const priorStop=frameworkStopSchema.safeParse(current.frameworkCurrentStop)
    // A fresh authenticated supervisor observation can answer unknown current
    // metadata. It does not need a fabricated prior ending or debug receipt.
    let interval = currentFrameworkInterval({...current,frameworkCurrentStop:priorStop.success?priorStop.data:undefined})
    const earlierStop=observedIntervalStop(interval)??(priorStop.success?priorStop.data:undefined)
    const unaccepted=unacceptedStopPoints(current.frameworkUnacceptedStops)
    if(stop&&(!interval||!sameStoppedProcess(stop,interval.binding.installationId,interval.process)&&
      Date.parse(stop.observedAt)>=Date.parse(interval.effectiveAt))&&
      !unaccepted.some(value=>exactStop(value,stop.installationId,stop.process))) unaccepted.push(stop)
    // Capacity is explicit. Never acknowledge a new stop by dropping another
    // unresolved process point; the updater retains an unacknowledged delivery.
    frameworkUnacceptedStopsSchema.parse(unaccepted)
    const unresolvedStop=stop&&(!interval||sameStoppedProcess(stop,interval.binding.installationId,interval.process))
      ? earlierStop&&sameStoppedProcess(earlierStop,stop.installationId,stop.process)?earlierStop:stop : earlierStop??current.frameworkCurrentStop
    if (interval && stop && sameStoppedProcess(stop, interval.binding.installationId, interval.process)) {
      if (Date.parse(stop.observedAt) < Date.parse(interval.effectiveAt))
        throw new TestRunError(409, 'Observed framework stop precedes its accepted startup')
      interval = frameworkHistoryEntrySchema.parse({...interval, endedAt: frameworkStopSchema.parse(unresolvedStop).observedAt, endReason: 'observed-stop'})
    }
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
          ...(interval?{frameworkAcceptedIdentity:acceptedIdentity(interval)}:{}),
          ...(unresolvedStop?{frameworkCurrentStop:unresolvedStop}:{}),
          frameworkUnacceptedStops:unaccepted,
        },
        $unset: {frameworkHistory: '',...(interval||unresolvedStop?{frameworkStopReceipts:''}:{})},
      },
      {new: true, strict: false, writeConcern: testWriteConcern},
    ).select({deploymentGeneration: 1, deploymentSequence: 1}).lean()
    if (!saved) return undefined
    if (stop) void this.history.debug({hostId, incarnationGeneration: current.incarnationGeneration,
      sequence: current.sequence, receivedAt: new Date(this.now()), payload: {frameworkStopReceipts: [stop],
        ...(interval?.endedAt&&sameStoppedProcess(stop,interval.binding.installationId,interval.process)?{frameworkHistory:[interval]}:{})}})
      .catch(error => logger.warn({hostId, error}, 'Host stop debug history delivery failed'))
    return {hostId, generation: saved.deploymentGeneration ?? 0, sequence: saved.deploymentSequence ?? 0}
  }
}
