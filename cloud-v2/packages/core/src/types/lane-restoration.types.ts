import {z} from "zod";
import {frameworkIdentitySchema} from "./framework-request.types";

const identity = frameworkIdentitySchema.nullable();
const timestamp = z.string().datetime({offset: true}).nullable();
/** Read projection of controller records. A report's resume intention is not a scheduling receipt. */
export const laneRestorationAttemptSchema = z.object({
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
  report: z.object({reportId: frameworkIdentitySchema, reportedAt: z.string().datetime({offset: true}),
    decision: z.enum(["working", "needs-input", "halt", "unexpected-exit", "resume"]),
    summary: z.string().min(1).max(4000), question: z.string().max(4000).nullable()}).strict().nullable(),
  resume: z.object({status: z.enum(["accepted", "refused", "unknown"]), decisionId: identity,
    calledAt: timestamp, reason: z.string().max(2000).nullable()}).strict(),
  requiredAction: z.string().max(4000).nullable(),
  actions: z.array(z.object({operationId: frameworkIdentitySchema, resourceId: identity,
    action: z.literal("cleanup"), state: z.enum(["intended", "active", "unknown", "settled"])}).strict()).max(20),
  actionsTruncated: z.boolean(),
  requestId: identity,
  runId: identity,
  incidentId: z.string().regex(/^rep_[A-Z0-9]{26}$/).nullable(),
  sessionId: identity,
}).strict().superRefine((attempt, ctx) => {
  if (attempt.resume.status !== "unknown" && (!attempt.resume.decisionId || !attempt.resume.calledAt))
    ctx.addIssue({code: "custom", message: "Resume outcome requires its recorded decision and call time"});
  if (attempt.state === "resumed" && attempt.resume.status !== "accepted")
    ctx.addIssue({code: "custom", message: "Resumed attempt requires the controller's accepted resume receipt"});
  const start = attempt.startedAt;
  if (start && attempt.finishedAt && Date.parse(attempt.finishedAt) < Date.parse(start))
    ctx.addIssue({code: "custom", message: "Restoration finish precedes its recorded start"});
});
export const laneRestorationProjectionSchema = z.object({schemaVersion: z.literal(1),
  attempts: z.array(laneRestorationAttemptSchema).max(100), truncated: z.boolean()}).strict()
  .superRefine((projection, ctx) => {
    if (new Set(projection.attempts.map(row => row.executionId)).size !== projection.attempts.length)
      ctx.addIssue({code: "custom", message: "Duplicate restoration execution identity"});
  });
export type LaneRestorationAttempt = z.infer<typeof laneRestorationAttemptSchema>;
export type LaneRestorationProjection = z.infer<typeof laneRestorationProjectionSchema>;
export type LaneRestorationHost = {
  hostId: string; receivedAt: string; observedAt: string;
  lanes: Array<{id: string; platform: "android" | "ios-on-mac"; state: string; dispatchMode: string}>;
  restoration: LaneRestorationProjection | null;
};
export type LaneRestorationList = {generatedAt: string; freshForMs: number; hosts: LaneRestorationHost[]; truncated: boolean};
