import {createHash, createHmac} from "node:crypto"
import {createLogger} from "@mentra/cloud-shared"
import {SupportProfileModel} from "../models/support-profile.model"
import {UserModel} from "../models/user.model"
import {getUserById} from "./account/gotrue.client"

export const SUPPORT_DEVICE_HISTORY_LIMIT = 12
export const SUPPORT_IDENTICAL_UPDATE_MIN_MS = 60_000
const CAPTURE_TIMEOUT_MS = 10_000
const logger = createLogger("core").child({service: "support-profile"})

export interface SupportStateInput {
  observedAt: string
  host: {
    appVersion?: string
    appBuild?: string
    engineVersion?: string
    bluetoothSdkVersion?: string
    phonePlatform: "ios" | "android" | "unknown"
    phoneModel?: string
    phoneOsVersion?: string
    connectionState: "disconnected" | "scanning" | "connecting" | "bonding" | "connected"
    failureCode?: string
    failureStage?: string
  }
  device?: {
    hardwareId?: string
    model?: string
    androidVersion?: string
    firmwareVersion?: string
    mtkFirmwareVersion?: string
    besFirmwareVersion?: string
    appVersion?: string
    buildNumber?: string
  }
}

export interface SupportProfileUpdateResult {
  status: "accepted" | "deduplicated" | "stale"
  observedAt: string
}

export class SupportProfileAccountDeletedError extends Error {
  constructor() {
    super("account is deleted")
  }
}

type StoredDevice = {
  deviceKey: string
  model: string | null
  androidVersion: string | null
  firmwareVersion: string | null
  mtkFirmwareVersion: string | null
  besFirmwareVersion: string | null
  appVersion: string | null
  buildNumber: string | null
  firstSeenAt: Date
  lastSeenAt: Date
  lastConnectedAt: Date | null
  observedAt: Date
}

/**
 * Last-write-wins support snapshot. This is an operational read model, not an
 * event log: concurrent phone writes may overwrite each other and that is
 * fine — support only ever needs the latest picture.
 */
export async function updateSupportProfile(
  identity: {mentraUserId: string; tenantId: string},
  input: SupportStateInput,
): Promise<SupportProfileUpdateResult> {
  // The unique mentraUserId index must exist before upserts can race safely.
  await SupportProfileModel.init()
  await assertActiveOrCleanup(identity.mentraUserId)
  const observedAt = new Date(input.observedAt)
  const receivedAt = new Date()
  const fingerprint = fingerprintFor(input)

  // Two concurrent first-ever writes can both attempt the insert half of the
  // upsert; the unique index turns the loser into a single retry.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await SupportProfileModel.findOne({mentraUserId: identity.mentraUserId}).lean()
    if (current) {
      if (observedAt < current.host.observedAt) {
        return {status: "stale", observedAt: current.host.observedAt.toISOString()}
      }
      if (
        current.lastFingerprint === fingerprint &&
        receivedAt.getTime() - current.lastAcceptedAt.getTime() < SUPPORT_IDENTICAL_UPDATE_MIN_MS
      ) {
        return {status: "deduplicated", observedAt: current.host.observedAt.toISOString()}
      }
    }

    const deviceKey = input.device ? deriveDeviceKey(input.device.hardwareId, input.device.model) : null
    const recordConnectedAt = shouldRecordConnectedAt(
      current?.host.connectionState ?? "disconnected",
      current?.currentDeviceKey ?? null,
      input.host.connectionState,
      deviceKey,
    )
    const device = input.device ? toStoredDevice(input.device, observedAt, recordConnectedAt) : null
    const devices = mergeDevice((current?.devices as unknown as StoredDevice[]) ?? [], device)
    const host = toStoredHost(input, observedAt, receivedAt)
    const currentDeviceKey = device?.deviceKey ?? current?.currentDeviceKey ?? null
    const next = {host, devices, currentDeviceKey}
    try {
      await SupportProfileModel.updateOne(
        {
          "mentraUserId": identity.mentraUserId,
          // Freshness guard for racing writes: an older observation must not
          // overwrite a newer snapshot. When it loses the race the filter
          // matches nothing, the upsert insert trips the unique index, and
          // the retry re-reads (usually answering "stale").
          "host.observedAt": {$lte: observedAt},
        },
        {
          $set: {
            tenantId: identity.tenantId,
            host,
            devices,
            currentDeviceKey,
            lastFingerprint: fingerprint,
            lastAcceptedAt: receivedAt,
          },
        },
        {upsert: true},
      )
    } catch (error) {
      if ((error as {code?: number})?.code === 11000 && attempt === 0) continue
      throw error
    }
    await assertActiveOrCleanup(identity.mentraUserId)
    // Analytics is best-effort fire-and-forget: a lost PostHog event never
    // fails, delays, or retries against the canonical profile write.
    void captureMeaningfulTransitions(identity.mentraUserId, current, next, receivedAt)
    return {status: "accepted", observedAt: observedAt.toISOString()}
  }
  // Three-plus same-user writes racing is pathological. Answer with the
  // settled snapshot as "stale" instead of surfacing a 500; the phone retries
  // with a fresh observation.
  const settled = await SupportProfileModel.findOne({mentraUserId: identity.mentraUserId}).lean()
  return {status: "stale", observedAt: settled?.host.observedAt.toISOString() ?? input.observedAt}
}

