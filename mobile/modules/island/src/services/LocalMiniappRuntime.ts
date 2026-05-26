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

import {Linking} from "react-native"
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
  parseEnvelope,
  serializeEnvelope,
} from "@mentra/miniapp"
import type {MiniappEnvelope} from "@mentra/miniapp"

import {DeviceTypes, getModelCapabilities} from "../types"
import {storage as mmkvStorage} from "../utils/storage/storage"
import {BgTimer} from "../utils/timers"
import devServerBridge from "./DevServerBridge"
import localDisplayManager from "./LocalDisplayManager"
import type {DisplayPayload} from "./LocalDisplayManager"
import localSttFallbackCoordinator from "./LocalSttFallbackCoordinator"
import micStateCoordinator from "./MicStateCoordinator"
import {getRuntimeHooks, ISLAND_SETTINGS_KEYS} from "../runtime/config"

// =============================================================================
// Types
// =============================================================================

export interface InstalledMiniappManifest {
  permissions?: Array<{type: string; required?: boolean; description?: string}>
  hardwareRequirements?: Array<{type: string; level: string; description?: string}>
}

type SpeakerStateValue = "idle" | "loading" | "playing" | "stopped" | "error"

interface ConnectedMiniapp {
  subscriptions: Set<string>
  sendMessage: (raw: string) => void
  lastPongAt: number
  installedManifest?: InstalledMiniappManifest
  /** Last speaker state pushed to this app. Used to dedup SPEAKER_STATE pushes. */
  speakerState: SpeakerStateValue
}

const LOG_TAG = "LOCAL_MINIAPP"
const PING_INTERVAL_MS = 5_000
const PING_TIMEOUT_THRESHOLD = 3 // unregister after 3 missed pongs (~15s)
const RGB_LED_ACTIONS = new Set<RgbLedAction>(["on", "off"])
const RGB_LED_COLORS = new Set<RgbLedColor>(["red", "green", "blue", "orange", "white"])

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

const ALL_CANONICAL_PERMISSIONS = ["location", "microphone", "camera", "notifications", "calendar"] as const

/**
 * Build the {location, microphone, camera, notifications, calendar} record the
 * SDK's session.permissions module reads from. Missing types are false.
 */
