import {frameworkBindingSchema, routineSourceRefSchema} from './framework-version.types';
import {z} from "zod";
import {frameworkIdentitySchema} from "./framework-request.types";
import {routineIdentitySchema, routinePlatformSchema} from "./routine-definition.types";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
/** A summary is derived from a fully validated frozen result, never a second verdict. */
const frozenSummarySchema = z.object({
  runId: frameworkIdentitySchema, requestId: frameworkIdentitySchema,
  hostId: frameworkIdentitySchema, routineId: routineIdentitySchema, platform: routinePlatformSchema, laneId: frameworkIdentitySchema,
  routineSource: routineSourceRefSchema, frameworkBinding: frameworkBindingSchema,
  startedAt: z.string().datetime({offset: true}), finishedAt: z.string().datetime({offset: true}),
  outcome: z.enum(["setup-failed", "failed", "cancelled", "teardown-failed", "pass", "not-run"]),
  evidenceStatus: z.enum(["complete", "failed"]),
  stepCounts: z.object({passed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative()}).strict().refine(counts => counts.passed + counts.skipped <= counts.total).optional(),
  build: z.object({repository: z.string().regex(/^[\w-]+\/[\w.-]+$/), channel: z.enum(["dev", "staging", "pr", "local"]),
    headSha: sha, prNumber: z.number().int().positive().optional(), release: z.string().optional(), producerUrl: z.string().optional()}).strict(),
}).strict();
const frozenProjectionSchema = z.object({
  version: z.literal(1), payloadSha256: digest, summarySha256: digest, definitionRevision: sha, recordingAssetId: z.string().optional(),
  summary: frozenSummarySchema,
}).strict();
const recordedProjectionSchema = frozenProjectionSchema.extend({summary: frozenSummarySchema.extend({
  routineSource: routineSourceRefSchema.optional(), frameworkBinding: frameworkBindingSchema.optional(),
})});
function validateFrozenSummary(projection: z.infer<typeof recordedProjectionSchema>, ctx: z.RefinementCtx) {
  if (projection.summary.runId !== projection.summary.requestId
    || Date.parse(projection.summary.finishedAt) < Date.parse(projection.summary.startedAt))
    ctx.addIssue({code: "custom", message: "Summary identity or timing is unavailable"});
}
export const frameworkRunSummaryProjectionSchema = frozenProjectionSchema.superRefine(validateFrozenSummary);
/** Read existing frozen summaries without rewriting their provenance or summary digest. */
export const recordedFrameworkRunSummaryProjectionSchema = recordedProjectionSchema.superRefine(validateFrozenSummary);
export type FrameworkRunSummaryProjection = z.infer<typeof frameworkRunSummaryProjectionSchema>;
export type RecordedFrameworkRunSummaryProjection = z.infer<typeof recordedFrameworkRunSummaryProjectionSchema>;
