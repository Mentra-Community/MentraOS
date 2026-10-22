/**
 * @fileoverview The Fleet report and acknowledgement contract.
 *
 * The Mentra App reports what a phone and its glasses did to the organization's Fleet service (MFM), through the
 * phone's own Core. The reporter (via `@mentra/cloud-client`) and MFM both parse with these schemas, so this file is
 * the one definition of what may cross that wire.
 *
 * Records are validated one at a time. The envelope accepts any record shape so that one bad record is rejected on
 * its own, and never strands the rest of its batch.
 */
import {z} from "zod"

export const FLEET_SCHEMA_VERSION = 1 as const

export const FLEET_LIMITS = {
  maxRecordsPerBatch: 500,
  maxBatchBytes: 1_048_576,
  maxSessionsPerCheckpoint: 32,
  maxSessionElapsedMs: 7 * 24 * 60 * 60 * 1000,
  maxInventoryMiniapps: 500,
  maxAssignmentEntries: 500,
  phoneQueueMaxRecords: 10_000,
  phoneQueueMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  replayWindowMs: 14 * 24 * 60 * 60 * 1000,
  maxFutureSkewMs: 5 * 60 * 1000,
} as const

const FleetId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const FLEET_UTC_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/

/**
 * Whether `value` names a real instant. `Date.parse` alone is not enough: it normalizes a calendar-invalid date (such
 * as `2025-02-30`) to a later instant, and accepts `24:00:00`. So the parsed instant is formatted back and must
 * reproduce every field of the input, with a missing or short fraction read as milliseconds.
 */
