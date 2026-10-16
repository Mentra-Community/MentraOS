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
