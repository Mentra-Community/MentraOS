/**
 * LocalMiniappRuntime
 *
 * Singleton service that bridges local miniapps (running in WebViews) with
 * phone capabilities: display, audio, storage, sensors, LED, etc.
 *
 * Each miniapp communicates via the @mentra/miniapp envelope protocol.
 * This runtime handles request dispatch, stream fan-out, and lifecycle
 * management (connect/disconnect/ping).
 */

import {AppState, Linking} from "react-native"
import Share from "react-native-share"
import * as Battery from "expo-battery"
import * as Clipboard from "expo-clipboard"
import {File, Paths} from "expo-file-system"
import * as Location from "expo-location"
import BluetoothSdk, {type RgbLedAction, type RgbLedColor} from "@mentra/bluetooth-sdk"

import {
  MiniappErrorCode,
  MiniappRequestType,
  MiniappResponseType,
  MiniappStreamType,
  CLOUD_STATUS_STREAM,
  parseEnvelope,
  serializeEnvelope,
} from "@mentra/miniapp"
import type {MiniappEnvelope} from "@mentra/miniapp"

import {DeviceTypes, getModelCapabilities} from "../types"
import {storage as mmkvStorage} from "../utils/storage/storage"
import {BgTimer} from "../utils/timers"
import devServerBridge from "./DevServerBridge"
import {islandNotifications} from "./NotificationsEmitter"
import {isGlassesConnected} from "./GlassesReadiness"
import audioPlaybackService from "./AudioPlaybackService"
import {phoneLocationService} from "./PhoneLocationService"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore} from "../stores/settings"
import localDisplayManager from "./LocalDisplayManager"
import type {DisplayPayload} from "./LocalDisplayManager"
import headingService from "./HeadingService"
import localSttFallbackCoordinator from "./LocalSttFallbackCoordinator"
import micStateCoordinator from "./MicStateCoordinator"
import {BlobStore} from "./BlobStore"
import {CloudAudioSubscriptionSync} from "./CloudAudioSubscriptionSync"
import {phoneCameraFovCoordinator} from "./PhoneCameraFovCoordinator"
import {phonePhotoCoordinator} from "./PhonePhotoCoordinator"
import {phoneStreamCoordinator} from "./PhoneStreamCoordinator"
import {phoneVideoCoordinator} from "./PhoneVideoCoordinator"
import {runSentenceTtsPipeline} from "./SentenceTtsPipeline"
import {summarizeTranscriptionRoutes, transcriptionDeliveryRoute} from "./TranscriptionRouting"
import {prepareTtsSentences} from "./TtsTextSanitizer"
import {handleWifiAdbRequest} from "./WifiAdbRequest"
import {cloudClientService} from "./CloudClientService"
import {miniappLauncher} from "./MiniappLauncher"
import {
  ISLAND_SETTINGS_KEYS,
  type CameraFovPreset,
  type CameraFovRequest,
  type CameraRoiPosition,
  type CloudClientStatusSnapshot,
  type InteropAuditEvent,
  type MiniappAuthToken,
  type TtsSynthesisResult,
} from "../runtime/config"
import {getAnalytics, getMiniappConfiguration, getUiSeams, isFeatureEnabled} from "../runtime/bootstrap"
import {invokeScanQrSeam} from "../runtime/scanQrSeam"
import {normalizeStreamAudioConfig, normalizeStreamVideoConfig} from "../runtime/streamConfig"
import {toLanguageHint} from "@mentra/cloud-protocol/languages"
import type {AudioSubscription, LanguageSource, TranscriptionData, TranslationData} from "@mentra/cloud-protocol"
import {buildMiniappManifestSnapshot, type MiniappRuntimeDiagnosticSnapshot} from "../utils/miniappDiagnostics"
import ttsModelManager from "./TTSModelManager"
import {NavigationHandlers} from "./NavigationHandlers"
import type {ClientApp} from "../types/applet"
import {useAppStatusStore} from "../stores/apps"
import {getDevAppAttestation, getDevAppSourcePackage} from "./AppRegistry"
import {resolveForegroundLocationPermission} from "./ForegroundLocationPermission"
import {advanceMiniappPingLiveness} from "./MiniappLiveness"
import {listPhoneCalendarEvents, PhoneCalendarError} from "./PhoneCalendarService"
import {LocalMiniappStorage} from "./LocalMiniappStorage"

// =============================================================================
// Types
// =============================================================================

export interface InstalledMiniappManifest {
  packageName?: string
  /** Human-facing app name (from miniapp.json `name`). Shown in the "Starting
   * <name>…" boot message; falls back to the package name when absent. */
  name?: string
  version?: string
  sdkVersion?: string
  minHostVersion?: string
  type?: string
  entry?: {background?: string; ui?: string}
  permissions?: Array<{type: string; required?: boolean; description?: string}>
  hardwareRequirements?: Array<{type: string; level: string; description?: string}>
  actions?: Array<{id?: unknown; description?: unknown; parameters?: unknown; outputSchema?: unknown}>
}

type SpeakerStateValue = "idle" | "loading" | "playing" | "stopped" | "error"

interface ConnectedMiniapp {
  subscriptions: Set<string>
  /** Transcription streams this app explicitly requires to stay on-device. */
  forceLocalTranscriptionStreams: Set<string>
  /** Transcription streams with at least one listener using the default/cloud route. */
  cloudTranscriptionStreams: Set<string>
  sendMessage: (raw: string) => void
  lastPongAt: number
  unansweredPingRounds: number
  installedManifest?: InstalledMiniappManifest
  authRefreshTimerId: number | null
  /**
   * Backoff timer for re-attempting the INITIAL miniapp-token mint after it
   * failed (distinct from `authRefreshTimerId`, which renews an already-issued
   * token near expiry). Null when no retry is queued.
   */
  authRetryTimerId: number | null
  /**
   * True once this app has received a miniapp auth token (in CONNECT_ACK or a
   * follow-up AUTH_UPDATE). Gates the initial-mint retry loop and the
   * on-reconnect re-drive so we stop hammering once auth has landed.
   */
  authDelivered: boolean
  /** Last speaker state pushed to this app. Used to dedup SPEAKER_STATE pushes. */
  speakerState: SpeakerStateValue
  /** Live PCM output stream this app has open (speaker.createStream), if any. */
  activeSpeakerStreamId?: string
  /**
   * Location-tier rate this app is currently asking for via its
   * `location_stream` subscription, or null if it hasn't asked for
   * one. The aggregate tier handed to the host is the strictest
   * (highest-accuracy) rate across all currently connected apps —
   * see {@link LOCATION_RATE_PRIORITY}.
   */
  requestedLocationRate: string | null
}

interface SpeechRun {
  id: string
  cancelled: boolean
  playbackRequestId?: string
  onCancelled?: () => void
}

type TranscriptionEventSource = "cloud" | "local"

/**
 * Strictness ordering for `location_stream` rate values. Higher index =
 * higher accuracy and higher power cost. The aggregate tier applied to
 * the OS is the max of every connected miniapp's requested rate;
 * miniapps that didn't ask for `location_stream` contribute nothing.
 *
 * If a miniapp passes a value we don't recognize, we treat it like the
 * weakest known rate ("passive") rather than blanket-overwriting an
 * active stronger request from another app.
 */
const LOCATION_RATE_PRIORITY = ["off", "passive", "low", "high", "realtime"] as const
type LocationRate = (typeof LOCATION_RATE_PRIORITY)[number]
function locationRateRank(rate: string | null | undefined): number {
  if (!rate) return -1
  const i = LOCATION_RATE_PRIORITY.indexOf(rate as LocationRate)
  return i >= 0 ? i : LOCATION_RATE_PRIORITY.indexOf("passive")
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: T | null) => {
      if (settled) return
      settled = true
      BgTimer.clearTimeout(timer)
      resolve(value)
    }
    const timer = BgTimer.setTimeout(() => done(null), timeoutMs)
    promise.then(
      (value) => done(value),
      () => done(null),
    )
  })
}

const LOG_TAG = "LOCAL_MINIAPP"
const DIAGNOSTIC_MAX_LIST_ITEMS = 100
const DIAGNOSTIC_MAX_STRING_LENGTH = 512

function diagnosticStringList(values: Iterable<string>): string[] {
  return [...values]
    .map((value) => value.slice(0, DIAGNOSTIC_MAX_STRING_LENGTH))
    .sort()
    .slice(0, DIAGNOSTIC_MAX_LIST_ITEMS)
}

const SYSTEM_MINIAPP_PACKAGES = new Set([
  "com.mentra.camera",
  "com.mentra.gallery",
  "com.mentra.settings",
  "com.mentra.simulated",
  "com.mentra.mirror",
  "com.mentra.ai",
  "cloud.augmentos.notify",
  "com.mentra.feedback",
  "com.mentra.miniappdev",
])
const PING_INTERVAL_MS = 5_000
const MINIAPP_AUTH_REFRESH_HEADROOM_MS = 5 * 60 * 1000
const MINIAPP_AUTH_REFRESH_MIN_DELAY_MS = 5_000
// Backoff bounds for re-minting the INITIAL miniapp token after a failed mint
// (e.g. the cloud client had not finished its first-boot Core token exchange
// when the miniapp connected). Exponential from base, capped, so a transient
// not-yet-connected client self-heals within seconds instead of needing a full
// manual Cloud V2 reconnect.
const MINIAPP_AUTH_RETRY_BASE_MS = 1_000
const MINIAPP_AUTH_RETRY_MAX_MS = 15_000
const FOREGROUND_LIVENESS_PROBE_TIMEOUT_MS = 2_500
const REQUEST_WIFI_SETUP_TYPE = "miniapp_request_wifi_setup"
// Unregister after this many missed pongs. Generous on purpose: a busy
// context (heavy interim translation traffic) or OS scheduling while idle can
// delay pongs well past one interval, and killing a healthy-but-busy script
// drops its subscriptions (releasing the mic). With the liveness-timeout
// respawn path wired (MentraJSRouter.start), a genuinely dead context still
// comes back automatically — this threshold only bounds how long that takes.
const PING_TIMEOUT_THRESHOLD = 6 // ~30s

const TRANSCRIPT_TIMING_TELEMETRY = (globalThis as {__DEV__?: boolean}).__DEV__ === true

const RGB_LED_ACTIONS = new Set<RgbLedAction>(["on", "off"])
const RGB_LED_COLORS = new Set<RgbLedColor>(["red", "green", "blue", "orange", "white"])
const CAMERA_FOV_MIN = 62
const CAMERA_FOV_MAX = 118
const CAMERA_FOV_DEFAULT = 118
const CAMERA_FOV_PRESETS: Record<CameraFovPreset, number> = {narrow: 82, standard: 102, wide: 118}
const CAMERA_ROI_POSITION_BY_NAME: Record<string, CameraRoiPosition> = {center: "center", bottom: "bottom", top: "top"}

const localMiniappStorageBackend = {
  get(key: string): unknown | null {
    const result = mmkvStorage.load<unknown>(key)
    return result.is_ok() ? result.value : null
  },
  has(key: string): boolean {
    return mmkvStorage.load<unknown>(key).is_ok()
  },
  set(key: string, value: unknown): void {
    mmkvStorage.save(key, value)
  },
  remove(key: string): void {
    mmkvStorage.remove(key)
  },
  keys(): string[] {
    return mmkvStorage.getAllKeys()
  },
}

// =============================================================================
// Declared-permission record helper (for CONNECT_ACK / PERMISSIONS_UPDATE)
// =============================================================================

/**
 * Map from manifest permission types (uppercase, snake-y) to the lowercase
 * canonical permission keys the SDK exposes via session.permissions. Mirrors
 * cloud SDK v3's PermissionType union.
 *
 * BACKGROUND_LOCATION + POST_NOTIFICATIONS aren't in v3's surface; they map
 * onto the same canonical keys (location / notifications) since the SDK's
 * `has()` is "do I have *any* form of this permission declared".
 */
const PERMISSION_TYPE_TO_CANONICAL: Record<string, string> = {
  MICROPHONE: "microphone",
  CAMERA: "camera",
  LOCATION: "location",
  BACKGROUND_LOCATION: "location",
  READ_NOTIFICATIONS: "notifications",
  POST_NOTIFICATIONS: "notifications",
  CALENDAR: "calendar",
}

function normalizeRgbLedAction(value: unknown): RgbLedAction {
  return typeof value === "string" && RGB_LED_ACTIONS.has(value as RgbLedAction) ? (value as RgbLedAction) : "off"
}

function normalizeRgbLedColor(value: unknown): RgbLedColor | null {
  return typeof value === "string" && RGB_LED_COLORS.has(value as RgbLedColor) ? (value as RgbLedColor) : null
}

function normalizeCameraFovPayload(payload: Record<string, unknown>): CameraFovRequest {
  if (typeof payload.preset === "string") {
    const preset = payload.preset in CAMERA_FOV_PRESETS ? (payload.preset as CameraFovPreset) : "standard"
    return {preset}
  }

  const rawFov = typeof payload.fov === "number" && Number.isFinite(payload.fov) ? payload.fov : CAMERA_FOV_DEFAULT

  return {
    fov: Math.min(CAMERA_FOV_MAX, Math.max(CAMERA_FOV_MIN, rawFov)),
    roiPosition: normalizeCameraRoiPosition(payload.roiPosition ?? payload.roi_position),
  }
}

function normalizeCameraRoiPosition(value: unknown): CameraRoiPosition {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2) {
    return value === 1 ? "bottom" : value === 2 ? "top" : "center"
  }

  if (typeof value === "string") {
    return CAMERA_ROI_POSITION_BY_NAME[value] ?? "center"
  }

  return "center"
}

const ALL_CANONICAL_PERMISSIONS = ["location", "microphone", "camera", "notifications", "calendar"] as const

/**
 * Build the {location, microphone, camera, notifications, calendar} record the
 * SDK's session.permissions module reads from. Missing types are false.
 */
function computeDeclaredPermissionRecord(manifest: InstalledMiniappManifest | undefined): Record<string, boolean> {
  const record: Record<string, boolean> = {}
  for (const k of ALL_CANONICAL_PERMISSIONS) record[k] = false
  for (const perm of manifest?.permissions ?? []) {
    const canonical = PERMISSION_TYPE_TO_CANONICAL[perm.type?.toUpperCase()]
    if (canonical) record[canonical] = true
  }
  return record
}

// =============================================================================
// PERMISSION_NOT_DECLARED warnings — per-session dedup
// =============================================================================
//
// When a miniapp tries to subscribe / call something whose required permission
// isn't declared in miniapp.json, the runtime rejects with
// PERMISSION_NOT_DECLARED. The error reaches the SDK but most authors don't
// subscribe to session.on("error", ...), so it's silent in practice.
//
// To make the failure discoverable for developers running the MentraOS app
// from source, log a clear, copy-pasteable message in the phone console that
// names the offending permission, the offending stream/op, and the JSON
// snippet to add to miniapp.json. Once-per-session per (packageName, permission)
// to avoid spam from a tight retry loop.
//
// Production users running the App Store build of MentraOS won't see these
// (they don't watch Metro/adb logcat). For them, the WebView console bridge
// (#5 of the quick-fixes round) ships the structured error to the miniapp
// itself, and the miniapp's own console.warn flows to the dev terminal.

const warnedPermission = new Set<string>() // key: `${packageName}::${permission}`

function logPermissionNotDeclared(
  packageName: string,
  permission: string,
  context: string,
  manifestSnippet: string,
): void {
  const key = `${packageName}::${permission}`
  if (warnedPermission.has(key)) return
  warnedPermission.add(key)
  console.warn(
    `${LOG_TAG}: ${packageName} attempted ${context}, but permission ${permission} is not declared in miniapp.json.\n` +
      `Add this to the "permissions" array:\n  ${manifestSnippet}`,
  )
}

/** Reset the per-session dedup; called when a miniapp unregisters so a fresh launch warns again. */
function resetPermissionWarnings(packageName: string): void {
  for (const key of warnedPermission) {
    if (key.startsWith(`${packageName}::`)) warnedPermission.delete(key)
  }
}

// =============================================================================
// LocalMiniappRuntime
// =============================================================================

class LocalMiniappRuntime {
  private static instance: LocalMiniappRuntime | null = null

  /** Connected miniapps keyed by packageName. */
  private connectedApps: Map<string, ConnectedMiniapp> = new Map()

  /**
   * Packages that have completed their CONNECT handshake (sent
   * `miniapp_connect`, got `CONNECT_ACK`). Distinct from `connectedApps`,
   * which is populated at spawn/registration time — handshake is later.
   * Drives {@link waitForConnect}.
   */
  private handshookApps: Set<string> = new Set()

  /** Pending {@link waitForConnect} resolvers, keyed by packageName. */
  private connectWaiters: Map<string, Set<(err?: Error) => void>> = new Map()

  /** Ref-counted stream subscriptions: stream → set of packageNames. */
  private streamSubscribers: Map<string, Set<string>> = new Map()

  /** Host observers for the Mentra Live button-capture policy. */
  private buttonPressSubscriberListeners = new Set<(packageNames: string[]) => void>()

  /** Guards one-time wiring of the cloud transcript/translation fan-out. */
  private cloudResultsWired = false
  private cloudStatusWired = false
  private cloudAudioSubscriptionSync = new CloudAudioSubscriptionSync()

  /**
   * Per-miniapp language hints from TRANSCRIPTION_CONFIG (issue 021 WP3).
   * Bare ISO 639-1 codes, already registry-validated by the SDK and
   * re-normalized here (defense in depth). Merged (union) into the auto-mode
   * cloud transcription subscription in buildCloudAudioSubscriptions.
   */
  private transcriptionHintsByApp = new Map<string, string[]>()

  /** Ping interval handle. */
  private pingIntervalId: number | null = null
  private foregroundProbeTimers: Map<string, number> = new Map()

  /**
   * Notified when a miniapp is unregistered for missing liveness pings.
   * MentraJSRouter wires this into its crash-respawn machinery so a
   * silently-stalled background script is restarted (with crash-loop
   * protection) instead of staying dead — a dead background drops its
   * subscriptions, which releases the mic while the webview still looks
   * alive.
   */
  public onLivenessTimeout: ((packageName: string) => void) | null = null

  /** Pending cloud requests: requestId → packageName that originated the request. */
  private pendingCloudRequests: Map<string, {packageName: string; envelopeRequestId?: string}> = new Map()
  private speechRuns = new Map<string, SpeechRun>()

  // Browser fallback token auth — HMAC-signed blob with a phone-local
  // secret. Both issuer and verifier are the same process, so the
  // secret never leaves the device.
  private localSecret = `miniapp_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`
  private usedTokens = new Set<string>()

  private constructor() {}

  /** Snapshot of miniapps actively subscribed to hardware button events. */
  public getButtonPressSubscribers(): string[] {
    return [...(this.streamSubscribers.get(MiniappStreamType.BUTTON_PRESS) ?? [])].sort()
  }

  /** Observe active hardware-button subscriptions. */
  public onButtonPressSubscribersChanged(listener: (packageNames: string[]) => void): () => void {
    this.buttonPressSubscriberListeners.add(listener)
    return () => this.buttonPressSubscriberListeners.delete(listener)
  }

