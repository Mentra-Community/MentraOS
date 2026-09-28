import { createHash } from "node:crypto";
import { z } from "zod";
import { testFailureOccurrenceIdSchema } from "./test-failure.types";
import { testBuildSourceSchema } from "./test-dispatch.types";

const sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const repository = z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
/** The same case-anchor shape as a continuation grant. */
export const existingWorkAgentRunIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
/**
 * A routine name as the occurrence recorded it. It is not required to be registered: an
 * unregistered routine (for example `notes-phone` before its registration) is reported as
 * unavailable by the service, never retagged as another routine.
 */
export const existingWorkRoutineNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * The reviewed MentraOS bundling PR recorded on the controller's existing-work row.
 * Its merge is forward provenance: a selected publication must contain it and carry
 * exactly this artifact blob.
 */
export const existingWorkBundleTargetSchema = z.object({
  repository: z.literal("Mentra-Community/MentraOS"),
  pullRequest: positive,
  mergeCommitSha: sha40,
  artifactPath: z.string().max(200).regex(/^mobile\/assets\/miniapps\/[A-Za-z0-9][A-Za-z0-9._-]*-\d+\.\d+\.\d+\.zip$/),
  artifactBlobSha: sha40,
  baseBranch: z.enum(["dev", "staging"]),
}).strict();
/**
 * A backend source fix the verification depends on (for example Notes backend PR9), or null
 * when the client artifact alone carries the fix. Required and explicit: there is no default.
 */
export const existingWorkBackendRequirementSchema = z.object({ repository, mergeCommitSha: sha40 }).strict().nullable();

/**
 * `mentra-routine-fixer-existing-work-v1`: one acknowledged occurrence/agent run and one
 * exact existing-work binding. It carries no case, candidate or model lease; the operation
 * itself is authenticated by the controller's operation callback before any send.
 */
export const existingWorkGrantSchema = z.object({
  purpose: z.literal("mentra-routine-fixer-existing-work-v1"),
  environment: z.enum(["dev", "staging", "prod"]),
  occurrenceId: testFailureOccurrenceIdSchema,
  agentRunId: existingWorkAgentRunIdSchema,
  binding: z.object({ sha256: sha64, revision: positive }).strict(),
  bundle: existingWorkBundleTargetSchema,
  routineId: existingWorkRoutineNameSchema,
  verificationAttempt: z.literal(1),
  backendRequirement: existingWorkBackendRequirementSchema,
  actions: z.array(z.enum(["request-routine", "read-results"])).min(1).max(2).refine(ids => new Set(ids).size === ids.length),
  expires: positive,
}).strict();
export type ExistingWorkGrant = z.infer<typeof existingWorkGrantSchema>;
export type ExistingWorkBundleTarget = z.infer<typeof existingWorkBundleTargetSchema>;

/**
 * The caller selects a published build only. The first existing-work scope is a merged
 * dev/staging publication; a PR selection parses here so it can be refused explicitly.
 */
export const existingWorkRequestSchema = z.object({
  source: testBuildSourceSchema,
  routineId: existingWorkRoutineNameSchema,
  archiveSha256: sha64,
  verificationAttempt: z.literal(1),
}).strict();

/**
 * Stored on the dispatch receipt as `existingWork`, never as `continuation`. Everything
 * except `authorizedBindingRevision` is the stable identity a replay or read must match;
 * the revision records which controller row revision authorized the one send.
 */
export const testExistingWorkBindingSchema = z.object({
  kind: z.literal("existing-work-verification-v1"),
  occurrenceId: testFailureOccurrenceIdSchema,
  agentRunId: existingWorkAgentRunIdSchema,
  bindingSha256: sha64,
  authorizedBindingRevision: positive,
  bundle: existingWorkBundleTargetSchema,
  backendRequirement: existingWorkBackendRequirementSchema,
  routineId: existingWorkRoutineNameSchema,
  verificationAttempt: z.literal(1),
  expectedHeadSha: sha40,
}).strict();
export type TestExistingWorkBinding = z.infer<typeof testExistingWorkBindingSchema>;

/**
 * The controller's stable existing-work identity (shared contract `existing-work-v1`).
 * Merge commits and volatile revision/check times are deliberately absent.
 */
export const existingWorkIdentitySchema = z.object({
  agentRunId: z.string(), occurrenceId: z.string(), testRunId: z.string(), environment: z.string(),
  sourceSha256: z.string(), payloadSha256: z.string(), incidentId: z.string(), routineId: z.string(),
  source: z.object({ repository: z.string(), pullRequest: positive, headSha: z.string(), baseBranch: z.string(),
    manifestPath: z.string(), packageName: z.string(), version: z.string() }),
  bundle: z.object({ repository: z.string(), pullRequest: positive, headSha: z.string(), baseBranch: z.string(),
    artifactPath: z.string(), artifactBlobSha: z.string(), registryPath: z.string() }),
});
export type ExistingWorkIdentity = z.infer<typeof existingWorkIdentitySchema>;
/** Frozen ordered array: object key order can never change the digest. Do not reorder. */
export function existingWorkBindingOrdered(value: ExistingWorkIdentity): unknown[] {
  const { source, bundle, ...identity } = existingWorkIdentitySchema.parse(value);
  return ["existing-work-v1", identity.agentRunId, identity.occurrenceId, identity.testRunId, identity.environment,
    identity.sourceSha256, identity.payloadSha256, identity.incidentId, identity.routineId,
    source.repository, source.pullRequest, source.headSha, source.baseBranch, source.manifestPath, source.packageName, source.version,
    bundle.repository, bundle.pullRequest, bundle.headSha, bundle.baseBranch, bundle.artifactPath, bundle.artifactBlobSha, bundle.registryPath];
}
/** SHA-256 of the UTF-8 JSON serialization of the frozen ordered array. */
export function existingWorkBindingDigest(value: ExistingWorkIdentity): string {
  return createHash("sha256").update(JSON.stringify(existingWorkBindingOrdered(value)), "utf8").digest("hex");
}
