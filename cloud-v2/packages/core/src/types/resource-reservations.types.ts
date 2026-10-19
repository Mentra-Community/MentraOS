import {z} from 'zod'
import {recorderHostReservationSchema, type RecorderHostReservation} from './recorder-storage.types'
import {frameworkBindingSchema} from './framework-version.types'

const identity = z.string().min(1).max(240)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const controller = z.object({incarnation: identity, generation: z.number().int().positive().safe(),
  sequence: z.number().int().nonnegative().safe()}).strict()
/** A scarce dependency of an existing provider, not a new provider or credential store. */
export const exclusiveResourceDependencySchema = z.object({resourceId: identity, authorityHostId: identity,
  capability: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/)}).strict()
export const exclusiveResourceDependenciesSchema = z.array(exclusiveResourceDependencySchema).min(1).max(30)
  .refine(values => new Set(values.map(value => value.resourceId)).size === values.length,
    'Exclusive dependencies must have unique canonical resource identities')
export type ExclusiveResourceDependency = z.infer<typeof exclusiveResourceDependencySchema>

/** Existing durable operator dispatch receipt, projected only by its current controller. */
export const localResourceDispatchSchema = z.object({requestId: identity, inputSha256: hash, definitionSha256: hash}).strict()
export const exclusiveResourceOwnerSchema = z.object({id: identity, kind: z.enum(['run', 'authoring', 'boundary-cleanup', 'fixer'])}).strict()
export const backendPrerequisiteIntentSchema = z.object({kind: z.literal('backend-connectivity'), jobId: identity,
  targetInputSha256: hash, resourceId: identity, binding: frameworkBindingSchema,
  preparing: z.object({dispatchIntentSha256: hash, fleetInputSha256: hash, bindingSha256: hash, admissionSha256: hash, reservationSha256: hash}).strict()}).strict()
export const exclusiveResourceIntentSchema = z.object({operationId: identity, hostId: identity, laneId: identity,
  controller,
  owner: exclusiveResourceOwnerSchema, inputSha256: hash,
  localDispatch: localResourceDispatchSchema.optional(),
  prerequisite: backendPrerequisiteIntentSchema.optional(),
  resources: z.array(z.object({id: identity, capabilities: z.array(identity).max(30)}).strict()).min(1).max(9),
}).strict().superRefine((value, context) => {
  if (new Set(value.resources.map(resource => resource.id)).size !== value.resources.length ||
    value.resources.some(resource => new Set(resource.capabilities).size !== resource.capabilities.length))
    context.addIssue({code: 'custom', message: 'Reservation intent resources and capabilities must be unique'})
  if (value.prerequisite && (value.owner.kind !== 'boundary-cleanup' || value.localDispatch ||
    value.inputSha256 !== value.prerequisite.targetInputSha256 || value.resources.length !== 1 ||
    value.resources[0]!.id !== value.prerequisite.resourceId || value.resources[0]!.capabilities.length !== 1 ||
    value.resources[0]!.capabilities[0] !== 'backend-connectivity'))
    context.addIssue({code: 'custom', message: 'Backend prerequisite requires one phone check and its original target input'})
})
export type ExclusiveResourceIntent = z.infer<typeof exclusiveResourceIntentSchema>
/** One immutable candidate on the existing request, including a deliberate empty dependency selection. */
export const fleetResourceAdmissionSchema = z.object({intent: exclusiveResourceIntentSchema,
  dependencies: z.array(exclusiveResourceDependencySchema).max(30)}).strict().superRefine((value, context) => {
  if (value.intent.prerequisite || value.intent.owner.kind !== 'run' || value.intent.operationId !== `run:${value.intent.owner.id}` ||
    new Set(value.dependencies.map(dependency => dependency.resourceId)).size !== value.dependencies.length ||
    new Set(value.dependencies.map(dependency => dependency.authorityHostId)).size > 1)
    context.addIssue({code: 'custom', message: 'Fleet admission requires one original run and canonical resource authority'})
})
export type FleetResourceAdmission = z.infer<typeof fleetResourceAdmissionSchema>
export const exclusiveResourceObservationInputSchema = z.object({intent: exclusiveResourceIntentSchema,
  controller}).strict()

/** Stored beside recorder claims on the existing host row; the intent is immutable. */
export const exclusiveHostReservationSchema = z.object({kind: z.literal('exclusive'), id: z.string().uuid(),
  resourceId: identity, authorityHostId: identity, borrowerHostId: identity, laneId: identity,
  operationId: identity, intentSha256: hash, inputSha256: hash, owner: exclusiveResourceOwnerSchema,
  controllerIncarnation: identity, controllerGeneration: z.number().int().positive().safe(),
  borrowerSequence: z.number().int().nonnegative().safe(), reservedAt: z.string().datetime(),
  origin: z.object({kind: z.literal('fleet'), fleetInputSha256: hash}).strict().optional(),
  prerequisite: backendPrerequisiteIntentSchema.optional(),
}).strict().refine(value => !value.prerequisite || !value.origin && value.owner.kind === 'boundary-cleanup' &&
  value.prerequisite.resourceId === value.resourceId && value.prerequisite.targetInputSha256 === value.inputSha256 &&
  value.authorityHostId === value.borrowerHostId, 'Prerequisite claim requires its original phone resource and host authority')
