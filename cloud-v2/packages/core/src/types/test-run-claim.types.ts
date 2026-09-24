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

/** A display checkpoint, never an execution grant, lease heartbeat or settlement. */
const progressFields = z.object({
  sequence: z.number().int().positive().safe(),
  mode: z.enum(["running", "recovering", "complete"]),
  phase: z.enum(["preflight", "setup", "test", "final-assertions", "teardown", "return-verification", "evidence"]),
  step: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/),
    label: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/),
  }).strict().nullable(),
  completedSteps: z.number().int().min(0).max(10_000),
  totalSteps: z.number().int().min(0).max(10_000),
  action: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/),
    label: z.string().trim().min(1).max(240).regex(/^[^\x00-\x1f\x7f]+$/),
    completedActions: z.number().int().min(0).max(10_000),
    totalActions: z.number().int().min(0).max(10_000).nullable(),
  }).strict().refine(value => value.totalActions === null || value.completedActions <= value.totalActions,
    "completed actions exceed total").nullable().optional(),
}).strict();
const validCounts = (value: { completedSteps: number; totalSteps: number }) => value.completedSteps <= value.totalSteps;
export const testRunProgressSchema = progressFields.refine(validCounts, "completed steps exceed phase total");
export const testRunProgressRequestSchema = progressFields.extend({ executionToken: sha256 }).refine(validCounts, "completed steps exceed phase total");
export type TestRunProgress = z.infer<typeof testRunProgressSchema>;
export type TestRunProgressCheckpoint = TestRunProgress & { receivedAt: string };
export interface TestRunProgressResponse { accepted: boolean; sequence: number; receivedAt: string }
