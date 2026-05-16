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

export interface TtsSynthesisResult {
  audioUrl: string
  cleanup?: () => Promise<void> | void
}

export interface TtsAdapter {
  isAvailable: () => Promise<boolean> | boolean
  synthesize: (params: {
    text: string
    voiceId?: string
    speakerId?: number
    speed?: number
  }) => Promise<TtsSynthesisResult>
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
  localSttFallbackEnabled: "local_stt_fallback_enabled",
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

export interface RuntimeHooks {
  socketComms?: SocketCommsAdapter
  audioPlayback?: AudioPlaybackAdapter
  tts?: TtsAdapter
  /** Returns the connected glasses' status snapshot. */
  glassesStatus?: StoreAccessor<GlassesSnapshot>
  settings?: SettingsAccessor
  /** Google Navigation SDK adapter (turn-by-turn + computeRoute). */
  navigation?: NavigationAdapter
  /** Device heading / compass adapter. */
  heading?: HeadingAdapter
  /** Location-tier escalation (e.g. realtime GPS when a trip is active). */
  locationTier?: LocationTierAdapter
  /**
   * STT model availability check used by LocalSttFallbackCoordinator before
   * starting the on-device transcriber.
   */
  sttModelAvailable?: () => Promise<boolean> | boolean
  /**
   * Forward processed display events into the host's mirror store. The
   * default no-op skips the mirror — installed-only hosts (no UI mirror)
   * can leave this unset.
   */
  setDisplayEvent?: (event: string) => void
  /**
   * Cloud-coordinated photo request. The host posts to its own backend
   * (mobile manager hits /api/client/miniapp-sdk-photo/request) and
   * resolves once the cloud accepts the request. The phone_photo_ready
   * response arrives later via SocketComms → handleCloudMessage.
   */
  requestMiniappSdkPhoto?: (params: {
    requestId: string
    packageName: string
    size?: string
    compress?: string
    saveToGallery?: boolean
    sound?: boolean
  }) => Promise<{accepted: boolean; requestId: string}>
}

let hooks: RuntimeHooks = {}

export function configureRuntime(next: RuntimeHooks): void {
  hooks = {...hooks, ...next}
}

export function getRuntimeHooks(): RuntimeHooks {
  return hooks
}
