import { z } from "zod";

const positive = z.number().int().positive().safe();
export const testRoutineIdSchema = z.enum(["no-glasses", "no-glasses-android", "day1-ota", "mentra-call"]);
export const testBuildSourceSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("pr"), prNumber: positive, buildRunId: positive, publicationAttempt: positive }).strict(),
  z.object({ channel: z.literal("dev"), buildRunId: positive, publicationAttempt: positive }).strict(),
  z.object({ channel: z.literal("staging"), buildRunId: positive, publicationAttempt: positive }).strict(),
]);
export const testDispatchInputSchema = z.object({
  source: testBuildSourceSchema,
  routineId: testRoutineIdSchema,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().uuid(),
}).strict();
export const testBuildQuerySchema = z.object({
  channel: z.enum(["pr", "dev", "staging"]),
  pr: z.coerce.number().int().positive().safe().optional(),
  routineId: testRoutineIdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.channel === "pr") !== (value.pr !== undefined))
    ctx.addIssue({ code: "custom", message: "Only PR inventory requires a PR number" });
});

export type TestBuildSource = z.infer<typeof testBuildSourceSchema>;
export type TestDispatchInput = z.infer<typeof testDispatchInputSchema>;
export type TestBuildQuery = z.infer<typeof testBuildQuerySchema>;
export type TestRoutineId = z.infer<typeof testRoutineIdSchema>;
export type TestBuildPlatform = "ios-on-mac" | "android";
export const testRoutinePlatform = (id: TestRoutineId = "no-glasses"): TestBuildPlatform =>
  id === "no-glasses-android" ? "android" : "ios-on-mac";
export const TEST_ROUTINES = [
  { id: "no-glasses" as const, name: "UI walkthrough without glasses (Mac)", description: "Open the app and verify navigation, settings and account screens." },
  { id: "no-glasses-android" as const, name: "UI walkthrough without glasses (Android)", description: "Verify app navigation on the dedicated Android phone with no glasses paired." },
  { id: "day1-ota" as const, name: "Day-one OTA update", description: "Prepare day-one firmware, update it, then verify and restore the selected build's firmware." },
  { id: "mentra-call" as const, name: "Mentra Call", description: "Join a call with the glasses and a browser peer, recording both views and checking the connection." },
];

export interface TestBuild {
  source: TestBuildSource;
  platform?: TestBuildPlatform;
  title: string;
  headSha: string;
  buildUrl: string;
  createdAt: string;
  availability: "available" | "unavailable";
  reason?: string;
  release?: string;
  archive?: { name: string; sha256: string; size: number };
  receiptSha256?: string;
  manifestSha256?: string;
  routines: { id: TestRoutineId; available: boolean; reason?: string }[];
}

export interface TestDispatchReceipt {
  dispatchId: string;
  input: TestDispatchInput;
  requestedBy: string;
  createdAt: string;
  // This is a send receipt, not another queue. A send is never retried here.
  sendState: "sending" | "accepted" | "unknown" | "rejected";
  rejectionReason?: string;
  requestRunId?: number;
  requestUrl?: string;
}
export interface TestDispatchView extends TestDispatchReceipt {
  state: "requesting" | "unavailable" | "queued" | "running" | "recovery-required" | "finished" | "failed" | "unknown";
  message: string;
  requestId?: string;
  workerUrl?: string;
  result?: { runId: string; outcome: string; outcomes: Record<string, string>; reportPath: string };
}
