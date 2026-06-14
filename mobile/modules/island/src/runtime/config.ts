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
 * Cloud connection state surface used by LocalSttFallbackCoordinator to
 * decide when on-device STT should take over from cloud transcription.
 * Hosts wrap their own WebSocket-status store.
 */
export interface CloudConnectionAdapter {
  isConnected: () => boolean
  addListener: (l: (connected: boolean) => void) => () => void
}

export interface AudioPlayRequest {
  requestId: string
  audioUrl: string
  appId?: string
  volume?: number
  stopOtherAudio?: boolean
}

export interface AudioPlaybackAdapter {
  /**
   * Play audio for a specific app. Calls onComplete when playback finishes
   * or errors. Returns a promise that resolves once playback is dispatched.
   */
  play: (
    request: AudioPlayRequest,
    onComplete: (requestId: string, success: boolean, error: string | null, duration: number | null) => void,
  ) => Promise<void> | void
  /**
   * Stop playback for an app (e.g. on disconnect / close).
   */
  stopForApp: (packageName: string) => void
}

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

/**
 * Navigation adapter — surface of the host's NavigationService that the
 * runtime needs to wire `navigation_*` streams + request handlers for
 * miniapps.
 */
export interface NavigationAdapter {
  getState: () => "idle" | "navigating" | "rerouting" | "arrived"
  getSnapshot: () => NavTripSnapshot | null
  addListener: (l: (u: NavUpdate) => void) => () => void
  addLocationListener: (l: (loc: NavLocation) => void) => () => void
  addRouteListener: (l: (route: NavRoute) => void) => () => void
  start: (
    coords: {lat: number; lng: number},
    options?: {
      simulate?: boolean
      speedMultiplier?: number
      stops?: Array<{lat: number; lng: number}>
      mode?: string
      avoid?: {highways?: boolean; tolls?: boolean; ferries?: boolean}
      missedTurnRerouteMeters?: number
    },
  ) => Promise<{ok: boolean; error?: string}>
  stop: () => Promise<{ok: boolean; error?: string}>
  simulateDeviation: (offsetMeters?: number) => Promise<{ok: boolean; error?: string}>
  setWrongSidewalkOffset: (enabled: boolean) => Promise<{ok: boolean; error?: string}>
  setSkipCrossings: (enabled: boolean) => Promise<{ok: boolean; error?: string}>
  requestPermission: () => Promise<{ok: boolean; accepted: boolean; error?: string}>
  computeRoute: (payload: Record<string, unknown>) => Promise<{
    ok: boolean
    error?: string
    routes?: Array<{
      points: Array<{lat: number; lng: number}>
      totalDistanceMeters: number
      totalDurationSeconds: number
      summary?: string
      steps?: NavRouteStep[]
    }>
  }>
  /**
   * Reverse-geocode a coordinate into a short road/route name. Used by
   * the SDK pivot engine as a last-resort fallback when the Routes-API
   * step's instruction text didn't yield a clean road name. Optional —
   * hosts that don't implement it leave the SDK without a fallback,
   * and pivots with no parseable instruction stay unlabeled.
   */
  reverseGeocodeRoad?: (coord: {lat: number; lng: number}) => Promise<{
    ok: boolean
    road?: string | null
    error?: string
  }>
}

/**
 * Heading adapter — compass / device heading subscription. The host's
 * HeadingService wraps native sensor output; the runtime only needs the
 * subscribe-and-unsubscribe surface.
 */
export interface HeadingAdapter {
  addListener: (l: (degrees: number) => void) => () => void
}

/**
 * Location-tier control. Used by the runtime to request a higher GPS
 * sample rate while a miniapp is subscribed to `location_update`.
 * Implemented by the host's MantleManager (or equivalent).
 */
export interface LocationTierAdapter {
  setLocationTier: (rate: "off" | "passive" | "low" | "high" | "realtime") => void
}

/**
 * Streaming adapter — owns RTMP/SRT/WHIP publishing on the phone for local
 * miniapps. The runtime calls these from its stream request handlers; the
 * host's PhoneStreamCoordinator implements them.
 */
export interface StreamingAdapter {
  /** Glasses-confirmed publisher start result. */
  startUnmanaged: (
    packageName: string,
    opts: {
      streamUrl: string
      video?: unknown
      audio?: unknown
      sound?: boolean
    },
  ) => Promise<StreamPublisherStartResult>
  startManaged: (
    packageName: string,
    opts: {
      restreamDestinations?: Array<string | {url: string; name?: string}>
      video?: unknown
      audio?: unknown
      sound?: boolean
    },
  ) => Promise<ManagedStreamStartResult>
  stop: (packageName: string, streamId?: string) => Promise<void>
  /**
   * Subscribe to status updates produced by the coordinator (BLE-originated
   * status, Cloudflare poll, lifecycle errors). Called per-(packageName,
   * update) pair so the runtime can fan an EVENT into the right miniapp(s).
   */
  setStatusSubscriber: (
    cb: (
      packageName: string,
      update: {streamId: string; status: string; data?: Record<string, unknown>; source: string},
    ) => void,
  ) => void
}

