import {z} from 'zod'

const identity = z.string().min(1).max(240)
export const laneControlCommandSchema = z.object({
  operationId: z.string().uuid(), hostId: identity, laneId: identity,
  operatorId: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive().safe(),
  action: z.enum(['pause', 'resume', 'reserve', 'release', 'reopen-repair']),
  purpose: z.string().trim().min(1).max(200).optional(),
  reservation: z.object({id: identity, generation: z.number().int().nonnegative().safe()}).strict().optional(),
  repair: z.object({interruptionId: identity, expectedHaltDecisionId: identity,
    changedConditions: z.string().trim().min(1).max(4000)}).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === 'reserve') !== (value.purpose !== undefined) ||
      (value.action === 'release') !== (value.reservation !== undefined) ||
      (value.action === 'reopen-repair') !== (value.repair !== undefined))
    ctx.addIssue({code: 'custom', message: 'Lane control arguments must match their action'})
})
export type LaneControlCommand = z.infer<typeof laneControlCommandSchema>
export const laneControlReservationSchema = z.object({
  id: identity, laneId: identity, generation: z.number().int().nonnegative().safe(),
  state: z.enum(['waiting', 'granted', 'returning', 'released', 'cancelled']),
  purpose: z.string().min(1).max(200), requestedAt: z.string(),
  grantedAt: z.string().optional(), returnedAt: z.string().optional(), reason: z.string().max(2000).optional(),
}).strict()
export const laneControlReceiptSchema = z.object({
  operationId: z.string().uuid(), inputSha256: z.string().regex(/^[a-f0-9]{64}$/), hostId: identity, laneId: identity,
  completedAt: z.string().datetime({offset: true}),
  result: z.discriminatedUnion('status', [
    z.object({status: z.literal('accepted'), mode: z.enum(['automatic', 'authoring', 'paused']).optional(),
      reservation: laneControlReservationSchema.optional(),
      repair: z.object({interruptionId: identity, laneId: identity, status: z.literal('in-repair'),
        generation: z.number().int().nonnegative().safe(), fixerExecutionId: identity}).strict().optional()}).strict(),
    z.object({status: z.literal('refused'), code: identity, reason: z.string().min(1).max(2000)}).strict(),
  ]),
}).strict()
export type LaneControlReceipt = z.infer<typeof laneControlReceiptSchema>

export const laneControlInputSchema = z.object({operationId: z.string().uuid(), hostId: identity, laneId: identity,
  expiresAt: z.number().int().positive().safe(),
  action: z.enum(['pause', 'resume', 'reserve', 'release', 'reopen-repair']), purpose: z.string().trim().min(1).max(200).optional(),
  reservation: z.object({id: identity, generation: z.number().int().nonnegative().safe()}).strict().optional(),
  repair: z.object({interruptionId: identity, expectedHaltDecisionId: identity,
    changedConditions: z.string().trim().min(1).max(4000)}).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === 'reserve') !== (value.purpose !== undefined) ||
      (value.action === 'release') !== (value.reservation !== undefined) ||
      (value.action === 'reopen-repair') !== (value.repair !== undefined))
    ctx.addIssue({code: 'custom', message: 'Lane control arguments must match their action'})
})
export const laneControlRecordSchema = z.object({command: laneControlCommandSchema,
  receipt: laneControlReceiptSchema.optional(), operatorLabel: z.string().min(1).max(320).optional()}).strict()
export type LaneControlRecord = z.infer<typeof laneControlRecordSchema>
export type LaneControlInput = z.infer<typeof laneControlInputSchema>
export type LaneControlView = {operationId: string; hostId: string; laneId: string; action: LaneControlInput['action'];
  expiresAt: number; receipt?: LaneControlReceipt}
export type LaneControlsView = {enabled: boolean; reopenRepair?: boolean; fresh: boolean; observedAt: string; controls: LaneControlView[]}

