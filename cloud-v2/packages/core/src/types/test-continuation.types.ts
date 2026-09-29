import { z } from "zod";
import { testFailureOccurrenceIdSchema } from "./test-failure.types";
import { testDispatchInputSchema, testRoutineIdSchema } from "./test-dispatch.types";

const candidateRepository = z.enum(["Mentra-Community/MentraOS", "Mentra-Community/Mentra-Automated-Testing"]);
const candidateHead = z.string().regex(/^[a-f0-9]{40}$/);
/**
 * A reviewed PR candidate, or `target: "original"`: the occurrence's exact recorded
 * source and published artifact, for a diagnostic/reproduction rerun or a rerun
 * after a state-only repair. The original target never names a PR or a newer head.
 */
export const continuationCandidateSchema = z.union([
  z.object({ repository: candidateRepository, pullRequest: z.number().int().positive().safe(), headSha: candidateHead }).strict(),
  z.object({ repository: candidateRepository, headSha: candidateHead, target: z.literal("original") }).strict(),
]);
export const isOriginalCandidate = (candidate: ContinuationCandidate): candidate is Extract<ContinuationCandidate, { target: "original" }> =>
  "target" in candidate;
/**
 * Same-case adoption of a shared, reviewed harness candidate. The controller signs it
 * only from its own case record; the lease callback re-verifies case membership,
 * owner, reservation and candidate before any dispatch uses the owner's branch.
 */
export const continuationCaseBindingSchema = z.object({
  caseId: z.string().regex(/^mfc_[a-f0-9]{64}$/),
  candidateOwnerRunId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
/**
 * Where an app candidate for a local feature-branch source is verified. A local build of a branch that is not
 * itself a destination has no base of its own; the controller proves the pull request it came from and saves
 * that route. It signs this projection only from its saved route, never from model text, and Core re-verifies
 * the whole relationship with the provider. Absent for every other source, candidate and target.
 *
 * `testedHeadSha` is the exact tested commit the origin was proven for when the route was saved (the case
 * anchor's own source head). The route belongs to the branch, so a later occurrence of that branch consumes it
 * with its own, different head: the origin is re-proven from this immutable head, and the consuming head must
 * continue it.
 */
export const continuationExecutionDestinationSchema = z.object({
  repository: z.literal("Mentra-Community/MentraOS"),
  baseBranch: z.enum(["dev", "staging"]),
  sourceOrigin: z.discriminatedUnion("state", [
    // The originating PR is the route itself; if that same PR later merges, its merged-candidate path applies.
    z.object({ pullRequest: z.number().int().positive().safe(), state: z.literal("open"), testedHeadSha: candidateHead }).strict(),
    // A merged origin takes no more commits: a new anchor fix PR into the same base carries the fix.
    z.object({ pullRequest: z.number().int().positive().safe(), state: z.literal("merged"), testedHeadSha: candidateHead,
      mergeCommitSha: candidateHead }).strict(),
  ]),
}).strict();
export const continuationGrantSchema = z.object({
  purpose: z.literal("mentra-routine-fixer-continuation-v1"),
  environment: z.enum(["dev", "staging", "prod"]),
  occurrenceId: testFailureOccurrenceIdSchema,
  agentRunId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  candidate: continuationCandidateSchema,
  caseBinding: continuationCaseBindingSchema.optional(),
  executionDestination: continuationExecutionDestinationSchema.optional(),
  executionAttempt: z.number().int().min(1).max(2),
  leaseGeneration: z.number().int().positive().safe(),
  leaseTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  routineIds: z.array(testRoutineIdSchema).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
  actions: z.array(z.enum(["request-routine", "read-results", "repair-state"])).min(1).max(3).refine(ids => new Set(ids).size === ids.length),
  expires: z.number().int().positive().safe(),
}).strict();
export type ContinuationGrant = z.infer<typeof continuationGrantSchema>;
export type ContinuationCandidate = z.infer<typeof continuationCandidateSchema>;
export type ContinuationCaseBinding = z.infer<typeof continuationCaseBindingSchema>;
export type ContinuationExecutionDestination = z.infer<typeof continuationExecutionDestinationSchema>;
export interface TestContinuationBinding {
  occurrenceId: string;
  agentRunId: string;
  candidate: ContinuationCandidate;
  caseBinding?: ContinuationCaseBinding;
  executionDestination?: ContinuationExecutionDestination;
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
