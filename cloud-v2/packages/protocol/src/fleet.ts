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
  management: z
    .object({associationId: FleetId, generation: z.number().int().min(0)})
    .strict()
    .optional(),
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
  })
  .strict()
export type FleetRecordResult = z.infer<typeof FleetRecordResultSchema>
export type FleetReportAck = z.infer<typeof FleetReportAckSchema>

/** Whole-response error codes Core and MFM answer with. */
export const FLEET_NOT_INSTALLED = "fleet_not_installed"
export const FLEET_UNAVAILABLE = "fleet_unavailable"
