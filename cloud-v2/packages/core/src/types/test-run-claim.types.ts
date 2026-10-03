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
