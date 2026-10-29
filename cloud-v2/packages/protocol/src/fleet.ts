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
  maxTelemetryLossPackages: 500,
  maxCrashesInWindow: 1_000,
  maxReconnectMs: 7 * 24 * 60 * 60 * 1000,
} as const

/**
 * Phase 12: a miniapp's own events. The Mentra App applies these before it queues an event (dropping the event, a
 * property, or cutting a string) and MFM checks them again, rejecting a record that still breaks one.
 */
export const FLEET_TELEMETRY_LIMITS = {
  maxProperties: 25,
  maxStringValueLength: 64,
  eventsPerMinute: 60,
  eventsPerDay: 2_000,
  /** Places of the phone's queue telemetry may hold; when full, the oldest telemetry record gives way. */
  queueShare: 2_000,
} as const
/** An event or property name: 1-64 lowercase letters, digits and underscores, starting with a letter. */
export const FLEET_TELEMETRY_NAME = /^[a-z][a-z0-9_]{0,63}$/

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
  "phone_battery",
  // Phase 12. A record kind the phone can produce is declared, so a view tells a measured 0 from an unknown.
  "miniapp_failures",
  "glasses_connectivity",
  "miniapp_telemetry",
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
        /** The phone's own battery; absent from an app that does not report one. */
        battery: Battery.optional(),
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

/** Phase 12: why a launch failed. Codes only, never error text. */
export const FLEET_LAUNCH_FAILURE_REASONS = [
  "bundle_missing",
  "incompatible_host",
  "policy_blocked",
  "spawn_failed",
  "connect_timeout",
  "permission_denied",
  "unknown",
] as const
export type FleetLaunchFailureReason = (typeof FLEET_LAUNCH_FAILURE_REASONS)[number]

export const FleetLaunchPayloadSchema = z
  .object({
    packageName: FleetText,
    miniappName: FleetText.optional(),
    versionName: FleetText.optional(),
    start: z.enum(["user", "automatic"]),
    outcome: z.enum(["started", "failed"]),
    /** Phase 12. Only a failed launch carries it; a Mentra App from before Phase 12 sends none. */
    failureReason: z.enum(FLEET_LAUNCH_FAILURE_REASONS).optional(),
  })
  .strict()
  .refine((v) => v.failureReason === undefined || v.outcome === "failed", {
    path: ["failureReason"],
    message: "only a failed launch carries a failureReason",
  })

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

const TelemetryName = z.string().regex(FLEET_TELEMETRY_NAME)
const TelemetryValue = z.union([
  z.string().max(FLEET_TELEMETRY_LIMITS.maxStringValueLength),
  z.number().finite(),
  z.boolean(),
])

/** Phase 12: one event a miniapp captured, attributed by the Mentra App to the miniapp whose bridge sent it. */
export const FleetTelemetryEventPayloadSchema = z
  .object({
    packageName: FleetText,
    versionName: FleetText.optional(),
    /** The miniapp's execution session at capture (its `miniapp_execution` activitySessionId), when one was open. */
    executionSessionId: FleetId.optional(),
    event: TelemetryName,
    properties: z
      .record(TelemetryName, TelemetryValue)
      .refine((p) => Object.keys(p).length <= FLEET_TELEMETRY_LIMITS.maxProperties, "too many properties"),
    /** Properties the Mentra App dropped from this event (bad name or value, or past the 25th). */
    droppedProperties: z.number().int().min(0).max(1_000_000),
    /** String values the Mentra App cut to 64 characters. */
    cutValues: z.number().int().min(0).max(FLEET_TELEMETRY_LIMITS.maxProperties),
  })
  .strict()

