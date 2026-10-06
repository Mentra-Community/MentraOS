import {z} from "zod"
import {frameworkIdentitySchema} from "./framework-request.types"
import {frameworkBindingSchema, type FrameworkBinding} from "./framework-version.types"

export const frameworkProcessSchema = z
  .object({pid: z.number().int().positive(), startedAt: z.string().min(1).max(240)})
  .strict()
export const frameworkDeploymentSchema = z
  .object({
    phase: z.enum(["idle", "staging", "waiting", "activating", "failed"]),
    observedAt: z.string().datetime({offset: true}),
    desiredTarget: frameworkBindingSchema.optional(),
    activeTarget: frameworkBindingSchema.optional(),
    operationId: frameworkIdentitySchema.optional(),
    phaseStartedAt: z.string().datetime({offset: true}).optional(),
    deadline: z.string().datetime({offset: true}).optional(),
    consumers: z
      .array(
        z
          .object({id: frameworkIdentitySchema, kind: z.string().min(1).max(100), reason: z.string().min(1).max(2000)})
          .strict(),
      )
      .max(100),
    reason: z.string().max(4000).optional(),
    nextAction: z.string().min(1).max(4000),
  })
  .strict()
export const frameworkHistoryEntrySchema = z
  .object({
    binding: frameworkBindingSchema,
    incarnation: frameworkIdentitySchema,
    incarnationGeneration: z.number().int().positive().safe(),
    process: frameworkProcessSchema,
    effectiveAt: z.string().datetime({offset: true}),
    observedAt: z.string().datetime({offset: true}),
    endedAt: z.string().datetime({offset: true}).optional(),
    endReason: z.enum(["observed-stop", "accepted-replacement"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.endedAt === undefined) !== (value.endReason === undefined) ||
      (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.effectiveAt))
    )
      ctx.addIssue({code: "custom", message: "Framework interval requires an ordered observed ending and reason"})
  })
export type FrameworkDeployment = z.infer<typeof frameworkDeploymentSchema>
export type FrameworkHistoryEntry = z.infer<typeof frameworkHistoryEntrySchema>

const identity = frameworkIdentitySchema.nullable()
const timestamp = z.string().datetime({offset: true}).nullable()
/** Read projection of controller records. A report's resume intention is not a scheduling receipt. */
export const laneRestorationAttemptSchema = z
  .object({
    executionId: frameworkIdentitySchema,
    interruptionId: frameworkIdentitySchema,
    laneId: frameworkIdentitySchema,
    generation: z.number().int().nonnegative().safe().nullable(),
    current: z.boolean(),
    state: z.enum(["awaiting-fixer", "working", "needs-input", "stopped", "halted", "resumed", "unknown"]),
    assignedAt: timestamp,
    handedOffAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    report: z
      .object({
        reportId: frameworkIdentitySchema,
        reportedAt: z.string().datetime({offset: true}),
        decision: z.enum(["working", "needs-input", "halt", "unexpected-exit", "resume"]),
        summary: z.string().min(1).max(4000),
        question: z.string().max(4000).nullable(),
      })
      .strict()
      .nullable(),
    resume: z
      .object({
        status: z.enum(["accepted", "refused", "unknown"]),
        decisionId: identity,
        calledAt: timestamp,
        reason: z.string().max(2000).nullable(),
      })
      .strict(),
    requiredAction: z.string().max(4000).nullable(),
    actions: z
      .array(
        z
          .object({
            operationId: frameworkIdentitySchema,
            resourceId: identity,
            action: z.literal("cleanup"),
            state: z.enum(["intended", "active", "unknown", "settled"]),
          })
          .strict(),
      )
      .max(20),
    actionsTruncated: z.boolean(),
    requestId: identity,
    runId: identity,
    incidentId: z
      .string()
      .regex(/^rep_[A-Z0-9]{26}$/)
      .nullable(),
    sessionId: identity,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.resume.status !== "unknown" && (!attempt.resume.decisionId || !attempt.resume.calledAt))
      ctx.addIssue({code: "custom", message: "Resume outcome requires its recorded decision and call time"})
    if (attempt.state === "resumed" && attempt.resume.status !== "accepted")
      ctx.addIssue({code: "custom", message: "Resumed attempt requires the controller's accepted resume receipt"})
    const start = attempt.startedAt
    if (start && attempt.finishedAt && Date.parse(attempt.finishedAt) < Date.parse(start))
      ctx.addIssue({code: "custom", message: "Restoration finish precedes its recorded start"})
  })
export const laneRestorationProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    attempts: z.array(laneRestorationAttemptSchema).max(100),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((projection, ctx) => {
    if (new Set(projection.attempts.map((row) => row.executionId)).size !== projection.attempts.length)
      ctx.addIssue({code: "custom", message: "Duplicate restoration execution identity"})
  })
export type LaneRestorationAttempt = z.infer<typeof laneRestorationAttemptSchema>
export type LaneRestorationProjection = z.infer<typeof laneRestorationProjectionSchema>
export type LaneRestorationHost = {
  hostId: string
  receivedAt: string
  observedAt: string
  lanes: Array<{id: string; platform: "android" | "ios-on-mac"; state: string; dispatchMode: string}>
  restoration: LaneRestorationProjection | null
  frameworkBinding?: FrameworkBinding
  frameworkAcceptedAt?: string
  frameworkHistory?: FrameworkHistoryEntry[]
  deployment?: FrameworkDeployment
  deploymentReceivedAt?: string
}
export type LaneRestorationList = {
  generatedAt: string
  freshForMs: number
  hosts: LaneRestorationHost[]
  truncated: boolean
}

export function restorationHostIsFresh(
  host: Pick<LaneRestorationHost, "observedAt" | "receivedAt">,
  now: number,
  freshForMs: number,
) {
  const observed = Date.parse(host.observedAt),
    received = Date.parse(host.receivedAt)
  return (
    Number.isFinite(now) &&
    Number.isFinite(freshForMs) &&
    freshForMs > 0 &&
    Number.isFinite(observed) &&
    Number.isFinite(received) &&
    observed <= now + 5_000 &&
    received <= now + 5_000 &&
    now - observed <= freshForMs &&
    now - received <= freshForMs
  )
}
