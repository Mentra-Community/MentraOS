/**
 * Runtime-shared constants and DTOs.
 *
 * The old host-injected runtime adapter surface has moved behind engine-owned
 * services and `engine.configure({auth, config, analytics})`. Keep this file
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
  tenantId?: string
  token: string
  expiresAt: number
}

/**
 * Result of an offline TTS synthesis. The engine's TTSModelManager produces
 * this directly; the type is kept exported for hosts that wrap it.
 */
export interface TtsSynthesisResult {
  audioUrl: string
  cleanup?: () => Promise<void> | void
}

/**
 * Stable settings keys read by engine services. Hosts must wire their own
 * settings store keys to these names. Mobile already uses these strings.
 */
export const ISLAND_SETTINGS_KEYS = {
  localSttFallbackActive: "local_stt_fallback_active",
  defaultWearable: "default_wearable",
  coreToken: "core_token",
  cameraFov: "camera_fov",
} as const

/**
 * Navigation event payloads. Mirror the host's NavigationService types but are
 * duplicated here so the engine module does not import host types.
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

export interface StreamVideoConfig {
  width?: number
  height?: number
  bitrate?: number
  /** WHIP minimum target in bps; omitted leaves it unset. Clamped to the maximum. */
  minBitrateBps?: number
  /** WHIP startup bitrate in bps, clamped to the requested bounds. */
  initialBitrateBps?: number
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

/** One audited inter-miniapp call. */
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

