import { z } from "zod";
import { testFailureOccurrenceIdSchema } from "./test-failure.types";
import { testDispatchInputSchema, testRoutineIdSchema } from "./test-dispatch.types";

export const continuationCandidateSchema = z.object({
  repository: z.enum(["Mentra-Community/MentraOS", "Mentra-Community/Mentra-Automated-Testing"]),
  pullRequest: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
/**
 * Same-case adoption of a shared, reviewed harness candidate. The controller signs it
 * only from its own case record; the lease callback re-verifies case membership,
 * owner, reservation and candidate before any dispatch uses the owner's branch.
 */
export const continuationCaseBindingSchema = z.object({
  caseId: z.string().regex(/^mfc_[a-f0-9]{64}$/),
  candidateOwnerRunId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export const continuationGrantSchema = z.object({
  purpose: z.literal("mentra-routine-fixer-continuation-v1"),
  environment: z.enum(["dev", "staging", "prod"]),
  occurrenceId: testFailureOccurrenceIdSchema,
  agentRunId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  candidate: continuationCandidateSchema,
  caseBinding: continuationCaseBindingSchema.optional(),
  executionAttempt: z.number().int().min(1).max(2),
  leaseGeneration: z.number().int().positive().safe(),
  leaseTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  routineIds: z.array(testRoutineIdSchema).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
  actions: z.array(z.enum(["request-routine", "read-results"])).min(1).max(2).refine(ids => new Set(ids).size === ids.length),
  expires: z.number().int().positive().safe(),
}).strict();
export type ContinuationGrant = z.infer<typeof continuationGrantSchema>;
export type ContinuationCandidate = z.infer<typeof continuationCandidateSchema>;
export type ContinuationCaseBinding = z.infer<typeof continuationCaseBindingSchema>;
export interface TestContinuationBinding {
  occurrenceId: string;
  agentRunId: string;
  candidate: ContinuationCandidate;
  caseBinding?: ContinuationCaseBinding;
  executionAttempt: number;
  retryReason?: string;
  expectedHeadSha: string;
  expectedHarnessSha?: string;
}
// The caller selects only a published build. Repository, branch and URLs are
// resolved from authenticated case/candidate metadata, never request text.
export const continuationRequestSchema = testDispatchInputSchema.omit({ idempotencyKey: true }).extend({
  executionAttempt: z.number().int().min(1).max(2).default(1),
  retryReason: z.string().min(1).max(400).optional(),
}).superRefine((value, ctx) => {
  if (value.executionAttempt > 1 && !value.retryReason) ctx.addIssue({ code: "custom", message: "An additional execution requires a recorded reason" });
});
