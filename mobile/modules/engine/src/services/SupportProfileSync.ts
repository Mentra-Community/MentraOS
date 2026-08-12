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
let sendingGeneration: number | null = null
let syncGeneration = 0
let lastFailure: {code: string; stage: string} | null = null

/**
 * Keep Cloud V2's canonical support snapshot current without creating an event
 * stream from noisy store updates. Only the explicitly selected fields below
 * leave the phone; Wi-Fi, Bluetooth addresses, location and diagnostics do not.
 */
export function startSupportProfileSync(): void {
  if (unsubscribe) return
  const generation = ++syncGeneration
  unsubscribe = useGlassesStore.subscribe(() => scheduleMeaningfulUpdate(generation))
  heartbeatTimer = BgTimer.setInterval(() => void sendCurrentSnapshot(true, generation), HEARTBEAT_MS)
  void sendCurrentSnapshot(true, generation)
}

export function stopSupportProfileSync(): void {
  syncGeneration += 1
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
  sendingGeneration = null
  lastFailure = null
}

function scheduleMeaningfulUpdate(generation = syncGeneration): void {
  if (!unsubscribe || generation !== syncGeneration) return
  if (useGlassesStore.getState().connection.state === "connected") lastFailure = null
  const fingerprint = snapshotFingerprint(buildSnapshot())
  if (fingerprint === lastSentFingerprint) return
  queuedFingerprint = fingerprint
  armDebounce(generation)
}

function armDebounce(generation: number): void {
  if (debounceTimer !== null) BgTimer.clearTimeout(debounceTimer)
  debounceTimer = BgTimer.setTimeout(() => {
    debounceTimer = null
    void sendCurrentSnapshot(false, generation)
  }, DEBOUNCE_MS)
}

async function sendCurrentSnapshot(force: boolean, generation = syncGeneration): Promise<void> {
  if (!unsubscribe || generation !== syncGeneration) return
  if (sendingGeneration === generation) {
    const fingerprint = snapshotFingerprint(buildSnapshot())
    if (fingerprint !== lastSentFingerprint) queuedFingerprint = fingerprint
    return
  }
  const snapshot = buildSnapshot()
  const fingerprint = snapshotFingerprint(snapshot)
  if (!force && fingerprint === lastSentFingerprint) return

  sendingGeneration = generation
  let retryDelayMs: number | null = null
  try {
    const result = await cloudClientService.core.supportProfile.update(snapshot)
    if (generation !== syncGeneration || !unsubscribe) return
    retryDelayMs = retryDelayForSupportProfileResult(result)
    if (retryDelayMs === null) {
      lastSentFingerprint = fingerprint
      if (queuedFingerprint === fingerprint) queuedFingerprint = null
      if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
      retryTimer = null
    }
  } catch (error) {
    if (generation !== syncGeneration || !unsubscribe) return
    console.warn("supportProfile: Cloud V2 update failed:", error instanceof Error ? error.message : error)
    retryDelayMs = RETRY_MS
  } finally {
    if (generation !== syncGeneration || sendingGeneration !== generation || !unsubscribe) return
    sendingGeneration = null
    if (retryDelayMs !== null) {
      if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
      retryTimer = BgTimer.setTimeout(() => {
        retryTimer = null
        void sendCurrentSnapshot(true, generation)
      }, retryDelayMs)
      return
    }

    const currentFingerprint = snapshotFingerprint(buildSnapshot())
    if (currentFingerprint !== lastSentFingerprint) {
      queuedFingerprint = currentFingerprint
      if (retryTimer === null) armDebounce(generation)
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
      phoneOsVersion: optional(
        Platform.OS === "android"
          ? String((Platform.constants as {Release?: string} | undefined)?.Release ?? Platform.Version)
          : String(Platform.Version),
      ),
      connectionState: glasses.connection.state,
      ...(lastFailure ? {failureCode: lastFailure.code, failureStage: lastFailure.stage} : {}),
    },
    ...(hasDevice ? {device} : {}),
  }
}

/** Record only normalized connection failures; arbitrary exception messages never leave the phone. */
export function recordSupportProfileConnectionFailure(error: unknown, stage: string): void {
  const rawCode =
    typeof error === "object" && error && "code" in error ? String((error as {code?: unknown}).code ?? "") : ""
  const message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : ""
  const code = /^[a-zA-Z0-9_.-]{1,64}$/.test(rawCode)
    ? rawCode.toLowerCase()
    : message.includes("permission")
    ? "permission_denied"
    : message.includes("bluetooth") && (message.includes("off") || message.includes("unavailable"))
    ? "bluetooth_unavailable"
    : message.includes("not found") || message.includes("no default")
    ? "device_not_found"
    : message.includes("timeout")
    ? "connect_timeout"
    : "connect_failed"
  lastFailure = {code, stage: stage.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64)}
  scheduleMeaningfulUpdate()
}

export function clearSupportProfileConnectionFailure(): void {
  if (!lastFailure) return
  lastFailure = null
  scheduleMeaningfulUpdate()
}

export function snapshotFingerprint(snapshot: SupportStateInput): string {
  return JSON.stringify({host: snapshot.host, device: snapshot.device})
}

function optional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 128) : undefined
}