export function fingerprintFor(input: SupportStateInput): string {
  const device = input.device
    ? {
        ...withoutHardwareId(input.device),
        deviceKey: deriveDeviceKey(input.device.hardwareId, input.device.model),
      }
    : undefined
  return createHash("sha256")
    .update(JSON.stringify({host: input.host, device}))
    .digest("hex")
}

export function deriveDeviceKey(hardwareId: string | undefined, model: string | undefined): string {
  const secret = process.env.SUPPORT_DEVICE_ID_HMAC_KEY?.trim()
  if (hardwareId?.trim() && secret) {
    return `hd_${createHmac("sha256", secret).update(hardwareId.trim()).digest("hex")}`
  }
  const normalizedModel = model?.trim().toLowerCase() || "unknown"
  return `model_${createHash("sha256").update(normalizedModel).digest("hex").slice(0, 24)}`
}

export function meaningfulTransitions(previous: any | null, next: any): string[] {
  if (!previous) return ["support_profile_created"]
  const events: string[] = []
  const beforeConnection = previous.host.connectionState
  const afterConnection = next.host.connectionState
  if (beforeConnection !== afterConnection) {
    if (afterConnection === "connected") events.push("support_glasses_connected")
    else if (beforeConnection === "connected") events.push("support_glasses_disconnected")
    else events.push("support_connection_changed")
  }
  const hostFields = [
    "appVersion",
    "appBuild",
    "engineVersion",
    "bluetoothSdkVersion",
    "phonePlatform",
    "phoneModel",
    "phoneOsVersion",
  ]
  const hostChanged = hostFields.some((field) => previous.host[field] !== next.host[field])
  const previousDevice = currentDevice(previous)
  const nextDevice = currentDevice(next)
  const deviceFields = [
    "deviceKey",
    "model",
    "androidVersion",
    "firmwareVersion",
    "mtkFirmwareVersion",
    "besFirmwareVersion",
    "appVersion",
    "buildNumber",
  ]
  const deviceChanged = deviceFields.some((field) => previousDevice?.[field] !== nextDevice?.[field])
  if (hostChanged || deviceChanged) events.push("support_software_changed")
  if (next.host.failureCode && next.host.failureCode !== previous.host.failureCode) {
    events.push("support_failure_observed")
  }
  return events
}

export function shouldRecordConnectedAt(
  previousState: SupportStateInput["host"]["connectionState"],
  previousDeviceKey: string | null,
  nextState: SupportStateInput["host"]["connectionState"],
  nextDeviceKey: string | null,
): boolean {
  return nextState === "connected" && (previousState !== "connected" || previousDeviceKey !== nextDeviceKey)
}

function toStoredHost(input: SupportStateInput, observedAt: Date, receivedAt: Date) {
  return {
    appVersion: input.host.appVersion ?? null,
    appBuild: input.host.appBuild ?? null,
    engineVersion: input.host.engineVersion ?? null,
    bluetoothSdkVersion: input.host.bluetoothSdkVersion ?? null,
    phonePlatform: input.host.phonePlatform,
    phoneModel: input.host.phoneModel ?? null,
    phoneOsVersion: input.host.phoneOsVersion ?? null,
    connectionState: input.host.connectionState,
    failureCode: input.host.failureCode ?? null,
    failureStage: input.host.failureStage ?? null,
    observedAt,
    receivedAt,
  }
}

function toStoredDevice(
  input: NonNullable<SupportStateInput["device"]>,
  observedAt: Date,
  recordConnectedAt: boolean,
): StoredDevice {
  return {
    deviceKey: deriveDeviceKey(input.hardwareId, input.model),
    model: input.model ?? null,
    androidVersion: input.androidVersion ?? null,
    firmwareVersion: input.firmwareVersion ?? null,
    mtkFirmwareVersion: input.mtkFirmwareVersion ?? null,
    besFirmwareVersion: input.besFirmwareVersion ?? null,
    appVersion: input.appVersion ?? null,
    buildNumber: input.buildNumber ?? null,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    lastConnectedAt: recordConnectedAt ? observedAt : null,
    observedAt,
  }
}