export type ExclusiveHostReservation = z.infer<typeof exclusiveHostReservationSchema>
export const fleetExclusiveReservationSchema = z.object({origin: z.object({kind: z.literal('fleet'), fleetInputSha256: hash}).strict(),
  intent: exclusiveResourceIntentSchema, intentSha256: hash, claims: z.array(exclusiveHostReservationSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
  if (value.intent.prerequisite || value.intent.inputSha256 !== value.origin.fleetInputSha256 || value.intent.owner.kind !== 'run' ||
    value.intent.operationId !== `run:${value.intent.owner.id}` || value.claims.some(claim => claim.prerequisite || !claim.origin ||
      claim.origin.fleetInputSha256 !== value.origin.fleetInputSha256 || claim.inputSha256 !== value.origin.fleetInputSha256 ||
      claim.intentSha256 !== value.intentSha256 || claim.operationId !== value.intent.operationId || claim.borrowerHostId !== value.intent.hostId ||
      claim.laneId !== value.intent.laneId || claim.owner.id !== value.intent.owner.id || claim.owner.kind !== value.intent.owner.kind ||
      claim.controllerIncarnation !== value.intent.controller.incarnation || claim.controllerGeneration !== value.intent.controller.generation ||
      claim.borrowerSequence !== value.intent.controller.sequence) ||
    new Set(value.claims.map(claim => claim.resourceId)).size !== value.claims.length)
    context.addIssue({code: 'custom', message: 'Portable exclusive receipt must preserve one original run and source identity'})
})
export const fleetExclusiveExecutionBindingSchema = z.object({reservationSha256: hash, dispatchIntentSha256: hash,
  executionInputSha256: hash}).strict()
export const fleetExclusiveDeliverySchema = z.object({reservation: fleetExclusiveReservationSchema,
  binding: fleetExclusiveExecutionBindingSchema}).strict()
export const fleetExclusiveObservationSchema = z.object({fleetExclusive: fleetExclusiveDeliverySchema, controller}).strict()
export type FleetExclusiveReservation = z.infer<typeof fleetExclusiveReservationSchema>
export type FleetExclusiveExecutionBinding = z.infer<typeof fleetExclusiveExecutionBindingSchema>
/** The same CAS authority carries byte claims and exclusive claims without discarding either. */
export const hostResourceReservationsSchema = z.array(z.union([recorderHostReservationSchema, exclusiveHostReservationSchema]))
  .max(1000).superRefine((values, context) => {
    const recorders = values.filter((value): value is RecorderHostReservation => !('kind' in value)),
      exclusive = values.filter((value): value is ExclusiveHostReservation => 'kind' in value)
    if (new Set(recorders.map(value => value.requestId)).size !== recorders.length ||
      new Set(exclusive.map(value => value.resourceId)).size !== exclusive.length)
      context.addIssue({code: 'custom', message: 'Host resource claims require unique request or exclusive resource identities'})
  })
export type HostResourceReservation = z.infer<typeof hostResourceReservationsSchema>[number]
export const isExclusiveHostReservation = (value: HostResourceReservation): value is ExclusiveHostReservation => 'kind' in value

/** Return proof is emitted only by the existing successful local release transaction. */
const normalLaneReleaseSchema = z.object({eventId: identity, owner: exclusiveResourceOwnerSchema.extend({generation: z.number().int().positive().safe()}),
  releasedAt: z.string().datetime(),
  lineage: z.array(exclusiveResourceOwnerSchema.extend({generation: z.number().int().positive().safe()})).min(1).max(100),
  neverStarted: z.object({requestId: identity, reason: z.literal('cancelled-before-allocation')}).strict().optional(),
}).strict()
export const resourceCheckReleaseSchema = z.object({kind: z.literal('resource-check'), operationId: identity,
  subjectGeneration: z.number().int().nonnegative().safe(), releasedAt: z.string().datetime({offset: true}), eventId: identity}).strict()
export const exclusiveResourceReturnSchema = z.object({claimId: z.string().uuid(), authorityHostId: identity,
  resourceId: identity, intentSha256: hash, inputSha256: hash, originalOwner: exclusiveResourceOwnerSchema,
  release: z.union([normalLaneReleaseSchema, resourceCheckReleaseSchema]),
  controller: z.object({incarnation: identity, generation: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe()}).strict(), laneId: identity,
}).strict()
export type ExclusiveResourceReturn = z.infer<typeof exclusiveResourceReturnSchema>
const observedResourceReturnSchema = z.object({claimId: exclusiveResourceReturnSchema.shape.claimId,
  authorityHostId: identity, resourceId: identity, intentSha256: hash, inputSha256: hash,
  originalOwner: exclusiveResourceOwnerSchema, release: exclusiveResourceReturnSchema.shape.release, laneId: identity}).strict()

/** Bounded projection of the existing local claim/normal-release journal, not another owner store. */
export const resourceReservationObservationSchema = z.object({
  claims: z.array(exclusiveHostReservationSchema).max(100),
  returns: z.array(observedResourceReturnSchema).max(100),
  dispatches: z.array(localResourceDispatchSchema).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.claims.map(claim => claim.id)).size !== value.claims.length ||
    new Set(value.returns.map(receipt => receipt.claimId)).size !== value.returns.length ||
    new Set(value.dispatches?.map(dispatch => dispatch.requestId)).size !== (value.dispatches?.length ?? 0))
    context.addIssue({code: 'custom', message: 'Claim, return and dispatch observations require unique identities'})
})