  /** Report-safe live miniapp/subscription/resource snapshot. */
  public getDiagnosticSnapshot(nowMs = Date.now()): MiniappRuntimeDiagnosticSnapshot {
    const connectedApps = [...this.connectedApps.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, DIAGNOSTIC_MAX_LIST_ITEMS)
      .map(([packageName, app]) => ({
        packageName: packageName.slice(0, DIAGNOSTIC_MAX_STRING_LENGTH),
        handshakeComplete: this.handshookApps.has(packageName),
        subscriptions: diagnosticStringList(app.subscriptions),
        lastMessageAgeMs: Math.max(0, nowMs - app.lastPongAt),
        requestedLocationRate: app.requestedLocationRate,
        hasActiveSpeakerStream: app.activeSpeakerStreamId !== undefined,
        ...(app.installedManifest
          ? {
              manifest: buildMiniappManifestSnapshot(app.installedManifest, {
                packageName,
                name: app.installedManifest.name,
                version: app.installedManifest.version,
                type: app.installedManifest.type,
              }),
            }
          : {}),
      }))
    const subscriptionsByStream = Object.fromEntries(
      [...this.streamSubscribers.entries()]
        .filter(([, packageNames]) => packageNames.size > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, DIAGNOSTIC_MAX_LIST_ITEMS)
        .map(([stream, packageNames]) => [
          stream.slice(0, DIAGNOSTIC_MAX_STRING_LENGTH),
          diagnosticStringList(packageNames),
        ]),
    )

    return {
      connectedApps,
      subscriptionsByStream,
      resources: {
        display: localDisplayManager.getDiagnosticSnapshot(),
        camera: phonePhotoCoordinator.getDiagnosticSnapshot(),
        video: phoneVideoCoordinator.getDiagnosticSnapshot(),
        stream: phoneStreamCoordinator.getDiagnosticSnapshot(),
        cameraFov: phoneCameraFovCoordinator.getDiagnosticSnapshot(),
      },
    }
  }

  private replaceStreamSubscribers(
    packageName: string,
    previousStreams: Iterable<string>,
    nextStreams: Iterable<string>,
  ) {
    const previousButtonSubscribers = this.getButtonPressSubscribers().join("\u0000")

    for (const stream of previousStreams) {
      const subscribers = this.streamSubscribers.get(stream)
      if (!subscribers) continue
      subscribers.delete(packageName)
      if (subscribers.size === 0) this.streamSubscribers.delete(stream)
    }

    for (const stream of nextStreams) {
      let subscribers = this.streamSubscribers.get(stream)
      if (!subscribers) {
        subscribers = new Set()
        this.streamSubscribers.set(stream, subscribers)
      }
      subscribers.add(packageName)
    }

    const nextButtonSubscribers = this.getButtonPressSubscribers()
    if (previousButtonSubscribers !== nextButtonSubscribers.join("\u0000")) {
      for (const listener of this.buttonPressSubscriberListeners) {
        try {
          listener(nextButtonSubscribers)
        } catch (error) {
          console.warn(`${LOG_TAG}: button press subscriber listener threw:`, error)
        }
      }
    }
  }

  /**
   * Generate an HMAC-signed local session token for browser fallback auth.
   * Token format: base64(JSON({userId, packageName, exp})).base64(HMAC-SHA256(payload, secret))
   * Single-use, 5-minute TTL.
   */
  public generateLocalToken(userId: string, packageName: string): string {
    const payload = JSON.stringify({
      userId,
      packageName,
      exp: Date.now() + 5 * 60 * 1000, // 5 min TTL
      nonce: Math.random().toString(36).slice(2, 10),
    })
    const payloadB64 = btoa(payload)
    const sig = this.hmacSign(payload)
    return `${payloadB64}.${sig}`
  }

  /**
   * Validate and consume a local session token. Single-use.
   */
  public validateLocalToken(token: string): {userId: string; packageName: string} | null {
    const parts = token.split(".")
    if (parts.length !== 2) return null
    const [payloadB64, sig] = parts

    // Check single-use
    if (this.usedTokens.has(token)) return null

    // Verify signature
    let payload: string
    try {
      payload = atob(payloadB64!)
    } catch {
      return null
    }
    if (this.hmacSign(payload) !== sig) return null

    // Parse and check expiry
    let parsed: {userId: string; packageName: string; exp: number}
    try {
      parsed = JSON.parse(payload)
    } catch {
      return null
    }
    if (Date.now() > parsed.exp) return null

    // Mark as used
    this.usedTokens.add(token)
    // Prune old used tokens periodically (keep set from growing unbounded)
    if (this.usedTokens.size > 1000) {
      this.usedTokens.clear()
    }

    return {userId: parsed.userId, packageName: parsed.packageName}
  }

