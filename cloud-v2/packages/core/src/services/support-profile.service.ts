import {createHash, createHmac} from "node:crypto"
import {SupportProfileModel} from "../models/support-profile.model"
import {enqueueSupportTelemetry} from "./support-telemetry.service"

export const SUPPORT_DEVICE_HISTORY_LIMIT = 12
export const SUPPORT_IDENTICAL_UPDATE_MIN_MS = 60_000
export const SUPPORT_RATE_WINDOW_MS = 60 * 60_000
export const SUPPORT_RATE_WINDOW_LIMIT = 120

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
  status: "accepted" | "deduplicated" | "stale" | "rate_limited"
  observedAt: string
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

export async function updateSupportProfile(
  identity: {mentraUserId: string; tenantId: string},
  input: SupportStateInput,
): Promise<SupportProfileUpdateResult> {
  const observedAt = new Date(input.observedAt)
  const receivedAt = new Date()
  const fingerprint = fingerprintFor(input)
  const device = input.device ? toStoredDevice(input.device, observedAt, input.host.connectionState) : null

  for (let attempt = 0; attempt < 5; attempt += 1) {
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
      const inCurrentWindow = receivedAt.getTime() - current.rateWindowStartedAt.getTime() < SUPPORT_RATE_WINDOW_MS
      if (inCurrentWindow && current.rateWindowCount >= SUPPORT_RATE_WINDOW_LIMIT) {
        return {status: "rate_limited", observedAt: current.host.observedAt.toISOString()}
      }

      const devices = mergeDevice(current.devices as unknown as StoredDevice[], device)
      const host = toStoredHost(input, observedAt, receivedAt)
      const updated = await SupportProfileModel.findOneAndUpdate(
        {_id: current._id, revision: current.revision},
        {
          $set: {
            tenantId: identity.tenantId,
            host,
            devices,
            currentDeviceKey: device?.deviceKey ?? current.currentDeviceKey ?? null,
            lastFingerprint: fingerprint,
            lastAcceptedAt: receivedAt,
            rateWindowStartedAt: inCurrentWindow ? current.rateWindowStartedAt : receivedAt,
            rateWindowCount: inCurrentWindow ? current.rateWindowCount + 1 : 1,
          },
          $inc: {revision: 1},
        },
        {new: true},
      ).lean()
      if (!updated) continue
      await enqueueTransitions(identity.mentraUserId, current as any, updated as any)
      return {status: "accepted", observedAt: observedAt.toISOString()}
    }

    const host = toStoredHost(input, observedAt, receivedAt)
    try {
      const created = await SupportProfileModel.create({
        ...identity,
        host,
        devices: device ? [device] : [],
        currentDeviceKey: device?.deviceKey ?? null,
        lastFingerprint: fingerprint,
        lastAcceptedAt: receivedAt,
        rateWindowStartedAt: receivedAt,
        rateWindowCount: 1,
        revision: 0,
      })
      await enqueueTransitions(identity.mentraUserId, null, created.toObject() as any)
      return {status: "accepted", observedAt: observedAt.toISOString()}
    } catch (error) {
      if ((error as {code?: number})?.code !== 11000) throw error
    }
  }
  throw new Error("support profile update conflicted repeatedly")
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
  const versionFields = ["appVersion", "appBuild", "engineVersion", "bluetoothSdkVersion"]
  const hostChanged = versionFields.some((field) => previous.host[field] !== next.host[field])
  const previousDevice = currentDevice(previous)
  const nextDevice = currentDevice(next)
  const deviceFields = ["firmwareVersion", "mtkFirmwareVersion", "besFirmwareVersion", "appVersion", "buildNumber"]
  const deviceChanged = deviceFields.some((field) => previousDevice?.[field] !== nextDevice?.[field])
  if (hostChanged || deviceChanged) events.push("support_software_changed")
  if (next.host.failureCode && next.host.failureCode !== previous.host.failureCode) {
    events.push("support_failure_observed")
  }
  return events
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
  connectionState: SupportStateInput["host"]["connectionState"],
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
    lastConnectedAt: connectionState === "connected" ? observedAt : null,
    observedAt,
  }
}

function mergeDevice(devices: StoredDevice[], incoming: StoredDevice | null): StoredDevice[] {
  if (!incoming) return devices
  const existing = devices.find((device) => device.deviceKey === incoming.deviceKey)
  const merged: StoredDevice = existing
    ? {
        ...incoming,
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

async function enqueueTransitions(mentraUserId: string, previous: any | null, next: any): Promise<void> {
  const properties = posthogPropertiesFor(next)
  for (const event of meaningfulTransitions(previous, next)) {
    await enqueueSupportTelemetry({mentraUserId, event, properties})
  }
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
    support_glasses_app_version: device?.appVersion ?? null,
    support_last_observed_at: next.host.observedAt.toISOString(),
  }
}