function mergeDevice(devices: StoredDevice[], incoming: StoredDevice | null): StoredDevice[] {
  if (!incoming) return devices
  const existing = devices.find((device) => device.deviceKey === incoming.deviceKey)
  const merged: StoredDevice = existing
    ? {
        ...incoming,
        model: incoming.model ?? existing.model,
        androidVersion: incoming.androidVersion ?? existing.androidVersion,
        firmwareVersion: incoming.firmwareVersion ?? existing.firmwareVersion,
        mtkFirmwareVersion: incoming.mtkFirmwareVersion ?? existing.mtkFirmwareVersion,
        besFirmwareVersion: incoming.besFirmwareVersion ?? existing.besFirmwareVersion,
        appVersion: incoming.appVersion ?? existing.appVersion,
        buildNumber: incoming.buildNumber ?? existing.buildNumber,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: later(existing.lastSeenAt, incoming.lastSeenAt),
        lastConnectedAt: incoming.lastConnectedAt ?? existing.lastConnectedAt,
        ...(incoming.observedAt < existing.observedAt ? existing : {}),
      }
    : incoming
  return [merged, ...devices.filter((device) => device.deviceKey !== incoming.deviceKey)]
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .slice(0, SUPPORT_DEVICE_HISTORY_LIMIT)
}

function later(a: Date, b: Date): Date {
  return a > b ? a : b
}

function withoutHardwareId(device: SupportStateInput["device"]) {
  if (!device) return undefined
  const {hardwareId: _discarded, ...safe} = device
  return safe
}

function currentDevice(profile: any): any | null {
  return profile.devices?.find((device: any) => device.deviceKey === profile.currentDeviceKey) ?? null
}

async function assertActiveOrCleanup(mentraUserId: string): Promise<void> {
  const active = await UserModel.exists({mentraUserId, supportTelemetryDeletedAt: null})
  if (active) return
  await SupportProfileModel.deleteOne({mentraUserId})
  throw new SupportProfileAccountDeletedError()
}

async function captureMeaningfulTransitions(
  mentraUserId: string,
  previous: any | null,
  next: any,
  receivedAt: Date,
): Promise<void> {
  if (!posthogApiKey()) return
  const events = meaningfulTransitions(previous, next)
  if (events.length === 0) return
  const email = await trustedEmail(mentraUserId).catch(() => null)
  const properties = posthogPropertiesFor(next)
  for (const event of events) {
    try {
      await sendCapture({
        distinctId: mentraUserId,
        event,
        eventAt: next.host.observedAt,
        insertId: `${mentraUserId}:${receivedAt.getTime()}:${event}`,
        properties,
        email,
      })
    } catch (error) {
      logger.warn({mentraUserId, event, error: (error as Error)?.message}, "support PostHog capture dropped")
    }
  }
}

async function trustedEmail(mentraUserId: string): Promise<string | null> {
  const user = await UserModel.findOne({mentraUserId}).lean()
  if (!user || user.tenantId !== "mentra") return null
  const identity = await getUserById(user.tenantUserId).catch(() => null)
  return identity?.emailVerified ? identity.email : null
}

async function sendCapture(input: {
  distinctId: string
  event: string
  eventAt: Date
  insertId: string
  properties: Record<string, unknown>
  email: string | null
}): Promise<void> {
  const key = posthogApiKey()
  if (!key) return
  const host = (process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "")
  const personProperties = {
    ...input.properties,
    ...(input.email ? {email: input.email} : {}),
  }
  const response = await fetch(`${host}/capture/`, {
    method: "POST",
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      api_key: key,
      event: input.event,
      timestamp: input.eventAt.toISOString(),
      properties: {
        distinct_id: input.distinctId,
        $insert_id: input.insertId,
        $process_person_profile: true,
        $set: personProperties,
        ...input.properties,
      },
    }),
  })
  if (!response.ok) throw new Error(`PostHog capture returned ${response.status}`)
}

function posthogApiKey(): string | null {
  return process.env.POSTHOG_API_KEY?.trim() || null
}

export function posthogPropertiesFor(next: any): Record<string, unknown> {
  const device = currentDevice(next)
  return {
    support_phone_platform: next.host.phonePlatform,
    support_phone_model: next.host.phoneModel,
    support_phone_os_version: next.host.phoneOsVersion,
    support_app_version: next.host.appVersion,
    support_app_build: next.host.appBuild,
    support_engine_version: next.host.engineVersion,
    support_bluetooth_sdk_version: next.host.bluetoothSdkVersion,
    support_connection_state: next.host.connectionState,
    support_failure_code: next.host.failureCode,
    support_failure_stage: next.host.failureStage,
    support_glasses_model: device?.model ?? null,
    support_glasses_android_version: device?.androidVersion ?? null,
    support_glasses_firmware_version: device?.firmwareVersion ?? null,
    support_glasses_mtk_firmware_version: device?.mtkFirmwareVersion ?? null,
    support_glasses_bes_firmware_version: device?.besFirmwareVersion ?? null,
    support_glasses_app_version: device?.appVersion ?? null,
    support_last_observed_at: next.host.observedAt.toISOString(),
  }
}