const resourceSubject = z.object({resourceId: identity, subjectGeneration: z.number().int().nonnegative().safe()}).strict()
export const resourceControlInputSchema = z.object({operationId: z.string().uuid(), hostId: identity, subject: resourceSubject,
  expiresAt: z.number().int().positive().safe(), action: z.enum(['reserve', 'release', 'check', 'mark-out-of-service']),
  purpose: z.string().trim().min(1).max(200).optional(), reason: z.string().trim().min(1).max(2000).optional(),
  reservation: z.object({id: identity, generation: z.number().int().nonnegative().safe()}).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === 'reserve') !== (value.purpose !== undefined) ||
    (value.action === 'release') !== (value.reservation !== undefined) ||
    (value.action === 'mark-out-of-service') !== (value.reason !== undefined))
    ctx.addIssue({code: 'custom', message: 'Resource control arguments must match their action'})
})
export type ResourceControlInput = z.infer<typeof resourceControlInputSchema>
export const resourceControlCommandSchema = resourceControlInputSchema.innerType().extend({operatorId: z.string().regex(/^[a-f0-9]{64}$/)})
  .strict().superRefine((value, ctx) => {
    if ((value.action === 'reserve') !== (value.purpose !== undefined) ||
      (value.action === 'release') !== (value.reservation !== undefined) ||
      (value.action === 'mark-out-of-service') !== (value.reason !== undefined))
      ctx.addIssue({code: 'custom', message: 'Resource control arguments must match their action'})
  })
export type ResourceControlCommand = z.infer<typeof resourceControlCommandSchema>
export const resourceControlReservationSchema = z.object({id: identity, resourceId: identity,
  generation: z.number().int().nonnegative().safe(), state: z.enum(['waiting', 'granted', 'returning', 'released', 'cancelled']),
  purpose: z.string().min(1).max(200), requestedAt: z.string().datetime({offset: true}),
  grantedAt: z.string().datetime({offset: true}).optional(), returnedAt: z.string().datetime({offset: true}).optional(),
  reason: z.string().max(2000).optional(),
}).strict()
export const resourceControlReceiptSchema = z.object({operationId: z.string().uuid(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), hostId: identity, subject: resourceSubject,
  completedAt: z.string().datetime({offset: true}), result: z.discriminatedUnion('status', [
    z.object({status: z.literal('accepted'), reservation: resourceControlReservationSchema.optional(),
      check: z.object({operationId: identity, resourceId: identity, generation: z.number().int().nonnegative().safe(),
        state: z.enum(['intended', 'active', 'settled', 'unknown'])}).strict().optional(),
      resource: z.object({resourceId: identity, generation: z.number().int().nonnegative().safe(), status: z.literal('out-of-service')}).strict().optional(),
    }).strict(),
    z.object({status: z.literal('refused'), code: identity, reason: z.string().min(1).max(2000)}).strict(),
  ]),
}).strict()
export type ResourceControlReceipt = z.infer<typeof resourceControlReceiptSchema>
export const resourceControlRecordSchema = z.object({command: resourceControlCommandSchema,
  receipt: resourceControlReceiptSchema.optional(), operatorLabel: z.string().min(1).max(320).optional(),
  reservationGenerationConstraint: z.number().int().positive().safe().optional(),
  restoredBy: z.object({hostId: identity, resourceId: identity, operationId: identity,
    subjectGeneration: z.number().int().nonnegative().safe(), resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedAt: z.string().datetime({offset: true})}).strict().optional()}).strict()
export type ResourceControlRecord = z.infer<typeof resourceControlRecordSchema>
export type ResourceControlView = {operationId: string; hostId: string; subject: ResourceControlInput['subject'];
  action: ResourceControlInput['action']; expiresAt: number; receipt?: ResourceControlReceipt; reservationGenerationConstraint?: number}
export type ResourceControlsView = {enabled: boolean; fresh: boolean; observedAt: string;
  subject: ResourceControlInput['subject']; controls: ResourceControlView[]}

export const laneControlExchangeSchema = z.object({schemaVersion: z.literal(1),
  receipts: z.array(z.union([laneControlReceiptSchema, resourceControlReceiptSchema])).max(100),
  reopenRepair: z.literal(true).optional(), resourceControls: z.literal(true).optional()}).strict()
