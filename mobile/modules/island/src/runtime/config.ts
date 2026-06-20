/**
 * Runtime-shared constants and DTOs.
 *
 * The old host-injected runtime adapter surface has moved behind island-owned
 * services and `toolkit.configure({auth, config, analytics})`. Keep this file
 * limited to stable types that are shared across those services.
 */

export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

export interface CloudClientStatusSnapshot {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
}

export interface MiniappAuthToken {
  mentraUserId: string
  oemId?: string
  token: string
  expiresAt: number
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