export interface StreamPublisherStartResult {
  streamId: string
  status: string
  resolvedConfig?: Record<string, unknown>
}

export interface ManagedStreamStartResult extends StreamPublisherStartResult {
  liveInputId: string
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
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

/**
 * Camera settings adapter. Used for local miniapp camera.setFov so the
 * miniapp Promise resolves from the glasses-side hardware-applied ack flow.
 */
export interface CameraSettingsAdapter {
  setFov: (packageName: string, request: CameraFovRequest) => Promise<CameraFovResult>
}

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
  /** Start (and foreground) another miniapp — user-tap semantics. */
  startApp: (packageName: string) => Promise<void>
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
  audioPlayback?: AudioPlaybackAdapter
  /** Returns the connected glasses' status snapshot. */
  glassesStatus?: StoreAccessor<GlassesSnapshot>
  settings?: SettingsAccessor
  /** Google Navigation SDK adapter (turn-by-turn + computeRoute). */
  navigation?: NavigationAdapter
  /** Device heading / compass adapter. */
  heading?: HeadingAdapter
  /** Location-tier escalation (e.g. realtime GPS when a trip is active). */
  locationTier?: LocationTierAdapter
  /** Cloud WebSocket connection state surface. */
  cloudConnection?: CloudConnectionAdapter
  /**
   * Forward processed display events into the host's mirror store. The
   * default no-op skips the mirror — installed-only hosts (no UI mirror)
   * can leave this unset.
   */
  setDisplayEvent?: (event: string) => void
  /**
   * Send a processed display event to the connected glasses through the host's
   * native Bluetooth bridge.
   */
  sendDisplayEvent?: (event: Record<string, unknown>) => Promise<void> | void
  /**
   * Subscribe to host glasses-status changes when the runtime needs live
   * device-model updates. Returns an unsubscribe function.
   */
  subscribeGlassesStatus?: (onChange: (changed: Partial<GlassesSnapshot>) => void) => () => void
  /**
   * Restart the host-managed local transcriber. The runtime only decides when
   * local STT is needed; the host owns the native STT implementation.
   */
  restartTranscriber?: () => Promise<void> | void
  /**
   * Apply the union of cloud and local microphone requirements through the
   * host's native Bluetooth bridge.
   */
  setMicRequirements?: (requirements: MicRequirements) => Promise<void> | void
  /** Phone-orchestrated photo capture (session.camera.takePhoto). */
  photo?: PhotoAdapter
  /** Phone-orchestrated video recording (session.camera.startVideoRecording). */
  videoRecording?: VideoRecordingAdapter
  /** Phone-orchestrated camera settings (session.camera.setFov). */
  cameraSettings?: CameraSettingsAdapter
  /** Phone-orchestrated RTMP/SRT/WHIP publishing. */
  streaming?: StreamingAdapter
  /** Inter-miniapp interop (session.miniapps + session.actions.invoke). */
  interop?: InteropAdapter
}

/**
 * Video recording adapter — start/stop a local video recording on the glasses.
 * The runtime calls these from its handleVideoRecordingStart/Stop handlers; the
 * host's PhoneVideoCoordinator implements them (drives the glasses over BLE via
 * the bluetooth-sdk startVideoRecording/stopVideoRecording). Unlike photo, this
 * returns recording control status only — no uploaded URL is returned.
 */
export interface VideoRecordingAdapter {
  startRecording: (
    packageName: string,
    opts: {
      width?: number
      height?: number
      fps?: number
      sound?: boolean
      save?: boolean
    },
  ) => Promise<{recordingId: string}>
  stopRecording: (packageName: string, recordingId?: string) => Promise<void>
  /**
   * Stop any recordings still owned by an app (e.g. on miniapp disconnect/crash)
   * so the glasses don't keep recording until the max-recording timeout.
   */
  stopForApp?: (packageName: string) => Promise<void>
}

/**
 * Photo adapter — end-to-end takePhoto(). The runtime calls `takePhoto`
 * from its handlePhoto handler; the host's PhonePhotoCoordinator implements
 * it (mints upload token via the v2 cloud route, drives glasses over BLE,
 * long-polls for the download URL).
 */
export interface PhotoAdapter {
  takePhoto: (
    packageName: string,
    opts: {
      size?: "small" | "medium" | "large" | "full"
      compress?: "none" | "low" | "medium" | "high"
      sound?: boolean
      saveToGallery?: boolean
      exposureTimeNs?: number
    },
  ) => Promise<{
    photoUrl: string
    mimeType: string
    size: number
    requestId: string
  }>
}

let hooks: RuntimeHooks = {}

export function configureRuntime(next: RuntimeHooks): void {
  hooks = {...hooks, ...next}
}

export function getRuntimeHooks(): RuntimeHooks {
  return hooks
}
