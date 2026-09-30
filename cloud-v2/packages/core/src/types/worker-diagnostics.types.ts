import { z } from "zod";
import { testFailureOccurrenceIdSchema } from "./test-failure.types";

export const WORKER_DIAGNOSTICS_MAX_BYTES = 1024 * 1024;
export const workerDiagnosticsSchema = z.object({
  schemaVersion: z.literal(1),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  attachmentKey: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  entries: z.array(z.object({
    timestamp: z.number().int().nonnegative().safe(),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string().min(1).max(8000),
  }).strict()).min(1).max(1000),
}).strict();

/** Separate write purpose: an occurrence read capability never authorizes attachments. */
export const workerDiagnosticsGrantSchema = z.object({
  purpose: z.literal("mentra-test-failure-diagnostics-v1"),
  environment: z.enum(["dev", "staging", "prod"]),
  occurrenceId: testFailureOccurrenceIdSchema,
  expires: z.number().int().positive().safe(),
}).strict();
export type WorkerDiagnosticsGrant = z.infer<typeof workerDiagnosticsGrantSchema>;
