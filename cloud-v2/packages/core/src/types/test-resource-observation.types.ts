import { z } from "zod";
import { testRunProgressFieldsSchema, validTestRunProgressCounts, type TestRunProgress } from "./test-run-claim.types";

/**
 * Version-one local resource observation: a strict projection of the private
 * harness `readLaneStatus` (runner/lane-status.ts) for one host guard. It is
 * trusted, attributed reporting only. It never admits, reserves, releases,
 * recovers or cancels anything, and it is not proof of hardware control.
 *
 * Deliberately excluded: `scopeCovers`, checkpoint `note`, `caveats`, guard
 * paths, owner tokens, run directories, command lines, environment, errors,
 * free-form messages and device timestamps. The Admin UI supplies fixed wording.
 */

/** Same rule as the harness lane-status reader and app-ownership reservations. */
export const laneIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/);
/** Explicitly configured reporting host ID; never derived from a fixture alias or hostname. */
export const testResourceHostIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
/**
 * `shared`: the Mac app guard covering Mac UI, Mac audio and all glasses pairs.
 * `android-<12 hex>`: one phone-only Android guard, keyed by the existing redacted
 * serial digest (`sha256:<12 hex>` in lane status). Independent of `shared`.
 */
export const testResourceKeySchema = z.string().regex(/^(?:shared|android-[a-f0-9]{12})$/);

export const testResourceLaneStates = [
  "available-to-attempt", "idle-prerequisites-unchecked", "idle-prerequisite-blocked", "idle-prerequisite-unknown",
  "busy", "retained-recovery-required", "stale-unretained-owner", "ownership-changing", "unknown",
] as const;
export type TestResourceLaneState = typeof testResourceLaneStates[number];

/** Every reason `readLaneStatus` can emit, with the only state it is emitted with. */
export const testResourceReasonStates = {
  "owner-unverifiable": "unknown",
  "owner-liveness-unknown": "unknown",
  "reclaim-marker-unreadable": "unknown",
  "no-guard-fixture-not-supplied": "idle-prerequisites-unchecked",
  "owner-process-alive": "busy",
  "dead-retained-reservation": "retained-recovery-required",
  "dead-retained-unclassified-installation": "retained-recovery-required",
  "dead-unretained-owner": "stale-unretained-owner",
  "no-guard-recorded-fixture-ready": "available-to-attempt",
  "recorded-fixture-busy": "idle-prerequisite-blocked",
  "recorded-fixture-recovery-required": "idle-prerequisite-blocked",
  "recorded-fixture-uncommissioned": "idle-prerequisite-blocked",
  "fixture-record-absent": "idle-prerequisite-blocked",
  "fixture-record-malformed": "idle-prerequisite-unknown",
  "fixture-record-unreadable": "idle-prerequisite-unknown",
  "reclaim-marker-present": "ownership-changing",
  "guard-changed-during-observation": "ownership-changing",
} as const satisfies Record<string, TestResourceLaneState>;
export type TestResourceReason = keyof typeof testResourceReasonStates;
const reasons = Object.keys(testResourceReasonStates) as [TestResourceReason, ...TestResourceReason[]];

/** Owner-derived reasons and the probe result each one requires. */
const ownerReasonLiveness = {
  "owner-process-alive": "alive",
  "owner-liveness-unknown": "unknown",
  "dead-retained-reservation": "dead",
  "dead-retained-unclassified-installation": "dead",
  "dead-unretained-owner": "dead",
} as const satisfies Partial<Record<TestResourceReason, "alive" | "dead" | "unknown">>;

const pendingStep = z.object({ phase: z.string().regex(/^[a-z-]{1,40}$/), stepID: laneIdSchema }).strict().nullable();
const reservation = z.object({ runID: laneIdSchema, fixtureID: laneIdSchema }).strict();

