import {z} from "zod";
import {frameworkIdentitySchema} from "./framework-request.types";
import {routineIdentitySchema, routinePlatformSchema} from "./routine-definition.types";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
/** A summary is derived from a fully validated frozen result, never a second verdict. */
export const frameworkRunSummaryProjectionSchema = z.object({
  version: z.literal(1), payloadSha256: digest, summarySha256: digest, definitionRevision: sha, recordingAssetId: z.string().optional(),
  summary: z.object({runId: frameworkIdentitySchema, requestId: frameworkIdentitySchema,
    hostId: frameworkIdentitySchema, routineId: routineIdentitySchema, platform: routinePlatformSchema, laneId: frameworkIdentitySchema,
    startedAt: z.string().datetime({offset: true}), finishedAt: z.string().datetime({offset: true}),
    outcome: z.enum(["setup-failed", "failed", "cancelled", "teardown-failed", "pass", "not-run"]),
    evidenceStatus: z.enum(["complete", "failed"]),
    build: z.object({repository: z.string().regex(/^[\w-]+\/[\w.-]+$/), channel: z.enum(["dev", "staging", "pr", "local"]),
      headSha: sha, prNumber: z.number().int().positive().optional(), release: z.string().optional(), producerUrl: z.string().optional()}).strict(),
  }).strict(),
}).strict().superRefine((projection, ctx) => {
  if (projection.summary.runId !== projection.summary.requestId
    || Date.parse(projection.summary.finishedAt) < Date.parse(projection.summary.startedAt))
    ctx.addIssue({code: "custom", message: "Summary identity or timing is unavailable"});
});
export type FrameworkRunSummaryProjection = z.infer<typeof frameworkRunSummaryProjectionSchema>;