function isRoundTripUtcTime(value: string): boolean {
  const match = FLEET_UTC_TIME.exec(value)
  if (!match) return false
  const instant = Date.parse(value)
  if (Number.isNaN(instant)) return false
  return new Date(instant).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`
}

/** RFC 3339 UTC with a `Z`; a numeric offset, a calendar-invalid date, `24:00:00` and a leap second are refused. */
const FleetUtcTime = z.string().regex(FLEET_UTC_TIME).refine(isRoundTripUtcTime, "not a date")
const FleetText = z.string().min(1).max(128)

export const FleetDeviceBindingSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("serial"), manufacturer: FleetText, product: FleetText, serial: FleetText}).strict(),
  z.object({kind: z.literal("provisional"), bindingId: FleetId, product: FleetText}).strict(),
])

export const FLEET_CAPABILITIES = [
  "glasses_connection",
  "glasses_battery",
  "glasses_versions",
  "miniapp_execution",
  "app_foreground",
  "engine_active",
  "photo_operations",
] as const

const Battery = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("measured"),
      observedAt: FleetUtcTime,
      level: z.number().int().min(0).max(100),
      charging: z.boolean().optional(),
    })
    .strict(),
  z.object({state: z.literal("unsupported"), observedAt: FleetUtcTime}).strict(),
  z.object({state: z.literal("unknown"), observedAt: FleetUtcTime}).strict(),
])

export const FleetSnapshotPayloadSchema = z
  .object({
    phone: z
      .object({
        model: FleetText.optional(),
        os: z.enum(["ios", "android"]),
        osVersion: FleetText,
        appVersion: FleetText,
        appBuild: FleetText,
        engineVersion: FleetText.optional(),
        sdkVersion: FleetText.optional(),
      })
      .strict(),
    glasses: z
      .object({
        model: FleetText,
        firmware: z
          .object({
            apk: FleetText.optional(),
            mtk: FleetText.optional(),
            bes: FleetText.optional(),
            os: FleetText.optional(),
          })
          .strict()
          .optional(),
        connection: z
          .object({state: z.enum(["connected", "disconnected", "connecting", "unknown"]), observedAt: FleetUtcTime})
          .strict(),
        battery: Battery.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const FleetLaunchPayloadSchema = z
  .object({
    packageName: FleetText,
    miniappName: FleetText.optional(),
    versionName: FleetText.optional(),
    start: z.enum(["user", "automatic"]),
    outcome: z.enum(["started", "failed"]),
  })
  .strict()

export const FLEET_ACTIVITIES = ["glasses_connection", "miniapp_execution", "app_foreground", "engine_active"] as const
export const FleetActivityCheckpointSchema = z
  .object({
    activity: z.enum(FLEET_ACTIVITIES),
    activitySessionId: FleetId,
    packageName: FleetText.optional(),
    deviceBinding: FleetDeviceBindingSchema.optional(),
    startedAt: FleetUtcTime,
    /** Cumulative monotonic elapsed time of this session, never wall-clock subtraction. */
    elapsedMs: z.number().int().min(0).max(FLEET_LIMITS.maxSessionElapsedMs),
    ended: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.activity === "miniapp_execution") !== (value.packageName !== undefined))
      ctx.addIssue({code: "custom", message: "packageName is required for, and only for, miniapp_execution"})
    if ((value.activity === "glasses_connection") !== (value.deviceBinding !== undefined))
      ctx.addIssue({code: "custom", message: "deviceBinding is required for, and only for, glasses_connection"})
  })
export type FleetActivity = (typeof FLEET_ACTIVITIES)[number]
export const FleetUsagePayloadSchema = z
  .object({
    sessions: z.array(FleetActivityCheckpointSchema).min(1).max(FLEET_LIMITS.maxSessionsPerCheckpoint),
  })
  .strict()

export const FleetPhotoPayloadSchema = z
  .object({
    stage: z.enum(["requested", "captured", "delivered", "failed"]),
    failedStage: z.enum(["requested", "captured", "delivered"]).optional(),
  })
  .strict()
  .refine((v) => (v.stage === "failed") === (v.failedStage !== undefined), "failedStage goes with stage failed")

/** The provisioning spec's installation reasons. Management reasons are kept apart from the artifact's provenance. */
export const FLEET_INSTALL_REASONS = ["bundled", "explicit", "manifest", "assignment"] as const
export type FleetInstallReason = (typeof FLEET_INSTALL_REASONS)[number]

/** Phase 11: the phone's installed miniapps. Sent when the collector starts and whenever the inventory changes. */
export const FleetMiniappInventoryPayloadSchema = z
  .object({
    miniapps: z
      .array(
        z
          .object({
            packageName: FleetText,
            versionName: FleetText,
            digest: FleetText,
            reasons: z.array(z.enum(FLEET_INSTALL_REASONS)).min(1).max(FLEET_INSTALL_REASONS.length),
          })
          .strict(),
      )
      .max(FLEET_LIMITS.maxInventoryMiniapps),
  })
  .strict()

/** The provisioning spec's outcome states for one assignment on one phone. */
export const FLEET_ASSIGNMENT_STATES = [
  "pending",
  "deferred_running",
  "downloading",
  "installing",
  "installed",
  "blocked",
  "retrying",
  "withdrawn",
] as const
export type FleetAssignmentState = (typeof FLEET_ASSIGNMENT_STATES)[number]

/** Stable reasons for a blocked or retrying assignment. Never error text. */
export const FLEET_ASSIGNMENT_REASONS = [
  "archived",
  "access_denied",
  "not_a_miniapp",
  "download_failed",
  "signature_invalid",
  "incompatible_host",
  "newer_version_installed",
  "manifest_conflict",
  "storage_full",
] as const
export type FleetAssignmentReason = (typeof FLEET_ASSIGNMENT_REASONS)[number]

/** A miniapp's address: https, bounded, and with no credentials in it. */
export const FleetMiniappUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === "https:" && url.username === "" && url.password === ""
    } catch {
      return false
    }
  }, "a miniapp URL is an https address without credentials")

const FleetRevision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

/** Phase 11: one assignment's state on this phone. */
export const FleetAssignmentOutcomePayloadSchema = z
  .object({
    assignmentId: FleetId,
    /** The assignment's own revision. */
    assignmentRevision: FleetRevision,
    /** The account's desired-state revision the phone acted on. */
    desiredRevision: FleetRevision,
    packageName: FleetText,
    state: z.enum(FLEET_ASSIGNMENT_STATES),
    reason: z.enum(FLEET_ASSIGNMENT_REASONS).optional(),
    selectedVersion: FleetText.optional(),
    installedVersion: FleetText.optional(),
    attempts: z.number().int().min(0).max(1_000_000),
    attemptedAt: FleetUtcTime,
    lastSuccessAt: FleetUtcTime.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "blocked" && value.reason === undefined)
      ctx.addIssue({code: "custom", path: ["reason"], message: "a blocked assignment carries its reason"})
    if (value.state !== "blocked" && value.state !== "retrying" && value.reason !== undefined)
      ctx.addIssue({code: "custom", path: ["reason"], message: "only a blocked or retrying assignment carries a reason"})
  })

export const FleetCoverageGapPayloadSchema = z
  .object({
    reason: z.enum(["queue_dropped", "queue_expired", "clock_untrusted", "reporter_stopped", "record_rejected"]),
    from: FleetUtcTime,
    to: FleetUtcTime,
    droppedRecordCount: z.number().int().min(0).optional(),
  })
  .strict()

const base = {
  schemaVersion: z.literal(FLEET_SCHEMA_VERSION),
  recordId: FleetId,
  phoneDeviceId: FleetId,
  collectorSessionId: FleetId,
  sequence: z.number().int().min(0),
  observedAt: FleetUtcTime,
  capabilities: z.array(z.enum(FLEET_CAPABILITIES)).max(FLEET_CAPABILITIES.length),
}
export const FleetRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("snapshot"),
      deviceBinding: FleetDeviceBindingSchema.optional(),
      payload: FleetSnapshotPayloadSchema,
    })
    .strict(),
  z.object({...base, kind: z.literal("miniapp_launch"), payload: FleetLaunchPayloadSchema}).strict(),
  z.object({...base, kind: z.literal("usage_checkpoint"), payload: FleetUsagePayloadSchema}).strict(),
  z
    .object({
      ...base,
      kind: z.literal("photo_operation"),
      operationId: FleetId,
      deviceBinding: FleetDeviceBindingSchema,
      payload: FleetPhotoPayloadSchema,
    })
    .strict(),
  z.object({...base, kind: z.literal("coverage_gap"), payload: FleetCoverageGapPayloadSchema}).strict(),
  z.object({...base, kind: z.literal("miniapp_inventory"), payload: FleetMiniappInventoryPayloadSchema}).strict(),
  z.object({...base, kind: z.literal("assignment_outcome"), payload: FleetAssignmentOutcomePayloadSchema}).strict(),
]).superRefine((value, ctx) => {
  // A snapshot's glasses belong to the pair its binding names, so the two come together.
  if (value.kind === "snapshot" && (value.payload.glasses !== undefined) !== (value.deviceBinding !== undefined))
    ctx.addIssue({
      code: "custom",
      path: ["deviceBinding"],
      message: "deviceBinding is required for, and only for, a snapshot that includes glasses",
    })
})
export type FleetRecord = z.infer<typeof FleetRecordSchema>
export type FleetDeviceBinding = z.infer<typeof FleetDeviceBindingSchema>

/** The envelope. Records are validated one at a time, so one bad record cannot strand a batch. */
export const FleetReportSchema = z
  .object({
    schemaVersion: z.literal(FLEET_SCHEMA_VERSION),
    records: z.array(z.unknown()).min(1).max(FLEET_LIMITS.maxRecordsPerBatch),
  })
  .strict()
export type FleetReport = {schemaVersion: 1; records: FleetRecord[]}

export const FLEET_REJECT_REASONS = [
  "schema_invalid",
  "unsupported_schema_version",
  "content_mismatch",
  "outside_replay_window",
  "timestamp_out_of_bounds",
  "account_deleted",
] as const
export const FleetRecordResultSchema = z
  .object({
    index: z.number().int().min(0),
    recordId: FleetId.optional(),
    status: z.enum(["accepted", "duplicate", "retryable", "rejected"]),
    reasonCode: z.enum(FLEET_REJECT_REASONS).optional(),
    retryAfterSeconds: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "rejected") !== (value.reasonCode !== undefined))
      ctx.addIssue({code: "custom", message: "reasonCode is required for, and only for, status rejected"})
  })
export const FleetReportAckSchema = z
  .object({
    schemaVersion: z.literal(FLEET_SCHEMA_VERSION),
    results: z.array(FleetRecordResultSchema),
    /**
     * The account's current desired-state revision (Phase 11). A phone holding an older one fetches desired state at
     * once; there is no push channel. Optional so an acknowledgment from an older MFM still parses.
     */
    revision: FleetRevision.optional(),
  })
  .strict()
export type FleetRecordResult = z.infer<typeof FleetRecordResultSchema>
export type FleetReportAck = z.infer<typeof FleetReportAckSchema>

/**
 * Desired state, as MFM answers a phone through Core (`GET /api/client/fleet/desired-state`). Every answer carries one
 * monotonic per-account `revision` and its generation time.
 *
 * - `managed`: the account's workspace and the assignment entries, which may be empty. A member of a workspace with
 *   nothing assigned is still managed.
 * - `unmanaged`: the account belongs to no workspace. Authoritative: the phone clears its assignment reasons.
 *
 * An error, timeout, partial response or missing MFM is never an empty set: MFM answers {@link FLEET_UNAVAILABLE}
 * (503) and the phone keeps its last complete snapshot. `paused` (Phase 15) is not part of this schema, so a phone
 * that receives an unknown status keeps its last snapshot.
 */
export const FleetDesiredStateEntrySchema = z
  .object({
    assignmentId: FleetId,
    revision: FleetRevision,
    /** The miniapp's own URL (Mentra-Specs #140). The phone installs it with `installMiniapp(url)` and takes the version it serves. */
    url: FleetMiniappUrl,
    /** The package the URL's manifest named when it was assigned. Display and matching only; the URL decides what installs. */
    packageName: FleetText,
    selection: z.literal("latest"),
  })
  .strict()

export const FleetDesiredStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("managed"),
      revision: FleetRevision,
      generatedAt: FleetUtcTime,
      workspace: z.object({workspaceId: FleetId, name: z.string().min(1).max(200)}).strict(),
      entries: z.array(FleetDesiredStateEntrySchema).max(FLEET_LIMITS.maxAssignmentEntries),
    })
    .strict(),
  z.object({status: z.literal("unmanaged"), revision: FleetRevision, generatedAt: FleetUtcTime}).strict(),
])
export type FleetDesiredStateEntry = z.infer<typeof FleetDesiredStateEntrySchema>
export type FleetDesiredState = z.infer<typeof FleetDesiredStateSchema>
export type FleetMiniappInventoryPayload = z.infer<typeof FleetMiniappInventoryPayloadSchema>
export type FleetAssignmentOutcomePayload = z.infer<typeof FleetAssignmentOutcomePayloadSchema>

/** Whole-response error codes Core and MFM answer with. */
export const FLEET_NOT_INSTALLED = "fleet_not_installed"
export const FLEET_UNAVAILABLE = "fleet_unavailable"
