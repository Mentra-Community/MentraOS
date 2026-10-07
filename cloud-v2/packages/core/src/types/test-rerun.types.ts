import {z} from "zod";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "./framework-request.types";
import {testBuildSourceSchema} from "./test-build.types";
import {routineDispatchIntentSchema} from './routine-dispatch.types';

export const rerunTerminalStatuses = ["pass", "failed", "setup-failed", "teardown-failed", "not-run", "cancelled", "incomplete"] as const;
export const rerunFailureStatuses = ["failed", "setup-failed", "teardown-failed"] as const;
const identities = z.array(frameworkIdentitySchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length, "Duplicate members");
const parentSchema = z.union([
  z.object({suiteId: frameworkIdentitySchema}).strict(),
  z.object({requestId: frameworkIdentitySchema}).strict(),
]);
export const rerunSelectionSchema = z.union([
  z.object({memberIds: identities}).strict(),
  z.object({filter: z.object({statuses: z.array(z.enum(rerunTerminalStatuses)).min(1).max(7),
    excludeMemberIds: identities.optional()}).strict()}).strict(),
]);
export const rerunPreviewSchema = z.object({rerunId: frameworkIdentitySchema, parent: parentSchema,
  selection: rerunSelectionSchema, source: testBuildSourceSchema.optional(), reason: z.string().trim().min(1).max(1000),
  routineRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  predecessorAttemptId: frameworkIdentitySchema.optional()}).strict();
export const rerunSubmitSchema = z.object({rerunId: frameworkIdentitySchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const individualRerunSchema = z.object({requestId: frameworkIdentitySchema,
  parent: z.union([z.object({suiteId: frameworkIdentitySchema, memberId: frameworkIdentitySchema}).strict(),
    z.object({requestId: frameworkIdentitySchema}).strict()]),
  predecessorAttemptId: frameworkIdentitySchema, source: testBuildSourceSchema.optional(),
  routineRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  reason: z.string().trim().min(1).max(1000)}).strict();
export const rerunPlanSchema = z.object({rerunId: frameworkIdentitySchema, parent: parentSchema,
  source: testBuildSourceSchema.optional(), routineRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(), reason: z.string(), actor: z.string().max(300), createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(), members: z.array(z.object({memberId: frameworkIdentitySchema,
    rootKey: z.string(), originalRequestId: frameworkIdentitySchema.optional(), predecessorAttemptId: frameworkIdentitySchema,
    attemptNumber: z.number().int().min(1), requestId: frameworkIdentitySchema,
    hostId: frameworkIdentitySchema, dispatchIntent: routineDispatchIntentSchema}).strict()).min(1).max(100)}).strict();
export type RerunPreviewInput = z.infer<typeof rerunPreviewSchema>;
export type RerunPlan = z.infer<typeof rerunPlanSchema>;
export type RerunMember = RerunPlan["members"][number];
export interface RerunAttempt {
  attemptId: string; attemptNumber: number; rerunId?: string; requestId?: string; runId?: string;
  status: string; publicationComplete: boolean; createdAt?: string; startedAt?: string; finishedAt?: string;
  preparationDisposition?: 'not-run' | 'not-applicable';
  reason?: string; build?: z.infer<typeof frameworkRequestInputSchema>["build"]; definitionRevision?: string;
  predecessorAttemptId?: string; parent: RerunPlan["parent"]; memberId: string;
}
