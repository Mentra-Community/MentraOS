import {z} from 'zod'
import {recorderHostReservationSchema, type RecorderHostReservation} from './recorder-storage.types'

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

export const exclusiveResourceOwnerSchema = z.object({id: identity, kind: z.enum(['run', 'authoring', 'boundary-cleanup', 'fixer'])}).strict()
export const exclusiveResourceIntentSchema = z.object({operationId: identity, hostId: identity, laneId: identity,
  controller,
  owner: exclusiveResourceOwnerSchema, inputSha256: hash,
  resources: z.array(z.object({id: identity, capabilities: z.array(identity).max(30)}).strict()).min(1).max(9),
}).strict().superRefine((value, context) => {
  if (new Set(value.resources.map(resource => resource.id)).size !== value.resources.length ||
    value.resources.some(resource => new Set(resource.capabilities).size !== resource.capabilities.length))
    context.addIssue({code: 'custom', message: 'Reservation intent resources and capabilities must be unique'})
})
export type ExclusiveResourceIntent = z.infer<typeof exclusiveResourceIntentSchema>
export const exclusiveResourceObservationInputSchema = z.object({intent: exclusiveResourceIntentSchema,
  controller}).strict()

/** Stored beside recorder claims on the existing host row; the intent is immutable. */
export const exclusiveHostReservationSchema = z.object({kind: z.literal('exclusive'), id: z.string().uuid(),
  resourceId: identity, authorityHostId: identity, borrowerHostId: identity, laneId: identity,
  operationId: identity, intentSha256: hash, inputSha256: hash, owner: exclusiveResourceOwnerSchema,
  controllerIncarnation: identity, controllerGeneration: z.number().int().positive().safe(),
  borrowerSequence: z.number().int().nonnegative().safe(), reservedAt: z.string().datetime(),
}).strict()
export type ExclusiveHostReservation = z.infer<typeof exclusiveHostReservationSchema>
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
export const exclusiveResourceReturnSchema = z.object({claimId: z.string().uuid(), authorityHostId: identity,
  resourceId: identity, intentSha256: hash, inputSha256: hash, originalOwner: exclusiveResourceOwnerSchema,
  release: z.object({eventId: identity, owner: exclusiveResourceOwnerSchema.extend({generation: z.number().int().positive().safe()}),
    releasedAt: z.string().datetime(),
    lineage: z.array(exclusiveResourceOwnerSchema.extend({generation: z.number().int().positive().safe()})).min(1).max(100),
    neverStarted: z.object({requestId: identity, reason: z.literal('cancelled-before-allocation')}).strict().optional(),
  }).strict(),
  controller: z.object({incarnation: identity, generation: z.number().int().positive().safe(),
    sequence: z.number().int().nonnegative().safe()}).strict(), laneId: identity,
}).strict()
export type ExclusiveResourceReturn = z.infer<typeof exclusiveResourceReturnSchema>

/** Bounded projection of the existing local claim/normal-release journal, not another owner store. */
export const resourceReservationObservationSchema = z.object({
  claims: z.array(exclusiveHostReservationSchema).max(100),
  returns: z.array(exclusiveResourceReturnSchema.omit({controller: true})).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.claims.map(claim => claim.id)).size !== value.claims.length ||
    new Set(value.returns.map(receipt => receipt.claimId)).size !== value.returns.length)
    context.addIssue({code: 'custom', message: 'Claim and return observations require unique claim identities'})
})
