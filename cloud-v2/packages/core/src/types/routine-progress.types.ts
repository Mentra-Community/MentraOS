import {z} from 'zod'
import {frameworkIdentitySchema} from './framework-request.types'
import {routineIdentitySchema} from './routine-definition.types'

/** Display-only observation from the controller already holding this request. */
export const routineProgressSchema = z.object({
  requestId: frameworkIdentitySchema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ownerGeneration: z.number().int().nonnegative().safe(),
  controllerIncarnation: frameworkIdentitySchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: z.enum(['preparation', 'framework-setup', 'routine-setup', 'test', 'routine-teardown', 'framework-teardown', 'publication']),
  currentStep: z.object({id: routineIdentitySchema, index: z.number().int().nonnegative().max(999)}).strict().optional(),
  completedSteps: z.number().int().nonnegative().max(1000),
  totalSteps: z.number().int().nonnegative().max(1000),
  startedAt: z.string().datetime({offset: true}),
  lastProgressAt: z.string().datetime({offset: true}),
  observedAt: z.string().datetime({offset: true}),
}).strict().superRefine((value, ctx) => {
  if (value.completedSteps > value.totalSteps || value.currentStep &&
      (value.phase !== 'test' || value.currentStep.index >= value.totalSteps) ||
      Date.parse(value.startedAt) > Date.parse(value.lastProgressAt) ||
      Date.parse(value.lastProgressAt) > Date.parse(value.observedAt))
    ctx.addIssue({code: 'custom', message: 'Routine observation counts or timestamps are inconsistent'})
})
export type RoutineProgress = z.infer<typeof routineProgressSchema>