/** What the Mentra App lost of one miniapp's telemetry. */
export const FleetTelemetryLossSchema = z
  .object({
    packageName: FleetText,
    /** Over the name, rate or daily limit. */
    overLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Given way in the queue to newer telemetry. */
    evicted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Too old in the queue to send. */
    expired: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** Sent, and rejected by MFM. */
    rejected: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((v) => v.overLimit + v.evicted + v.expired + v.rejected > 0, "a loss counts something")

/** Phase 12: telemetry the Mentra App lost over a period, per miniapp. Never a coverage gap. */
export const FleetTelemetryLossPayloadSchema = z
  .object({
    from: FleetUtcTime,
    to: FleetUtcTime,
    losses: z.array(FleetTelemetryLossSchema).min(1).max(FLEET_LIMITS.maxTelemetryLossPackages),
  })
  .strict()
  .refine((v) => Date.parse(v.from) <= Date.parse(v.to), {path: ["to"], message: "to is not before from"})

export const FLEET_CRASH_SURFACES = ["context", "webview"] as const
export const FLEET_CRASH_CATEGORIES = [
  "uncaught_exception",
  "bridge_error",
  "unresponsive",
  "watchdog_kill",
  "content_process_terminated",
  "unknown",
] as const
export type FleetCrashCategory = (typeof FLEET_CRASH_CATEGORIES)[number]
/**
 * What followed a crash: the engine restarts the miniapp, or stops restarting it after repeated crashes, or (a screen
 * whose content process died) the screen closes and nothing restarts it until the person opens it again.
 */
export const FLEET_CRASH_OUTCOMES = ["respawn_scheduled", "crash_loop_stopped", "closed"] as const

/** Phase 12: one miniapp crash. The engine maps its reason to a category; the reason text never leaves the phone. */
export const FleetMiniappCrashPayloadSchema = z
  .object({
    packageName: FleetText,
    versionName: FleetText.optional(),
    executionSessionId: FleetId.optional(),
    surface: z.enum(FLEET_CRASH_SURFACES),
    category: z.enum(FLEET_CRASH_CATEGORIES),
    outcome: z.enum(FLEET_CRASH_OUTCOMES),
    /** Crashes of this miniapp in the crash window, this one included. */
    crashesInWindow: z.number().int().min(1).max(FLEET_LIMITS.maxCrashesInWindow),
  })
  .strict()

export const FLEET_INSTALL_OPERATIONS = ["install", "update", "remove"] as const
/** What started an install: `url` covers a link, the QR scanner, the paste box, the system list and the update check. */
export const FLEET_INSTALL_SOURCES = ["bundled", "url", "manifest", "local", "assignment"] as const
export const FLEET_INSTALL_OUTCOMES = ["succeeded", "failed", "deferred"] as const
/** `assignment_outcome`'s reasons where they apply, and three of its own. */
export const FLEET_INSTALL_FAILURE_REASONS = [...FLEET_ASSIGNMENT_REASONS, "network", "user_cancelled", "unknown"] as const
export type FleetInstallFailureReason = (typeof FLEET_INSTALL_FAILURE_REASONS)[number]

/** Phase 12: one install, update or removal attempt, managed or not. */
export const FleetMiniappInstallPayloadSchema = z
  .object({
    packageName: FleetText,
    operation: z.enum(FLEET_INSTALL_OPERATIONS),
    source: z.enum(FLEET_INSTALL_SOURCES),
    fromVersion: FleetText.optional(),
    toVersion: FleetText.optional(),
    outcome: z.enum(FLEET_INSTALL_OUTCOMES),
    reason: z.enum(FLEET_INSTALL_FAILURE_REASONS).optional(),
  })
  .strict()
  .refine((v) => (v.outcome === "succeeded") === (v.reason === undefined), {
    path: ["reason"],
    message: "a failed or deferred attempt carries its reason, and only it",
  })

export const FLEET_CONNECTION_EVENTS = ["pair_failed", "connect_failed", "disconnected", "reconnected"] as const
export type FleetConnectionEventKind = (typeof FLEET_CONNECTION_EVENTS)[number]
export const FLEET_CONNECTION_CATEGORIES = [
  "bluetooth_off",
  "permission_denied",
  "bond_failed",
  "not_found",
  "timeout",
  "firmware_incompatible",
  "link_lost",
  "user_action",
  "unknown",
] as const
export type FleetConnectionCategory = (typeof FLEET_CONNECTION_CATEGORIES)[number]

/**
 * Phase 12: a pairing or connection change. A disconnect the person asked for is `user_action`, and is not shown as a
 * problem. The glasses are the record's `deviceBinding` when the phone knows them.
 */
export const FleetConnectionEventPayloadSchema = z
  .object({
    event: z.enum(FLEET_CONNECTION_EVENTS),
    category: z.enum(FLEET_CONNECTION_CATEGORIES),
    glassesModel: FleetText.optional(),
    appVersion: FleetText,
    /** How long the reconnect took, for `reconnected` only. */
    reconnectMs: z.number().int().min(0).max(FLEET_LIMITS.maxReconnectMs).optional(),
  })
  .strict()
  .refine((v) => (v.event === "reconnected") === (v.reconnectMs !== undefined), {
    path: ["reconnectMs"],
    message: "a reconnect carries the time it took, and only it",
  })

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
  z.object({...base, kind: z.literal("telemetry_event"), payload: FleetTelemetryEventPayloadSchema}).strict(),
  z.object({...base, kind: z.literal("telemetry_loss"), payload: FleetTelemetryLossPayloadSchema}).strict(),
  z.object({...base, kind: z.literal("miniapp_crash"), payload: FleetMiniappCrashPayloadSchema}).strict(),
  z.object({...base, kind: z.literal("miniapp_install"), payload: FleetMiniappInstallPayloadSchema}).strict(),
  z
    .object({
      ...base,
      kind: z.literal("connection_event"),
      deviceBinding: FleetDeviceBindingSchema.optional(),
      payload: FleetConnectionEventPayloadSchema,
    })
    .strict(),
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
export type FleetLaunchPayload = z.infer<typeof FleetLaunchPayloadSchema>
export type FleetTelemetryEventPayload = z.infer<typeof FleetTelemetryEventPayloadSchema>
export type FleetTelemetryLossPayload = z.infer<typeof FleetTelemetryLossPayloadSchema>
export type FleetMiniappCrashPayload = z.infer<typeof FleetMiniappCrashPayloadSchema>
export type FleetMiniappInstallPayload = z.infer<typeof FleetMiniappInstallPayloadSchema>
export type FleetConnectionEventPayload = z.infer<typeof FleetConnectionEventPayloadSchema>

/** Whole-response error codes Core and MFM answer with. */
export const FLEET_NOT_INSTALLED = "fleet_not_installed"
export const FLEET_UNAVAILABLE = "fleet_unavailable"
