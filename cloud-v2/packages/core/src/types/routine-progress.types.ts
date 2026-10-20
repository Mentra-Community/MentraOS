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

/** Both GitHub checks and Admin details observe the same accepted controller owner. */
export function matchingRoutineProgress(host: {incarnation: string; sequence: number},
  lane: {activity?: {owner: {kind: string; id: string}; generation: number}; progress?: RoutineProgress},
  request: {requestId: string; inputSha256?: string}, stepIds: readonly string[]): RoutineProgress | undefined {
  const progress = lane.progress
  if (progress && lane.activity?.owner.kind === 'run' && lane.activity.owner.id === request.requestId &&
      progress.requestId === request.requestId && progress.requestDigest === request.inputSha256 &&
      progress.ownerGeneration === lane.activity.generation && progress.controllerIncarnation === host.incarnation &&
      progress.sequence === host.sequence && (progress.totalSteps === stepIds.length || progress.phase === 'preparation' && progress.totalSteps === 0) &&
      (!progress.currentStep || stepIds[progress.currentStep.index] === progress.currentStep.id)) return progress
  return undefined
}

export interface RoutineLiveProgress {
  progress: RoutineProgress
  receivedAt: string
  observationAgeMs: number
  title: string
  steps: Array<{id: string; instruction: string}>
}

/** An accepted request blocked before execution is distinct from running progress. */
export const routineQueuedBlockSchema = z.object({requestId: frameworkIdentitySchema, requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedAt: z.string().datetime({offset: true}), observedAt: z.string().datetime({offset: true}),
  code: z.literal('storage-capacity'), reason: z.string().min(1).max(2000)}).strict()
export type RoutineQueuedBlock = z.infer<typeof routineQueuedBlockSchema>
