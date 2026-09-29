import { z } from "zod";
import { testFailureOccurrenceIdSchema } from "./test-failure.types";
import { testRunIdSchema } from "./test-run.types";

export const EVIDENCE_SUPPLEMENT_BYTES = 262144;
export const EVIDENCE_SUPPLEMENT_LIMIT = 2;
export const EVIDENCE_SUPPLEMENT_CONTENT_TYPE = "application/vnd.mentra.routine-failure-evidence-supplement+json";
export const EVIDENCE_SUPPLEMENT_PURPOSE = "mentra-routine-failure-evidence-supplement-v1";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
  schemaVersion: z.literal(1), environment: z.enum(["dev", "staging", "prod"]), testRunId: testRunIdSchema,
  payloadSha256: hash, occurrenceId: testFailureOccurrenceIdSchema, revision: z.literal(1), agentRunId: z.string().uuid(),
  target: z.object({ caseId: z.string().regex(/^mfc_[a-f0-9]{64}$/), caseRevision: z.number().int().nonnegative().safe(),
    sessionSha256: hash }).strict(),
};
const assetId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const asset = z.object({ assetId, sizeBytes: z.number().int().positive().max(EVIDENCE_SUPPLEMENT_BYTES), sha256: hash }).strict();
export const evidenceSupplementManifestSchema = z.object({ ...identity,
  reason: z.string().min(20).max(2000).refine(value => value.trim().length >= 20),
  redactionPolicy: z.literal("reviewed-harness-diagnostic-v1"), assets: z.array(asset).min(1).max(8),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.assets.map(item => item.assetId)).size !== value.assets.length
    || value.assets.reduce((sum, item) => sum + item.sizeBytes, 0) > EVIDENCE_SUPPLEMENT_BYTES)
    ctx.addIssue({ code: "custom", message: "duplicate assets or supplement byte limit exceeded" });
});
export const evidenceSupplementReferenceSchema = z.object({ ...identity,
  supplementId: z.string().regex(/^tes_[a-f0-9]{64}$/), supplementSha256: hash,
}).strict().refine(value => value.supplementId === `tes_${value.supplementSha256}`);
export const evidenceSupplementRequestSchema = z.object({
  confirmation: z.literal("append-reviewed-diagnostics"), manifest: evidenceSupplementManifestSchema,
  content: z.array(z.object({ assetId, json: z.string().min(1).max(EVIDENCE_SUPPLEMENT_BYTES) }).strict()).min(1).max(8),
}).strict();
export const evidenceSupplementAckSchema = z.object({ schemaVersion: z.literal(1), occurrenceId: testFailureOccurrenceIdSchema,
  revision: z.literal(1), agentRunId: z.string().uuid(), supplementId: z.string().regex(/^tes_[a-f0-9]{64}$/), status: z.literal("accepted"),
}).strict();
export type EvidenceSupplementManifest = z.infer<typeof evidenceSupplementManifestSchema>;
export type EvidenceSupplementReference = z.infer<typeof evidenceSupplementReferenceSchema>;
export type EvidenceSupplementRequest = z.infer<typeof evidenceSupplementRequestSchema>;
export type EvidenceSupplement = { reference: EvidenceSupplementReference; manifest: EvidenceSupplementManifest;
  reviewedAt: string; reviewedBy: string; delivery: { state: "pending"; lastAttemptAt?: string }
    | { state: "acknowledged"; agentRunId: string; acknowledgedAt: string } | { state: "refused"; refusedAt: string } };