function computeDeclaredPermissionRecord(
  manifest: InstalledMiniappManifest | undefined,
): Record<string, boolean> {
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

  /** Ref-counted stream subscriptions: stream → set of packageNames. */
  private streamSubscribers: Map<string, Set<string>> = new Map()

  /** Ping interval handle. */
  private pingIntervalId: number | null = null

  /** Pending cloud requests: requestId → packageName that originated the request. */
  private pendingCloudRequests: Map<string, {packageName: string; envelopeRequestId?: string}> = new Map()

  // Browser fallback token auth (Phase 4)
  // HMAC-signed blob with a phone-local secret. Both issuer and verifier are
  // the same process, so the secret never leaves the device.
  private localSecret = `miniapp_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`
  private usedTokens = new Set<string>()

  private constructor() {}

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
   * (phone_photo_ready, phone_stream_status, phone_managed_stream_status).
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
      case "phone_photo_ready": {
        if (msg.error) {
          this.sendResult(pending.packageName, pending.envelopeRequestId, false, undefined, {
            code: msg.error as string,
            message: `Photo capture failed: ${msg.error}`,
          })
        } else {
          this.sendResult(pending.packageName, pending.envelopeRequestId, true, {
            photoUrl: msg.photoUrl,
            mimeType: msg.mimeType,
            size: msg.size,
          })
        }
        break
      }

      case "phone_stream_status": {
        // Forward stream status as an event to the miniapp
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
    // If the app is already registered (e.g. QR scanned again for same package),
    // tear down its old subscriptions first so streamSubscribers doesn't keep
    // dangling references. The WebView will re-subscribe after its CONNECT.
    if (this.connectedApps.has(packageName)) {
      const existing = this.connectedApps.get(packageName)!
      for (const stream of existing.subscriptions) {
        const subs = this.streamSubscribers.get(stream)
        if (subs) {
          subs.delete(packageName)
          if (subs.size === 0) this.streamSubscribers.delete(stream)
        }
      }
      this.recomputeMicRequirements()
      this.updateCloudSubscriptions()
    }
    this.connectedApps.set(packageName, {
      subscriptions: new Set(),
      sendMessage: sendFn,
      lastPongAt: Date.now(),
      installedManifest,
      speakerState: "idle",
    })
    this.ensurePingLoop()
  }

  /**
   * Attach (or update) the installedManifest for an already-registered app.
   * Used when the manifest is fetched asynchronously (dev miniapps) after the
   * miniapp has already CONNECTed — preserves existing subscriptions.
   */
  public setInstalledManifest(
    packageName: string,
    installedManifest: InstalledMiniappManifest,
  ): void {
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

  public unregisterApp(packageName: string): void {
    console.log(`${LOG_TAG}: unregisterApp(${packageName})`)
    const app = this.connectedApps.get(packageName)
    if (!app) return

    // Remove from all stream subscriber sets
    for (const stream of app.subscriptions) {
      const subs = this.streamSubscribers.get(stream)
      if (subs) {
        subs.delete(packageName)
        if (subs.size === 0) {
          this.streamSubscribers.delete(stream)
        }
      }
    }

    // Reset per-session warning dedup so a relaunch surfaces issues again.
    resetPermissionWarnings(packageName)

    // Stop audio for this app
    getRuntimeHooks().audioPlayback?.stopForApp(packageName)

    // Clean up any pending cloud requests from this app
    for (const [reqId, pending] of this.pendingCloudRequests) {
      if (pending.packageName === packageName) {
        this.pendingCloudRequests.delete(reqId)
      }
    }

    this.connectedApps.delete(packageName)
    this.recomputeMicRequirements()
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
      devServerBridge.forwardLog(packageName, level, args, timestamp)

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
        this.handleConnect(packageName, payload, requestId)
        break
      case MiniappRequestType.SUBSCRIBE:
        this.handleSubscribe(packageName, payload, requestId)
        break
      case MiniappRequestType.DISPLAY:
        this.handleDisplay(packageName, payload, requestId)
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
      case MiniappRequestType.RGB_LED:
        this.handleRgbLed(packageName, payload, requestId)
        break
      case MiniappRequestType.LOCATION_POLL:
        this.handleLocationPoll(packageName, requestId)
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
      case MiniappRequestType.CAMERA_FOV:
        this.handleCameraFov(packageName, payload, requestId)
        break
      case MiniappRequestType.PING:
        // SDK should handle this itself; reply PONG just in case
        this.sendToMiniapp(packageName, {type: MiniappResponseType.PONG}, requestId)
        break
      case MiniappResponseType.PONG:
        // Miniapp's auto-reply to our PING — mark the app as alive
        this.handlePong(packageName)
        break

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

      // Phase 5 — cloud-coordinated features
      case MiniappRequestType.PHOTO:
        this.handlePhoto(packageName, payload, requestId)
        break
      case MiniappRequestType.STREAM_START:
        this.handleStreamStart(packageName, payload, requestId)
        break
      case MiniappRequestType.STREAM_STOP:
        this.handleStreamStop(packageName, payload, requestId)
        break
      case MiniappRequestType.MANAGED_STREAM_START:
        this.handleManagedStreamStart(packageName, payload, requestId)
        break
      case MiniappRequestType.MANAGED_STREAM_STOP:
        this.handleManagedStreamStop(packageName, payload, requestId)
        break

      // Deferred in v1
      case MiniappRequestType.DASHBOARD_CONTENT_UPDATE:
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: "Dashboard API is deferred in v1",
        })
        break

      default:
        console.warn(`${LOG_TAG}: Unknown request type from ${packageName}: ${requestType}`)
        break
    }
  }

  // ===========================================================================
  // Request handlers
  // ===========================================================================

  private handleConnect(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    console.log(`${LOG_TAG}: CONNECT from ${packageName}`)

    const userId = (getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.coreToken)) || ""

    // Register if not already
    const existing = this.connectedApps.get(packageName)
    if (!existing) {
      console.warn(`${LOG_TAG}: CONNECT from unregistered app ${packageName}, ignoring`)
      return
    }

    // Update lastPongAt so it doesn't time out right away
    existing.lastPongAt = Date.now()

    // Read current glasses capabilities from the settings store
    const defaultWearable = getRuntimeHooks().settings?.getSetting<DeviceTypes>(
      ISLAND_SETTINGS_KEYS.defaultWearable,
    )
    const capabilities = getModelCapabilities(defaultWearable || DeviceTypes.NONE)

    // Build the declared-permission record for the SDK's session.permissions
    // module. Lower-cased to match v3's PermissionType union (microphone,
    // camera, location, notifications, calendar). Missing permissions default
    // to false; this is manifest-declaration tracking only — OS-grant state
    // is intentionally not modeled here.
    const declaredPermissions = computeDeclaredPermissionRecord(existing.installedManifest)

    this.sendToMiniapp(
      packageName,
      {
        type: MiniappResponseType.CONNECT_ACK,
        userId,
        packageName,
        capabilities,
        permissions: declaredPermissions,
      },
      requestId,
    )
  }

  private handleSubscribe(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const app = this.connectedApps.get(packageName)
    if (!app) return

    const streams = (payload.subscriptions ?? payload.streams) as string[] | undefined
    if (!Array.isArray(streams)) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "subscribe requires a subscriptions array",
      })
      return
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
      if (s === "calendar_event") return "CALENDAR"
      return null
    }

    for (const stream of streams) {
      const required = permissionForStream(stream)
      if (required && !declaredTypes.has(required)) {
        logPermissionNotDeclared(
          packageName,
          required,
          `to subscribe to "${stream}"`,
          `{"type": "${required}"}`,
        )
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

    // Remove old subscriptions for this app
    for (const oldStream of app.subscriptions) {
      const subs = this.streamSubscribers.get(oldStream)
      if (subs) {
        subs.delete(packageName)
        if (subs.size === 0) {
          this.streamSubscribers.delete(oldStream)
        }
      }
    }

    // Add new subscriptions
    app.subscriptions = new Set(streams)
    for (const stream of streams) {
      let subs = this.streamSubscribers.get(stream)
      if (!subs) {
        subs = new Set()
        this.streamSubscribers.set(stream, subs)
      }
      subs.add(packageName)
    }

    this.recomputeMicRequirements()
    this.updateCloudSubscriptions()
    this.sendResult(packageName, requestId, true)

    // Fire initial snapshot values for stateful streams so miniapps don't have
    // to wait for the first change event.
    this.emitInitialSnapshots(packageName, streams)
  }

  /**
   * For state-bearing streams (battery, connection), deliver the current value
   * immediately on subscribe. Other streams (button press, transcription, etc.)
   * are pure event streams with no "current value" to snapshot.
   */
  private emitInitialSnapshots(packageName: string, streams: string[]): void {
    const glassesState = getRuntimeHooks().glassesStatus?.get() ?? {connected: false}
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
      } else if (stream === "head_position") {
        const headUp = (glassesState as {headUp?: boolean}).headUp
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

    this.setSpeakerState(packageName, "loading")
    getRuntimeHooks().audioPlayback?.play(
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
    getRuntimeHooks().audioPlayback?.stopForApp(packageName)
    this.setSpeakerState(packageName, "stopped")
    this.sendResult(packageName, requestId, true)
  }

  private async handleSpeak(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const text = payload.text as string | undefined
    if (!text) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: "speak requires text",
      })
      return
    }

    try {
      const backendUrl = getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.backendUrl)
      const voice = ((payload.voice_id ?? payload.voice) as string) || "default"
      const ttsUrl = `${backendUrl}/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`

      const audioRequestId = requestId || `tts_${Date.now()}`

      this.setSpeakerState(packageName, "loading")
      getRuntimeHooks().audioPlayback?.play(
        {requestId: audioRequestId, audioUrl: ttsUrl, appId: packageName, volume: 1.0, stopOtherAudio: true},
        (_respId, success, error, duration) => {
          if (success) {
            this.setSpeakerState(packageName, "stopped", {durationMs: duration ?? undefined})
          } else {
            this.setSpeakerState(packageName, "error", {
              errorCode: MiniappErrorCode.TTS_UPSTREAM_ERROR,
              errorMessage: error ?? "tts failed",
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
                  code: MiniappErrorCode.TTS_UPSTREAM_ERROR,
                  message: error,
                }
              : undefined,
          )
        },
      )
      queueMicrotask(() => this.setSpeakerState(packageName, "playing"))
    } catch (err) {
      console.error(`${LOG_TAG}: speak error:`, err)
      const message = err instanceof Error ? err.message : "TTS error"
      this.setSpeakerState(packageName, "error", {
        errorCode: MiniappErrorCode.TTS_UPSTREAM_ERROR,
        errorMessage: message,
      })
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.TTS_UPSTREAM_ERROR,
        message,
      })
    }
  }

  private handleRgbLed(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const coerceNumber = (value: unknown, fallback: number): number => {
      const coerced = Number(value)
      return Number.isFinite(coerced) ? coerced : fallback
    }

    const ledRequestId = requestId || `led_${Date.now()}`
    const action = normalizeRgbLedAction(payload.action)
    const color = normalizeRgbLedColor(payload.color)

    BluetoothSdk.rgbLedControl(
      ledRequestId,
      packageName,
      action,
      color,
      coerceNumber(payload.ontime, 1000),
      coerceNumber(payload.offtime, 0),
      coerceNumber(payload.count, 1),
    )

    this.sendResult(packageName, requestId, true)
  }

  private async handleLocationPoll(packageName: string, requestId?: string): Promise<void> {
    try {
      const {status} = await Location.requestForegroundPermissionsAsync()
      if (status !== "granted") {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
          message: "Location permission not granted",
        })
        return
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      })

      this.sendResult(packageName, requestId, true, {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        altitude: location.coords.altitude,
        accuracy: location.coords.accuracy,
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
  // Storage helpers
  // ---------------------------------------------------------------------------

  private getStorageKeyPrefix(packageName: string): string {
    const userId =
      getRuntimeHooks().settings?.getSetting<string>(ISLAND_SETTINGS_KEYS.coreToken) || "anonymous"
    return `mentraos_localstorage_${userId}_${packageName}_`
  }

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
      const fullKey = this.getStorageKeyPrefix(packageName) + key
      const result = mmkvStorage.load<unknown>(fullKey)
      this.sendResult(packageName, requestId, true, {key, value: result.is_ok() ? result.value : null})
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
      const fullKey = this.getStorageKeyPrefix(packageName) + key
      mmkvStorage.save(fullKey, payload.value ?? null)
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
      const fullKey = this.getStorageKeyPrefix(packageName) + key
      mmkvStorage.remove(fullKey)
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
      const prefix = this.getStorageKeyPrefix(packageName)
      const allKeys = mmkvStorage.getAllKeys()
      const keys = allKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
      this.sendResult(packageName, requestId, true, {keys})
    } catch (err) {
      console.error(`${LOG_TAG}: storage_list error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Storage error",
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Camera FOV
  // ---------------------------------------------------------------------------

  private handleCameraFov(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    try {
      const ROI_MAP: Record<string, number> = {center: 0, bottom: 1, top: 2}
      // SDK sends {horizontal, vertical} degrees; settings store uses {fov, roi_position}
      // Accept both the SDK field names and legacy field names for backwards compat
      const horizontal = payload.horizontal as number | undefined
      const fov =
        typeof horizontal === "number"
          ? Math.min(118, Math.max(82, horizontal))
          : typeof payload.fov === "number"
            ? Math.min(118, Math.max(82, payload.fov))
            : 118
      const roiStr = (payload.roiPosition as string) ?? "center"
      const numericRoi = ROI_MAP[roiStr] ?? 0
      console.log(`${LOG_TAG}: camera_fov_set fov=${fov} roi=${roiStr} (${numericRoi})`)
      getRuntimeHooks().settings?.setSetting(
        ISLAND_SETTINGS_KEYS.cameraFov,
        {fov, roi_position: numericRoi},
        false,
      )
      this.sendResult(packageName, requestId, true)
    } catch (err) {
      console.error(`${LOG_TAG}: camera_fov error:`, err)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Camera FOV error",
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
  // Phase 5: Photo + streaming handlers (cloud-coordinated)
  // ===========================================================================

  private async handlePhoto(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    // Check CAMERA permission
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
      const requestMiniappSdkPhoto = getRuntimeHooks().requestMiniappSdkPhoto
      if (!requestMiniappSdkPhoto) {
        this.sendResult(packageName, requestId, false, undefined, {
          code: MiniappErrorCode.NOT_IMPLEMENTED,
          message: "Photo capture is not configured on this host",
        })
        return
      }
      const photoRequestId = requestId || `photo_${Date.now()}`

      // Register so handleCloudMessage can route phone_photo_ready back
      this.registerPendingCloudRequest(photoRequestId, packageName, requestId)

      await requestMiniappSdkPhoto({
        requestId: photoRequestId,
        packageName,
        size: (payload.size as string) || "medium",
        compress: (payload.compress as string) || "none",
        saveToGallery: payload.saveToGallery as boolean | undefined,
        sound: payload.sound as boolean | undefined,
      })
      // Don't sendResult here — we wait for phone_photo_ready via handleCloudMessage
    } catch (err) {
      this.pendingCloudRequests.delete(requestId || "")
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INTERNAL,
        message: err instanceof Error ? err.message : "Photo request failed",
      })
    }
  }

  private handleStreamStart(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const streamRequestId = requestId || `stream_${Date.now()}`
    this.registerPendingCloudRequest(streamRequestId, packageName, requestId)

    getRuntimeHooks().socketComms?.sendMessage({
      type: "stream_request",
      packageName: "__phone__",
      requestId: streamRequestId,
      streamUrl: payload.streamUrl,
      video: payload.video ?? true,
      audio: payload.audio ?? true,
    })
  }

  private handleStreamStop(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    getRuntimeHooks().socketComms?.sendMessage({
      type: "stream_stop",
      packageName: "__phone__",
      streamId: payload.streamId,
    })
    this.sendResult(packageName, requestId, true)
  }

  private handleManagedStreamStart(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    const streamRequestId = requestId || `managed_${Date.now()}`
    this.registerPendingCloudRequest(streamRequestId, packageName, requestId)

    getRuntimeHooks().socketComms?.sendMessage({
      type: "managed_stream_request",
      packageName: "__phone__",
      requestId: streamRequestId,
      restreamDestinations: payload.restreamDestinations,
    })
  }

  private handleManagedStreamStop(packageName: string, payload: Record<string, unknown>, requestId?: string): void {
    getRuntimeHooks().socketComms?.sendMessage({
      type: "managed_stream_stop",
      packageName: "__phone__",
      streamId: payload.streamId,
    })
    this.sendResult(packageName, requestId, true)
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

    // Remove old subscriptions for this app
    for (const oldStream of app.subscriptions) {
      const subs = this.streamSubscribers.get(oldStream)
      if (subs) {
        subs.delete(packageName)
        if (subs.size === 0) {
          this.streamSubscribers.delete(oldStream)
        }
      }
    }

    // Add new subscriptions
    app.subscriptions = new Set(streams)
    for (const stream of streams) {
      let subs = this.streamSubscribers.get(stream)
      if (!subs) {
        subs = new Set()
        this.streamSubscribers.set(stream, subs)
      }
      subs.add(packageName)
    }

    this.recomputeMicRequirements()
    this.updateCloudSubscriptions()
    return {ok: true}
  }

  // ===========================================================================
  // Mic requirements
  // ===========================================================================

  private recomputeMicRequirements(): void {
    let anyPcm = false
    let anyLc3 = false
    for (const [stream, subscribers] of this.streamSubscribers) {
      if (subscribers.size === 0) continue
      if (stream === "audio_chunk") anyPcm = true
      if (stream.startsWith("transcription:") || stream.startsWith("translation:") || stream === "vad") anyLc3 = true
    }
    micStateCoordinator.setLocalRequirements({pcm: anyPcm, lc3: anyLc3})
  }

  /**
   * Recompute the aggregated subscription list across all local miniapps and
   * send PHONE_SUBSCRIPTION_UPDATE to the cloud so TranscriptionManager /
   * TranslationManager deliver data to the __phone__ subscriber.
   *
   * Cloud-dependent streams (transcription:*, translation:*) only flow if the
   * cloud knows the phone wants them. Local-only streams (button_press, etc.)
   * are NOT sent — they come from the Bluetooth SDK, not from cloud.
   */
  private updateCloudSubscriptions(): void {
    const cloudStreams = new Set<string>()
    let transcriptionLang: string | null = null
    for (const [stream, subscribers] of this.streamSubscribers) {
      if (subscribers.size === 0) continue
      // Only transcription / translation need cloud delivery. Location,
      // notifications, and calendar events are sourced natively on the phone
      // and forwarded to miniapps directly via MantleManager — no cloud hop.
      if (stream.startsWith("transcription:") || stream.startsWith("translation:")) {
        cloudStreams.add(stream)
      }
      if (stream.startsWith("transcription:") && transcriptionLang === null) {
        transcriptionLang = stream.substring("transcription:".length)
      }
    }
    getRuntimeHooks().socketComms?.updatePhoneSubscriptions(Array.from(cloudStreams))
    localSttFallbackCoordinator.onSubscriptionChange(transcriptionLang !== null, transcriptionLang)
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
  public forwardEvent(streamType: string, data: unknown): void {
    // Translate cloud event names to miniapp protocol stream types
    const normalizedStream = this.normalizeStreamType(streamType)

    // Collect all subscribers: exact match, plus wildcard matches for streams
    // that carry a language tag. A miniapp subscribed to "transcription:auto"
    // should receive any "transcription:<lang>" event (the detected language
    // is conveyed in the event data, not the stream key). Same for translation.
    const matchedSubs = new Set<string>()
    const exact = this.streamSubscribers.get(normalizedStream)
    if (exact) for (const p of exact) matchedSubs.add(p)

    if (normalizedStream.startsWith("transcription:")) {
      const autoSubs = this.streamSubscribers.get("transcription:auto")
      if (autoSubs) for (const p of autoSubs) matchedSubs.add(p)
    } else if (normalizedStream.startsWith("translation:")) {
      const autoSubs = this.streamSubscribers.get("translation:auto")
      if (autoSubs) for (const p of autoSubs) matchedSubs.add(p)
    }

    // Touch event per-gesture fan-out. SDK-side dispatch is keyed on the
    // exact streamType, so per-gesture subscribers (`touch_event:click`,
    // etc.) need their own EVENT envelope with the gesture-tagged streamType.
    // The bare `touch_event` stream above still catches `onTouch(handler)`.
    let perGestureStream: string | null = null
    if (normalizedStream === MiniappStreamType.TOUCH_EVENT) {
      const kind = (data as {kind?: string} | null)?.kind
      if (typeof kind === "string" && kind.length > 0) {
        perGestureStream = `${MiniappStreamType.TOUCH_EVENT}:${kind}`
      }
    }

    if (normalizedStream.startsWith("transcription:")) {
      const known = Array.from(this.streamSubscribers.keys())
      console.log(
        `${LOG_TAG}: forwardEvent(${streamType} → ${normalizedStream}) matched=${matchedSubs.size} known=[${known.join(", ")}]`,
      )
    }

    if (matchedSubs.size === 0 && !perGestureStream) return

    for (const packageName of matchedSubs) {
      this.sendToMiniapp(packageName, {
        type: MiniappResponseType.EVENT,
        streamType: normalizedStream,
        data,
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
            data,
          })
        }
      }
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
      console.log(
        `${LOG_TAG}: sendToMiniapp → ${packageName} streamType=${(payload as Record<string, unknown>).streamType}`,
      )
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
    const now = Date.now()
    const staleThreshold = PING_INTERVAL_MS * PING_TIMEOUT_THRESHOLD

    const toRemove: string[] = []

    for (const [packageName, app] of this.connectedApps) {
      if (now - app.lastPongAt > staleThreshold) {
        console.warn(`${LOG_TAG}: ${packageName} missed ${PING_TIMEOUT_THRESHOLD} pings, unregistering`)
        toRemove.push(packageName)
        continue
      }

      // Send PING — SDK auto-replies with PONG
      this.sendToMiniapp(packageName, {
        type: MiniappRequestType.PING,
      })
    }

    for (const pkg of toRemove) {
      this.unregisterApp(pkg)
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
    }
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
    this.streamSubscribers.clear()
    this.connectedApps.clear()

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
