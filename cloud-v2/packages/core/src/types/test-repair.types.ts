import { z } from "zod";
import type { ContinuationCandidate, ContinuationCaseBinding } from "./test-continuation.types";
import type { TestRoutineId } from "./test-dispatch.types";

/**
 * Named state repairs, each an existing owned recovery path of the private worker for
 * one routine. A name is not a command: it cannot select a host, path, lock or script.
 * `runner.recovery` is intentionally absent: the private runner has no owned recovery
 * entrypoint, only UI-step helpers. Mentra Call has no state repair.
 */
export const TEST_REPAIR_OPERATIONS = {
  "no-glasses.recover-recording-start": { routineId: "no-glasses", privateEntrypoint: "worker/no-glasses.ts recover-recording-start" },
  "no-glasses.recover-account-home": { routineId: "no-glasses", privateEntrypoint: "worker/no-glasses.ts recover-account-home" },
  "android.sign-in-recovery": { routineId: "no-glasses-android", privateEntrypoint: "worker/android-no-glasses.ts --recover-setup-sign-in" },
  "android.interrupted-search-return": { routineId: "no-glasses-android", privateEntrypoint: "worker/android-search-repair.ts executeAndroidSearchRepair" },
  "android.owner-reconciliation": { routineId: "no-glasses-android", privateEntrypoint: "worker/android-no-glasses.ts --reconcile-original-owner" },
  "day1.recovery": { routineId: "day1-ota", privateEntrypoint: "worker/day1-recovery.ts recover (host maintenance recover-day1)" },
} as const satisfies Record<string, { routineId: TestRoutineId; privateEntrypoint: string }>;
export type TestRepairOperation = keyof typeof TEST_REPAIR_OPERATIONS;
export const testRepairOperationSchema = z.enum(Object.keys(TEST_REPAIR_OPERATIONS) as [TestRepairOperation, ...TestRepairOperation[]]);

export const testRepairRequestSchema = z.object({
  operationId: z.string().uuid(),
  operation: testRepairOperationSchema,
  routineId: z.enum(["no-glasses", "no-glasses-android", "day1-ota", "mentra-call"]),
  reason: z.string().min(1).max(400),
}).strict();
export type TestRepairRequest = z.infer<typeof testRepairRequestSchema>;

const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/);
/** Existing durable worker evidence, relayed as the executor reported it; Core never fabricates a slot. */
// Each existing slot must be present (an omitted key is not evidence); an explicit null remains a value.
const evidenceSlot = z.unknown().refine(value => value !== undefined, "Evidence slot is required");
export const testRepairEvidenceSchema = z.object({
  before: evidenceSlot, action: evidenceSlot, result: evidenceSlot,
  check: z.object({ passed: z.boolean() }).passthrough(),
}).strict();
/** An executor's answer about one registered operation, naming that exact operation. */
export const testRepairStatusSchema = z.object({
  repairId: z.string().uuid(),
  operation: testRepairOperationSchema,
  state: z.enum(["accepted", "running", "unknown", "completed", "failed", "rejected"]),
  owner: z.object({ workerId: identity, fixtureId: identity }).strict().optional(),
  evidence: testRepairEvidenceSchema.optional(),
}).strict();
export type TestRepairStatus = z.infer<typeof testRepairStatusSchema>;

/** Core's permanent send fence for one registered operation. It is not a queue. */
export interface TestRepairReceipt {
  repairId: string;
  request: TestRepairRequest;
  binding: { occurrenceId: string; agentRunId: string; candidate: ContinuationCandidate; caseBinding?: ContinuationCaseBinding };
  /**
   * The verified grant's lease at request time, so the executor can prove the same live lease at
   * acceptance. Not part of the stable input digest or the bound identity: replays under a renewed
   * lease still reach the same operation, and only the original send carries it.
   */
  lease: { environment: "dev" | "staging" | "prod"; executionAttempt: 1; leaseGeneration: number; leaseTokenSha256: string };
  createdAt: string;
  sendState: "sending" | "accepted" | "unknown" | "rejected";
  rejectionReason?: string;
  /** Set when an uncertain send was settled by the executor's own answer, never by a resend. */
  reconciledAt?: string;
}
export interface TestRepairView {
  repairId: string;
  operation: TestRepairOperation;
  state: "sending" | TestRepairReceipt["sendState"] | TestRepairStatus["state"];
  owner?: TestRepairStatus["owner"];
  evidence?: TestRepairStatus["evidence"];
  message: string;
}
