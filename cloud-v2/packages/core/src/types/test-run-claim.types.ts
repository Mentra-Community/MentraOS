import { z } from "zod";
import { testRunIdSchema } from "./test-run.types";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const testRunClaimIdentitySchema = z.object({
  requestId: testRunIdSchema,
  requestSha256: sha256,
  workerId: testRunIdSchema,
  fixtureId: testRunIdSchema,
  executionId: testRunIdSchema,
}).strict();

/** Persist this random token locally before POST; Core stores only its digest. */
export const testRunClaimRequestSchema = testRunClaimIdentitySchema.extend({ executionToken: sha256 });
export const testRunClaimSettlementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("terminal"), resultRunId: testRunIdSchema }).strict(),
  z.object({ state: z.literal("recovery-required"), reason: z.string().trim().min(1).max(1000) }).strict(),
]);
export const testRunClaimSettleRequestSchema = z.object({
  executionToken: sha256,
  settlement: testRunClaimSettlementSchema,
}).strict();

export type TestRunClaimIdentity = z.infer<typeof testRunClaimIdentitySchema>;
export type TestRunClaimRequest = z.infer<typeof testRunClaimRequestSchema>;
export type TestRunClaimSettlement = z.infer<typeof testRunClaimSettlementSchema>;
export type TestRunClaimSettleRequest = z.infer<typeof testRunClaimSettleRequestSchema>;
export type TestRunClaim = TestRunClaimIdentity & { claimedAt: string } & (
  | { state: "claimed"; settlement?: never; settledAt?: never }
  | { state: "terminal" | "recovery-required"; settlement: TestRunClaimSettlement; settledAt: string }
);
export interface TestRunClaimResponse { executionGranted: boolean; claim: TestRunClaim }

const sequence = z.number().int().positive().safe();
const originalTerminal = z.object({ sequence, sha256 }).strict();
const journalPrefix = z.object({ bytes: sequence, sha256 }).strict();
const release = <T extends string>(type: T) => z.object({
  type: z.literal(type),
  sequence,
  eventSha256: sha256,
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  implementationSha256: sha256,
}).strict();
const released = {
  fixture: z.literal("uncommissioned"),
  selectedCandidateInstalled: z.literal(false),
  candidateTestRun: z.literal(false),
  recordingStarted: z.literal(false),
};
/**
 * Evidence pins for an original owner's release of a failed first terminal: the
 * reviewed release event was appended directly after the original
 * (first-generation) terminal. It is not a recovery terminal, a result or a
 * readiness verdict: no candidate test ran and the fixture was left uncommissioned.
 *
 * - `android-refused-install-released`: Android completed an in-place install
 *   refusal, released by `setup-abandoned-after-refusal`.
 * - `preflight-abandoned-released`: preflight failed before setup with zero
 *   mutation operations, released by `preflight-abandoned`.
 */
export const testRunClaimClosureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("android-refused-install-released"),
    originalTerminal, journalPrefix,
    release: release("setup-abandoned-after-refusal"),
    ...released,
  }).strict(),
  z.object({
    kind: z.literal("preflight-abandoned-released"),
    originalTerminal, journalPrefix,
    release: release("preflight-abandoned"),
    operations: z.literal(0),
    ...released,
  }).strict(),
]).refine(value => value.release.sequence === value.originalTerminal.sequence + 1,
  "release must directly follow the original terminal");
/** The original owner's frozen identity and execution token, plus one closure. */
export const testRunClaimCloseRequestSchema = testRunClaimRequestSchema.extend({ closure: testRunClaimClosureSchema }).strict();
export type TestRunClaimClosure = z.infer<typeof testRunClaimClosureSchema>;
export type TestRunClaimCloseRequest = z.infer<typeof testRunClaimCloseRequestSchema>;
/** Stored separately from the immutable claim and settlement; `closedAt` is server time. */
export type TestRunClaimClosureRecord = TestRunClaimClosure & { closedAt: string };
export interface TestRunClaimCloseResponse { executionGranted: false; claim: TestRunClaim; closure: TestRunClaimClosureRecord }

/**
 * A display checkpoint, never an execution grant, lease heartbeat or settlement.
 * Exported unrefined so other reporting projections reuse the exact fields.
 */
export const testRunProgressFieldsSchema = z.object({
  sequence: z.number().int().positive().safe(),
  mode: z.enum(["running", "recovering", "complete"]),
  phase: z.enum(["preflight", "setup", "test", "final-assertions", "teardown", "return-verification", "evidence"]),
  step: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
    label: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/),
  }).strict().nullable(),
  completedSteps: z.number().int().min(0).max(10_000),
  totalSteps: z.number().int().min(0).max(10_000),
  action: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
    label: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/),
    completedActions: z.number().int().min(0).max(10_000),
    totalActions: z.number().int().min(0).max(10_000).nullable(),
  }).strict().refine(value => value.totalActions === null || value.completedActions <= value.totalActions,
    "completed actions exceed total").nullable().optional(),
}).strict();
export const validTestRunProgressCounts = (value: { completedSteps: number; totalSteps: number }) => value.completedSteps <= value.totalSteps;
export const testRunProgressSchema = testRunProgressFieldsSchema.refine(validTestRunProgressCounts, "completed steps exceed phase total");
export const testRunProgressRequestSchema = testRunProgressFieldsSchema.extend({ executionToken: sha256 }).refine(validTestRunProgressCounts, "completed steps exceed phase total");
export type TestRunProgress = z.infer<typeof testRunProgressSchema>;
export type TestRunProgressCheckpoint = TestRunProgress & { receivedAt: string };
export interface TestRunProgressResponse { accepted: boolean; sequence: number; receivedAt: string }
