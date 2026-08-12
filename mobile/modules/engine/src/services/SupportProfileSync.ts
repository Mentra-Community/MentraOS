import Constants from "expo-constants"
import * as Device from "expo-device"
import {Platform} from "react-native"
import type {SupportStateInput} from "@mentra/cloud-client"

import {useGlassesStore} from "../stores/glasses"
import {BgTimer} from "../utils/timers"
import {cloudClientService} from "./CloudClientService"

const ENGINE_VERSION = (require("../../package.json") as {version?: string}).version
const BLUETOOTH_SDK_VERSION = (require("@mentra/bluetooth-sdk/package.json") as {version?: string}).version
const DEBOUNCE_MS = 2_000
const RETRY_MS = 30_000
const RATE_LIMIT_RETRY_MS = 60 * 60_000
const HEARTBEAT_MS = 6 * 60 * 60_000

let unsubscribe: (() => void) | null = null
let debounceTimer: number | null = null
let retryTimer: number | null = null
let heartbeatTimer: number | null = null
let lastSentFingerprint: string | null = null
let queuedFingerprint: string | null = null
let sending = false

/**
 * Keep Cloud V2's canonical support snapshot current without creating an event
 * stream from noisy store updates. Only the explicitly selected fields below
 * leave the phone; Wi-Fi, Bluetooth addresses, location and diagnostics do not.
 */
export function startSupportProfileSync(): void {
  if (unsubscribe) return
  unsubscribe = useGlassesStore.subscribe(scheduleMeaningfulUpdate)
  heartbeatTimer = BgTimer.setInterval(() => void sendCurrentSnapshot(true), HEARTBEAT_MS)
  void sendCurrentSnapshot(true)
}

export function stopSupportProfileSync(): void {
  unsubscribe?.()
  unsubscribe = null
  if (debounceTimer !== null) BgTimer.clearTimeout(debounceTimer)
  if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
  if (heartbeatTimer !== null) BgTimer.clearInterval(heartbeatTimer)
  debounceTimer = null
  retryTimer = null
  heartbeatTimer = null
  lastSentFingerprint = null
  queuedFingerprint = null
  sending = false
}

function scheduleMeaningfulUpdate(): void {
  const fingerprint = snapshotFingerprint(buildSnapshot())
  if (fingerprint === lastSentFingerprint) return
  queuedFingerprint = fingerprint
  armDebounce()
}

function armDebounce(): void {
  if (debounceTimer !== null) BgTimer.clearTimeout(debounceTimer)
  debounceTimer = BgTimer.setTimeout(() => {
    debounceTimer = null
    void sendCurrentSnapshot(false)
  }, DEBOUNCE_MS)
}

async function sendCurrentSnapshot(force: boolean): Promise<void> {
  if (sending) {
    const fingerprint = snapshotFingerprint(buildSnapshot())
    if (fingerprint !== lastSentFingerprint) queuedFingerprint = fingerprint
    return
  }
  const snapshot = buildSnapshot()
  const fingerprint = snapshotFingerprint(snapshot)
  if (!force && fingerprint === lastSentFingerprint) return

  sending = true
  let retryDelayMs: number | null = null
  try {
    const result = await cloudClientService.core.supportProfile.update(snapshot)
    retryDelayMs = retryDelayForSupportProfileResult(result)
    if (retryDelayMs === null) {
      lastSentFingerprint = fingerprint
      if (queuedFingerprint === fingerprint) queuedFingerprint = null
      if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
      retryTimer = null
    }
  } catch (error) {
    console.warn("supportProfile: Cloud V2 update failed:", error instanceof Error ? error.message : error)
    retryDelayMs = RETRY_MS
  } finally {
    sending = false
    if (retryDelayMs !== null) {
      if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
      retryTimer = BgTimer.setTimeout(() => {
        retryTimer = null
        void sendCurrentSnapshot(true)
      }, retryDelayMs)
      return
    }

    const currentFingerprint = snapshotFingerprint(buildSnapshot())
    if (currentFingerprint !== lastSentFingerprint) {
      queuedFingerprint = currentFingerprint
      if (retryTimer === null) armDebounce()
    }
  }
}

export function retryDelayForSupportProfileResult(result: {
  status: "accepted" | "deduplicated" | "stale" | "rate_limited"
  retryAfterMs?: number
}): number | null {
  if (result.status === "accepted" || result.status === "deduplicated") return null
  if (result.status === "rate_limited") {
    return Math.max(1_000, result.retryAfterMs ?? RATE_LIMIT_RETRY_MS)
  }
  return RETRY_MS
}

export function buildSnapshot(observedAt = new Date()): SupportStateInput {
  const glasses = useGlassesStore.getState()
  const device = {
    hardwareId: optional(glasses.serialNumber),
    model: optional(glasses.deviceModel),
    androidVersion: optional(glasses.androidVersion),
    firmwareVersion: optional(glasses.firmwareVersion),
    mtkFirmwareVersion: optional(glasses.mtkFirmwareVersion),
    besFirmwareVersion: optional(glasses.besFirmwareVersion),
    appVersion: optional(glasses.appVersion),
    buildNumber: optional(glasses.buildNumber),
  }
  const hasDevice = Object.values(device).some(Boolean)
  const constants = Constants as typeof Constants & {
    nativeAppVersion?: string | null
    nativeBuildVersion?: string | null
  }
  return {
    observedAt: observedAt.toISOString(),
    host: {
      appVersion: optional(constants.nativeAppVersion ?? Constants.expoConfig?.version),
      appBuild: optional(constants.nativeBuildVersion),
      engineVersion: optional(ENGINE_VERSION),
      bluetoothSdkVersion: optional(BLUETOOTH_SDK_VERSION),
      phonePlatform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "unknown",
      phoneModel: optional(Device.modelName),
      phoneOsVersion: optional(String(Platform.Version)),
      connectionState: glasses.connection.state,
    },
    ...(hasDevice ? {device} : {}),
  }
}

export function snapshotFingerprint(snapshot: SupportStateInput): string {
  return JSON.stringify({host: snapshot.host, device: snapshot.device})
}

function optional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 128) : undefined
}