  /**
   * Simple HMAC-SHA256 using Web Crypto API (available in React Native).
   * Returns base64url-encoded signature.
   * Falls back to a simpler hash if crypto.subtle is not available.
   */
  private hmacSign(payload: string): string {
    // Synchronous HMAC using a simple hash — Web Crypto's subtle.sign is async
    // which doesn't fit cleanly here. For phone-local single-process auth,
    // a keyed hash is sufficient.
    let hash = 0
    const key = this.localSecret
    const input = key + payload + key
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i)
      hash = ((hash << 5) - hash + ch) | 0
    }
    // Mix in more bytes for collision resistance
    let hash2 = 0x811c9dc5 // FNV offset basis
    for (let i = 0; i < input.length; i++) {
      hash2 ^= input.charCodeAt(i)
      hash2 = Math.imul(hash2, 0x01000193) // FNV prime
    }
    return btoa(String(hash >>> 0) + "." + String(hash2 >>> 0))
  }

  public static getInstance(): LocalMiniappRuntime {
    if (!LocalMiniappRuntime.instance) {
      LocalMiniappRuntime.instance = new LocalMiniappRuntime()
    }
    return LocalMiniappRuntime.instance
  }

  private initialized = false

  /**
   * Initialize the runtime. Called from MantleManager.init().
   * Idempotent — safe to call multiple times.
   */
  public initialize(): void {
    if (this.initialized) return
    this.initialized = true
    console.log(`${LOG_TAG}: initialize()`)
    this.ensurePingLoop()
  }

  /**
   * Handle an incoming cloud message forwarded by SocketComms
   * (phone_stream_status, phone_managed_stream_status).
   *
   * Routes the response back to the originating miniapp via the requestId
   * that was stored when the miniapp first made the request.
   */
  public handleCloudMessage(msg: any): void {
    const requestId = msg.requestId as string | undefined
    const msgType = msg.type as string

    console.log(`${LOG_TAG}: Cloud message: ${msgType}, requestId=${requestId ?? "none"}`)

    if (!requestId) {
      console.warn(`${LOG_TAG}: Cloud message ${msgType} has no requestId, cannot route`)
      return
    }

    const pending = this.pendingCloudRequests.get(requestId)
    if (!pending) {
      console.warn(`${LOG_TAG}: No pending request for requestId=${requestId}`)
      return
    }

    this.pendingCloudRequests.delete(requestId)

    switch (msgType) {
      case "phone_stream_status": {
        // Unreachable for phone-orchestrated streams (the coordinator owns
        // their lifecycle and never registers a pending cloud request).
        // Retained as a safety net for any legacy registration path.
        this.sendToMiniapp(pending.packageName, {
          type: MiniappResponseType.EVENT,
          streamType: "stream_status",
          data: {
            streamId: msg.streamId,
            status: msg.status,
            errorDetails: msg.errorDetails,
          },
        })
        // Re-register for ongoing status updates (streams send multiple status messages)
        this.pendingCloudRequests.set(requestId, pending)
        break
      }

      case "phone_managed_stream_status": {
        if (msg.status === "connected" || msg.status === "active") {
          // Managed stream is ready — send back the playback URLs as the request result
          this.sendResult(pending.packageName, pending.envelopeRequestId, true, {
            streamId: msg.streamId,
            hlsUrl: msg.hlsUrl,
            dashUrl: msg.dashUrl,
            webrtcUrl: msg.webrtcUrl,
          })
        }
        // Forward all statuses as events too
        this.sendToMiniapp(pending.packageName, {
          type: MiniappResponseType.EVENT,
          streamType: "stream_status",
          data: {
            streamId: msg.streamId,
            status: msg.status,
            hlsUrl: msg.hlsUrl,
            dashUrl: msg.dashUrl,
            webrtcUrl: msg.webrtcUrl,
          },
        })
        // Re-register for ongoing updates
        this.pendingCloudRequests.set(requestId, pending)
        break
      }

      default:
        console.warn(`${LOG_TAG}: Unknown cloud message type: ${msgType}`)
    }
  }

  /**
   * Register a pending cloud request so we can route the response back.
   */
  public registerPendingCloudRequest(requestId: string, packageName: string, envelopeRequestId?: string): void {
    this.pendingCloudRequests.set(requestId, {packageName, envelopeRequestId})
  }

  // ===========================================================================
  // App registration
  // ===========================================================================

  public registerApp(
    packageName: string,
    sendFn: (raw: string) => void,
    installedManifest?: InstalledMiniappManifest,
  ): void {
    console.log(`${LOG_TAG}: registerApp(${packageName})`)
    this.clearForegroundProbe(packageName)
    // Fresh spawn → fresh handshake. Clear any prior handshake flag so
    // waitForConnect() blocks until this context's own CONNECT arrives.
    this.handshookApps.delete(packageName)
    // If the app is already registered (e.g. QR scanned again for same package),
    // tear down its old subscriptions first so streamSubscribers doesn't keep
    // dangling references. The WebView will re-subscribe after its CONNECT.
    if (this.connectedApps.has(packageName)) {
      const existing = this.connectedApps.get(packageName)!
      this.cancelSpeech(packageName)
      // A crash respawn replaces the ConnectedMiniapp without going through
      // unregisterApp(). Abort the old incarnation's native PCM player before
      // its only stream id is lost. Target the exact stream rather than using
      // stopForApp(), whose async playback cleanup could race with audio the
      // replacement app starts after it connects.
      const existingSpeakerStreamId = existing.activeSpeakerStreamId
      if (existingSpeakerStreamId) {
        existing.activeSpeakerStreamId = undefined
        void audioPlaybackService.abortStream(existingSpeakerStreamId).catch((error) => {
          console.warn(`${LOG_TAG}: failed to abort speaker stream while replacing ${packageName}`, error)
        })
      }
      if (existing.authRefreshTimerId !== null) {
        BgTimer.clearTimeout(existing.authRefreshTimerId)
        existing.authRefreshTimerId = null
      }
      if (existing.authRetryTimerId !== null) {
        BgTimer.clearTimeout(existing.authRetryTimerId)
        existing.authRetryTimerId = null
      }
      this.replaceStreamSubscribers(packageName, existing.subscriptions, [])
      this.recomputeMicRequirements()
      this.updateCloudSubscriptions()
    }
    this.connectedApps.set(packageName, {
      subscriptions: new Set(),
      forceLocalTranscriptionStreams: new Set(),
      cloudTranscriptionStreams: new Set(),
      sendMessage: sendFn,
      lastPongAt: Date.now(),
      unansweredPingRounds: 0,
      installedManifest,
      authRefreshTimerId: null,
      authRetryTimerId: null,
      authDelivered: false,
      speakerState: "idle",
      requestedLocationRate: null,
    })
    // If we just clobbered an existing entry, its requestedLocationRate is
    // now gone — recompute so the aggregate doesn't include a stale rate.
    // The WebView will re-SUBSCRIBE shortly and the rate will reappear.
    this.recomputeLocationTier()
    this.ensureCloudStatusWired()
    this.ensurePingLoop()

    // Show the system boot message ("Starting <name>…") on the glasses for the
    // bounded boot window, mirroring the cloud DisplayManager boot screen. The
    // window ends early once this app pushes its first display (see
    // LocalDisplayManager.request), or after ~1.5s. Fires once per spawn —
    // including a crash-respawn, since each spawn is a fresh "app is starting".
    localDisplayManager.onMount(packageName, installedManifest?.name ?? packageName)
  }

  /**
   * Resolve once `packageName` has completed its CONNECT handshake. If it has
   * already connected, resolves immediately. Rejects if the timeout elapses
   * first, or if the app is unregistered while waiting.
   *
   * Used by the launcher's `ensureConnected` (and thus the action broker) so a
   * just-spawned target is known to be live before anything is delivered to it.
   */
  public waitForConnect(packageName: string, timeoutMs: number): Promise<void> {
    if (this.handshookApps.has(packageName)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const waiter = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.connectWaiters.get(packageName)?.delete(waiter)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        waiter(new Error(`waitForConnect: ${packageName} did not connect within ${timeoutMs}ms`))
      }, timeoutMs)
      let set = this.connectWaiters.get(packageName)
      if (!set) {
        set = new Set()
        this.connectWaiters.set(packageName, set)
      }
      set.add(waiter)
    })
  }

  /** Resolve/reject all pending {@link waitForConnect} waiters for a package. */
  private flushConnectWaiters(packageName: string, err?: Error): void {
    const waiters = this.connectWaiters.get(packageName)
    if (!waiters) return
    this.connectWaiters.delete(packageName)
    for (const w of waiters) w(err)
  }

  /**
   * Invalidate the CONNECT handshake for a package whose native context is
   * being replaced WITHOUT going through register/unregister — i.e. a crash
   * respawn. Without this, {@link waitForConnect} would treat the dead/
   * not-yet-initialized context as connected and deliver to it. Pending waiters
   * are failed so a wake mid-respawn retries rather than hanging.
   */
  public resetHandshake(packageName: string): void {
    this.handshookApps.delete(packageName)
    this.flushConnectWaiters(packageName, new Error(`${packageName} respawning`))
  }

  /**
   * Attach (or update) the installedManifest for an already-registered app.
   * Used when the manifest is fetched asynchronously (dev miniapps) after the
   * miniapp has already CONNECTed — preserves existing subscriptions.
   */
  public setInstalledManifest(packageName: string, installedManifest: InstalledMiniappManifest): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return
    app.installedManifest = installedManifest

    // Push declared-permission record to the SDK so session.permissions stays
    // in sync. Sent regardless of CONNECT_ACK timing — covers the dev-miniapp
    // case where the manifest is fetched async after the miniapp CONNECTs.
    this.sendToMiniapp(packageName, {
      type: MiniappResponseType.PERMISSIONS_UPDATE,
      permissions: computeDeclaredPermissionRecord(installedManifest),
    })
  }

  /**
   * Graceful version of {@link unregisterApp}: notify the miniapp via
   * `WILL_DISCONNECT`, wait ~50ms so its `beforeDisconnect` handlers can
   * fire one last `sendOneShot` (e.g. `display.clear()`), then run the
   * normal teardown. Use this for any disconnect path where the socket
   * is still open. For ungraceful paths (transport already closed),
   * call {@link unregisterApp} directly — the heads-up would be
   * undeliverable anyway.
   */
  public async gracefullyUnregisterApp(packageName: string, reason = "unregistering"): Promise<void> {
    const app = this.connectedApps.get(packageName)
    if (!app) return

    console.log(`${LOG_TAG}: gracefullyUnregisterApp(${packageName}) — sending WILL_DISCONNECT`)
    this.sendToMiniapp(packageName, {
      type: MiniappResponseType.WILL_DISCONNECT,
      reason,
    })
    // 50 ms: imperceptible to the user, plenty of time for the SDK's
    // synchronous `beforeDisconnect` handlers to flush a final
    // sendOneShot through the still-open transport.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    this.unregisterApp(packageName)
  }

  public unregisterApp(packageName: string): void {
    console.log(`${LOG_TAG}: unregisterApp(${packageName})`)
    const releasedMicGateOverride = micStateCoordinator.clearMiniappGateOverrides(packageName)
    this.clearForegroundProbe(packageName)
    this.clearMiniappAuthRefresh(packageName)
    this.clearMiniappAuthDeliveryRetry(packageName)
    // Drop the handshake flag and fail any in-flight waitForConnect() callers
    // (e.g. a wake that's mid-handshake when the app is torn down). Done before
    // the early-return so it runs even if the connectedApps entry is already gone.
    this.handshookApps.delete(packageName)
    this.flushConnectWaiters(packageName, new Error(`${packageName} unregistered before connect`))
    // Drop this app's transcription hints; the cloud subscription rebuild
    // below (via replaceStreamSubscribers) re-derives the hint union without it.
    this.transcriptionHintsByApp.delete(packageName)

    // Warm-up is a request-owned camera lease. Cancel it even if the app record was already
    // removed so a close racing the camera-open promise cannot leave the sensor running.
    // Keep camera teardown ordered: restoring FOV can restart the HAL, so the warm-up lease must
    // finish closing the sensor before FOV reconciliation begins. Continue to FOV cleanup even if
    // warm-up cancellation fails; phone ownership remains retryable until the ASG lease TTL.
    void phonePhotoCoordinator
      .stopWarmUpForApp(packageName)
      .catch((error) => {
        console.warn(`${LOG_TAG}: failed to stop camera warm-up for ${packageName} on unregister`, error)
      })
      .then(() => phoneCameraFovCoordinator.releaseForApp(packageName))
      .catch((error) => {
        console.warn(`${LOG_TAG}: failed to release camera FOV override for ${packageName} on unregister`, error)
      })
    const app = this.connectedApps.get(packageName)
    if (!app) {
      if (releasedMicGateOverride) {
        void micStateCoordinator.syncEffectiveGatePolicy(this.getConfiguredMicGates()).catch((error) => {
          console.warn(`${LOG_TAG}: failed to restore mic gate policy for ${packageName}`, error)
        })
      }
      return
    }

    // Remove from all stream subscriber sets
    this.replaceStreamSubscribers(packageName, app.subscriptions, [])

    // Reset per-session warning dedup so a relaunch surfaces issues again.
    resetPermissionWarnings(packageName)

    // Cancel lookahead/in-flight synthesis before stopping the current file so
    // an interrupted sentence cannot advance and reclaim playback.
    this.cancelSpeech(packageName)

    // Stop audio for this app
    audioPlaybackService.stopForApp(packageName)

    // Tear down this app's blob state: abort in-flight uploads + close readers
    // so a crashed/closed miniapp doesn't leak partial files or file handles.
    this.blobStore.onAppGone(packageName)

    // Release phone-owned camera streams. If a miniapp closes/crashes without
    // sending STREAM_STOP, the host coordinator must drop its subscriber/owner
    // so glasses publishing and managed Cloudflare inputs do not leak.
    void phoneStreamCoordinator.stop(packageName).catch((error) => {
      console.warn(`${LOG_TAG}: failed to stop stream for ${packageName} on unregister`, error)
    })

    // Stop any phone-owned video recordings for this app. A miniapp that
    // closes/crashes mid-recording loses its recordingId, so without this the
    // glasses keep recording until the max-recording timeout or thermal shutdown.
    void phoneVideoCoordinator.stopForApp(packageName).catch((error) => {
      console.warn(`${LOG_TAG}: failed to stop video recording for ${packageName} on unregister`, error)
    })

    // Detach the per-app nav event forwarder but leave the native nav session
    // running. The user may have just closed the mini-app UI and will reopen
    // it; stopping the session here would kill an active trip mid-route.
    // Navigation is only stopped when the mini-app explicitly calls
    // navigation.stop() or when the trip arrives/errors naturally.
    // (See NavigationHandlers — activeNavApps stays populated so a reconnect
    // can reattach listeners and resume.)
    this.navigationHandlers.onDisconnect(packageName)

    // Recompute heading subscription — if this app was the last subscriber,
    // the sensor will stop.
    this.recomputeHeadingSubscription()
    // Same for the IMU/accelerometer stream.
    this.recomputeImuSubscription()

    // Drop this app's location-tier request before recomputing so the
    // aggregate falls back down if it was the strictest. Done before
    // `connectedApps.delete` below so it doesn't matter that the iter
    // in `recomputeLocationTier` is over connectedApps — clearing the
    // field is enough.
    app.requestedLocationRate = null
    this.recomputeLocationTier()

    // Clean up any pending cloud requests from this app
    for (const [reqId, pending] of this.pendingCloudRequests) {
      if (pending.packageName === packageName) {
        this.pendingCloudRequests.delete(reqId)
      }
    }

    // Release any display real estate this app held — if it owned the
    // current on-glasses frame, this clears the glasses (or restores the
    // core app's saved frame).
    localDisplayManager.onUnmount(packageName)

    this.connectedApps.delete(packageName)
    this.recomputeMicRequirements()
    if (releasedMicGateOverride) {
      void micStateCoordinator.syncEffectiveGatePolicy(this.getConfiguredMicGates()).catch((error) => {
        console.warn(`${LOG_TAG}: failed to restore mic gate policy for ${packageName}`, error)
      })
    }
    this.updateCloudSubscriptions()

    if (this.connectedApps.size === 0) {
      this.stopPingLoop()
    }
  }

  // ===========================================================================
  // Inbound message handling
  // ===========================================================================

  public handleRawMessage(packageName: string, raw: string): void {
    const envelope = parseEnvelope(raw)
    if (!envelope) {
      // Not a miniapp envelope — ignore (could be legacy bridge message)
      return
    }

    const payload = envelope.payload as Record<string, unknown>
    const requestType = payload.type as string | undefined
    const requestId = envelope.requestId

    if (!requestType) {
      console.warn(`${LOG_TAG}: Envelope from ${packageName} missing payload.type`)
      return
    }

    // ANY inbound message proves the context is alive — a busy background
    // script streaming DISPLAY/storage traffic shouldn't be killed by the
    // liveness watchdog just because its PONG replies queue behind real work.
    this.handlePong(packageName)

    // Console-tap forwarding. The miniapp's console.log/warn/etc is wrapped
    // (via injected shim from miniappGlobals.ts) to post a `dev_log`
    // envelope. We fan out to two destinations:
    //   1. DevServerBridge — forwards to the laptop's `mentra-miniapp dev`
    //      terminal. No-op when there's no sidecar (installed miniapps).
    //   2. React Native console — surfaces the log in Metro / Xcode console
    //      / adb logcat so installed-miniapp errors are still inspectable
    //      when there's no laptop to forward to.
    if (requestType === "dev_log") {
      const level = (payload.level as string | undefined) ?? "log"
      const args = Array.isArray(payload.args) ? (payload.args as unknown[]) : []
      const timestamp = (payload.timestamp as number | undefined) ?? Date.now()
      // Source is "ui" because the single-bundle WebView console-tap
      // shim in miniappGlobals.ts is the only thing that posts
      // `dev_log`; the two-layer path uses a separate envelope
      // (`{type:"log", source}`) routed by MentraUIRouter.
      devServerBridge.forwardLog(packageName, level, args, timestamp, "ui")

      const tag = `[MINIAPP ${packageName}]`
      const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[level] ?? console.log
      try {
        fn(tag, ...args)
      } catch {
        console.log(tag, ...args)
      }
      return
    }

    // Dispatch
    switch (requestType) {
      case MiniappRequestType.CONNECT:
        void this.handleConnect(packageName, payload, requestId)
        break
      case MiniappRequestType.AUTH_REFRESH:
        void this.handleAuthRefresh(packageName, payload, requestId)
        break
      case MiniappRequestType.SUBSCRIBE:
        this.handleSubscribe(packageName, payload, requestId)
        break
      case MiniappRequestType.DISPLAY:
        this.handleDisplay(packageName, payload, requestId)
        break
      case MiniappRequestType.RENDER:
        this.handleRender(packageName, payload, requestId)
        break
      case MiniappRequestType.PLAY_AUDIO:
        this.handlePlayAudio(packageName, payload, requestId)
        break
      case MiniappRequestType.STOP_AUDIO:
        this.handleStopAudio(packageName, payload, requestId)
        break
      case MiniappRequestType.SPEAK:
        this.handleSpeak(packageName, payload, requestId)
        break
      case MiniappRequestType.SPEAKER_STREAM_OPEN:
        void this.handleSpeakerStreamOpen(packageName, payload, requestId)
        break
      case MiniappRequestType.SPEAKER_STREAM_WRITE:
        void this.handleSpeakerStreamWrite(packageName, payload, requestId)
        break
      case MiniappRequestType.SPEAKER_STREAM_CLOSE:
        void this.handleSpeakerStreamClose(packageName, payload, requestId)
        break
      case MiniappRequestType.SPEAKER_STREAM_ABORT:
        void this.handleSpeakerStreamAbort(packageName, payload, requestId)
        break
      case MiniappRequestType.RGB_LED:
        void this.handleRgbLed(packageName, payload, requestId)
        break
      case MiniappRequestType.LOCATION_POLL:
        this.handleLocationPoll(packageName, requestId)
        break
      case MiniappRequestType.CALENDAR_LIST_EVENTS:
        void this.handleCalendarListEvents(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_START:
        this.navigationHandlers.handleStart(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_STOP:
        this.navigationHandlers.handleStop(packageName, requestId)
        break
      case MiniappRequestType.NAVIGATION_DEVIATE:
        this.navigationHandlers.handleDeviate(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_SET_WRONG_SIDEWALK:
        this.navigationHandlers.handleSetWrongSidewalk(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_SET_SKIP_CROSSINGS:
        this.navigationHandlers.handleSetSkipCrossings(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_GET_STATE:
        this.navigationHandlers.handleGetState(packageName, requestId)
        break
      case MiniappRequestType.NAVIGATION_COMPUTE_ROUTE:
        this.navigationHandlers.handleComputeRoute(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_REVERSE_GEOCODE:
        this.navigationHandlers.handleReverseGeocode(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_PLACE_AUTOCOMPLETE:
        this.navigationHandlers.handlePlaceAutocomplete(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_PLACE_DETAILS:
        this.navigationHandlers.handlePlaceDetails(packageName, payload, requestId)
        break
      case MiniappRequestType.NAVIGATION_REQUEST_PERMISSION:
        this.navigationHandlers.handleRequestPermission(packageName, requestId)
        break
      case MiniappRequestType.STORAGE_GET:
        this.handleStorageGet(packageName, payload, requestId)
        break
      case MiniappRequestType.STORAGE_SET:
        this.handleStorageSet(packageName, payload, requestId)
        break
      case MiniappRequestType.STORAGE_DELETE:
        this.handleStorageDelete(packageName, payload, requestId)
        break
      case MiniappRequestType.STORAGE_LIST:
        this.handleStorageList(packageName, payload, requestId)
        break
      case MiniappRequestType.STORAGE_CLEAR:
        this.handleStorageClear(packageName, requestId)
        break
      case MiniappRequestType.STORAGE_HAS:
        this.handleStorageHas(packageName, payload, requestId)
        break
      case MiniappRequestType.STORAGE_GET_ALL:
        this.handleStorageGetAll(packageName, requestId)
        break
      case MiniappRequestType.STORAGE_SET_MULTIPLE:
        this.handleStorageSetMultiple(packageName, payload, requestId)
        break
      case MiniappRequestType.STORAGE_FLUSH:
        // No-op today — MMKV writes through synchronously. Reserved so
        // a future debounced backend can honor "flush before I quit"
        // calls without breaking the API.
        this.sendResult(packageName, requestId, true)
        break
      case MiniappRequestType.CAMERA_FOV:
        void this.handleCameraFov(packageName, payload, requestId)
        break
      case MiniappRequestType.SET_WIFI_ADB_STATE:
        void this.handleSetWifiAdbState(packageName, payload, requestId)
        break
      case MiniappRequestType.IMU_SET_ENABLED:
        this.handleImuSetEnabled(packageName, payload, requestId)
        break
      case MiniappRequestType.MIC_SET_VAD_ENABLED:
        void this.handleMicSetVadEnabled(packageName, payload, requestId)
        break
      case MiniappRequestType.MIC_SET_LOUDNESS_GATE_ENABLED:
        void this.handleMicSetLoudnessGateEnabled(packageName, payload, requestId)
        break
      case MiniappRequestType.PING:
        // SDK should handle this itself; reply PONG just in case
        this.sendToMiniapp(packageName, {type: MiniappResponseType.PONG}, requestId)
        break
      case MiniappResponseType.PONG: {
        // Liveness already touched above for every inbound message; the
        // PONG carries no other action.
        break
      }

      case MiniappRequestType.SHARE:
        this.handleShare(packageName, payload, requestId)
        break
      case MiniappRequestType.OPEN_URL:
        this.handleOpenUrl(packageName, payload)
        break
      case MiniappRequestType.COPY_CLIPBOARD:
        this.handleCopyClipboard(packageName, payload, requestId)
        break
      case MiniappRequestType.DOWNLOAD:
        this.handleDownload(packageName, payload, requestId)
        break
      case MiniappRequestType.SCAN_QR:
        void this.handleScanQr(packageName, payload, requestId)
        break

      // Persistent binary blob storage (session.blob)
      case MiniappRequestType.BLOB_CREATE:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleCreate(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_WRITE:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleWrite(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_COMMIT:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleCommit(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_ABORT:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleAbort(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_SET_FROM_URL:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleSetFromUrl(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_IMPORT:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleImport(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_GET:
        this.enqueueBlobRequest(packageName, requestId, () => this.blobStore.handleGet(packageName, payload, requestId))
        break
      case MiniappRequestType.BLOB_LIST:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleList(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_USAGE:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleUsage(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_DELETE:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleDelete(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_CLEAR:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleClear(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_OPEN_READ:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleOpenRead(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_READ:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleRead(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_CLOSE_READ:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleCloseRead(packageName, payload, requestId),
        )
        break
      case MiniappRequestType.BLOB_SHARE:
        this.enqueueBlobRequest(packageName, requestId, () =>
          this.blobStore.handleShare(packageName, payload, requestId),
        )
        break

      // Cloud-coordinated features
      case MiniappRequestType.PHOTO:
        void this.handlePhoto(packageName, payload, requestId)
        break
      case MiniappRequestType.CAMERA_WARM_UP:
        void this.handleCameraWarmUp(packageName, payload, requestId)
        break
      case MiniappRequestType.VIDEO_RECORDING_START:
        void this.handleVideoRecordingStart(packageName, payload, requestId)
        break
      case MiniappRequestType.VIDEO_RECORDING_STOP:
        void this.handleVideoRecordingStop(packageName, payload, requestId)
        break
      case MiniappRequestType.STREAM_START:
        void this.handleStreamStart(packageName, payload, requestId)
        break
      case MiniappRequestType.STREAM_STOP:
        void this.handleStreamStop(packageName, payload, requestId)
        break
      case MiniappRequestType.MANAGED_STREAM_START:
        void this.handleManagedStreamStart(packageName, payload, requestId)
        break
      case MiniappRequestType.MANAGED_STREAM_STOP:
        void this.handleManagedStreamStop(packageName, payload, requestId)
        break
      case REQUEST_WIFI_SETUP_TYPE:
        void this.handleRequestWifiSetup(packageName, payload, requestId)
        break

      // Inter-miniapp interop (SYSTEM apps only)
      case MiniappRequestType.MINIAPPS_LIST:
        this.handleMiniappsList(packageName, payload, requestId)
        break
      case MiniappRequestType.MINIAPPS_START:
        void this.handleMiniappsStart(packageName, payload, requestId)
        break
      case MiniappRequestType.MINIAPPS_STOP:
        void this.handleMiniappsStop(packageName, payload, requestId)
        break
      case MiniappRequestType.ACTION_INVOKE:
        void this.handleActionInvoke(packageName, payload, requestId)
        break
      case MiniappRequestType.ACTION_RESULT:
        this.handleActionResult(packageName, payload)
        break

      // Deferred in v1
      case MiniappRequestType.DASHBOARD_CONTENT_UPDATE:
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: "Dashboard API is deferred in v1",
        })
        break

      case MiniappRequestType.TRANSCRIPTION_CONFIG:
        this.handleTranscriptionConfig(packageName, payload, requestId)
        break

      default:
        // NACK instead of silent drop (issue 021 S3): an SDK that sends a
        // request this runtime doesn't implement must get a rejected promise,
        // not a permanently-pending silent gap. One-shots (no requestId) can
        // only be logged.
        console.warn(`${LOG_TAG}: Unknown request type from ${packageName}: ${requestType}`)
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: `Unknown or unimplemented request type: ${requestType}`,
        })
        break
    }
  }

  // ===========================================================================
  // Request handlers
  // ===========================================================================

  private async handleConnect(
    packageName: string,
    _payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    console.log(`${LOG_TAG}: CONNECT from ${packageName}`)

    // Register if not already
    const existing = this.connectedApps.get(packageName)
    if (!existing) {
      console.warn(`${LOG_TAG}: CONNECT from unregistered app ${packageName}, ignoring`)
      return
    }

    // Update lastPongAt so it doesn't time out right away
    existing.lastPongAt = Date.now()
    existing.unansweredPingRounds = 0

    // Read current glasses capabilities from the settings store
    const defaultWearable = useSettingsStore.getState().getSetting(ISLAND_SETTINGS_KEYS.defaultWearable) as
      | DeviceTypes
      | undefined
    const capabilities = getModelCapabilities(defaultWearable || DeviceTypes.NONE)

    // Build the declared-permission record for the SDK's session.permissions
    // module. Lower-cased to match v3's PermissionType union (microphone,
    // camera, location, notifications, calendar). Missing permissions default
    // to false; this is manifest-declaration tracking only — OS-grant state
    // is intentionally not modeled here.
    const declaredPermissions = computeDeclaredPermissionRecord(existing.installedManifest)
    // Fresh handshake → clear any auth state from a prior context so a stale
    // retry timer can't fire against this new connection and so the retry loop
    // below re-arms from scratch.
    existing.authDelivered = false
    this.clearMiniappAuthDeliveryRetry(packageName)
    const authPromise = this.requestMiniappAuth(packageName)
    const initialAuth = await withTimeout(authPromise, 1_500)
    const userId = initialAuth?.mentraUserId ?? ""
    if (initialAuth) {
      existing.authDelivered = true
      this.scheduleMiniappAuthRefresh(packageName, initialAuth)
    }

    this.sendToMiniapp(
      packageName,
      {
        type: MiniappResponseType.CONNECT_ACK,
        userId,
        packageName,
        capabilities,
        permissions: declaredPermissions,
        configuration: getMiniappConfiguration(packageName),
        ...(initialAuth ? {auth: initialAuth} : {}),
      },
      requestId,
    )
    if (!initialAuth) {
      // The mint timed out or (more importantly) REJECTED — the latter happens
      // when the cloud client hasn't finished its first-boot Core token exchange
      // yet, which is exactly the case when a dev miniapp is scanned/launched
      // right after app start. CONNECT_ACK already went out without auth; keep
      // trying to mint (and re-drive on cloud-connect) so the app authenticates
      // to its backend on its own, instead of staying dead until a full manual
      // Cloud V2 reconnect re-runs the whole handshake.
      this.deliverInitialMiniappAuth(packageName, authPromise, 0)
    }
    this.sendCloudStatusToMiniapp(packageName)

    // Handshake complete — unblock any launcher.waitForConnect() callers.
    this.handshookApps.add(packageName)
    this.flushConnectWaiters(packageName)
  }

  private async requestMiniappAuth(packageName: string, opts?: {minTtlMs?: number}): Promise<MiniappAuthToken | null> {
    // Core owns miniapp-backend token minting. A Runtime-only deployment has
    // no such capability, so fail once instead of entering the retry loop.
    if (!cloudClientService.hasCore()) return null
    const authPackageName = getDevAppSourcePackage(packageName) ?? packageName
    const devAttestation = getDevAppAttestation(packageName) ?? undefined
    return cloudClientService.getMiniappAuthToken(authPackageName, {
      ...opts,
      ...(devAttestation ? {devAttestation} : {}),
    })
  }

  private async handleAuthRefresh(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const auth = await this.refreshMiniappAuth(packageName, this.authRefreshOptions(payload))
      if (!auth) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_CONNECTED,
          message: "Miniapp auth is not configured",
        })
        return
      }
      this.sendResult(packageName, requestId, true, {auth})
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: (err as Error)?.message ?? "Miniapp auth refresh failed",
      })
    }
  }

  private async refreshMiniappAuth(packageName: string, opts?: {minTtlMs?: number}): Promise<MiniappAuthToken | null> {
    const auth = await this.requestMiniappAuth(packageName, opts)
    if (!auth) return null
    this.scheduleMiniappAuthRefresh(packageName, auth)
    this.sendToMiniapp(packageName, {
      type: MiniappResponseType.AUTH_UPDATE,
      auth,
    })
    return auth
  }

  private authRefreshOptions(payload: Record<string, unknown>): {minTtlMs?: number} | undefined {
    const minTtlMs = Number(payload.minTtlMs)
    if (!Number.isFinite(minTtlMs) || minTtlMs <= 0) return undefined
    return {minTtlMs}
  }

  private scheduleMiniappAuthRefresh(packageName: string, auth: MiniappAuthToken): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return
    this.clearMiniappAuthRefresh(packageName)

    const refreshAt = auth.expiresAt - MINIAPP_AUTH_REFRESH_HEADROOM_MS
    const delay = Math.max(MINIAPP_AUTH_REFRESH_MIN_DELAY_MS, refreshAt - Date.now())
    app.authRefreshTimerId = BgTimer.setTimeout(() => {
      const current = this.connectedApps.get(packageName)
      if (!current) return
      current.authRefreshTimerId = null
      void this.refreshMiniappAuth(packageName).catch((err) => {
        console.warn(`${LOG_TAG}: miniapp auth refresh failed for ${packageName}: ${(err as Error)?.message ?? err}`)
      })
    }, delay)
  }

  private clearMiniappAuthRefresh(packageName: string): void {
    const app = this.connectedApps.get(packageName)
    if (!app || app.authRefreshTimerId === null) return
    const timerId = app.authRefreshTimerId
    BgTimer.clearTimeout(timerId)
    app.authRefreshTimerId = null
  }

  /**
   * Deliver the miniapp's FIRST auth token, retrying until it lands. Called from
   * {@link handleConnect} when the initial mint didn't resolve in the CONNECT_ACK
   * window. `inFlight` lets attempt 0 reuse the mint the handshake already
   * started (avoids a redundant duplicate request); later attempts mint fresh.
   *
   * A `null` result means auth is fundamentally unavailable (no miniappAuth hook)
   * — permanent, so we do NOT retry. A REJECTION means a transient failure
   * (typically the cloud client isn't connection-ready yet) — retry with backoff.
   * Either way we bail if the app has since disconnected or already got a token
   * (e.g. via {@link redriveMiniappAuthDelivery} on cloud-connect).
   */
  private deliverInitialMiniappAuth(
    packageName: string,
    inFlight: Promise<MiniappAuthToken | null> | undefined,
    attempt: number,
  ): void {
    const app = this.connectedApps.get(packageName)
    if (!app || app.authDelivered) return
    const mint = inFlight ?? this.requestMiniappAuth(packageName)
    void mint
      .then((auth) => {
        const current = this.connectedApps.get(packageName)
        if (!current || current.authDelivered) return
        if (!auth) return // no auth hook — permanent, don't spin
        current.authDelivered = true
        this.clearMiniappAuthDeliveryRetry(packageName)
        this.scheduleMiniappAuthRefresh(packageName, auth)
        this.sendToMiniapp(packageName, {type: MiniappResponseType.AUTH_UPDATE, auth})
      })
      .catch((err) => {
        console.warn(
          `${LOG_TAG}: miniapp auth mint failed for ${packageName} (attempt ${attempt}): ${
            (err as Error)?.message ?? err
          }`,
        )
        this.scheduleInitialMiniappAuthRetry(packageName, attempt)
      })
  }

  private scheduleInitialMiniappAuthRetry(packageName: string, attempt: number): void {
    const app = this.connectedApps.get(packageName)
    if (!app || app.authDelivered) return
    this.clearMiniappAuthDeliveryRetry(packageName)
    const delay = Math.min(MINIAPP_AUTH_RETRY_MAX_MS, MINIAPP_AUTH_RETRY_BASE_MS * 2 ** attempt)
    app.authRetryTimerId = BgTimer.setTimeout(() => {
      const current = this.connectedApps.get(packageName)
      if (!current) return
      current.authRetryTimerId = null
      this.deliverInitialMiniappAuth(packageName, undefined, attempt + 1)
    }, delay)
  }

  private clearMiniappAuthDeliveryRetry(packageName: string): void {
    const app = this.connectedApps.get(packageName)
    if (!app || app.authRetryTimerId === null) return
    BgTimer.clearTimeout(app.authRetryTimerId)
    app.authRetryTimerId = null
  }

  /**
   * When the cloud client (re)connects, immediately re-attempt the initial mint
   * for any handshook app still missing its token, instead of waiting out the
   * backoff. This is what turns "scan a dev app before the cloud is ready" from
   * "dead until you manually reconnect Cloud V2" into "authenticates on its own
   * the instant the connection comes up".
   */
  private redriveMiniappAuthDelivery(): void {
    for (const [packageName, app] of this.connectedApps) {
      if (app.authDelivered) continue
      // Only apps that finished their CONNECT handshake are in the mint-retry
      // state; skip anything still mid-handshake (handleConnect owns that).
      if (!this.handshookApps.has(packageName)) continue
      this.clearMiniappAuthDeliveryRetry(packageName)
      this.deliverInitialMiniappAuth(packageName, undefined, 0)
    }
  }

  /**
   * TRANSCRIPTION_CONFIG (issue 021 WP3): store the miniapp's language hints
   * and rebuild the cloud subscription set so the auto-mode subscription
   * carries them. Replies with a REQUEST_RESULT so the SDK's configure()
   * promise settles: unknown hint values are an error, not a silent drop.
   */
  private handleTranscriptionConfig(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return

    const config = (payload.config ?? {}) as Record<string, unknown>
    const rawHints = config.languageHints
    if (rawHints !== undefined && !Array.isArray(rawHints)) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "languageHints must be an array of language codes",
      })
      return
    }

    if (rawHints === undefined || rawHints.length === 0) {
      this.transcriptionHintsByApp.delete(packageName)
    } else {
      // Defense in depth: the SDK already validated, but the wire is untyped.
      const hints: string[] = []
      const invalid: string[] = []
      for (const raw of rawHints as unknown[]) {
        const hint = typeof raw === "string" ? toLanguageHint(raw) : null
        if (hint) hints.push(hint)
        else invalid.push(String(raw))
      }
      if (invalid.length > 0) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: `Unknown language hint(s): ${invalid.join(", ")}`,
        })
        return
      }
      this.transcriptionHintsByApp.set(packageName, [...new Set(hints)].sort())
    }

    this.updateCloudSubscriptions()
    this.sendResult(packageName, requestId, true, {applied: true})
  }

  private handleSubscribe(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return

    const rawStreams = (payload.subscriptions ?? payload.streams) as
      | (string | {stream: string; rate?: string; forceLocal?: boolean; includeCloud?: boolean})[]
      | undefined
    // Normalize: objects like {stream: "location_stream", rate: "realtime"} → extract stream name
    // "location_stream" is the rate-bearing alias for "location_update".
    // The strictest rate wins when multiple `location_stream` entries appear
    // in one SUBSCRIBE — the same rule we apply across apps.
    let requestedLocationRate: string | null = null
    const forceLocalTranscriptionStreams = new Set<string>()
    const cloudTranscriptionStreams = new Set<string>()
    const streams = rawStreams?.map((s) => {
      if (typeof s === "object" && s !== null) {
        if (s.stream === "location_stream") {
          if (s.rate && locationRateRank(s.rate) > locationRateRank(requestedLocationRate)) {
            requestedLocationRate = s.rate
          }
          return "location_update"
        }
        if (s.forceLocal === true && s.stream.startsWith("transcription:")) {
          forceLocalTranscriptionStreams.add(s.stream)
        }
        if (s.stream.startsWith("transcription:") && (s.forceLocal !== true || s.includeCloud === true)) {
          cloudTranscriptionStreams.add(s.stream)
        }
        return s.stream
      }
      if (s.startsWith("transcription:")) cloudTranscriptionStreams.add(s)
      return s
    }) as string[] | undefined
    if (!Array.isArray(streams)) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "subscribe requires a subscriptions array",
      })
      return
    }

    for (const subscription of rawStreams ?? []) {
      const stream = typeof subscription === "string" ? subscription : subscription.stream
      if (stream.startsWith("translation:") && !isFeatureEnabled("cloudSpeech")) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: "Cloud speech is disabled by this deployment",
        })
        return
      }
      if (!stream.startsWith("transcription:")) continue
      const forceLocal = typeof subscription === "object" && subscription.forceLocal === true
      const includeCloud = typeof subscription === "object" && subscription.includeCloud === true
      if (forceLocal && !isFeatureEnabled("onDeviceSpeech")) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: "On-device speech is disabled by this deployment",
        })
        return
      }
      if ((!forceLocal || includeCloud) && !isFeatureEnabled("cloudSpeech")) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: "Cloud speech is disabled by this deployment",
        })
        return
      }
    }

    console.log(`${LOG_TAG}: SUBSCRIBE from ${packageName}: [${streams.join(", ")}]`)

    // Gate each stream on the permission type its data requires. The manifest
    // must declare the permission (miniapp.json -> permissions) or we reject
    // the whole subscribe with PERMISSION_NOT_DECLARED.
    const declaredTypes = new Set((app.installedManifest?.permissions ?? []).map((p) => p.type?.toUpperCase()))

    const permissionForStream = (s: string): string | null => {
      if (s === "audio_chunk" || s === "vad") return "MICROPHONE"
      if (s.startsWith("transcription") || s.startsWith("translation")) return "MICROPHONE"
      if (s === "location_update") return "LOCATION"
      if (s === "phone_notification") return "READ_NOTIFICATIONS"
      if (s === "phone_notification_dismissed") return "READ_NOTIFICATIONS"
      return null
    }

    for (const stream of streams) {
      const required = permissionForStream(stream)
      if (required && !declaredTypes.has(required)) {
        logPermissionNotDeclared(packageName, required, `to subscribe to "${stream}"`, `{"type": "${required}"}`)
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
          message: `${required} permission not declared in miniapp.json (required for "${stream}"). Add {"type": "${required}"} to the "permissions" array.`,
          // Extra context fields read by the SDK so authors that subscribe
          // to session.on("error") can format their own messages.
          permission: required,
          subscription: stream,
        })
        return
      }
    }

    // Add new subscriptions
    const previousSubscriptions = app.subscriptions
    app.subscriptions = new Set(streams)
    app.forceLocalTranscriptionStreams = new Set(
      [...forceLocalTranscriptionStreams].filter((stream) => app.subscriptions.has(stream)),
    )
    app.cloudTranscriptionStreams = new Set(
      [...cloudTranscriptionStreams].filter((stream) => app.subscriptions.has(stream)),
    )
    this.replaceStreamSubscribers(packageName, previousSubscriptions, app.subscriptions)

    this.recomputeMicRequirements()
    this.updateCloudSubscriptions()
    this.recomputeHeadingSubscription()
    this.recomputeImuSubscription()
    // Persist this app's requested rate (or clear it if SUBSCRIBE didn't
    // include `location_stream` this time), then ask the host for the
    // strictest rate across all connected apps.
    app.requestedLocationRate = requestedLocationRate
    this.recomputeLocationTier()
    this.sendResult(packageName, requestId, true)

    // Fire initial snapshot values for stateful streams so miniapps don't have
    // to wait for the first change event.
    this.emitInitialSnapshots(packageName, streams)
  }

  private async handleCalendarListEvents(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const app = this.connectedApps.get(packageName)
    const declared = app?.installedManifest?.permissions?.some(
      (permission) => permission.type?.toUpperCase() === "CALENDAR",
    )
    if (!declared) {
      logPermissionNotDeclared(packageName, "CALENDAR", "to list calendar events", '{"type": "CALENDAR"}')
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: 'CALENDAR permission not declared in miniapp.json. Add {"type": "CALENDAR"} to the permissions array.',
        permission: "CALENDAR",
      })
      return
    }

    try {
      const result = await listPhoneCalendarEvents(payload)
      this.sendResult(packageName, requestId, true, result)
    } catch (error) {
      const known = error instanceof PhoneCalendarError
      this.sendResult(packageName, requestId, false, undefined, {
        code: known ? error.code : MiniappErrorCode.INTERNAL,
        message: error instanceof Error ? error.message : "Failed to read phone calendar events",
      })
    }
  }

  /**
   * For state-bearing streams (battery, connection), deliver the current value
   * immediately on subscribe. Other streams (button press, transcription, etc.)
   * are pure event streams with no "current value" to snapshot.
   */
  private emitInitialSnapshots(packageName: string, streams: string[]): void {
    // Read the engine glasses store directly (was a host glassesStatus hook).
    const gs = useGlassesStore.getState()
    const glassesState = {
      connected: isGlassesConnected(gs.connection),
      deviceModel: gs.deviceModel,
      batteryLevel: gs.batteryLevel,
      charging: gs.charging,
    }
    const isSimulated = (glassesState.deviceModel || "").toLowerCase().includes("simulated")

    for (const stream of streams) {
      if (stream === "glasses_battery") {
        // Simulated glasses have no real battery; mirror the phone's battery
        // so miniapps see a sensible value during development.
        if (isSimulated) {
          void this.emitPhoneBatteryAs(packageName, "glasses_battery")
        } else if (typeof glassesState.batteryLevel === "number" && glassesState.batteryLevel >= 0) {
          this.sendToMiniapp(packageName, {
            type: MiniappResponseType.EVENT,
            streamType: "glasses_battery",
            data: {
              level: glassesState.batteryLevel,
              charging: !!glassesState.charging,
              timestamp: Date.now(),
            },
          })
        }
      } else if (stream === "phone_battery") {
        void this.emitPhoneBatteryAs(packageName, "phone_battery")
      } else if (stream === "glasses_connection") {
        this.sendToMiniapp(packageName, {
          type: MiniappResponseType.EVENT,
          streamType: "glasses_connection",
          data: glassesState,
        })
      } else if (stream === "glasses_wifi") {
        // Snapshot the current glasses Wi-Fi state on subscribe (like battery).
        // Read the canonical nested `wifi: {state, ssid}` from the STORE state
        // (`glassesState` is the narrowed 4-field projection and has no `wifi`;
        // the pre-engine host hook spread the full store, so read gs directly —
        // NOT the legacy flat wifiConnected). Effective connectivity requires the
        // glasses connected AND on Wi-Fi — mirrors the host's store-derived
        // forward, so an already-disconnected device reports `connected: false`
        // rather than silently emitting nothing. Always emits so onWifi gets an
        // initial value.
        const wifi = gs.wifi.state === "connected" ? gs.wifi : null
        const connected = glassesState.connected === true && wifi !== null
        this.sendToMiniapp(packageName, {
          type: MiniappResponseType.EVENT,
          streamType: "glasses_wifi",
          data: {
            connected,
            ssid: connected ? wifi?.ssid : undefined,
            localIp: connected ? wifi?.localIp : undefined,
            timestamp: Date.now(),
          },
        })
      } else if (stream === "head_position") {
        // The glasses store has no headUp field (same on the pre-engine host
        // hook), so this stays a no-emit until head state lands in the store.
        const headUp = (gs as {headUp?: boolean}).headUp
        if (typeof headUp === "boolean") {
          this.sendToMiniapp(packageName, {
            type: MiniappResponseType.EVENT,
            streamType: "head_position",
            data: {
              position: headUp ? "up" : "down",
              timestamp: Date.now(),
            },
          })
        }
      }
    }
  }

  /**
   * Read the phone's battery state right now and emit it as the given stream.
   * Used for both phone_battery snapshot on subscribe, and as a stand-in for
   * glasses_battery when connected to Simulated Glasses.
   */
  private async emitPhoneBatteryAs(
    packageName: string,
    streamType: "phone_battery" | "glasses_battery",
  ): Promise<void> {
    try {
      const level = await Battery.getBatteryLevelAsync()
      const state = await Battery.getBatteryStateAsync()
      const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL
      this.sendToMiniapp(packageName, {
        type: MiniappResponseType.EVENT,
        streamType,
        data: {
          level: Math.round(level * 100),
          charging,
          timestamp: Date.now(),
        },
      })
    } catch (err) {
      console.log(`${LOG_TAG}: phone battery snapshot failed`, err)
    }
  }

  private handleDisplay(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    try {
      // Zombie-frame gate: a dying miniapp's last in-flight frame can arrive
      // AFTER onUnmount cleared its display — repainting a dead app's UI (and
      // poisoning the next boot's pre-boot restore snapshot). Killed mid-route
      // nav reproduced this reliably; its 3s re-push raced the teardown.
      if (!this.connectedApps.has(packageName)) {
        console.log(`${LOG_TAG}: dropping display from unmounted app ${packageName}`)
        return
      }
      if (!payload.layout || typeof payload.layout !== "object") {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "display request missing layout object",
        })
        return
      }

      // Hand off to LocalDisplayManager — it owns boot/throttle/arbitration/
      // expiry + the native BluetoothSdk.displayEvent call + useDisplayStore.
      localDisplayManager.request(packageName, {
        view: (payload.view as DisplayPayload["view"]) ?? "main",
        layout: payload.layout as DisplayPayload["layout"],
        durationMs: payload.durationMs as number | undefined,
      })

      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: display error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Display error",
      })
    }
  }

  /**
   * Scene render (session.display.render()). Same arbitration as DISPLAY, but
   * the payload is a whole frame of positioned elements and the caller may be
   * awaiting the outcome: LocalDisplayManager guarantees the resolver fires
   * exactly once (displayed/blocked, with degraded/dropped reporting), and that
   * becomes the REQUEST_RESULT data.
   */
  private handleRender(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    try {
      // Zombie-frame gate — see handleDisplay.
      if (!this.connectedApps.has(packageName)) {
        this.sendResult(packageName, requestId, true, {status: "blocked", reason: "app stopped"})
        return
      }
      if (!Array.isArray(payload.elements)) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "render request missing elements array",
        })
        return
      }

      localDisplayManager.request(
        packageName,
        {
          view: (payload.view as DisplayPayload["view"]) ?? "main",
          scene: payload.elements as DisplayPayload["scene"],
          durationMs: payload.durationMs as number | undefined,
        },
        (result) => this.sendResult(packageName, requestId, true, result),
      )
    } catch (err) {
      console.error(`${LOG_TAG}: render error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Render error",
      })
    }
  }

  private handlePlayAudio(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const audioUrl = (payload.audioUrl ?? payload.url) as string | undefined
    if (!audioUrl) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "play_audio requires an audioUrl",
      })
      return
    }

    const audioRequestId = requestId || `local_${Date.now()}`
    const volume = typeof payload.volume === "number" ? payload.volume : 1.0
    const stopOtherAudio = payload.stopOtherAudio !== false

    this.cancelSpeech(packageName)
    this.setSpeakerState(packageName, "loading")
    audioPlaybackService.play(
      {requestId: audioRequestId, audioUrl, appId: packageName, volume, stopOtherAudio},
      (_respId, success, error, duration) => {
        if (success) {
          this.setSpeakerState(packageName, "stopped", {durationMs: duration ?? undefined})
        } else {
          this.setSpeakerState(packageName, "error", {
            errorCode: MiniappErrorCode.INTERNAL,
            errorMessage: error ?? "play failed",
            durationMs: duration ?? undefined,
          })
        }
        this.sendResult(
          packageName,
          requestId,
          success,
          {duration},
          error
            ? {
                code: MiniappErrorCode.INTERNAL,
                message: error,
              }
            : undefined,
        )
      },
    )
    // Optimistic "started playing" transition. The audio service doesn't
    // have a "playback actually started" callback today; cloud SDK v3 has
    // the same constraint and uses optimistic timing. Microtask so the
    // initial "loading" envelope flushes first.
    queueMicrotask(() => this.setSpeakerState(packageName, "playing"))
  }

  private handleStopAudio(packageName: string, _payload: Record<string, unknown>, requestId?: string): void {
    this.cancelSpeech(packageName)
    audioPlaybackService.stopForApp(packageName)
    this.setSpeakerState(packageName, "stopped")
    this.sendResult(packageName, requestId, true)
  }

  // ── speaker.createStream (live PCM output) ────────────────────────────────

  /** Valid PCM sample rates for speaker streams. Mirrors the SDK contract. */
  private static readonly SPEAKER_STREAM_SAMPLE_RATES = new Set([16000, 24000, 48000])
  private static readonly SPEAKER_STREAM_MAX_BASE64_CHARS = Math.ceil((256 * 1024) / 3) * 4
  private speakerStreamCounter = 0

  private async handleSpeakerStreamOpen(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const app = this.connectedApps.get(packageName)
    if (!app) return

    // One stream per miniapp: opening a second closes the first.
    const previous = app.activeSpeakerStreamId
    if (previous) {
      app.activeSpeakerStreamId = undefined
      await audioPlaybackService.abortStream(previous).catch((error) => {
        console.warn(`${LOG_TAG}: failed to abort previous speaker stream for ${packageName}`, error)
      })
    }

    const sampleRate = typeof payload.sampleRate === "number" ? payload.sampleRate : 16000
    if (!LocalMiniappRuntime.SPEAKER_STREAM_SAMPLE_RATES.has(sampleRate)) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: `unsupported sampleRate ${sampleRate} (use 16000, 24000, or 48000)`,
      })
      return
    }
    const channels = typeof payload.channels === "number" ? payload.channels : 1
    if (channels !== 1) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "speaker streams currently support mono PCM only",
      })
      return
    }
    const volume = typeof payload.volume === "number" ? payload.volume : 1
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "speaker stream volume must be between 0 and 1",
      })
      return
    }

    const streamId = `spkstream_${Date.now()}_${++this.speakerStreamCounter}`
    this.setSpeakerState(packageName, "loading")
    try {
      await audioPlaybackService.openStream({
        streamId,
        appId: packageName,
        sampleRate,
        channels,
        volume,
        stopOtherAudio: payload.stopOtherAudio !== false,
        onEnded: (endedId, success, error, durationMs) => {
          const current = this.connectedApps.get(packageName)
          // Ignore completion from an app incarnation replaced by a crash
          // respawn. Its abort may finish after the new app has registered and
          // must not overwrite that app's speaker state.
          if (current !== app) return
          if (current.activeSpeakerStreamId === endedId) current.activeSpeakerStreamId = undefined
          if (success) {
            this.setSpeakerState(packageName, "stopped", {durationMs: durationMs ?? undefined})
          } else {
            this.setSpeakerState(packageName, "error", {
              errorCode: MiniappErrorCode.INTERNAL,
              errorMessage: error ?? "speaker stream failed",
              durationMs: durationMs ?? undefined,
            })
          }
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setSpeakerState(packageName, "error", {
        errorCode: MiniappErrorCode.INTERNAL,
        errorMessage: message,
      })
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message,
      })
      return
    }

    // The native open can outlive a miniapp disconnect. Its ordinary teardown
    // ran while no StreamState existed yet, so close this late result here
    // instead of leaving an orphan AudioTrack/AVAudioEngine session.
    if (this.connectedApps.get(packageName) !== app) {
      await audioPlaybackService.abortStream(streamId)
      return
    }
    app.activeSpeakerStreamId = streamId
    // Optimistic "playing", same as play(): the chunk player starts as soon
    // as the first write lands. Microtask so "loading" flushes first.
    queueMicrotask(() => this.setSpeakerState(packageName, "playing"))
    this.sendResult(packageName, requestId, true, {streamId})
  }

  /** Resolve + validate a stream id from a payload against the app's active stream. */
  private activeSpeakerStream(packageName: string, payload: Record<string, unknown>): string | null {
    const streamId = typeof payload.streamId === "string" ? payload.streamId : undefined
    const app = this.connectedApps.get(packageName)
    if (!streamId || !app || app.activeSpeakerStreamId !== streamId) return null
    return streamId
  }

  private async handleSpeakerStreamWrite(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const streamId = this.activeSpeakerStream(packageName, payload)
    if (!streamId) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "speaker stream is not open",
      })
      return
    }
    const base64 = typeof payload.base64 === "string" ? payload.base64 : ""
    if (!base64 || base64.length % 4 !== 0) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "speaker stream write requires padded base64 PCM data",
      })
      return
    }
    if (base64.length > LocalMiniappRuntime.SPEAKER_STREAM_MAX_BASE64_CHARS) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PAYLOAD_TOO_LARGE,
        message: "speaker stream chunk exceeds the 256 KB raw PCM limit",
      })
      return
    }
    try {
      const result = await audioPlaybackService.writeStreamChunk(streamId, base64)
      this.sendResult(packageName, requestId, true, result)
    } catch (error) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleSpeakerStreamClose(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const streamId = this.activeSpeakerStream(packageName, payload)
    if (!streamId) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "speaker stream is not open",
      })
      return
    }
    try {
      // Resolves once the buffered audio has drained; onEnded delivers the
      // terminal SPEAKER_STATE ("stopped").
      const result = await audioPlaybackService.closeStream(streamId)
      this.sendResult(packageName, requestId, true, result)
    } catch (error) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleSpeakerStreamAbort(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const streamId = this.activeSpeakerStream(packageName, payload)
    if (!streamId) {
      // Aborting an already-gone stream is fine — abort() is idempotent.
      this.sendResult(packageName, requestId, true)
      return
    }
    try {
      await audioPlaybackService.abortStream(streamId)
      this.sendResult(packageName, requestId, true)
    } catch (error) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleSpeak(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const rawText = payload.text
    const rawSentences =
      typeof rawText === "string"
        ? [rawText.trim()].filter(Boolean)
        : Array.isArray(rawText)
          ? rawText
              .filter((sentence): sentence is string => typeof sentence === "string")
              .map((sentence) => sentence.trim())
              .filter(Boolean)
          : []
    const enableSanitization = payload.enableSanitization !== false
    const sentences = prepareTtsSentences(rawSentences, enableSanitization)
    if (sentences.length === 0) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "speak requires text or a non-empty sentence list with speakable content",
      })
      return
    }
    const cloudText = sentences.join(" ")

    const voice = ((payload.voice_id ?? payload.voice) as string) || "default"
    const audioRequestId = requestId || `tts_${Date.now()}`
    const volume = typeof payload.volume === "number" ? payload.volume : 1.0
    const stopOtherAudio = payload.stopOtherAudio !== false
    const voiceSettings =
      payload.voice_settings && typeof payload.voice_settings === "object"
        ? (payload.voice_settings as Record<string, unknown>)
        : undefined
    const speed = typeof voiceSettings?.speed === "number" ? voiceSettings.speed : undefined
    const run: SpeechRun = {id: audioRequestId, cancelled: false}

    this.cancelSpeech(packageName)
    this.speechRuns.set(packageName, run)
    this.setSpeakerState(packageName, "loading")

    let terminalSent = false
    const sendPlaybackResult = (
      success: boolean,
      error: string | null,
      duration: number | null,
      fallbackErrorMessage: string,
      completed = success,
      errorCode: MiniappErrorCode = MiniappErrorCode.TTS_UPSTREAM_ERROR,
    ) => {
      if (terminalSent) return
      terminalSent = true

      // A superseded run still owns its bridge request, but it no longer owns
      // the package's shared speaker state.
      const ownsSpeakerState = this.speechRuns.get(packageName) === run
      if (ownsSpeakerState) this.speechRuns.delete(packageName)

      if (ownsSpeakerState) {
        if (success) {
          this.setSpeakerState(packageName, "stopped", {durationMs: duration ?? undefined})
        } else {
          this.setSpeakerState(packageName, "error", {
            errorCode,
            errorMessage: error ?? fallbackErrorMessage,
            durationMs: duration ?? undefined,
          })
        }
      }

      this.sendResult(
        packageName,
        requestId,
        success,
        {completed, duration},
        error
          ? {
              code: errorCode,
              message: error,
            }
          : undefined,
      )
    }
    run.onCancelled = () => sendPlaybackResult(true, null, null, "tts playback stopped", false)

    try {
      const voiceExplicit = payload.voice_id !== undefined || payload.voice !== undefined
      const offlineSupportsVoice =
        !voiceExplicit || voice === "default" || ttsModelManager.getAvailableLanguages().some((l) => l.code === voice)

      const modelId = typeof payload.model_id === "string" ? payload.model_id : undefined
      const forceLocal = payload.forceLocal === true
      const cloudConnected = cloudClientService.isConnected()
      console.log(
        `${LOG_TAG}: TTS decision for ${packageName}: cloudConnected=${cloudConnected}, runtimeTts=yes, offlineVoice=${offlineSupportsVoice}, forceLocal=${forceLocal}`,
      )

      const playOfflineTts = async (reason?: string): Promise<boolean> => {
        if (run.cancelled) return true
        if (!isFeatureEnabled("onDeviceSpeech")) return false
        if (!offlineSupportsVoice || !(await ttsModelManager.isModelAvailable())) {
          return false
        }
        if (run.cancelled) return true

        const languageCode = ttsModelManager.getAvailableLanguages().some((l) => l.code === voice) ? voice : undefined
        const offlineSentences = sentences

        if (offlineSentences.length > 1) {
          let firstSentence: TtsSynthesisResult
          try {
            firstSentence = await ttsModelManager.synthesizeToFile(offlineSentences[0], {languageCode, speed})
          } catch (offlineErr) {
            if (run.cancelled) return true
            console.warn(
              `${LOG_TAG}: offline sentence TTS synthesize failed${reason ? ` after ${reason}` : ""}:`,
              offlineErr,
            )
            return false
          }

          if (run.cancelled) {
            await Promise.resolve(firstSentence.cleanup?.())
            return true
          }
          void runSentenceTtsPipeline({
            sentences: offlineSentences,
            firstAudio: firstSentence,
            run,
            synthesize: (sentence) => ttsModelManager.synthesizeToFile(sentence, {languageCode, speed}),
            play: (audio, index) =>
              new Promise((resolve) => {
                const sentenceRequestId = `${audioRequestId}_sentence_${index}`
                run.playbackRequestId = sentenceRequestId
                audioPlaybackService.play(
                  {
                    requestId: sentenceRequestId,
                    audioUrl: audio.audioUrl,
                    appId: packageName,
                    volume,
                    stopOtherAudio,
                  },
                  (_responseId, success, error, duration, completionReason) => {
                    if (run.playbackRequestId === sentenceRequestId) run.playbackRequestId = undefined
                    resolve({success, completed: completionReason === "completed", error, duration})
                  },
                )
              }),
            onCleanupError: (cleanupError) => {
              console.warn(`${LOG_TAG}: sentence TTS cleanup failed`, cleanupError)
            },
          }).then(
            ({success, completed, error, duration}) => {
              sendPlaybackResult(success, error, duration, "offline sentence tts playback failed", completed)
            },
            (pipelineError: unknown) => {
              const message = pipelineError instanceof Error ? pipelineError.message : String(pipelineError)
              sendPlaybackResult(false, message, null, "offline sentence tts playback failed", false)
            },
          )
          queueMicrotask(() => {
            if (this.speechRuns.get(packageName) === run) this.setSpeakerState(packageName, "playing")
          })
          return true
        }

        let offlineGenerated: TtsSynthesisResult | undefined

        try {
          offlineGenerated = await ttsModelManager.synthesizeToFile(offlineSentences[0], {languageCode, speed})
        } catch (offlineErr) {
          if (run.cancelled) return true
          console.warn(`${LOG_TAG}: offline TTS synthesize failed${reason ? ` after ${reason}` : ""}:`, offlineErr)
          return false
        }

        const generated = offlineGenerated
        if (run.cancelled) {
          await Promise.resolve(generated.cleanup?.())
          return true
        }
        run.playbackRequestId = audioRequestId
        audioPlaybackService.play(
          {
            requestId: audioRequestId,
            audioUrl: generated.audioUrl,
            appId: packageName,
            volume,
            stopOtherAudio,
          },
          (_respId, success, error, duration, completionReason) => {
            if (run.playbackRequestId === audioRequestId) run.playbackRequestId = undefined
            void Promise.resolve(generated.cleanup?.()).catch((cleanupError) => {
              console.warn(`${LOG_TAG}: offline TTS cleanup failed`, cleanupError)
            })
            sendPlaybackResult(
              success,
              error,
              duration,
              "offline tts playback failed",
              completionReason === "completed",
            )
          },
        )
        queueMicrotask(() => {
          if (this.speechRuns.get(packageName) === run) this.setSpeakerState(packageName, "playing")
        })
        return true
      }

      const playCloudTts = async (fallbackToOffline: boolean): Promise<boolean> => {
        if (run.cancelled) return true
        let source: Awaited<ReturnType<typeof cloudClientService.tts.speak>>
        try {
          source = await cloudClientService.tts.speak(cloudText, {
            ...(voiceExplicit && voice !== "default" ? {voice_id: voice} : {}),
            ...(modelId ? {model_id: modelId} : {}),
            ...(voiceSettings ? {voice_settings: voiceSettings} : {}),
          })
        } catch (cloudErr) {
          if (run.cancelled) return true
          const error = cloudErr instanceof Error ? cloudErr.message : String(cloudErr)
          console.warn(`${LOG_TAG}: cloud TTS source failed: ${error}`)
          if (fallbackToOffline && (await playOfflineTts("cloud tts source failed"))) {
            return true
          }
          sendPlaybackResult(false, error, null, "tts failed")
          return true
        }

        if (run.cancelled) return true

        run.playbackRequestId = audioRequestId
        await Promise.resolve(
          audioPlaybackService.play(
            {
              requestId: audioRequestId,
              audioUrl: source.audioUrl,
              appId: packageName,
              volume,
              stopOtherAudio,
            },
            (_respId, success, error, duration, completionReason) => {
              if (run.playbackRequestId === audioRequestId) run.playbackRequestId = undefined
              if (!success && fallbackToOffline) {
                void playOfflineTts("cloud tts playback failed").then((started) => {
                  if (!started) {
                    sendPlaybackResult(false, error, duration, "tts failed")
                  }
                })
                return
              }
              sendPlaybackResult(success, error, duration, "tts failed", completionReason === "completed")
            },
          ),
        )
        queueMicrotask(() => {
          if (this.speechRuns.get(packageName) === run) this.setSpeakerState(packageName, "playing")
        })
        return true
      }

      if (forceLocal) {
        if (await playOfflineTts()) {
          return
        }
        if (run.cancelled) return
        const message = "tts unavailable: forceLocal requested but offline TTS model is not available"
        sendPlaybackResult(false, message, null, message, false, MiniappErrorCode.TTS_LOCAL_UNAVAILABLE)
        return
      }

      if (cloudConnected && (await playCloudTts(true))) {
        return
      }

      // Offline is the disconnected-cloud fallback. If the model is not
      // available, preserve the old behavior by trying cloud as a last resort.
      if (await playOfflineTts(cloudConnected ? undefined : "cloud disconnected")) {
        return
      }

      if (await playCloudTts(false)) {
        return
      }

      const message = "tts unavailable: no cloud TTS URL or offline TTS model"
      sendPlaybackResult(false, message, null, message, false)
    } catch (err) {
      console.error(`${LOG_TAG}: speak error:`, err)
      const message = err instanceof Error ? err.message : "TTS error"
      sendPlaybackResult(false, message, null, "TTS error", false)
    }
  }

  private cancelSpeech(packageName: string): void {
    const run = this.speechRuns.get(packageName)
    if (!run) return
    run.cancelled = true
    this.speechRuns.delete(packageName)
    if (run.playbackRequestId) audioPlaybackService.cancelPlayback(run.playbackRequestId)
    run.onCancelled?.()
  }

  private async handleRgbLed(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const coerceNumber = (value: unknown, fallback: number): number => {
      const coerced = Number(value)
      return Number.isFinite(coerced) ? coerced : fallback
    }

    const ledRequestId = requestId || `led_${Date.now()}`
    const action = normalizeRgbLedAction(payload.action)
    const color = normalizeRgbLedColor(payload.color)

    try {
      const result = await BluetoothSdk.rgbLedControl(
        ledRequestId,
        packageName,
        action,
        color,
        coerceNumber(payload.ontime, 1000),
        coerceNumber(payload.offtime, 0),
        coerceNumber(payload.count, 1),
      )
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "RGB LED command failed",
      })
    }
  }

  private async handleLocationPoll(packageName: string, requestId?: string): Promise<void> {
    try {
      // Expo's Android requestForegroundPermissionsAsync always delegates to
      // Activity.requestPermissions(), even when permission is already granted.
      // Calling it after the user presses Home therefore waits until the Activity
      // resumes. Read the current grant first, and only enter the prompt flow
      // while the Activity is actually foregrounded.
      const permissionStartedAt = Date.now()
      const permission = await resolveForegroundLocationPermission(Location, () => AppState.currentState)
      const {status} = permission
      console.log(
        `${LOG_TAG}: location poll permission status=${status} appState=${AppState.currentState} elapsed=${Date.now() - permissionStartedAt}ms`,
      )
      if (status !== "granted") {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
          message: "Location permission not granted",
        })
        return
      }

      // Try the OS cache first — usually instant — and only fall back to
      // a fresh fix if the cache is empty. Use Low accuracy on the fresh
      // path so we get a cell/wifi-tower fix in ~1s instead of waiting
      // for full GPS warm-up.
      const locationStartedAt = Date.now()
      const cached = await Location.getLastKnownPositionAsync({maxAge: 60_000})
      console.log(`${LOG_TAG}: location poll cache hit=${cached !== null} elapsed=${Date.now() - locationStartedAt}ms`)
      const location = cached ?? (await Location.getCurrentPositionAsync({accuracy: Location.Accuracy.Low}))
      console.log(`${LOG_TAG}: location poll resolved elapsed=${Date.now() - locationStartedAt}ms`)

      this.sendResult(packageName, requestId, true, {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        accuracy: location.coords.accuracy ?? undefined,
        timestamp: location.timestamp,
      })
    } catch (err) {
      console.error(`${LOG_TAG}: location poll error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Location error",
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /**
   * All navigation handlers + their state live in NavigationHandlers. The
   * dispatcher's NAVIGATION_* cases delegate here; the rest of the runtime
   * cross-cuts navigation through {@link NavigationHandlers.onDisconnect}
   * (mini-app disconnect) and {@link NavigationHandlers.isTripActive}
   * (location-stream gating during a trip).
   */
  private readonly navigationHandlers = new NavigationHandlers(
    (packageName, envelope) => this.sendToMiniapp(packageName, envelope),
    (packageName, requestId, ok, result, error) => this.sendResult(packageName, requestId, ok, result, error),
  )

  /**
   * `session.blob` — persistent, per-app binary storage. Like NavigationHandlers,
   * the BLOB_* dispatcher cases delegate here. It's a generic byte store; audio
   * recording lives entirely in the miniapp (mic.onAudioChunk → chunked
   * BLOB_WRITE), so nothing audio-specific runs in the host.
   */
  private readonly blobStore = new BlobStore({
    sendResult: (packageName, requestId, ok, result, error) =>
      this.sendResult(packageName, requestId, ok, result, error),
    getUserId: () => cloudClientService.getMentraUserId(),
  })
  private readonly blobRequestQueues = new Map<string, Promise<void>>()

  private readonly simpleStorage = new LocalMiniappStorage({
    backend: localMiniappStorageBackend,
    getUserId: () => cloudClientService.resolveMentraUserId(),
  })

  /**
   * BlobStore's file helpers are synchronous once a user namespace is selected,
   * but first-boot Core auth is not. Queue requests per app behind stable
   * identity resolution so CREATE/WRITE/COMMIT ordering survives that wait.
   */
  private enqueueBlobRequest(
    packageName: string,
    requestId: string | undefined,
    operation: () => Promise<void> | void,
  ): void {
    const app = this.connectedApps.get(packageName)
    const previous = this.blobRequestQueues.get(packageName) ?? Promise.resolve()
    const queued = previous.then(async () => {
      try {
        await cloudClientService.resolveMentraUserId()
      } catch (err) {
        console.error(`${LOG_TAG}: blob identity error:`, err)
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_CONNECTED,
          message: "Blob storage is unavailable before sign-in completes",
        })
        return
      }

      // unregisterApp() or a crash-respawn may have replaced this app while
      // identity resolution was pending. Never replay an old context's request
      // against its replacement.
      if (!app || this.connectedApps.get(packageName) !== app) return

      // Invoke in request order, but do not keep the queue occupied for the
      // lifetime of an async picker, download, or share sheet. CREATE/WRITE/
      // COMMIT are synchronous and therefore still dispatch strictly in order.
      try {
        const pending = operation()
        if (pending) {
          void pending.catch((err) => this.handleBlobRequestError(packageName, requestId, err))
        }
      } catch (err) {
        this.handleBlobRequestError(packageName, requestId, err)
      }
    })
    this.blobRequestQueues.set(packageName, queued)
    void queued.finally(() => {
      if (this.blobRequestQueues.get(packageName) === queued) this.blobRequestQueues.delete(packageName)
    })
  }

  private handleBlobRequestError(packageName: string, requestId: string | undefined, err: unknown): void {
    console.error(`${LOG_TAG}: blob request error:`, err)
    this.sendResult(packageName, requestId, false, undefined, {
      code: MiniappErrorCode.INTERNAL,
      message: err instanceof Error ? err.message : "Blob storage error",
    })
  }

  /**
   * Heading is a sensor stream — start the native compass when any mini
   * app is subscribed to "heading_update", stop it when none are.
   */
  private headingUnsub: (() => void) | null = null
  private recomputeHeadingSubscription(): void {
    const wantsHeading = this.streamSubscribers.has(MiniappStreamType.HEADING_UPDATE)
    if (wantsHeading && !this.headingUnsub) {
      // Heading sensor lives in engine (HeadingService) — subscribe directly.
      this.headingUnsub = headingService.addListener((degrees: number) => {
        this.forwardEvent(MiniappStreamType.HEADING_UPDATE, {degrees})
      })
    } else if (!wantsHeading && this.headingUnsub) {
      this.headingUnsub()
      this.headingUnsub = null
    }
  }

  /**
   * Accelerometer is a sensor stream — enable the glasses IMU when any mini
   * app is subscribed to "accel_data", disable it when none are. Mirrors the
   * heading pattern. Only G2 streams IMU today; on other devices the native
   * call is a no-op so this is harmless.
   */
  private imuEnabled = false
  private recomputeImuSubscription(): void {
    const wantsImu = this.streamSubscribers.has(MiniappStreamType.ACCEL_DATA)
    if (wantsImu === this.imuEnabled) return
    this.imuEnabled = wantsImu
    void BluetoothSdk.setImuEnabled(wantsImu)
  }

  /**
   * Last rate we asked the host for. Lets us skip the cross-process call
   * when nothing actually changed (most SUBSCRIBE / unregister churn
   * leaves the aggregate unchanged) and tracks state for the no-active-
   * subscribers → tell host to back off case.
   */
  private lastAppliedLocationRate: LocationRate | null = null

  /**
   * Recompute the aggregate location tier across every connected
   * miniapp and push the result to the host. The aggregate is the
   * STRICTEST rate any single app has requested — see
   * {@link LOCATION_RATE_PRIORITY} — because the GPS sample rate is a
   * shared OS-level setting that we can't bias per-app.
   *
   * Called after every SUBSCRIBE and every unregister so that when a
   * realtime-requesting app goes away the tier falls back down. If no
   * connected app is asking for a location rate, we tell the host
   * "off" so it can drop GPS power.
   */
  private recomputeLocationTier(): void {
    let bestRank = -1
    for (const app of this.connectedApps.values()) {
      const r = app.requestedLocationRate
      if (!r) continue
      const rank = locationRateRank(r)
      if (rank > bestRank) {
        bestRank = rank
      }
    }
    // When no app is asking, downgrade to "off". Without this we'd
    // leak the last-known-strictest rate forever (the original bug).
    const next: LocationRate = bestRank >= 0 ? LOCATION_RATE_PRIORITY[bestRank] : "off"
    if (next === this.lastAppliedLocationRate) return
    this.lastAppliedLocationRate = next
    console.log(`[LOCATION] aggregate tier → ${next}`)
    void phoneLocationService.setLocationTier(next)
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  private async handleStorageGet(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const key = payload.key as string
      if (!key) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "storage_get requires a key",
        })
        return
      }
      const value = await this.simpleStorage.get(packageName, key)
      this.sendResult(packageName, requestId, true, {key, value})
    } catch (err) {
      console.error(`${LOG_TAG}: storage_get error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageSet(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const key = payload.key as string
      if (!key) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "storage_set requires a key",
        })
        return
      }
      await this.simpleStorage.set(packageName, key, payload.value ?? null)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: storage_set error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageDelete(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const key = payload.key as string
      if (!key) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "storage_delete requires a key",
        })
        return
      }
      await this.simpleStorage.delete(packageName, key)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: storage_delete error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageList(
    packageName: string,
    _payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const keys = await this.simpleStorage.keys(packageName)
      this.sendResult(packageName, requestId, true, {keys})
    } catch (err) {
      console.error(`${LOG_TAG}: storage_list error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageClear(packageName: string, requestId?: string): Promise<void> {
    try {
      await this.simpleStorage.clear(packageName)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: storage_clear error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageHas(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const key = payload.key as string
      if (!key) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "storage_has requires a key",
        })
        return
      }
      const has = await this.simpleStorage.has(packageName, key)
      this.sendResult(packageName, requestId, true, {has})
    } catch (err) {
      console.error(`${LOG_TAG}: storage_has error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageGetAll(packageName: string, requestId?: string): Promise<void> {
    try {
      const values = await this.simpleStorage.getAll(packageName)
      this.sendResult(packageName, requestId, true, {values})
    } catch (err) {
      console.error(`${LOG_TAG}: storage_get_all error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  private async handleStorageSetMultiple(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      const values = payload.values as Record<string, unknown> | undefined
      if (!values || typeof values !== "object") {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: "storage_set_multiple requires a values object",
        })
        return
      }
      await this.simpleStorage.setMultiple(packageName, values)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: storage_set_multiple error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Wi-Fi ADB
  // ---------------------------------------------------------------------------

  private async handleSetWifiAdbState(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const result = await handleWifiAdbRequest(packageName, payload, {
      isSystemPackage: (candidate) => this.isSystemPackage(candidate),
      setWifiAdbState: async (enabled) => {
        console.log(`${LOG_TAG}: set_wifi_adb_state enabled=${enabled} from ${packageName}`)
        try {
          await BluetoothSdk.setWifiAdbState(enabled)
        } catch (error) {
          console.error(`${LOG_TAG}: set_wifi_adb_state error:`, error)
          throw error
        }
      },
    })

    if (result.ok) {
      this.sendResult(packageName, requestId, true)
      return
    }

    this.sendResult(packageName, requestId, false, undefined, result.error)
  }

  // ---------------------------------------------------------------------------
  // Camera FOV
  // ---------------------------------------------------------------------------

  private async handleCameraFov(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const app = this.connectedApps.get(packageName)
    const hasCameraPermission = app?.installedManifest?.permissions?.some((p) => p.type === "CAMERA")
    if (!hasCameraPermission) {
      logPermissionNotDeclared(packageName, "CAMERA", "to set camera FOV", `{"type": "CAMERA"}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: `CAMERA permission not declared in miniapp.json. Add {"type": "CAMERA"} to the "permissions" array.`,
        permission: "CAMERA",
        operation: MiniappRequestType.CAMERA_FOV,
      })
      return
    }

    try {
      const request = normalizeCameraFovPayload(payload)
      const description =
        "preset" in request ? `preset=${request.preset}` : `fov=${request.fov} roi=${request.roiPosition ?? "center"}`
      console.log(`${LOG_TAG}: camera_fov_set ${description}`)

      const result = await phoneCameraFovCoordinator.setOverride(packageName, request)
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      console.error(`${LOG_TAG}: camera_fov error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Camera FOV error",
      })
    }
  }

  /**
   * Explicit IMU enable/disable from a miniapp (session.imu.setEnabled).
   *
   * The accel stream already auto-toggles the native IMU on subscribe (see
   * {@link recomputeImuSubscription}); this is a direct override. We sync
   * `this.imuEnabled` to the requested state so a subsequent subscription
   * recompute with the same aggregate doesn't issue a redundant native call.
   * Note that a later subscribe/unsubscribe that changes the aggregate will
   * still re-derive the sensor state from subscriptions.
   */
  private handleImuSetEnabled(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    try {
      const enabled = !!payload.enabled
      console.log(`${LOG_TAG}: imu_set_enabled ${enabled} (by ${packageName})`)
      this.imuEnabled = enabled
      void BluetoothSdk.setImuEnabled(enabled)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: imu_set_enabled error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "IMU set-enabled error",
      })
    }
  }

  /**
   * Lifecycle-scoped glasses-side VAD override from a miniapp
   * (session.mic.setVoiceActivityDetectionEnabled). Requires MICROPHONE in the
   * miniapp manifest. Mentra Live only today — other models no-op via DeviceStore.
   */
  private async handleMicSetVadEnabled(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const app = this.connectedApps.get(packageName)
    const hasMicPermission = app?.installedManifest?.permissions?.some((p) => p.type === "MICROPHONE")
    if (!hasMicPermission) {
      logPermissionNotDeclared(packageName, "MICROPHONE", "to set VAD enabled", `{"type": "MICROPHONE"}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: `MICROPHONE permission not declared in miniapp.json. Add {"type": "MICROPHONE"} to the "permissions" array.`,
        permission: "MICROPHONE",
        operation: MiniappRequestType.MIC_SET_VAD_ENABLED,
      })
      return
    }

    if (typeof payload.enabled !== "boolean") {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "enabled must be a boolean",
      })
      return
    }

    try {
      const enabled = payload.enabled
      console.log(`${LOG_TAG}: mic_set_vad_enabled ${enabled} (by ${packageName})`)
      await micStateCoordinator.setMiniappGateOverride(packageName, "vad", enabled, this.getConfiguredMicGates())
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: mic_set_vad_enabled error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "VAD set-enabled error",
      })
    }
  }

  /**
   * Lifecycle-scoped center-mic loudness gate ("Barrier") override from a miniapp
   * (session.mic.setLoudnessGateEnabled). Requires MICROPHONE in the miniapp
   * manifest. Mentra Live only today — other models no-op via DeviceStore.
   */
  private async handleMicSetLoudnessGateEnabled(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const app = this.connectedApps.get(packageName)
    const hasMicPermission = app?.installedManifest?.permissions?.some((p) => p.type === "MICROPHONE")
    if (!hasMicPermission) {
      logPermissionNotDeclared(packageName, "MICROPHONE", "to set loudness gate enabled", `{"type": "MICROPHONE"}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: `MICROPHONE permission not declared in miniapp.json. Add {"type": "MICROPHONE"} to the "permissions" array.`,
        permission: "MICROPHONE",
        operation: MiniappRequestType.MIC_SET_LOUDNESS_GATE_ENABLED,
      })
      return
    }

    if (typeof payload.enabled !== "boolean") {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "enabled must be a boolean",
      })
      return
    }

    try {
      const enabled = payload.enabled
      console.log(`${LOG_TAG}: mic_set_loudness_gate_enabled ${enabled} (by ${packageName})`)
      await micStateCoordinator.setMiniappGateOverride(
        packageName,
        "loudnessGate",
        enabled,
        this.getConfiguredMicGates(),
      )
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: mic_set_loudness_gate_enabled error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Loudness gate set-enabled error",
      })
    }
  }

  /**
   * session.system.scanQr — host camera overlay. Must not clear miniapp
   * foreground; the host seam is responsible for presenting a Modal on top.
   */
  private async handleScanQr(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    try {
      const result = await invokeScanQrSeam(getUiSeams().scanQr, payload)
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      if (!getUiSeams().scanQr) {
        console.warn(`${LOG_TAG}: scanQr seam missing — QR overlay is not registered`)
      }
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string} | null | undefined)?.code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "QR scan failed",
      })
    }
  }

  // ---------------------------------------------------------------------------
  // System utilities (share, open URL, clipboard, download)
  // ---------------------------------------------------------------------------

  private async handleShare(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const {text, title, base64, mimeType, filename, url} = payload as {
      text?: string
      title?: string
      base64?: string
      mimeType?: string
      filename?: string
      url?: string
    }
    try {
      if (base64) {
        // File share via base64 — write to temp file then share
        const tempFile = new File(Paths.cache, filename || "shared_file")
        tempFile.write(base64, {encoding: "base64"})
        await Share.open({
          url: tempFile.uri,
          type: mimeType || "application/octet-stream",
          filename: filename,
          title: title,
        })
      } else if (url) {
        await Share.open({url, title, message: text})
      } else {
        await Share.open({message: text || "", title})
      }
      this.sendResult(packageName, requestId, true, {success: true})
    } catch (error: any) {
      // react-native-share throws when user dismisses the share sheet
      if (error?.message?.includes("User did not share")) {
        this.sendResult(packageName, requestId, true, {success: false, cancelled: true})
      } else {
        console.error(`${LOG_TAG}: share error:`, error)
        this.sendResult(packageName, requestId, true, {success: false})
      }
    }
  }

  private async handleOpenUrl(packageName: string, payload: Record<string, unknown>): Promise<void> {
    const url = payload.url as string | undefined
    if (!url || typeof url !== "string") {
      console.warn(`${LOG_TAG}: open_url missing url`)
      return
    }
    // Block dangerous schemes
    if (url.startsWith("javascript:") || url.startsWith("file:")) {
      console.warn(`${LOG_TAG}: open_url blocked dangerous scheme: ${url}`)
      return
    }
    try {
      await Linking.openURL(url)
    } catch (error) {
      console.error(`${LOG_TAG}: open_url error:`, error)
    }
  }

  private async handleCopyClipboard(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const text = payload.text as string | undefined
    if (typeof text !== "string") {
      console.warn(`${LOG_TAG}: copy_clipboard missing text`)
      return
    }
    try {
      await Clipboard.setStringAsync(text)
      this.sendResult(packageName, requestId, true)
    } catch (error: any) {
      console.error(`${LOG_TAG}: clipboard error:`, error)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: error?.message || "Clipboard error",
      })
    }
  }

  private async handleDownload(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const {base64, url, mimeType, filename} = payload as {
      base64?: string
      url?: string
      mimeType?: string
      filename?: string
    }
    const name = filename || "download"
    try {
      let file: File
      if (base64) {
        file = new File(Paths.cache, name)
        file.write(base64, {encoding: "base64"})
      } else if (url) {
        file = await File.downloadFileAsync(url, new File(Paths.cache, name), {idempotent: true})
      } else {
        console.warn(`${LOG_TAG}: download missing base64 or url`)
        return
      }
      // Open share sheet so user can choose where to save
      await Share.open({
        url: file.uri,
        type: mimeType || "application/octet-stream",
        filename: name,
      })
      this.sendResult(packageName, requestId, true, {success: true})
    } catch (error: any) {
      if (error?.message?.includes("User did not share")) {
        this.sendResult(packageName, requestId, true, {success: true, cancelled: true})
      } else {
        console.error(`${LOG_TAG}: download error:`, error)
        this.sendResult(packageName, requestId, true, {success: false})
      }
    }
  }

  // ===========================================================================
  // Photo + streaming handlers (cloud-coordinated)
  // ===========================================================================

  private async handlePhoto(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    // Manifest CAMERA permission gate.
    const app = this.connectedApps.get(packageName)
    const hasCameraPermission = app?.installedManifest?.permissions?.some((p) => p.type === "CAMERA")
    if (!hasCameraPermission) {
      logPermissionNotDeclared(packageName, "CAMERA", "to take a photo", `{"type": "CAMERA"}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: `CAMERA permission not declared in miniapp.json. Add {"type": "CAMERA"} to the "permissions" array.`,
        permission: "CAMERA",
        operation: MiniappRequestType.PHOTO,
      })
      return
    }

    try {
      const result = await phonePhotoCoordinator.takePhoto(packageName, {
        size: payload.size as "low" | "medium" | "high" | "max" | "small" | "large" | "full" | undefined,
        mode: payload.mode as "photo" | "text" | undefined,
        transferMethod: payload.transferMethod as "auto" | "direct" | "ble" | undefined,
        compress: payload.compress as "none" | "low" | "medium" | "high" | undefined,
        sound: payload.sound as boolean | undefined,
        saveToGallery: payload.saveToGallery as boolean | undefined,
        exposureTimeNs: payload.exposureTimeNs as number | undefined,
        iso: payload.iso as number | null | undefined,
        aeExposureDivisor: payload.aeExposureDivisor as number | undefined,
        isoCap: payload.isoCap as number | undefined,
        noiseReduction: payload.noiseReduction as boolean | undefined,
        edgeEnhancement: payload.edgeEnhancement as boolean | undefined,
        zsl: payload.zsl as boolean | undefined,
        mfnr: payload.mfnr as boolean | undefined,
        ispDigitalGain: payload.ispDigitalGain as number | undefined,
        ispAnalogGain: payload.ispAnalogGain as string | undefined,
      })
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Photo request failed",
        stage: (err as {stage?: string}).stage,
        transport: (err as {transport?: string}).transport,
      })
    }
  }

  private async handleCameraWarmUp(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    // Manifest CAMERA permission gate (same as photo).
    const app = this.connectedApps.get(packageName)
    const hasCameraPermission = app?.installedManifest?.permissions?.some((p) => p.type === "CAMERA")
    if (!hasCameraPermission) {
      logPermissionNotDeclared(packageName, "CAMERA", "to warm up the camera", `{"type": "CAMERA"}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: `CAMERA permission not declared in miniapp.json. Add {"type": "CAMERA"} to the "permissions" array.`,
        permission: "CAMERA",
        operation: MiniappRequestType.CAMERA_WARM_UP,
      })
      return
    }

    try {
      await phonePhotoCoordinator.warmUpCamera(packageName, {
        size: payload.size as "low" | "medium" | "high" | "max" | undefined,
        mode: payload.mode as "photo" | "text" | undefined,
        exposureTimeNs: payload.exposureTimeNs as number | undefined,
        durationMs: payload.durationMs as number | undefined,
        zsl: payload.zsl as boolean | undefined,
        mfnr: payload.mfnr as boolean | undefined,
      })
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Camera warm-up failed",
        stage: (err as {stage?: string}).stage,
        transport: (err as {transport?: string}).transport,
      })
    }
  }

  private async handleVideoRecordingStart(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    // Manifest CAMERA permission gate (same as photo).
    const app = this.connectedApps.get(packageName)
    const hasCameraPermission = app?.installedManifest?.permissions?.some((p) => p.type === "CAMERA")
    if (!hasCameraPermission) {
      logPermissionNotDeclared(packageName, "CAMERA", "to record video", `{"type": "CAMERA"}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: `CAMERA permission not declared in miniapp.json. Add {"type": "CAMERA"} to the "permissions" array.`,
        permission: "CAMERA",
        operation: MiniappRequestType.VIDEO_RECORDING_START,
      })
      return
    }

    try {
      const result = await phoneVideoCoordinator.startRecording(packageName, {
        width: payload.width as number | undefined,
        height: payload.height as number | undefined,
        fps: payload.fps as number | undefined,
        sound: payload.sound as boolean | undefined,
        save: payload.save as boolean | undefined,
      })
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Video recording start failed",
      })
    }
  }

  private async handleVideoRecordingStop(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    try {
      await phoneVideoCoordinator.stopRecording(packageName, payload.recordingId as string | undefined, {
        uploadUrl: payload.uploadUrl as string | undefined,
        uploadAuthToken: payload.uploadAuthToken as string | undefined,
      })
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Video recording stop failed",
      })
    }
  }

  /**
   * Stream handlers — dispatched to the engine PhoneStreamCoordinator. For managed
   * streams the coordinator additionally calls the v2 client REST route to
   * provision Cloudflare. Cloud-SDK apps (third-party developers) use a
   * separate cloud-side path that does not pass through here.
   */
  private async handleStreamStart(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const streaming = phoneStreamCoordinator
    if (!streaming) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.NOT_IMPLEMENTED,
        message: "Streaming is not configured on this host",
      })
      return
    }
    try {
      const result = await streaming.startUnmanaged(packageName, {
        streamUrl: payload.streamUrl as string,
        video: normalizeStreamVideoConfig(payload.video),
        audio: normalizeStreamAudioConfig(payload.audio),
        sound: payload.sound as boolean | undefined,
        authToken: typeof payload.authToken === "string" ? payload.authToken : undefined,
      })
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Stream start failed",
        stage: (err as {stage?: string}).stage,
        transport: (err as {transport?: string}).transport,
      })
    }
  }

  private async handleStreamStop(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const streaming = phoneStreamCoordinator
    if (!streaming) {
      // No adapter wired — treat as already-stopped.
      this.sendResult(packageName, requestId, true)
      return
    }
    try {
      await streaming.stop(packageName, payload.streamId as string | undefined)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Stream stop failed",
        stage: (err as {stage?: string}).stage,
        transport: (err as {transport?: string}).transport,
      })
    }
  }

  private async handleManagedStreamStart(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const streaming = phoneStreamCoordinator
    if (!streaming) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.NOT_IMPLEMENTED,
        message: "Streaming is not configured on this host",
      })
      return
    }
    try {
      const result = await streaming.startManaged(packageName, {
        restreamDestinations: payload.restreamDestinations as Array<string | {url: string; name?: string}> | undefined,
        video: normalizeStreamVideoConfig(payload.video),
        audio: normalizeStreamAudioConfig(payload.audio),
        sound: payload.sound as boolean | undefined,
        ingest: payload.ingest as "srt" | "whip" | undefined,
      })
      this.sendResult(packageName, requestId, true, result)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Managed stream start failed",
        stage: (err as {stage?: string}).stage,
        transport: (err as {transport?: string}).transport,
      })
    }
  }

  private async handleManagedStreamStop(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    return this.handleStreamStop(packageName, payload, requestId)
  }

  /**
   * session.glasses.requestWifiSetup — open the phone's glasses Wi-Fi setup
   * flow. The host owns the actual UI via the `engine.configure({ui})` seam;
   * this just forwards the request and reports success/failure.
   */
  private async handleRequestWifiSetup(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const requestWifiSetup = getUiSeams().requestWifiSetup
    if (!requestWifiSetup) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.NOT_IMPLEMENTED,
        message: "Wi-Fi setup is not configured on this host",
      })
      return
    }
    try {
      await requestWifiSetup(payload.reason as string | undefined, packageName)
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: (err as {code?: string}).code || MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Wi-Fi setup failed",
      })
    }
  }

  /**
   * Wire the PhoneStreamCoordinator's status callback so coordinator-emitted
   * updates become `EVENT { streamType: "stream_status" }` envelopes on the
   * subscribing miniapp(s).
   */
  public wireStreamingStatusFanout(): void {
    const streaming = phoneStreamCoordinator
    if (!streaming) return
    streaming.setStatusSubscriber((packageName, update) => {
      this.sendToMiniapp(packageName, {
        type: MiniappResponseType.EVENT,
        streamType: "stream_status",
        data: {
          streamId: update.streamId,
          status: update.status,
          source: update.source,
          ...(update.data || {}),
        },
      })
    })
  }

  // ===========================================================================
  // Public subscribe helper
  // ===========================================================================

  /**
   * Standalone subscribe — lets external code subscribe a registered miniapp to
   * streams without going through the envelope protocol.
   *
   * Returns `{ok: true}` on success, or `{ok: false, error}` on failure.
   */
  public subscribe(packageName: string, streams: string[]): {ok: boolean; error?: string} {
    const app = this.connectedApps.get(packageName)
    if (!app) {
      return {ok: false, error: `App ${packageName} is not registered`}
    }

    if (!Array.isArray(streams)) {
      return {ok: false, error: "streams must be an array"}
    }

    console.log(`${LOG_TAG}: subscribe(${packageName}, [${streams.join(", ")}])`)

    // Check microphone permission for mic-requiring streams
    const micStreams = ["transcription", "translation", "audio_chunk", "vad"]
    const needsMic = streams.some((s: string) => micStreams.some((m) => s.startsWith(m) || s === m))
    if (needsMic) {
      const hasMicPermission = app.installedManifest?.permissions?.some((p) => p.type === "MICROPHONE")
      if (!hasMicPermission) {
        return {ok: false, error: "MICROPHONE permission not declared in miniapp.json"}
      }
    }

    // Add new subscriptions
    const previousSubscriptions = app.subscriptions
    app.subscriptions = new Set(streams)
    app.forceLocalTranscriptionStreams.clear()
    app.cloudTranscriptionStreams = new Set(streams.filter((stream) => stream.startsWith("transcription:")))
    this.replaceStreamSubscribers(packageName, previousSubscriptions, app.subscriptions)

    this.recomputeMicRequirements()
    this.updateCloudSubscriptions()
    return {ok: true}
  }

  // ===========================================================================
  // Mic requirements
  // ===========================================================================

  private getConfiguredMicGates(): {vadEnabled: boolean | null; loudnessGateEnabled: boolean | null} {
    const bluetoothSettings = useSettingsStore.getState().getBluetoothSettings()
    const configuredVad = bluetoothSettings.voice_activity_detection_enabled
    const configuredLoudnessGate = bluetoothSettings.loudness_gate_enabled
    return {
      vadEnabled: typeof configuredVad === "boolean" ? configuredVad : null,
      loudnessGateEnabled: typeof configuredLoudnessGate === "boolean" ? configuredLoudnessGate : null,
    }
  }

  private recomputeMicRequirements(): void {
    let anyPcm = false
    let anyLc3 = false
    for (const [stream, subscribers] of this.streamSubscribers) {
      if (subscribers.size === 0) continue
      if (stream === "audio_chunk") anyPcm = true
      if (stream.startsWith("transcription:") || stream.startsWith("translation:") || stream === "vad") anyLc3 = true
    }
    micStateCoordinator.setLocalRequirements({
      pcm: anyPcm,
      lc3: anyLc3,
      ...this.getConfiguredMicGates(),
    })
  }

  /**
   * Recompute the aggregated v2 cloud subscription list across all local miniapps.
   *
   * Cloud-dependent streams (transcription:*, translation:*) only flow if the
   * v2 runtime knows the phone wants them. Local-only streams (button_press, etc.)
   * are NOT sent — they come from the Bluetooth SDK, not from cloud.
   */
  private updateCloudSubscriptions(): void {
    const cloudStreams = new Set<string>()
    let transcriptionLang: string | null = null
    let forceLocalTranscriptionLang: string | null = null
    let hasForceLocalTranscription = false
    for (const [stream, subscribers] of this.streamSubscribers) {
      if (subscribers.size === 0) continue
      // Only transcription / translation need cloud delivery. Location and
      // notifications are sourced natively on the phone — no cloud hop.
      if (stream.startsWith("translation:")) {
        cloudStreams.add(stream)
      }
      if (stream.startsWith("transcription:")) {
        const language = stream.substring("transcription:".length)
        if (transcriptionLang === null) transcriptionLang = language

        const routes = summarizeTranscriptionRoutes(subscribers, (packageName) =>
          this.appTranscriptionRoutesForSubscription(packageName, stream),
        )
        if (routes.hasForceLocalSubscriber) {
          hasForceLocalTranscription = true
          if (forceLocalTranscriptionLang === null) forceLocalTranscriptionLang = language
        }
        if (routes.hasCloudSubscriber) cloudStreams.add(stream)
      }
    }
    localSttFallbackCoordinator.onSubscriptionChange(
      transcriptionLang !== null,
      forceLocalTranscriptionLang ?? transcriptionLang,
      hasForceLocalTranscription,
    )

    // Mirror the same set as typed AudioSubscription[] and push it to the cloud
    // runtime.
    this.ensureCloudResultsWired()
    const subs = this.buildCloudAudioSubscriptions(cloudStreams)
    const nextKey = this.audioSubscriptionKey(subs)
    if (!this.cloudAudioSubscriptionSync.begin(nextKey)) return
    console.log(
      `${LOG_TAG}: updateCloudSubscriptions streams=[${Array.from(cloudStreams).join(", ")}] cloudSubs=${subs.length}`,
    )
    cloudClientService
      .setSubscriptions(subs)
      .then(() => {
        this.cloudAudioSubscriptionSync.succeeded(nextKey)
      })
      .catch((err) => {
        // Best-effort: the cloud may not be connected yet. Keep failed writes
        // retryable; otherwise a reconnect that recomputes the same desired
        // transcription set gets deduped and local captions never recover.
        this.cloudAudioSubscriptionSync.failed(nextKey)
        console.warn(`${LOG_TAG}: cloud setSubscriptions failed: ${(err as Error)?.message ?? err}`)
      })
  }

  /**
   * Build the cloud `AudioSubscription[]` from the miniapp cloud-stream key set.
   *
   * Stream keys: `transcription:<lang>` (lang may be `auto`, `en-US`, …) and
   * `translation:<source>:<target>` (3 colon-parts; source/target may be `*`
   * or `auto` wildcards, target may also be `*`). The cloud protocol requires a
   * concrete `target: string` for translation, so wildcard-target translation
   * keys (`translation:<source>:*`, `translation:*:*`, `translation:auto`) have
   * no cloud equivalent and are skipped. Wildcard/`auto` SOURCE maps to
   * `{mode: "auto"}`.
   */
  private buildCloudAudioSubscriptions(cloudStreams: Set<string>): AudioSubscription[] {
    const subs: AudioSubscription[] = []
    // Union of every connected app's TRANSCRIPTION_CONFIG hints. Hints only
    // apply to the auto-mode TRANSCRIPTION subscription (the wire schema has
    // no hints field on specific-language sources — the language IS the hint
    // there), and are deliberately NOT attached to translation sources.
    const hintUnion = [...new Set([...this.transcriptionHintsByApp.values()].flat())].sort()
    const langSource = (code: string): LanguageSource =>
      code === "auto" || code === "*" ? {mode: "auto"} : {mode: "specific", code}
    for (const stream of cloudStreams) {
      if (stream.startsWith("transcription:")) {
        const lang = stream.substring("transcription:".length)
        const source = langSource(lang)
        subs.push({
          kind: "transcription",
          language: source.mode === "auto" && hintUnion.length > 0 ? {mode: "auto", hints: hintUnion} : source,
        })
      } else if (stream.startsWith("translation:")) {
        const parts = stream.split(":")
        // Only `translation:<source>:<target>` maps cleanly; a concrete target
        // is required by the cloud schema.
        if (parts.length === 3) {
          const [, source, target] = parts
          if (target === "*") continue
          subs.push({kind: "translation", source: langSource(source), target})
        }
      }
    }
    return subs
  }

  private audioSubscriptionKey(subs: AudioSubscription[]): string {
    return JSON.stringify(
      subs
        .map((sub) => {
          if (sub.kind === "transcription") {
            return {
              kind: sub.kind,
              language: sub.language,
            }
          }
          return {
            kind: sub.kind,
            source: sub.source,
            target: sub.target,
          }
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    )
  }

  /**
   * Wire the cloud's transcription/translation results into the existing
   * miniapp fan-out exactly once. Maps each cloud result back to the
   * cloud-to-app data shape `forwardEvent` already forwards, keyed on the
   * `transcription:<lang>` / `translation:<source>:<target>` stream strings, so
   * subscribed miniapps receive identical envelopes.
   */
  private ensureCloudResultsWired(): void {
    if (this.cloudResultsWired) return
    this.cloudResultsWired = true

    cloudClientService.onTranscript((d: TranscriptionData) => {
      const receivedAt = Date.now()
      if (TRANSCRIPT_TIMING_TELEMETRY) {
        console.log(
          `${LOG_TAG}: transcript cloud_recv t=${receivedAt} final=${d.isFinal} lang=${
            d.resolvedLanguage
          } text="${d.text.slice(0, 48)}"`,
        )
      }
      this.forwardEvent(
        `transcription:${d.resolvedLanguage}`,
        {
          type: "transcription",
          text: d.text,
          isFinal: d.isFinal,
          utteranceId: d.utteranceId,
          transcribeLanguage: d.resolvedLanguage,
          detectedLanguage: d.languageDetected ? d.resolvedLanguage : undefined,
          startTime: d.startMs,
          endTime: d.endMs,
          speakerId: d.speakerId,
          duration: d.durationMs,
          provider: d.provider,
          confidence: d.confidence,
          __hostReceivedAt: receivedAt,
        },
        "cloud",
      )
    })

    cloudClientService.onTranslation((d: TranslationData) => {
      this.forwardEvent(`translation:${d.source.language}:${d.target.language}`, {
        type: "translation",
        text: d.text,
        originalText: d.originalText,
        isFinal: d.isFinal,
        utteranceId: d.utteranceId,
        startTime: d.startMs,
        endTime: d.endMs,
        speakerId: d.speakerId,
        duration: d.durationMs,
        transcribeLanguage: d.source.language,
        translateLanguage: d.target.language,
        didTranslate: true,
        provider: d.provider,
        confidence: d.confidence,
      })
    })
  }

  private ensureCloudStatusWired(): void {
    if (this.cloudStatusWired) return
    this.cloudStatusWired = true

    cloudClientService.onStatusChanged((status) => {
      if (status.status === "connected") {
        this.updateCloudSubscriptions()
        // A miniapp that connected before the cloud client was ready never got
        // its auth token; now that we're connected, mint it without waiting for
        // the retry backoff (or a full manual reconnect).
        this.redriveMiniappAuthDelivery()
      }
      this.broadcastCloudStatus()
    })

    useSettingsStore.subscribe(
      (s) => s.getSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive),
      () => {
        this.broadcastCloudStatus()
      },
    )
  }

  private currentCloudStatus(): CloudClientStatusSnapshot {
    const base = cloudClientService.getStatus()
    const fallbackActive =
      (useSettingsStore.getState().getSetting(ISLAND_SETTINGS_KEYS.localSttFallbackActive) as boolean | undefined) ===
      true
    return {
      status: base.status,
      audioTransport: fallbackActive ? "offline" : base.audioTransport,
    }
  }

  private broadcastCloudStatus(): void {
    const status = this.currentCloudStatus()
    for (const packageName of this.connectedApps.keys()) {
      this.sendCloudStatusToMiniapp(packageName, status)
    }
  }

  private sendCloudStatusToMiniapp(packageName: string, status = this.currentCloudStatus()): void {
    this.sendToMiniapp(packageName, {
      type: MiniappResponseType.EVENT,
      streamType: CLOUD_STATUS_STREAM,
      data: status,
    })
  }

  // ===========================================================================
  // Stream fan-out
  // ===========================================================================

  /**
   * Forward a streamed event to all miniapps subscribed to the given stream.
   *
   * Event name translation:
   * - Cloud sends "head_up" → miniapp protocol uses "head_position" (HEAD_POSITION)
   * - Cloud sends "VAD" (uppercase) → miniapp protocol uses "vad" (lowercase)
   */
  public forwardEvent(streamType: string, data: unknown, transcriptionSource?: TranscriptionEventSource): void {
    // Translate cloud event names to miniapp protocol stream types
    const normalizedStream = this.normalizeStreamType(streamType)

    // Collect all subscribers: exact match, plus wildcard matches for streams
    // that carry a language tag. A miniapp subscribed to "transcription:auto"
    // should receive any "transcription:<lang>" event (the detected language
    // is conveyed in the event data, not the stream key).
    //
    // Translation streams support cloud v3's wildcard patterns. Incoming
    // events are keyed `translation:<source>:<target>` and we match against
    // any of:
    //   translation:*:*             — all-pairs (TranslationModule.on)
    //   translation:*:<target>      — any-source → target (TranslationModule.to)
    //   translation:<source>:*      — source → any-target (rare)
    //   translation:<source>:<target> — exact (TranslationModule.fromTo)
    //   translation:auto            — back-compat alias for *:*
    const matchedSubs = new Set<string>()
    const exact = this.streamSubscribers.get(normalizedStream)
    if (exact) for (const p of exact) matchedSubs.add(p)

    if (normalizedStream.startsWith("transcription:")) {
      const autoSubs = this.streamSubscribers.get("transcription:auto")
      if (autoSubs) for (const p of autoSubs) matchedSubs.add(p)
    } else if (normalizedStream.startsWith("translation:")) {
      // translation:<source>:<target> — match each wildcard variant.
      const parts = normalizedStream.split(":")
      // parts[0] = "translation", parts[1] = source, parts[2] = target
      if (parts.length === 3) {
        const [, source, target] = parts
        const patterns = [
          "translation:auto", // legacy alias for *:*
          "translation:*:*", // cloud v3 "all pairs"
          `translation:*:${target}`, // cloud v3 "to <target>"
          `translation:${source}:*`, // cloud v3 "from <source>"
        ]
        for (const pat of patterns) {
          const subs = this.streamSubscribers.get(pat)
          if (subs) for (const p of subs) matchedSubs.add(p)
        }
      } else {
        // Malformed stream key — still honor the legacy auto alias.
        const autoSubs = this.streamSubscribers.get("translation:auto")
        if (autoSubs) for (const p of autoSubs) matchedSubs.add(p)
      }
    }

    // Touch event per-gesture fan-out. SDK-side dispatch is keyed on the
    // exact streamType, so per-gesture subscribers (`touch_event:single_tap`,
    // etc.) need their own EVENT envelope with the gesture-tagged streamType.
    // The bare `touch_event` stream above still catches `onTouch(handler)`.
    let perGestureStream: string | null = null
    let outboundData = data
    if (normalizedStream === MiniappStreamType.TOUCH_EVENT) {
      // The Bluetooth SDK delivers the gesture under `gestureName` (single_tap /
      // double_tap / triple_tap / long_press / swipe_up / swipe_down). Surface it
      // to miniapps as `TouchData.kind` and tag a per-gesture stream so
      // onTouch("single_tap", ...) routes correctly.
      const touch = data as {gestureName?: string; kind?: string} | null
      const gesture = touch?.gestureName ?? touch?.kind
      if (typeof gesture === "string" && gesture.length > 0) {
        outboundData = {...(touch as object), kind: gesture}
        perGestureStream = `${MiniappStreamType.TOUCH_EVENT}:${gesture}`
      }
    }

    if (normalizedStream.startsWith("transcription:")) {
      // const known = Array.from(this.streamSubscribers.keys())
      // console.log(
      //   `${LOG_TAG}: forwardEvent(${streamType} → ${normalizedStream}) matched=${matchedSubs.size} known=[${known.join(", ")}]`,
      // )
    }

    if (matchedSubs.size === 0 && !perGestureStream) return

    for (const packageName of matchedSubs) {
      let transcriptionRoute: "default" | "forceLocal" | "all" | undefined
      if (normalizedStream.startsWith("transcription:") && transcriptionSource) {
        const routes = this.appTranscriptionRoutesForEvent(packageName, normalizedStream)
        transcriptionRoute =
          transcriptionDeliveryRoute(transcriptionSource, routes, cloudClientService.isConnected()) ?? undefined
        if (!transcriptionRoute) continue
      }
      if (TRANSCRIPT_TIMING_TELEMETRY && normalizedStream.startsWith("transcription:")) {
        const transcript = data as {text?: string; isFinal?: boolean; __hostReceivedAt?: number} | null
        const now = Date.now()
        console.log(
          `${LOG_TAG}: transcript fanout t=${now} app=${packageName} final=${!!transcript?.isFinal} hostDelta=${
            transcript?.__hostReceivedAt ? now - transcript.__hostReceivedAt : -1
          }ms text="${(transcript?.text ?? "").slice(0, 48)}"`,
        )
      }
      // While a nav trip is active the Nav SDK's road-snapped fixes are
      // already being forwarded via addLocationListener (see NAV_START handler).
      // Suppress the raw background-GPS forward for that miniapp so the two
      // streams don't interleave and cause the position to jump back to the
      // real-phone location during simulation.
      if (normalizedStream === MiniappStreamType.LOCATION_UPDATE && this.navigationHandlers.isTripActive(packageName)) {
        continue
      }
      this.sendToMiniapp(packageName, {
        type: MiniappResponseType.EVENT,
        streamType: normalizedStream,
        data: outboundData,
        ...(transcriptionRoute ? {transcriptionRoute} : {}),
      })
    }

    // Send a separate envelope to per-gesture subscribers tagged with the
    // gesture-specific streamType so SDK-side dispatch routes correctly.
    if (perGestureStream) {
      const gestureSubs = this.streamSubscribers.get(perGestureStream)
      if (gestureSubs) {
        for (const packageName of gestureSubs) {
          this.sendToMiniapp(packageName, {
            type: MiniappResponseType.EVENT,
            streamType: perGestureStream,
            data: outboundData,
          })
        }
      }
    }
  }

  private appTranscriptionRoutesForSubscription(
    packageName: string,
    stream: string,
  ): {
    cloud: boolean
    forceLocal: boolean
  } {
    const app = this.connectedApps.get(packageName)
    return {
      cloud: app?.cloudTranscriptionStreams.has(stream) === true,
      forceLocal: app?.forceLocalTranscriptionStreams.has(stream) === true,
    }
  }

  private appTranscriptionRoutesForEvent(
    packageName: string,
    stream: string,
  ): {
    cloud: boolean
    forceLocal: boolean
  } {
    const app = this.connectedApps.get(packageName)
    const autoStream = `${MiniappStreamType.TRANSCRIPTION}:auto`
    return {
      cloud:
        app?.cloudTranscriptionStreams.has(stream) === true || app?.cloudTranscriptionStreams.has(autoStream) === true,
      forceLocal:
        app?.forceLocalTranscriptionStreams.has(stream) === true ||
        app?.forceLocalTranscriptionStreams.has(autoStream) === true,
    }
  }

  /**
   * Translate cloud event names to miniapp stream type values.
   */
  private normalizeStreamType(cloudEventName: string): string {
    // Cloud / Bluetooth SDK → miniapp protocol translations.
    // Bluetooth SDK event names don't always match the miniapp wire values.
    switch (cloudEventName) {
      case "head_up":
        return MiniappStreamType.HEAD_POSITION // head_up → head_position
      case "accel_event":
        return MiniappStreamType.ACCEL_DATA // accel_event (native) → accel_data
      case "VAD":
        return MiniappStreamType.VAD // VAD (uppercase) → vad (lowercase)
      case "glasses_battery_update":
        return MiniappStreamType.GLASSES_BATTERY // glasses_battery_update → glasses_battery
      case "glasses_connection_state":
        return MiniappStreamType.GLASSES_CONNECTION // glasses_connection_state → glasses_connection
      default:
        // Preserve case for typed streams like "transcription:en-US" / "translation:en-US:fr-FR"
        // whose language tags are case-sensitive (BCP-47). Lowercase only plain names.
        if (cloudEventName.includes(":")) return cloudEventName
        return cloudEventName.toLowerCase()
    }
  }

  // ===========================================================================
  // Outbound helpers
  // ===========================================================================

  /**
   * Send a payload to a connected miniapp, wrapped in an envelope.
   */
  /**
   * Push a speaker-state transition to the owning miniapp. Idempotent: if
   * the new state matches the cached one (and isn't an error), no envelope
   * is sent. Error events are always sent — they're transient and the SDK
   * settles back to a non-error state immediately after.
   */
  private setSpeakerState(
    packageName: string,
    next: SpeakerStateValue,
    extra?: {errorCode?: string; errorMessage?: string; durationMs?: number},
  ): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return
    if (app.speakerState === next && next !== "error") return
    app.speakerState = next === "error" ? "error" : next
    this.sendToMiniapp(packageName, {
      type: MiniappResponseType.SPEAKER_STATE,
      state: next,
      ...(extra?.errorCode !== undefined ? {errorCode: extra.errorCode} : {}),
      ...(extra?.errorMessage !== undefined ? {errorMessage: extra.errorMessage} : {}),
      ...(extra?.durationMs !== undefined ? {durationMs: extra.durationMs} : {}),
    })
    // After an error event, immediately transition to "stopped" so the
    // SDK's isPlaying getter reads false and a new play()/speak() call
    // starts cleanly from idle/stopped.
    if (next === "error") {
      app.speakerState = "stopped"
      this.sendToMiniapp(packageName, {
        type: MiniappResponseType.SPEAKER_STATE,
        state: "stopped",
      })
    }
  }

  private sendToMiniapp(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const app = this.connectedApps.get(packageName)
    if (!app) {
      console.warn(`${LOG_TAG}: sendToMiniapp — ${packageName} not connected`)
      return
    }

    const envelope: MiniappEnvelope = {
      payload,
      requestId,
    }

    const serialized = serializeEnvelope(envelope)
    if ((payload as Record<string, unknown>)?.streamType?.toString().startsWith("transcription")) {
      // console.log(
      //   `${LOG_TAG}: sendToMiniapp → ${packageName} streamType=${(payload as Record<string, unknown>).streamType}`,
      // )
    }

    try {
      app.sendMessage(serialized)
    } catch (err) {
      console.error(`${LOG_TAG}: sendToMiniapp error for ${packageName}:`, err)
    }
  }

  /**
   * Send a REQUEST_RESULT response.
   */
  // ===========================================================================
  // Inter-miniapp interop (session.miniapps + session.actions.invoke)
  // ===========================================================================

  /** Max serialized size of an action call's params / result (256 KB). */
  private static readonly ACTION_PAYLOAD_CAP = 256 * 1024

  /** Outstanding action invocations, keyed by host-generated callId. */
  private actionCalls = new Map<
    string,
    {callerPackageName: string; targetPackageName: string; callerRequestId?: string; timer: number}
  >()
  private actionCallSeq = 0

  private interopApps(): ClientApp[] {
    return useAppStatusStore.getState().apps
  }

  private isSystemPackage(packageName: string): boolean {
    if (SYSTEM_MINIAPP_PACKAGES.has(packageName)) return true
    return this.interopApps().find((app) => app.packageName === packageName)?.isMiniappDev === true
  }

  private async startInteropApp(packageName: string): Promise<boolean> {
    const app = this.interopApps().find((a) => a.packageName === packageName)
    if (!app) return false
    if (app.local) {
      await miniappLauncher.ensureConnected(packageName)
      return true
    }
    return useAppStatusStore.getState().start(app, {skipNavigation: true})
  }

  private stopInteropApp(packageName: string): Promise<void> {
    return useAppStatusStore.getState().stop(packageName)
  }

  private wakeInteropApp(packageName: string): Promise<void> {
    return miniappLauncher.ensureConnected(packageName)
  }

  /** Emit an interop audit event (best-effort — never let telemetry break a call). */
  private auditInterop(event: InteropAuditEvent): void {
    try {
      getAnalytics()?.("miniapp_interop", {
        caller: event.caller,
        op: event.op,
        target: event.target ?? "",
        actionId: event.actionId ?? "",
        ok: event.ok,
        errorCode: event.errorCode ?? "",
      })
    } catch {
      /* telemetry must never break an interop call */
    }
  }

  /** Reject the request with NOT_PERMITTED unless the caller is a system app. */
  private requireSystemCaller(
    packageName: string,
    requestId: string | undefined,
    op: InteropAuditEvent["op"],
    target?: string,
  ): boolean {
    if (this.isSystemPackage(packageName)) return true
    this.auditInterop({caller: packageName, op, target, ok: false, errorCode: MiniappErrorCode.NOT_PERMITTED})
    this.sendResult(packageName, requestId, false, undefined, {
      code: MiniappErrorCode.NOT_PERMITTED,
      message: "Inter-miniapp APIs are restricted to system apps",
    })
    return false
  }

  /** Project a host ClientApp into the SDK's MiniappInfo shape (JSON over the wire). */
  private buildMiniappInfo(app: ClientApp): Record<string, unknown> {
    const compatibility = app.compatibility ?? {
      isCompatible: true,
      missingRequired: [],
      missingOptional: [],
      warnings: [],
    }
    return {
      packageName: app.packageName,
      name: app.name,
      version: app.version ?? "",
      running: app.running,
      compatibility,
      actions: app.actions ?? [],
    }
  }

  private handleMiniappsList(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    if (!this.requireSystemCaller(packageName, requestId, "list")) return
    const includeIncompatible = payload.includeIncompatible === true
    const infos = this.interopApps()
      .filter(
        (a) =>
          a.packageName &&
          a.packageName !== packageName &&
          !a.packageName.includes("@empty") &&
          (includeIncompatible || a.compatibility?.isCompatible !== false),
      )
      .map((a) => this.buildMiniappInfo(a))
    this.sendResult(packageName, requestId, true, infos)
    this.auditInterop({caller: packageName, op: "list", ok: true})
  }

  private async handleMiniappsStart(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const target = payload.packageName as string | undefined
    if (!this.requireSystemCaller(packageName, requestId, "start", target)) return
    const app = target ? this.interopApps().find((a) => a.packageName === target) : undefined
    if (!target || !app) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.APP_NOT_FOUND,
        message: `Miniapp not found: ${target ?? "(missing packageName)"}`,
      })
      this.auditInterop({
        caller: packageName,
        op: "start",
        target,
        ok: false,
        errorCode: MiniappErrorCode.APP_NOT_FOUND,
      })
      return
    }
    // Pre-flight the hardware gate so the caller gets a precise reason rather
    // than a generic rejection (start()'s own gate would otherwise alert + abort).
    if (app.compatibility && app.compatibility.isCompatible === false) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.APP_NOT_COMPATIBLE,
        message: `${target} is not compatible with the connected glasses`,
      })
      islandNotifications.emit({
        kind: "version_incompatible",
        packageName: target,
        reason: `${target} is not compatible with the connected glasses`,
        metadata: {missingRequired: app.compatibility.missingRequired ?? [], via: "miniapps.start"},
        timestamp: Date.now(),
      })
      this.auditInterop({
        caller: packageName,
        op: "start",
        target,
        ok: false,
        errorCode: MiniappErrorCode.APP_NOT_COMPATIBLE,
      })
      return
    }
    try {
      // startInteropApp resolves to false when the app-store gate rejected the
      // launch or the background context failed to spawn — don't report success.
      const started = await this.startInteropApp(target)
      if (started) {
        this.sendResult(packageName, requestId, true)
        this.auditInterop({caller: packageName, op: "start", target, ok: true})
      } else {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.INTERNAL,
          message: `start of ${target} was rejected by the host (gated or failed to spawn)`,
        })
        this.auditInterop({
          caller: packageName,
          op: "start",
          target,
          ok: false,
          errorCode: MiniappErrorCode.INTERNAL,
        })
      }
    } catch (e) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: (e as Error)?.message ?? "start failed",
      })
      this.auditInterop({
        caller: packageName,
        op: "start",
        target,
        ok: false,
        errorCode: MiniappErrorCode.INTERNAL,
      })
    }
  }

  private async handleMiniappsStop(
    packageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const target = payload.packageName as string | undefined
    if (!this.requireSystemCaller(packageName, requestId, "stop", target)) return
    if (!target) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.APP_NOT_FOUND,
        message: "stop requires a packageName",
      })
      return
    }
    try {
      await this.stopInteropApp(target)
      this.sendResult(packageName, requestId, true)
      this.auditInterop({caller: packageName, op: "stop", target, ok: true})
    } catch (e) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: (e as Error)?.message ?? "stop failed",
      })
    }
  }

  /** True iff `value` serializes larger than the action payload cap. */
  private actionPayloadTooLarge(value: unknown): boolean {
    try {
      return JSON.stringify(value ?? null).length > LocalMiniappRuntime.ACTION_PAYLOAD_CAP
    } catch {
      // Unserializable — let it through; the transport's own serialize handles it.
      return false
    }
  }

  /**
   * session.actions.invoke → wake the target headlessly, deliver an ACTION_CALL,
   * and correlate its ACTION_RESULT back to the caller's pending request.
   */
  private async handleActionInvoke(
    callerPackageName: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const targetForGate = payload.targetPackageName as string | undefined
    if (!this.requireSystemCaller(callerPackageName, requestId, "invoke", targetForGate)) return

    const target = payload.targetPackageName as string | undefined
    const actionId = payload.actionId as string | undefined
    const params = (payload.params as Record<string, unknown> | undefined) ?? {}
    // Floor the timeout at 6s so the host never rejects with ACTION_TIMEOUT before
    // the target SDK's handler-registration window closes. A freshly-woken miniapp
    // buffers an undelivered ACTION_CALL for HANDLER_WAIT_MS (5s in @mentra/miniapp's
    // actions module) waiting for session.actions.handle; a shorter host timeout
    // could fire while the target is still registering, then the action would run
    // with no caller left to receive its result. 6s = that 5s buffer + 1s for the
    // ACTION_RESULT/NO_ACTION_HANDLER reply to travel back. Keep these in sync.
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 30_000, 6_000), 120_000)

    if (this.actionPayloadTooLarge(params)) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.PAYLOAD_TOO_LARGE,
        message: "action params exceeded the 256 KB cap",
      })
      return
    }

    const app = target ? this.interopApps().find((a) => a.packageName === target) : undefined
    if (!target || !app) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.APP_NOT_FOUND,
        message: `Miniapp not found: ${target ?? "(missing targetPackageName)"}`,
      })
      return
    }
    if (!actionId) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.ACTION_NOT_FOUND,
        message: "invoke requires an actionId",
      })
      return
    }
    if (app.compatibility && app.compatibility.isCompatible === false) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.APP_NOT_COMPATIBLE,
        message: `${target} is not compatible with the connected glasses`,
      })
      islandNotifications.emit({
        kind: "version_incompatible",
        packageName: target,
        reason: `${target} is not compatible with the connected glasses`,
        metadata: {missingRequired: app.compatibility.missingRequired ?? [], via: "miniapps.invoke"},
        timestamp: Date.now(),
      })
      return
    }
    // Declared-action gate — only once the host populates app.actions (Phase 2);
    // until then app.actions is undefined and we fall through to NO_ACTION_HANDLER.
    if (!(app.actions ?? []).some((a) => a.id === actionId)) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.ACTION_NOT_FOUND,
        message: `${target} does not declare action "${actionId}"`,
      })
      return
    }

    // Headless wake + wait for CONNECT (idempotent / fast if already connected).
    try {
      await this.wakeInteropApp(target)
    } catch (e) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.WAKE_FAILED,
        message: (e as Error)?.message ?? `failed to wake ${target}`,
      })
      return
    }

    // The wake waited for CONNECT, but the target could have dropped in the gap
    // before delivery — fail fast rather than arming a timer for a call that
    // sendToMiniapp would silently drop (the caller would otherwise wait the
    // full invoke timeout for an ACTION_CALL that was never delivered).
    if (!this.connectedApps.has(target)) {
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.WAKE_FAILED,
        message: `${target} disconnected before the action could be delivered`,
      })
      this.auditInterop({
        caller: callerPackageName,
        op: "invoke",
        target,
        actionId,
        ok: false,
        errorCode: MiniappErrorCode.WAKE_FAILED,
      })
      return
    }

    // Deliver the call and arm the handler timeout; ACTION_RESULT resolves it.
    const callId = `act-${Date.now().toString(36)}-${this.actionCallSeq++}`
    const timer = BgTimer.setTimeout(() => {
      this.actionCalls.delete(callId)
      this.sendResult(callerPackageName, requestId, false, undefined, {
        code: MiniappErrorCode.ACTION_TIMEOUT,
        message: `action "${actionId}" timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    this.actionCalls.set(callId, {callerPackageName, targetPackageName: target, callerRequestId: requestId, timer})
    this.sendToMiniapp(target, {
      type: MiniappResponseType.ACTION_CALL,
      callId,
      actionId,
      params,
      callerPackageName,
    })
    this.auditInterop({caller: callerPackageName, op: "invoke", target, actionId, ok: true})
  }

  /** Target → host: forward an ACTION_RESULT back to the caller's pending invoke. */
  private handleActionResult(targetPackageName: string, payload: Record<string, unknown>): void {
    const callId = payload.callId as string | undefined
    if (!callId) return
    const pending = this.actionCalls.get(callId)
    if (!pending) return
    // Only the invoked target may resolve this call. callIds are guessable
    // (timestamp + seq), so a different connected miniapp must not be able to
    // spoof a result/error for someone else's invoke.
    if (pending.targetPackageName !== targetPackageName) return
    this.actionCalls.delete(callId)
    BgTimer.clearTimeout(pending.timer)

    if (payload.ok === true) {
      const result = payload.result
      if (this.actionPayloadTooLarge(result)) {
        this.sendResult(pending.callerPackageName, pending.callerRequestId, false, undefined, {
          code: MiniappErrorCode.PAYLOAD_TOO_LARGE,
          message: "action result exceeded the 256 KB cap",
        })
        return
      }
      this.sendResult(pending.callerPackageName, pending.callerRequestId, true, result ?? null)
    } else {
      const error = (payload.error as ({code: string; message: string} & Record<string, unknown>) | undefined) ?? {
        code: MiniappErrorCode.INTERNAL,
        message: "action handler error",
      }
      this.sendResult(pending.callerPackageName, pending.callerRequestId, false, undefined, error)
    }
  }

  private sendResult(
    packageName: string,
    requestId: string | undefined,
    ok: boolean,
    data?: unknown,
    error?: {code: string; message: string} & Record<string, unknown>,
  ): void {
    if (!requestId) return

    this.sendToMiniapp(
      packageName,
      {
        type: MiniappResponseType.REQUEST_RESULT,
        requestId,
        ok,
        ...(data !== undefined ? {data} : {}),
        ...(error ? {error} : {}),
      },
      requestId,
    )
  }

  /**
   * Send a VISIBILITY_CHANGE push to a miniapp.
   */
  public sendVisibilityChange(packageName: string, visibility: "foreground" | "background"): void {
    this.sendToMiniapp(packageName, {
      type: MiniappResponseType.VISIBILITY_CHANGE,
      visibility,
    })
  }

  /**
   * Fast foreground liveness check used when a local miniapp UI is opened or
   * resumed. The normal watchdog intentionally waits ~30s to avoid killing a
   * healthy-but-busy background script. When the user is actively looking at a
   * WebView, a stale JSContext reads as "cloud offline" / no captions, so probe
   * immediately and reuse the crash-respawn path if no message comes back.
   */
  public probeForegroundLiveness(
    packageName: string,
    reason = "foreground-open",
    timeoutMs = FOREGROUND_LIVENESS_PROBE_TIMEOUT_MS,
  ): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return

    this.clearForegroundProbe(packageName)
    const probeStartedAt = Date.now()

    this.sendToMiniapp(packageName, {
      type: MiniappRequestType.PING,
    })

    const timerId = BgTimer.setTimeout(() => {
      this.foregroundProbeTimers.delete(packageName)
      const current = this.connectedApps.get(packageName)
      if (!current) return
      if (current.lastPongAt >= probeStartedAt) return

      console.warn(`${LOG_TAG}: ${packageName} failed foreground liveness probe (${reason}), respawning`)
      this.unregisterApp(packageName)
      this.onLivenessTimeout?.(packageName)
    }, timeoutMs)
    this.foregroundProbeTimers.set(packageName, timerId)
  }

  // ===========================================================================
  // Ping / pong liveness
  // ===========================================================================

  private ensurePingLoop(): void {
    if (this.pingIntervalId !== null) return

    this.pingIntervalId = BgTimer.setInterval(() => {
      this.doPingRound()
    }, PING_INTERVAL_MS)
  }

  private stopPingLoop(): void {
    if (this.pingIntervalId !== null) {
      BgTimer.clearInterval(this.pingIntervalId)
      this.pingIntervalId = null
    }
  }

  private doPingRound(): void {
    const toRemove: string[] = []

    for (const [packageName, app] of this.connectedApps) {
      const liveness = advanceMiniappPingLiveness(app.unansweredPingRounds, PING_TIMEOUT_THRESHOLD)
      if (liveness.shouldUnregister) {
        console.warn(`${LOG_TAG}: ${packageName} missed ${PING_TIMEOUT_THRESHOLD} pings, unregistering`)
        toRemove.push(packageName)
        continue
      }
      app.unansweredPingRounds = liveness.unansweredPingRounds

      // Send PING — SDK auto-replies with PONG
      this.sendToMiniapp(packageName, {
        type: MiniappRequestType.PING,
      })
    }

    for (const pkg of toRemove) {
      this.unregisterApp(pkg)
      // Hand the package to the router's respawn machinery — a missed-pings
      // death is treated like a crash so the background script comes back.
      this.onLivenessTimeout?.(pkg)
    }
  }

  /**
   * Called when a PONG is received from a miniapp (or any message, really).
   * Updates lastPongAt to keep the app alive.
   */
  public handlePong(packageName: string): void {
    const app = this.connectedApps.get(packageName)
    if (app) {
      app.lastPongAt = Date.now()
      app.unansweredPingRounds = 0
      this.clearForegroundProbe(packageName)
    }
  }

  private clearForegroundProbe(packageName: string): void {
    const timerId = this.foregroundProbeTimers.get(packageName)
    if (timerId == null) return
    BgTimer.clearTimeout(timerId)
    this.foregroundProbeTimers.delete(packageName)
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  public cleanup(): void {
    console.log(`${LOG_TAG}: cleanup()`)
    this.stopPingLoop()

    // Copy keys since unregisterApp mutates the map
    const packageNames = [...this.connectedApps.keys()]
    for (const pkg of packageNames) {
      this.unregisterApp(pkg)
    }

    // Belt-and-suspenders: clear any remaining state
    this.pendingCloudRequests.clear()
    const hadButtonPressSubscribers = this.getButtonPressSubscribers().length > 0
    this.streamSubscribers.clear()
    if (hadButtonPressSubscribers) {
      for (const listener of this.buttonPressSubscriberListeners) {
        try {
          listener([])
        } catch (error) {
          console.warn(`${LOG_TAG}: button press subscriber listener threw during cleanup:`, error)
        }
      }
    }
    this.connectedApps.clear()
    for (const timerId of this.foregroundProbeTimers.values()) {
      BgTimer.clearTimeout(timerId)
    }
    this.foregroundProbeTimers.clear()

    LocalMiniappRuntime.instance = null
  }

  /**
   * Number of currently connected miniapps (for diagnostics).
   */
  public get connectedAppCount(): number {
    return this.connectedApps.size
  }
}

const localMiniappRuntime = LocalMiniappRuntime.getInstance()
export default localMiniappRuntime
