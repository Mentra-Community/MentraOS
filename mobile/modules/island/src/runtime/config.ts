/**
 * Runtime configuration — host-injected accessors used by services that
 * cannot be fully self-contained inside the island module (LocalMiniappRuntime,
 * LocalDisplayManager, LocalSttFallbackCoordinator, DisplayProcessor).
 *
 * The mobile manager calls `configureRuntime(...)` early at boot to wire in
 * the manager's own stores and adapters. OEM hosts implement the same shape
 * with their own backing.
 *
 * Keep this surface tight — every entry here is a coupling point between
 * the host and the runtime. Prefer pushing data IN over pulling it via a
 * getter when reasonable.
 */
import type {AudioSubscription, TranscriptionData, TranslationData} from "@mentra/cloud-runtime/protocol"

export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

export interface CloudClientStatusSnapshot {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
}

export interface CloudRuntimeTtsSpeakOptions {
  voiceId?: string
  voice_id?: string
  modelId?: string
  model_id?: string
  voiceSettings?: Record<string, unknown>
  voice_settings?: Record<string, unknown>
}

export interface CloudRuntimeTtsSpeechSource {
  audioUrl: string
  contentType: string
  source: "cloud"
}

export interface CloudRuntimeTtsAdapter {
  speak: (text: string, options?: CloudRuntimeTtsSpeakOptions) => Promise<CloudRuntimeTtsSpeechSource>
}

import type {ClientApp} from "../types/applet"

/**
 * Snapshot the host exposes about the connected glasses. The host's full
 * glasses store is too rich for the runtime — these are the fields the
 * runtime actually reads. Extra fields are passed through verbatim on the
 * `glasses_connection` stream snapshot.
 */
export interface GlassesSnapshot {
  connected: boolean
  deviceModel?: string
  modelName?: string
  batteryLevel?: number
  charging?: boolean
  headUp?: boolean
  /** Extra host-defined fields surfaced on glasses_connection. */
  [key: string]: unknown
}

export interface SocketCommsAdapter {
  sendMessage: (message: object) => void
  updatePhoneSubscriptions: (subscriptions: string[]) => void
}

/**
 * Cloud-v2 (`@mentra/cloud-client`) runtime surface, wired in alongside the v1
 * `socketComms` path during the dual-cloud transition. The host owns the
 * singleton CloudClient; this adapter is the thin slice the island runtime
 * needs to drive transcription/translation subscriptions and fan results back
 * to local miniapps.
 *
 * Typed against `@mentra/cloud-runtime/protocol` so the subscription/result
 * shapes are the real wire types, not loosely-typed mirrors. Optional on
 * `RuntimeHooks`: hosts still on v1-only leave it unset and the runtime keeps
 * driving cloud transcription purely through `socketComms`.
 */
export interface CloudRuntimeAdapter {
  /** Replace the v2 cloud's audio subscription set for the live session. */
  setSubscriptions: (subs: AudioSubscription[]) => Promise<void>
  /** Encrypt + send one LC3 (or PCM) audio frame over the v2 UDP path. */
  sendAudioFrame: (frame: Uint8Array) => void
  /** Subscribe to v2 transcription results. Returns an unsubscribe fn. */
  onTranscript: (cb: (d: TranscriptionData) => void) => () => void
  /** Subscribe to v2 translation results. Returns an unsubscribe fn. */
  onTranslation: (cb: (d: TranslationData) => void) => () => void
  /** Current cloud-client runtime status, without host UI labels. */
  getStatus: () => CloudClientStatusSnapshot
  /** Subscribe to cloud-client runtime status changes. Returns an unsubscribe fn. */
  onStatusChanged: (cb: (snapshot: CloudClientStatusSnapshot) => void) => () => void
  /** Runtime TTS API. The cloud-client owns endpoint paths and validation. */
  tts: CloudRuntimeTtsAdapter
  /**
   * Whether any transcription/translation subscription is currently set on v2.
   * The host's audio-capture site gates `sendAudioFrame` on this so we don't
   * burn UDP bandwidth when nobody is subscribed on the v2 cloud.
   */
  hasAudioSubscriptions: () => boolean
  /** Whether the v2 live session is connected (handshake completed). */
  isConnected: () => boolean
}

/**
 * Cloud connection state surface used by LocalSttFallbackCoordinator to decide when
 * on-device STT should take over from cloud transcription. island's cloudClientService
 * self-wires this from its own cloud-v2 liveness (no host injection).
 */
