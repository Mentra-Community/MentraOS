import { z } from "zod";
import type { TestContinuationBinding } from "./test-continuation.types";
import type { TestExistingWorkBinding } from "./test-existing-work.types";

const positive = z.number().int().positive().safe();
export const testRoutineIdSchema = z.enum(["no-glasses", "no-glasses-android", "day1-ota", "mentra-call",
  "account-miniapps", "connected-glasses", "livestreamer", "captions-phone", "notes-phone"]);
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
/**
 * Continuation-only: an original PR target replays its recorded request by run ID through the
 * trusted issuer. Admin and callers cannot supply it; Core sets it from the authenticated packet.
 */
export const continuationDispatchInputSchema = testDispatchInputSchema.extend({
  originalRequestRunId: positive.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.originalRequestRunId !== undefined && value.source.channel !== "pr")
    ctx.addIssue({ code: "custom", message: "Only a PR original is replayed by its request" });
});
export const testBuildQuerySchema = z.object({
  channel: z.enum(["pr", "dev", "staging"]),
  pr: z.coerce.number().int().positive().safe().optional(),
  routineId: testRoutineIdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.channel === "pr") !== (value.pr !== undefined))
    ctx.addIssue({ code: "custom", message: "Only PR inventory requires a PR number" });
});

export type TestBuildSource = z.infer<typeof testBuildSourceSchema>;
export type TestDispatchInput = z.infer<typeof continuationDispatchInputSchema>;
export type TestBuildQuery = z.infer<typeof testBuildQuerySchema>;
export type TestRoutineId = z.infer<typeof testRoutineIdSchema>;
export type TestBuildPlatform = "ios-on-mac" | "android";
export const testRoutinePlatform = (id: TestRoutineId = "no-glasses"): TestBuildPlatform =>
  id === "no-glasses-android" || id === "connected-glasses" ? "android" : "ios-on-mac";
export const TEST_ROUTINES = [
  { id: "no-glasses" as const, name: "UI walkthrough without glasses (Mac)", description: "Open the app and verify navigation, settings and account screens." },
  { id: "no-glasses-android" as const, name: "UI walkthrough without glasses (Android)", description: "Verify app navigation on the dedicated Android phone with no glasses paired." },
  { id: "day1-ota" as const, name: "Day-one OTA update", description: "Prepare day-one firmware, update it, then verify and restore the selected build's firmware." },
  { id: "mentra-call" as const, name: "Mentra Call", description: "Join a call with the glasses and a browser peer, recording both views and checking the connection." },
  // Planned nightly targets (account-miniapps, connected-glasses): listed so their unavailability is visible. `planned`
  // keeps them unavailable even if a deployment enables them, until the reviewed change that registers their automatic
  // worker removes it.
  { id: "account-miniapps" as const, name: "Account and miniapps (Mac)", description: "One combined paired-account routine: email, export, Google SSO, feedback, miniapps and incompatible tiles.",
    planned: "Planned routine: its automatic worker is not registered yet" },
  { id: "connected-glasses" as const, name: "Connected glasses (Android)", description: "One combined Android routine with paired glasses: pairing, Bluetooth, camera, Wi-Fi, gallery and audio.",
    planned: "Planned routine: its automatic worker is not registered yet" },
  // Registered Mac nightly target; a deployment enables it through TEST_RUN_DISPATCH_ROUTINES once its worker is enrolled.
  { id: "livestreamer" as const, name: "Livestreamer (Mac)", description: "Stream here and local RTMP from the Mentra app, observed by an owned receiver." },
  // Registered Mac Phone mode routines; a deployment enables each through TEST_RUN_DISPATCH_ROUTINES once its worker is enrolled.
  { id: "captions-phone" as const, name: "Captions with simulated glasses (Mac)", description: "Phone mode Captions transcribes one controlled speech fixture, then restores the microphone, Home and host audio." },
  { id: "notes-phone" as const, name: "Notes with simulated glasses (Mac)", description: "Phone mode Notes transcribes a controlled discussion, then its one new note is edited, persisted and found by Search." },
] satisfies { id: TestRoutineId; name: string; description: string; planned?: string }[];

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
  continuation?: TestContinuationBinding;
  /** A verification of an existing reviewed fix; never a continuation candidate. */
  existingWork?: TestExistingWorkBinding;
  adopted?: boolean;
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