export const testResourceObservationSchema = z.object({
  state: z.enum(testResourceLaneStates),
  reason: z.enum(reasons),
  guard: z.object({
    lock: z.enum(["absent", "present", "unreadable"]),
    reclaimMarker: z.enum(["absent", "present", "unknown"]),
  }).strict(),
  owner: z.discriminatedUnion("valid", [
    z.object({ valid: z.literal(false) }).strict(),
    z.object({
      valid: z.literal(true),
      pid: z.number().int().positive().safe(),
      liveness: z.enum(["alive", "dead", "unknown"]),
      retainOnExit: z.boolean(),
      reservation: reservation.nullable(),
      retainedReason: z.enum(["lifecycle-reservation", "unclassified-installation"]).optional(),
    }).strict(),
  ]).optional(),
  lastCheckpoint: z.discriminatedUnion("available", [
    z.object({ available: z.literal(false) }).strict(),
    z.object({
      available: z.literal(true),
      runID: laneIdSchema,
      mode: z.enum(["running", "recovering", "complete"]),
      phase: z.string().regex(/^[a-z-]{1,40}$/),
      pendingOperation: pendingStep,
      pendingReconciliation: pendingStep,
    }).strict(),
  ]).optional(),
  fixture: z.union([
    z.object({ checked: z.literal(false) }).strict(),
    z.object({ checked: z.literal(true), record: z.enum(["absent", "malformed", "unreadable"]) }).strict(),
    z.object({
      checked: z.literal(true),
      record: z.literal("valid"),
      fixtureID: laneIdSchema,
      status: z.enum(["ready", "busy", "recovery-required", "uncommissioned"]),
      lastRunID: laneIdSchema,
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: "custom", message });
  if (testResourceReasonStates[value.reason] !== value.state) problem("reason does not belong to state");
  // An owner record is read exactly when the guard file is present.
  if ((value.guard.lock === "present") !== Boolean(value.owner)) problem("owner must match guard presence");
  // Idle states are only derived when no guard file was present.
  if (value.state.startsWith("idle-") || value.state === "available-to-attempt") {
    if (value.guard.lock !== "absent") problem("idle state requires an absent guard");
  }
  const owner = value.owner?.valid ? value.owner : undefined;
  const liveness = ownerReasonLiveness[value.reason as keyof typeof ownerReasonLiveness];
  if (liveness && owner?.liveness !== liveness) problem("owner liveness does not match reason");
  if (value.reason === "owner-unverifiable" && owner) problem("a valid owner is verifiable");
  if (value.reason === "dead-retained-reservation" && !owner?.reservation) problem("reason requires a reservation");
  if (value.reason === "dead-retained-unclassified-installation" && (!owner?.retainOnExit || owner.reservation))
    problem("reason requires a retained owner without a reservation");
  if (value.reason === "dead-unretained-owner" && owner?.retainOnExit) problem("reason requires an unretained owner");
  if (owner) {
    if (owner.reservation && !owner.retainOnExit) problem("a reservation requires retainOnExit");
    const retained = owner.retainOnExit ? owner.reservation ? "lifecycle-reservation" : "unclassified-installation" : undefined;
    if (owner.retainedReason !== retained) problem("retainedReason does not match the owner record");
  }
  // A checkpoint is only read from the valid owner's reservation.
  if (value.lastCheckpoint && !owner?.reservation) problem("checkpoint requires an owner reservation");
  if (owner?.reservation && !value.lastCheckpoint) problem("owner reservation requires a checkpoint observation");
  if (value.lastCheckpoint?.available && value.lastCheckpoint.runID !== owner?.reservation?.runID)
    problem("checkpoint belongs to another run");
  const fixture = value.fixture;
  const recorded = fixture.checked && fixture.record === "valid" ? fixture.status : undefined;
  if (value.reason === "no-guard-recorded-fixture-ready" && recorded !== "ready") problem("fixture state does not match reason");
  if (value.reason.startsWith("recorded-fixture-") && value.reason !== `recorded-fixture-${recorded}`) problem("fixture state does not match reason");
  if (value.reason.startsWith("fixture-record-") && value.reason !== `fixture-record-${fixture.checked ? fixture.record : ""}`)
    problem("fixture record does not match reason");
  if (value.reason === "no-guard-fixture-not-supplied" && fixture.checked) problem("fixture was checked");
});

/**
 * The existing lifecycle progress projection for the observed owner's run. The
 * committed journal `sequence` is the only ordering authority within one run.
 */
export const testResourceProgressSchema = testRunProgressFieldsSchema.extend({ runId: laneIdSchema })
  .refine(validTestRunProgressCounts, "completed steps exceed phase total");

export const testResourceObservationPutSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: testResourceHostIdSchema,
  resourceKey: testResourceKeySchema,
  /** The revision returned by the GET that preceded this fresh observation. */
  expectedRevision: z.number().int().min(0).safe(),
  observation: testResourceObservationSchema,
  progress: testResourceProgressSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const owner = value.observation.owner?.valid ? value.observation.owner : undefined;
  if (value.progress && value.progress.runId !== owner?.reservation?.runID)
    ctx.addIssue({ code: "custom", message: "progress must belong to the observed owner's reservation" });
});

export type TestResourceObservation = z.infer<typeof testResourceObservationSchema>;
export type TestResourceProgress = TestRunProgress & { runId: string };
/** `receivedAt` is Core time when this journal sequence was first accepted. */
export type TestResourceProgressCheckpoint = TestResourceProgress & { receivedAt: string };
export type TestResourceObservationPut = z.infer<typeof testResourceObservationPutSchema>;

/** GET/PUT response. Revision 0 with a null observation means nothing was reported. */
export interface TestResourceObservationRecord {
  schemaVersion: 1;
  hostId: string;
  resourceKey: string;
  revision: number;
  /** Core receipt time of this revision; device clocks are never used. */
  receivedAt: string | null;
  observation: TestResourceObservation | null;
  progress: TestResourceProgressCheckpoint | null;
}
export interface TestResourceObservationPutResponse extends TestResourceObservationRecord {
  /** False for an exact retry of the request that already produced this revision. */
  applied: boolean;
}
