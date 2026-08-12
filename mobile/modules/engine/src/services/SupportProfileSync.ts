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
const HEARTBEAT_MS = 6 * 60 * 60_000

let unsubscribe: (() => void) | null = null
let debounceTimer: number | null = null
let retryTimer: number | null = null
let heartbeatTimer: number | null = null
let lastSentFingerprint: string | null = null
let queuedFingerprint: string | null = null
let sendingGeneration: number | null = null
let syncGeneration = 0
let consecutiveSendFailures = 0
let lastFailure: {code: string; stage: string} | null = null
let lastConnectionState: string | null = null

/**
 * Keep Cloud V2's canonical support snapshot current without creating an event
 * stream from noisy store updates. Only the explicitly selected fields below
 * leave the phone; Wi-Fi, Bluetooth addresses, location and diagnostics do not.
 */
export function startSupportProfileSync(): void {
  if (unsubscribe) return
  const generation = ++syncGeneration
  lastConnectionState = useGlassesStore.getState().connection.state
  unsubscribe = useGlassesStore.subscribe(() => handleGlassesStoreChange(generation))
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
  consecutiveSendFailures = 0
  lastFailure = null
  lastConnectionState = null
}

function handleGlassesStoreChange(generation: number): void {
  if (!unsubscribe || generation !== syncGeneration) return
  const connectionState = useGlassesStore.getState().connection.state
  if (connectionState === "connected" && lastConnectionState !== "connected") lastFailure = null
  lastConnectionState = connectionState
  scheduleMeaningfulUpdate(generation)
}

function scheduleMeaningfulUpdate(generation = syncGeneration): void {
  if (!unsubscribe || generation !== syncGeneration) return
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
    consecutiveSendFailures = 0
    retryDelayMs = retryDelayForSupportProfileResult(result)
    if (retryDelayMs === null) {
      lastSentFingerprint = fingerprint
      if (queuedFingerprint === fingerprint) queuedFingerprint = null
      if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
      retryTimer = null
    }
  } catch (error) {
    if (generation !== syncGeneration || !unsubscribe) return
    consecutiveSendFailures += 1
    retryDelayMs = retryDelayForSendFailure(consecutiveSendFailures)
    console.warn(
      `supportProfile: Cloud V2 update failed (retry in ${Math.round(retryDelayMs / 1_000)}s):`,
      error instanceof Error ? error.message : error,
    )
  } finally {
    const generationIsActive = generation === syncGeneration && sendingGeneration === generation && Boolean(unsubscribe)
    if (generationIsActive) {
      sendingGeneration = null
      if (retryDelayMs !== null) {
        if (retryTimer !== null) BgTimer.clearTimeout(retryTimer)
        retryTimer = BgTimer.setTimeout(() => {
          retryTimer = null
          void sendCurrentSnapshot(true, generation)
        }, retryDelayMs)
      } else {
        const currentFingerprint = snapshotFingerprint(buildSnapshot())
        if (currentFingerprint !== lastSentFingerprint) {
          queuedFingerprint = currentFingerprint
          if (retryTimer === null) armDebounce(generation)
        }
      }
    }
  }
}

export function retryDelayForSupportProfileResult(result: {
  status: "accepted" | "deduplicated" | "stale"
}): number | null {
  if (result.status === "accepted" || result.status === "deduplicated") return null
  return RETRY_MS
}

/**
 * Support freshness is not worth an aggressive retry loop. A snapshot the
 * server keeps rejecting (skewed clock, deleted account, signed-out host)
 * backs off exponentially until it converges on the heartbeat cadence.
 */
export function retryDelayForSendFailure(consecutiveFailures: number): number {
  return Math.min(HEARTBEAT_MS, RETRY_MS * 2 ** Math.min(Math.max(consecutiveFailures, 1) - 1, 10))
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

export function snapshotFingerprint(snapshot: SupportStateInput): string {
  return JSON.stringify({host: snapshot.host, device: snapshot.device})
}

function optional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 128) : undefined
}