export interface CloudConnectionAdapter {
  isConnected: () => boolean
  addListener: (l: (connected: boolean) => void) => () => void
}

// Audio playback (miniapp speaker / TTS) moved into island (AudioPlaybackService —
// pure expo-audio + btsdk volume control) — no longer a host hook.

export interface MicRequirements {
  shouldSendPcm: boolean
  shouldSendLc3: boolean
  shouldSendTranscript: boolean
}

/**
 * Result of an offline TTS synthesis. The island's TTSModelManager produces
 * this directly; the type is kept exported for hosts that wrap it.
 */
export interface TtsSynthesisResult {
  audioUrl: string
  cleanup?: () => Promise<void> | void
}

/**
 * Generic store accessor. The host wraps its Zustand / Redux / etc. selector
 * so the island module never imports the host's store implementation.
 */
export interface StoreAccessor<T> {
  get: () => T
}

export interface SettingsAccessor {
  getSetting: <T = unknown>(key: string) => T | undefined
  setSetting: <T = unknown>(key: string, value: T, persistImmediately?: boolean) => void
  /**
   * Subscribe to changes for one setting key. Returns an unsubscribe fn.
   * Optional — coordinators that only read settings on demand can skip it.
   */
  subscribeKey?: <T = unknown>(key: string, onChange: (value: T | undefined) => void) => () => void
}

/**
 * Stable settings keys read by island services. Hosts must wire their own
 * settings store keys to these names. Mobile already uses these strings.
 */
export const ISLAND_SETTINGS_KEYS = {
  localSttFallbackActive: "local_stt_fallback_active",
  defaultWearable: "default_wearable",
  backendUrl: "backend_url",
  coreToken: "core_token",
  cameraFov: "camera_fov",
} as const

/**
 * Navigation event payloads. Mirror the host's `NavigationService` types
 * but are duplicated here so the island module doesn't import host types.
 */
export type NavManeuverEvent = {
  kind: "maneuver"
  maneuverType: string
  distanceMeters: number
  fromRoad?: string | null
  toRoad?: string | null
  nextStepRoad?: string | null
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
  routeHeadingDeg?: number | null
}
export type NavOffRouteEvent = {kind: "off_route"; offRouteDistanceMeters: number}
export type NavReroutingEvent = {kind: "rerouting"}
export type NavArrivedEvent = {kind: "arrived"}
export type NavErrorEvent = {kind: "error"; message: string}
export type NavUpdate = NavManeuverEvent | NavOffRouteEvent | NavReroutingEvent | NavArrivedEvent | NavErrorEvent

export type NavLocation = {
  lat: number
  lng: number
  accuracy: number | null
  timestamp: number
}

export type NavRouteStep = {
  lat: number
  lng: number
  routeIndex: number
  road: string | null
  maneuver: string
  distanceMeters: number
}
export type NavRoute = {
  points: Array<{lat: number; lng: number}>
  steps?: NavRouteStep[]
}

export type NavTripSnapshot = {
  active: boolean
  mode?: string
  stops?: Array<{lat: number; lng: number}>
  currentStopIndex?: number
  route?: NavRoute
  maneuver?: NavManeuverEvent
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
}

// Navigation moved into island (NavigationService, called directly by the runtime's
// NavigationHandlers) — no longer a host-provided hook. The Nav* data types below stay
// (the runtime handlers use them).

/**
 * Heading adapter — compass / device heading subscription. The host's
 * HeadingService wraps native sensor output; the runtime only needs the
 * subscribe-and-unsubscribe surface.
 */
// Location-tier control + the background GPS task moved into island
// (PhoneLocationService, driven directly by the runtime's recomputeLocation) — no
// longer a host-provided hook.

// Streaming (RTMP/SRT/WHIP publishing) moved into island (PhoneStreamCoordinator,
// called directly by the runtime) — no longer a host-provided hook. The stream config
// data types stay here (shared by runtime/streamConfig.ts + the island coordinator).

export interface StreamVideoConfig {
  width?: number
  height?: number
  bitrate?: number
  fps?: number
}

export interface StreamAudioConfig {
  bitrate?: number
  sampleRate?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
}

export type CameraRoiPosition = "center" | "bottom" | "top"
export type CameraFovPreset = "narrow" | "standard" | "wide"

export type CameraFovRequest =
  | {
      fov: number
      roiPosition?: CameraRoiPosition
    }
  | {
      preset: CameraFovPreset
    }

export interface CameraFovResult {
  requestId: string
  fov: number
  roiPosition: CameraRoiPosition
  timestamp: number
}

