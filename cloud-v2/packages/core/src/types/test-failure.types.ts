import { z } from "zod";

const repository = z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const assetId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const text = z.string().min(1).max(2000);
// Branch names are metadata, never shell arguments. Keep the Git ref restrictions
// here too so a missing/invalid branch cannot become an automatic fix destination.
export const testFailureBranchSchema = z.string().min(1).max(255).refine(value =>
  !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.startsWith("-")
  && !value.includes("..") && !value.includes("@{") && value !== "@"
  && value.split("/").every(part => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  && !value.endsWith("."), "invalid source branch");

export const testFailureSourceSchema = z.object({
  schemaVersion: z.literal(1),
  // `manual`: an authenticated explicit request for a published build whose Admin/CLI
  // caller was not recorded. Routing uses channel/branch/pullRequest, never the trigger.
  trigger: z.enum(["pr", "dev", "staging", "nightly", "admin", "manual", "local"]),
  repository,
  channel: z.enum(["pr", "dev", "staging", "local"]),
  headSha: commit,
  branch: testFailureBranchSchema,
  pullRequest: z.object({
    number: z.number().int().positive().safe(), headRepository: repository,
    baseBranch: testFailureBranchSchema, baseSha: commit,
  }).strict().optional(),
}).strict().superRefine((source, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((source.channel === "pr") !== Boolean(source.pullRequest)) problem("PR source requires exactly one pull request identity");
  if (["pr", "dev", "staging", "local"].includes(source.trigger) && source.trigger !== source.channel)
    problem("trigger contradicts selected source channel");
  if (source.trigger === "nightly" && !["dev", "staging"].includes(source.channel)) problem("nightly source must be dev or staging");
  if (source.trigger === "admin" && source.channel === "local") problem("Admin source must be a published build");
  if (source.trigger === "manual" && source.channel === "local") problem("manual source must be a published build");
  if (["dev", "staging"].includes(source.channel) && source.branch !== source.channel) problem("coordinated source branch must match channel");
});

export const testFailurePhaseSchema = z.enum([
  "preflight", "setup", "test", "final-assertions", "teardown", "return-verification", "evidence", "unknown",
]);
export const testFailureSchema = z.object({
  phase: testFailurePhaseSchema,
  step: z.object({ id, label: text }).strict().nullable(),
  code: id,
  message: text,
  expected: text.optional(),
  stack: z.string().min(1).max(8000).optional(),
  // Only these reviewed/redacted representations are exposed to the agent.
  assetIds: z.array(assetId).max(100),
  incidentIds: z.array(z.string().regex(/^rep_[A-Za-z0-9]{1,80}$/)).max(20),
  redactionPolicy: z.string().min(1).max(160),
  missingEvidence: z.array(z.object({
    kind: z.enum(["recording", "screenshot", "phone-logs", "glasses-logs", "backend-logs", "symbols", "incident", "source", "failure-details", "other"]),
    reason: text,
  }).strict()).max(30),
}).strict();

export const testFailureOccurrenceIdSchema = z.string().regex(/^tfo_[a-f0-9]{64}$/);
export type TestFailureSource = z.infer<typeof testFailureSourceSchema>;
export type TestFailure = z.infer<typeof testFailureSchema>;
export interface TestFailureOccurrence {
  occurrenceId: string;
  revision: 1;
  failure: TestFailure;
  delivery: { state: "pending"; lastAttemptAt?: string } | { state: "acknowledged"; agentRunId: string; acknowledgedAt: string };
}

const agentRunId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
export const testFailureDeliveryAckSchema = z.object({
  schemaVersion: z.literal(1), occurrenceId: testFailureOccurrenceIdSchema, revision: z.literal(1),
  agentRunId, status: z.literal("accepted"),
}).strict();

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Core-generated placeholder policies describe status metadata only; they can never attest a reviewed representation. */
export const GENERATED_FAILURE_REDACTION_POLICIES = ["core-generated-summary-v1", "lifecycle-allowlist-v1"] as const;
export const testFailureCorrectionIdSchema = z.string().regex(/^tpc_[a-f0-9]{64}$/);
/**
 * An admin's explicit, reviewed request to add ONLY a missing source and missing diagnostic bindings to one
 * existing, acknowledged occurrence. Every identity is the exact existing one; nothing here approves itself.
 * Core still corroborates each field against the immutable accepted result before storing it.
 */
export const testFailureProvenanceCorrectionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  confirmation: z.literal("add-reviewed-provenance"),
  environment: z.enum(["dev", "staging", "prod"]),
  runId: assetId,
  payloadSha256: sha256,
  occurrenceId: testFailureOccurrenceIdSchema,
  occurrenceRevision: z.literal(1),
  agentRunId,
  reason: z.string().min(20).max(2000).refine(value => value.trim().length >= 20, "reason must explain the review"),
  source: testFailureSourceSchema,
  // Optional added recordings/screenshots. Incident IDs cannot be added: no authenticated report-to-run association
  // exists, so an incident is never exposed through an occurrence on a reviewer's say-so. Original incidents are kept.
  diagnostics: z.object({
    // Each added asset names the non-passing chapter of this run that records it.
    assets: z.array(z.object({ assetId, sha256, chapterId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/) }).strict()).min(1).max(20),
    // The reviewer's explicit attestation for exactly these added representations. The original failure's
    // redactionPolicy (for a generic fallback, a Core-generated placeholder) never attests them.
    redaction: z.object({ policy: text.max(160), confirmation: z.literal("reviewed-redacted-for-occurrence-access") }).strict()
      .refine(value => !(GENERATED_FAILURE_REDACTION_POLICIES as readonly string[]).includes(value.policy),
        "a Core-generated placeholder policy cannot attest reviewed diagnostics"),
  }).strict().optional(),
  // The immutable run assets the reviewer inspected to establish the source; references only, never assigned.
  review: z.object({ evidence: z.array(z.object({ assetId, sha256 }).strict()).min(1).max(8) }).strict(),
}).strict().superRefine((value, ctx) => {
  const unique = (items: string[]) => new Set(items).size === items.length;
  if (!unique((value.diagnostics?.assets ?? []).map(item => item.assetId)) || !unique(value.review.evidence.map(item => item.assetId)))
    ctx.addIssue({ code: "custom", message: "duplicate correction reference" });
});
export type TestFailureProvenanceCorrectionRequest = z.infer<typeof testFailureProvenanceCorrectionRequestSchema>;
/** Stored beside, never inside, the accepted payload and its occurrence. One per occurrence. */
export interface TestFailureProvenanceCorrection {
  schemaVersion: 1; correctionId: string; correctionSha256: string; revision: 1;
  environment: "dev" | "staging" | "prod"; runId: string; payloadSha256: string;
  occurrenceId: string; occurrenceRevision: 1; agentRunId: string;
  reason: string; source: TestFailureSource;
  /** Added chapter-bound assets with their explicit reviewed redaction attestation, or null when only the source is added. */
  added: { assets: Array<{ assetId: string; sha256: string; chapterId: string }>;
    redaction: { policy: string; confirmation: "reviewed-redacted-for-occurrence-access" } } | null;
  /** Which source fields Core matched to immutable payload records, and which rest on the cited review alone. */
  review: { evidence: Array<{ assetId: string; sha256: string }>; corroborated: string[]; asserted: string[] };
  /** The occurrence as originally accepted: its source absence remains a historical fact. */
  original: { source: null; assetIds: string[]; incidentIds: string[] };
  reviewedBy: string; reviewedAt: string;
  delivery: { state: "pending"; lastAttemptAt?: string } | { state: "acknowledged"; agentRunId: string; acknowledgedAt: string }
    | { state: "refused"; refusedAt: string };
}
export const testFailureCorrectionAckSchema = z.object({
  schemaVersion: z.literal(1), occurrenceId: testFailureOccurrenceIdSchema, revision: z.literal(1),
  correctionId: testFailureCorrectionIdSchema, agentRunId, status: z.literal("accepted"),
}).strict();