// Camera FOV moved into island — LocalMiniappRuntime calls BluetoothSdk.setCameraFov
// directly (a pure passthrough with no host coupling) — no longer a host hook.
// CameraFovRequest/CameraFovResult below stay: they're the miniapp-facing payload types.

/** One audited inter-miniapp call. An LLM caller (Mentra AI) will eventually do
 * something a user wants to trace — every interop op emits one of these. */
export interface InteropAuditEvent {
  /** The system app that made the call. */
  caller: string
  op: "list" | "start" | "stop" | "invoke"
  /** Target miniapp (start/stop/invoke). */
  target?: string
  /** Action id (invoke only). */
  actionId?: string
  /** True if the call was permitted and accepted; false on denial / pre-flight failure. */
  ok: boolean
  /** MiniappErrorCode when ok is false. */
  errorCode?: string
}

/**
 * Inter-miniapp interop adapter — backs `session.miniapps` (list/start/stop)
 * and `session.actions.invoke`. The host provides the system-app *policy* and
 * the app-store operations so the runtime stays decoupled from the host's
 * store and its hardcoded SYSTEM_APPS list. Wired by the host at bootstrap.
 */
export interface InteropAdapter {
  /** Is this package a system app — allowed to use the SYSTEM-only interop APIs? */
  isSystemApp: (packageName: string) => boolean
  /** Snapshot of all installed miniapps (the host's app-store state). */
  listApps: () => ClientApp[]
  /**
   * Start (and foreground) another miniapp — user-tap semantics. Resolves true
   * if it actually started; false if a host gate aborted it (incompatible
   * hardware, captions STT gate, …) or its JS context failed to spawn.
   */
  startApp: (packageName: string) => Promise<boolean>
  /** Stop another miniapp. */
  stopApp: (packageName: string) => Promise<void>
  /**
   * Headless-wake a miniapp's background context AND wait for its CONNECT
   * handshake (for action invoke). No foreground, no arbitration. Rejects on
   * spawn/connect failure.
   */
  wakeMiniapp: (packageName: string) => Promise<void>
  /** Optional audit sink — one event per interop call (caller, op, outcome). */
  audit?: (event: InteropAuditEvent) => void
}

export interface RuntimeHooks {
  socketComms?: SocketCommsAdapter
  /**
   * Cloud-v2 (`@mentra/cloud-client`) runtime adapter. Additive alongside
   * `socketComms` during the dual-cloud transition; unset on v1-only hosts.
   */
  cloud?: CloudRuntimeAdapter
  // Glasses status read/subscribe moved into island — the runtime reads the island
  // useGlassesStore directly (DisplayProcessor / LocalMiniappRuntime) — no longer hooks.
  settings?: SettingsAccessor
  // Device heading / compass moved into island (HeadingService, subscribed
  // directly by the runtime) — no longer a host-provided hook.
  // Location-tier + GPS task moved into island (PhoneLocationService) — no longer a hook.
  /** Cloud WebSocket connection state surface. */
  cloudConnection?: CloudConnectionAdapter
  /**
   * The dev machine's live LAN host (no port), derived by the host from
   * Metro's `hostUri` — the address this dev bundle was actually served from,
   * so it is always current for whatever network the phone is on. Used to
   * repair persisted dev-miniapp URLs that froze a previous network's IP.
   * Unset outside Metro-served dev builds.
   */
  devServerHost?: () => string | undefined
  /**
   * Forward processed display events into the host's mirror store. The
   * default no-op skips the mirror — installed-only hosts (no UI mirror)
   * can leave this unset.
   */
  setDisplayEvent?: (event: string) => void
  // Display output (sendDisplayEvent), the local-transcriber restart (restartTranscriber),
  // and the mic control plane (setMicRequirements) moved into island — the runtime calls
  // BluetoothSdk directly (LocalDisplayManager / LocalSttFallbackCoordinator /
  // MicStateCoordinator) — no longer host hooks.
  // Photo capture + video recording + camera FOV moved into island (PhonePhotoCoordinator
  // / PhoneVideoCoordinator + a direct BluetoothSdk.setCameraFov call) — no longer host hooks.
  /** Inter-miniapp interop (session.miniapps + session.actions.invoke). */
  interop?: InteropAdapter
}

let hooks: RuntimeHooks = {}

export function configureRuntime(next: RuntimeHooks): void {
  hooks = {...hooks, ...next}
}

export function getRuntimeHooks(): RuntimeHooks {
  return hooks
}
