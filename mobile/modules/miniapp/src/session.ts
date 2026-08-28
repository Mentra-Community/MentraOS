/**
 * @fileoverview MiniappSession — central session object for a local miniapp.
 *
 * Owns the transport, the request/response correlation map, the readiness queue,
 * the PONG auto-reply, the visibility state, and all per-module instances.
 *
 * Lifecycle:
 *   const session = new MiniappSession()
 *   await session.connect()          // sends CONNECT, resolves on CONNECT_ACK
 *   session.display.render([...])
 *   ...
 *   session.disconnect()
 */

import {EventEmitter} from "eventemitter3"

import {makeRequestId, MiniappEnvelope, parseEnvelope, serializeEnvelope} from "./envelope"
import {getMentraOSGlobals, MiniappColorScheme} from "./globals"
import {MiniappErrorCode, MiniappRequestType, MiniappResponseType} from "./protocol"
import {createTransport, CreateTransportOptions} from "./transport/auto"
import {Transport} from "./transport/types"
import {CameraModule} from "./modules/camera"
import {AuthModule} from "./modules/auth"
import {CloudModule} from "./modules/cloud"
import {DashboardAPI} from "./modules/dashboard"
import {DisplayManager} from "./modules/display"
import {EventManager, type TranscriptionEventRoute, type UnsubscribeFn} from "./modules/events"
import {GlassesModule} from "./modules/glasses"
import {HeadingModule} from "./modules/heading"
import {ImuModule} from "./modules/imu"
import {InputModule} from "./modules/input"
import {LedModule} from "./modules/led"
import {LocationModule} from "./modules/location"
import {MicModule} from "./modules/mic"
import {NavigationModule} from "./modules/navigation"
import {PermissionsModule} from "./modules/permissions"
import {PhoneModule} from "./modules/phone"
import {TranscriptionModule} from "./modules/transcription"
import {TranslationModule} from "./modules/translation"
import {UIModuleImpl, type UIModule} from "./modules/ui"
import {SimpleStorage} from "./modules/storage"
import {SpeakerModule} from "./modules/speaker"
import {StreamModule} from "./modules/stream"
import {SystemModule} from "./modules/system"
import {MiniappsModule} from "./modules/miniapps"
import {ActionsModule} from "./modules/actions"
import {BlobModule} from "./modules/blob"
import {MeetingModule} from "./modules/meeting"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Typed display capabilities for the scene API. All limit fields are optional
 * in the type because older hosts don't send them — treat absence as "unknown",
 * not zero. Populated on the "ready" event (null in `start()`).
 */
export interface DisplayCapabilities {
  /** Public drawable canvas in px — raw coordinate space for `display.render()` boxes. */
  width?: number
  height?: number
  /** False ⇒ the device can't position elements; scenes degrade to text walls host-side. */
  canPosition?: boolean
  /** Element budgets. Rects share the text pool on container-based devices. */
  maxTextElements?: number
  maxImageElements?: number
  /** Per-image dimension cap (box-level), when the device has one. */
  maxImagePx?: {width: number; height: number}
  shapes?: string[]
  intensityLevels?: number
  partialUpdate?: boolean
  /** Legacy capability fields (resolution, isColor, maxTextLines, …) ride along. */
  [key: string]: unknown
}

/** Minimal snapshot of the currently-connected glasses. Phone-provided. */
export interface GlassesCapabilities {
  /** Display block — null/absent on displayless devices (e.g. Mentra Live). */
  display?: DisplayCapabilities | null
  [key: string]: unknown
}

export type MiniappVisibility = "foreground" | "background"

export interface MiniappSessionOptions extends CreateTransportOptions {
  /** Override auto-detected packageName. Normally provided via window.MentraOS. */
  packageName?: string
  /** Override the ready timeout. Default 10s. */
  connectTimeoutMs?: number
}

export interface ConnectAckPayload {
  type: MiniappResponseType.CONNECT_ACK
  userId: string
  packageName: string
  capabilities: GlassesCapabilities | null
  visibility?: MiniappVisibility
  colorScheme?: MiniappColorScheme
  /**
   * Manifest-declared permission record. Mirrors cloud SDK v3's PermissionRecord:
   * `{location, microphone, camera, notifications, calendar}` — booleans
   * indicating whether the miniapp's manifest declared each. This is
   * declaration-only; OS-grant state is not modeled.
   */
  permissions?: PermissionRecord
  /** Miniapp-scoped backend auth. Never a Core or runtime token. */
  auth?: MiniappAuthState
  /** Host-advertised optional features. Absent on older Mentra Apps. */
  hostFeatures?: HostFeatures
}

export interface HostFeatures {
  /** Host honors `startStream({captureAudio})` for the lifetime of a WHIP session. */
  captureAudio?: boolean
}

export interface MiniappAuthState {
  mentraUserId: string
  oemId?: string
  token: string
  expiresAt: number
}

export interface AuthUpdatePayload {
  type: MiniappResponseType.AUTH_UPDATE
  auth?: MiniappAuthState
}

interface AuthRefreshResult {
  auth?: MiniappAuthState
}

/**
 * Manifest-declared permission record. v3-aligned: lowercase canonical keys.
 * Booleans indicate whether the miniapp declared each in its manifest.json.
 */
export type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar"
export type PermissionRecord = Record<PermissionType, boolean>

const ALL_PERMISSION_TYPES: readonly PermissionType[] = [
  "location",
  "microphone",
  "camera",
  "notifications",
  "calendar",
] as const

export class NotConnectedError extends Error {
  readonly code = MiniappErrorCode.NOT_CONNECTED
  constructor(message = "MiniappSession is not connected") {
    super(message)
    this.name = "NotConnectedError"
  }
}

export interface MiniappRequestError {
  code: string
  message: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingRequest {
  requestId: string
  resolve: (value: unknown) => void
  reject: (error: MiniappRequestError) => void
  /** Timeout handle; cleared when the response (or a transport failure) settles the request. */
  timer?: ReturnType<typeof setTimeout>
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

// Hard ceiling on how long a single bridge request waits for the host's
// REQUEST_RESULT. Without it, a host that never responds (a hung cloud call, a
// GPS fix that never arrives, a native handler that stalls) leaves the request
// promise pending FOREVER — which is what stalled navigation at "Starting…"
// (the controller's `starting` guard never reset because start() never settled).
// 60s is generous: it covers a slow route computation while still guaranteeing
// the promise eventually rejects so callers can roll back / surface an error.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

type SessionEmitterEvents = {
  ready: () => void
  error: (error: Error) => void
  /**
   * Last-chance hook before the transport closes. Fires when the phone
   * sends WILL_DISCONNECT, or when this session calls `disconnect()`
   * locally. Handlers run synchronously and may issue one final
   * `sendOneShot`/`sendRequest` (e.g. `display.render([])`); async work won't complete
   * before the socket closes.
   */
  beforeDisconnect: (reason: string) => void
  disconnect: (reason: string) => void
  visibility: (v: MiniappVisibility) => void
  capabilities: (cap: GlassesCapabilities | null) => void
  colorScheme: (scheme: MiniappColorScheme) => void
  permissions: (perms: PermissionRecord) => void
  speakerState: (event: import("./modules/speaker").SpeakerStateEvent) => void
  meetingState: (event: import("./modules/meeting").MeetingState) => void
  auth: (auth: MiniappAuthState) => void
}

// The default preserves the pre-channel-registry behavior for code that creates
// or accepts a bare MiniappSession. `registerMiniapp<Channels>` supplies the
// concrete mapping for scaffolded miniapps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class MiniappSession<TChannels extends object = any> {
  public readonly auth: AuthModule
  public readonly display: DisplayManager
  /**
   * Internal subscription registry + escape hatch.
   *
   * Domain modules (`session.mic`, `session.input`, etc.) are the canonical
   * surface for typed event subscriptions. `events.subscribe(...)` remains as
   * a forward-compat escape hatch for new event types not yet wrapped on a
   * domain module.
   */
  public readonly events: EventManager
  public readonly speaker: SpeakerModule
  public readonly meeting: MeetingModule
  public readonly camera: CameraModule
  public readonly cloud: CloudModule
  public readonly dashboard: DashboardAPI
  public readonly glasses: GlassesModule
  public readonly heading: HeadingModule
  public readonly imu: ImuModule
  public readonly input: InputModule
  public readonly led: LedModule
  public readonly location: LocationModule
  public readonly mic: MicModule
  public readonly navigation: NavigationModule
  public readonly permissions: PermissionsModule
  public readonly phone: PhoneModule
  public readonly storage: SimpleStorage
  /**
   * Phone-local persistent BINARY storage (`session.blob`) — the binary
   * counterpart to `session.storage`. Files on disk, scoped to this miniapp.
   * Writes/reads are chunked so large payloads (e.g. captured audio fed in via
   * `session.mic.onAudioChunk`) never cross the bridge in one message.
   */
  public readonly blob: BlobModule
  public readonly stream: StreamModule
  public readonly system: SystemModule
  public readonly transcription: TranscriptionModule
  public readonly translation: TranslationModule
  /**
   * UI message bus to the bound WebView (when one is open).
   * Background-only API surface; mirrors the WebView's `mentra` global
   * with inverted buffering policy (background drops when no WebView is
   * bound; the WebView buffers until ready).
   */
  public readonly ui: UIModule<TChannels>
  /**
   * Inter-miniapp lifecycle + discovery (list / start / stop). SYSTEM-only —
   * calls reject with NOT_PERMITTED unless this miniapp is a system app.
   */
  public readonly miniapps: MiniappsModule
  /**
   * Inter-miniapp action layer. `invoke` (SYSTEM-only) calls another miniapp's
   * declared action; `handle` (open to all) exposes one of your own.
   */
  public readonly actions: ActionsModule

  /** Phone-declared glasses capabilities. Null until CONNECT_ACK arrives. */
  public capabilities: GlassesCapabilities | null = null
  /**
   * Host-advertised optional features. Null until CONNECT_ACK. Older Mentra Apps
   * omit this, so miniapps must not assume `captureAudio` is honored.
   */
  public hostFeatures: HostFeatures | null = null
  public userId = ""
  public packageName = ""
  public visibility: MiniappVisibility = "foreground"
  /** Host color scheme. Seeded from window.MentraOS, updated via session events. */
  public colorScheme: MiniappColorScheme = "light"

  /** True after CONNECT_ACK. Observe with waitForReady() or the "ready" event. */
  public ready = false

  private readonly transport: Transport
  private readonly connectTimeoutMs: number
  private readonly emitter = new EventEmitter<SessionEmitterEvents>()
  private authState: MiniappAuthState | null = null
  private readonly authWaiters = new Set<{
    minTtlMs: number
    resolve: (auth: MiniappAuthState) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private authRefreshPromise: Promise<MiniappAuthState | null> | null = null

  /**
   * Outbound queue for anything sent before CONNECT_ACK. Flushed in FIFO order
   * once the phone responds with CONNECT_ACK.
   */
  private readonly outboundQueue: string[] = []
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private connectPromise: Promise<void> | null = null
  private disposed = false

  /** Manifest-declared permission cache. Updated on CONNECT_ACK / PERMISSIONS_UPDATE. */
  private _permissions: PermissionRecord = {
    location: false,
    microphone: false,
    camera: false,
    notifications: false,
    calendar: false,
  }

  constructor(options: MiniappSessionOptions = {}) {
    this.transport = createTransport(options)
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

    const injected = getMentraOSGlobals()
    this.packageName = options.packageName ?? injected.packageName ?? ""
    if (injected.colorScheme === "light" || injected.colorScheme === "dark") {
      this.colorScheme = injected.colorScheme
    }

    this.auth = new AuthModule(this)
    this.events = new EventManager(this)
    this.speaker = new SpeakerModule(this)
    this.meeting = new MeetingModule(this)
    this.camera = new CameraModule(this)
    this.cloud = new CloudModule(this)
    this.dashboard = new DashboardAPI(this)
    this.display = new DisplayManager(this)
    this.glasses = new GlassesModule(this)
    this.heading = new HeadingModule(this)
    this.imu = new ImuModule(this)
    this.input = new InputModule(this)
    this.led = new LedModule(this)
    this.location = new LocationModule(this)
    this.mic = new MicModule(this)
    this.navigation = new NavigationModule(this)
    this.permissions = new PermissionsModule(this)
    this.phone = new PhoneModule(this)
    this.storage = new SimpleStorage(this)
    this.blob = new BlobModule(this)
    this.stream = new StreamModule(this)
    this.system = new SystemModule(this)
    this.transcription = new TranscriptionModule(this)
    this.translation = new TranslationModule(this)
    this.ui = new UIModuleImpl<TChannels>(this)
    this.miniapps = new MiniappsModule(this)
    this.actions = new ActionsModule(this)
  }

  /**
   * @internal — synchronous lookup against the cached manifest-declared
   * permission record from CONNECT_ACK / PERMISSIONS_UPDATE. Domain modules
   * use this to expose their `hasPermission` getters without going to the
   * wire. Returns false until CONNECT_ACK arrives.
   *
   * `manifestKey` is the manifest's UPPER_CASE permission name
   * (MICROPHONE, CAMERA, LOCATION, READ_NOTIFICATIONS, etc.). Maps to v3's
   * lowercase canonical keys internally.
   */
  _hasManifestPermission(manifestKey: string): boolean {
    const canonical = manifestKeyToCanonical(manifestKey)
    if (!canonical) return false
    return this._permissions[canonical] === true
  }

  /**
   * @internal — read the current manifest-declared permission record.
   * Powers session.permissions.getAll(). Returns a fresh shallow copy so
   * callers can't mutate internal state.
   */
  _getPermissions(): PermissionRecord {
    return {...this._permissions}
  }

  /** @internal — current miniapp-scoped backend auth, if the host provided one. */
  _getAuth(): MiniappAuthState | null {
    return this.authState ? {...this.authState} : null
  }

  /**
   * @internal — wait for a scoped miniapp token. Used by session.auth; not part
   * of the public SDK surface because authors should never manage wire events.
   */
  _waitForAuth(minTtlMs: number, timeoutMs = 10_000): Promise<MiniappAuthState> {
    const current = this.authState
    if (current && this.authHasTtl(current, minTtlMs)) {
      return Promise.resolve({...current})
    }

    void this.requestAuthRefresh(minTtlMs)

    return new Promise((resolve, reject) => {
      const waiter = {
        minTtlMs,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.authWaiters.delete(waiter)
          reject(new NotConnectedError("Miniapp auth token is not available"))
        }, timeoutMs),
      }
      this.authWaiters.add(waiter)
    })
  }

  /**
   * @internal — subscribe to a raw stream type. Domain modules call this; it
   * delegates to the EventManager registry. Underscore prefix signals "not
   * part of the public SDK surface — use session.mic.onAudioChunk /
   * session.transcription.on(...)
   * etc. instead."
   */
  _subscribe(
    streamType: string,
    handler: (data: unknown) => void,
    options: {forceLocal?: boolean} = {},
  ): UnsubscribeFn {
    return this.events.subscribe(streamType, handler, options)
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to LocalMiniappRuntime. Idempotent — calling multiple times
   * returns the same Promise.
   */
  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new NotConnectedError("MiniappSession was disposed"))
    }
    if (this.connectPromise) return this.connectPromise

    // Register the readiness listener BEFORE any awaits so that a synchronous
    // CONNECT_ACK delivery in tests (or the phone) can't race the subscription.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error("MiniappSession: CONNECT_ACK timeout")
        this.failAllPending({code: MiniappErrorCode.NOT_CONNECTED, message: err.message})
        this.emitter.emit("error", err)
        reject(err)
      }, this.connectTimeoutMs)

      this.emitter.once("ready", () => {
        clearTimeout(timer)
        resolve()
      })
      this.emitter.once("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    this.connectPromise = (async () => {
      this.transport.onMessage((raw) => this.handleIncoming(raw))
      this.transport.onDisconnect((reason) => this.handleTransportDisconnect(reason))
      await this.transport.open()

      const requestId = makeRequestId()
      const connectPayload = {
        type: MiniappRequestType.CONNECT,
        packageName: this.packageName,
      }
      this.transport.send(serializeEnvelope({payload: connectPayload, requestId}))

      await readyPromise
    })()

    return this.connectPromise
  }

  /** Resolves when `ready` becomes true, or rejects if connect failed. */
  waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return this.connect()
  }

  isConnected(): boolean {
    return this.ready && this.transport.isOpen()
  }

  disconnect(): void {
    if (this.disposed) return
    this.disposed = true
    // Give listeners one synchronous chance to flush final messages
    // (e.g. display.render([])) before we tear down the transport.
    try {
      this.emitter.emit("beforeDisconnect", "disconnect called")
    } catch (err) {
      // A throwing handler must not block teardown.
      console.warn("[MiniappSession] beforeDisconnect handler threw:", err)
    }
    this.failAllPending({code: MiniappErrorCode.REQUEST_ABORTED, message: "Session disconnected"})
    try {
      this.transport.close()
    } catch {
      // ignore
    }
    this.ready = false
    this.emitter.emit("disconnect", "disconnect called")
  }

  // -------------------------------------------------------------------------
  // Outbound traffic — modules call these
  // -------------------------------------------------------------------------

  /** Send a fire-and-forget request that does not need a response. */
  sendOneShot(payload: object): void {
    const envelope: MiniappEnvelope = {payload}
    this.enqueueOrSend(serializeEnvelope(envelope))
  }

  /**
   * Send a request and get a Promise that resolves with the REQUEST_RESULT payload.
   * Rejects with a MiniappRequestError if the phone returns an error result.
   *
   * `opts.timeoutMs` overrides the default request timeout. Pass `0` to disable
   * it entirely for inherently long-running requests whose duration is unbounded
   * (e.g. audio playback that resolves only when the clip finishes) — those still
   * settle via REQUEST_RESULT or `failAllPending` on disconnect, so they can't
   * leak. Most requests should keep the default ceiling.
   */
  sendRequest<TResult = unknown>(payload: object, opts?: {timeoutMs?: number}): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(new NotConnectedError())
    }
    const requestId = makeRequestId()
    const envelope: MiniappEnvelope = {payload, requestId}
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<TResult>((resolve, reject) => {
      // Reject (and drop) the request if the host never sends a REQUEST_RESULT,
      // so the promise can't hang forever. The REQUEST_RESULT / failAllPending
      // paths clear this timer before settling. A non-positive timeout opts out
      // (long-running requests rely on the host result / disconnect to settle).
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const pending = this.pendingRequests.get(requestId)
              if (!pending) return
              this.pendingRequests.delete(requestId)
              pending.reject({
                code: MiniappErrorCode.ACTION_TIMEOUT,
                message: "Request timed out waiting for a response from the host",
              })
            }, timeoutMs)
          : undefined
      this.pendingRequests.set(requestId, {
        requestId,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      this.enqueueOrSend(serializeEnvelope(envelope))
    })
  }

  // -------------------------------------------------------------------------
  // Event emitter — external API
  // -------------------------------------------------------------------------

  on<K extends keyof SessionEmitterEvents>(event: K, handler: SessionEmitterEvents[K]): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void)
    return () => this.emitter.off(event, handler as (...args: unknown[]) => void)
  }

  off<K extends keyof SessionEmitterEvents>(event: K, handler: SessionEmitterEvents[K]): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void)
  }

  /**
   * Last-chance hook before the transport closes. Fires either when the
   * phone notifies the session of an imminent disconnect (~50ms grace
   * window before the socket is torn down) or when this session's
   * `disconnect()` is called locally. Use it to flush final cleanup
   * messages — e.g. `display.render([])` — synchronously. Async work
   * started here will not complete before the socket closes.
   */
  onBeforeDisconnect(handler: (reason: string) => void): () => void {
    return this.on("beforeDisconnect", handler)
  }

  onVisibilityChange(handler: (v: MiniappVisibility) => void): () => void {
    return this.on("visibility", handler)
  }

  onCapabilitiesChange(handler: (cap: GlassesCapabilities | null) => void): () => void {
    return this.on("capabilities", handler)
  }

  onColorSchemeChange(handler: (scheme: MiniappColorScheme) => void): () => void {
    return this.on("colorScheme", handler)
  }

  // -------------------------------------------------------------------------
  // Internal — transport glue
  // -------------------------------------------------------------------------

  private enqueueOrSend(raw: string): void {
    if (this.ready) {
      try {
        this.transport.send(raw)
      } catch (err) {
        // If send fails post-ready, treat as transport error.
        this.emitter.emit("error", err as Error)
      }
      return
    }
    this.outboundQueue.push(raw)
  }

  private flushQueue(): void {
    const queue = this.outboundQueue.splice(0)
    for (const raw of queue) {
      try {
        this.transport.send(raw)
      } catch (err) {
        this.emitter.emit("error", err as Error)
      }
    }
  }

  private handleIncoming(raw: string): void {
    const envelope = parseEnvelope(raw)
    if (!envelope) return

    const payload = envelope.payload as {type?: string} & Record<string, unknown>
    const type = payload?.type

    switch (type) {
      case MiniappResponseType.CONNECT_ACK: {
        const ack = payload as unknown as ConnectAckPayload
        this.userId = ack.userId ?? ""
        if (ack.packageName) this.packageName = ack.packageName
        this.capabilities = ack.capabilities ?? null
        this.hostFeatures = ack.hostFeatures ?? null
        if (ack.visibility) this.visibility = ack.visibility
        if (ack.colorScheme === "light" || ack.colorScheme === "dark") {
          this.colorScheme = ack.colorScheme
        }
        if (ack.auth) {
          this.applyAuth(ack.auth)
          if (!this.userId) this.userId = ack.auth.mentraUserId
        }
        // Populate the manifest-declared permission cache. Older runtimes
        // that don't send `permissions` leave the all-false default in place
        // — `hasPermission` getters will simply return false.
        if (ack.permissions) this.applyPermissions(ack.permissions)
        this.ready = true
        this.flushQueue()
        this.emitter.emit("ready")
        // Don't resolve request correlation here — CONNECT_ACK has no requestId.
        return
      }

      case MiniappResponseType.AUTH_UPDATE: {
        const next = (payload as unknown as AuthUpdatePayload).auth
        if (next) {
          this.applyAuth(next)
          if (!this.userId) this.userId = next.mentraUserId
        }
        return
      }

      case MiniappResponseType.PERMISSIONS_UPDATE: {
        const next = payload.permissions as PermissionRecord | undefined
        if (next) this.applyPermissions(next)
        return
      }

      case MiniappResponseType.SPEAKER_STATE: {
        const state = payload.state as "idle" | "loading" | "playing" | "stopped" | "error" | undefined
        if (!state) return
        const event = {
          state,
          errorCode: payload.errorCode as string | undefined,
          errorMessage: payload.errorMessage as string | undefined,
          durationMs: payload.durationMs as number | undefined,
        }
        this.speaker._applyState(event)
        this.emitter.emit("speakerState", event)
        return
      }

      case MiniappResponseType.MEETING_STATE: {
        const state = payload.state as import("./modules/meeting").MeetingPhase | undefined
        if (!state) return
        const event = {
          state,
          muted: Boolean(payload.muted),
          error: payload.error as string | undefined,
          meetingUrl: payload.meetingUrl as string | undefined,
          provider: payload.provider as import("./modules/meeting").MeetingProvider | undefined,
        }
        this.meeting._applyState(event)
        this.emitter.emit("meetingState", event)
        return
      }

      case MiniappRequestType.PING: {
        // Phone → miniapp keepalive ping. Auto-reply with PONG.
        const pong: object = {type: MiniappResponseType.PONG}
        const env: MiniappEnvelope = {
          payload: pong,
          ...(envelope.requestId ? {requestId: envelope.requestId} : {}),
        }
        try {
          this.transport.send(serializeEnvelope(env))
        } catch {
          // Ignore; next ping will fail too and runtime will unregister.
        }
        return
      }

      case MiniappResponseType.EVENT: {
        const streamType = payload.streamType as string | undefined
        if (!streamType) return
        this.events._forwardEvent(
          streamType,
          payload.data,
          payload.transcriptionRoute as TranscriptionEventRoute | undefined,
        )
        return
      }

      case MiniappResponseType.ACTION_CALL: {
        // Another miniapp invoked one of our declared actions. Route to the
        // registered handler (or buffer briefly for one to register). The SDK
        // replies with an ACTION_RESULT request keyed by callId.
        const callId = payload.callId as string | undefined
        const actionId = payload.actionId as string | undefined
        if (!callId || !actionId) return
        const params = (payload.params as Record<string, unknown> | undefined) ?? {}
        const callerPackageName = (payload.callerPackageName as string | undefined) ?? ""
        this.actions._deliver(callId, actionId, params, {callerPackageName})
        return
      }

      case MiniappResponseType.CAPABILITIES_UPDATE: {
        const cap = (payload.capabilities as GlassesCapabilities | null) ?? null
        this.capabilities = cap
        this.emitter.emit("capabilities", cap)
        return
      }

      case MiniappResponseType.VISIBILITY_CHANGE: {
        const next = payload.visibility as MiniappVisibility | undefined
        if (next === "foreground" || next === "background") {
          this.visibility = next
          this.emitter.emit("visibility", next)
        }
        return
      }

      case MiniappResponseType.COLOR_SCHEME_CHANGE: {
        const next = payload.colorScheme as MiniappColorScheme | undefined
        if (next === "light" || next === "dark") {
          this.colorScheme = next
          this.emitter.emit("colorScheme", next)
        }
        return
      }

      case MiniappResponseType.REQUEST_RESULT: {
        const requestId = envelope.requestId
        if (!requestId) return
        const pending = this.pendingRequests.get(requestId)
        if (!pending) return
        this.pendingRequests.delete(requestId)
        if (pending.timer) clearTimeout(pending.timer)
        if (payload.ok === false) {
          const err = (payload.error as MiniappRequestError | undefined) ?? {
            code: MiniappErrorCode.INTERNAL,
            message: "Unknown error",
          }
          pending.reject(err)
        } else {
          pending.resolve(payload.data ?? null)
        }
        return
      }

      case MiniappResponseType.WILL_DISCONNECT: {
        const reason = (payload.reason as string | undefined) ?? "phone unregistering"
        try {
          this.emitter.emit("beforeDisconnect", reason)
        } catch (err) {
          console.warn("[MiniappSession] beforeDisconnect handler threw:", err)
        }
        return
      }

      case MiniappResponseType.ERROR: {
        const err = new Error((payload.message as string | undefined) ?? "MiniappSession error")
        this.emitter.emit("error", err)
        return
      }

      default:
        // Unknown type — drop silently. Forward-compat.
        return
    }
  }

  private handleTransportDisconnect(reason: string): void {
    this.ready = false
    this.failAllPending({code: MiniappErrorCode.NOT_CONNECTED, message: `Transport disconnected: ${reason}`})
    this.emitter.emit("disconnect", reason)
  }

  private failAllPending(error: MiniappRequestError): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
    // Auth waiters live outside pendingRequests — they're resolved by an
    // AUTH_UPDATE push, not a correlated REQUEST_RESULT — so a transport drop,
    // dispose, or CONNECT_ACK timeout must reject them here too. Otherwise an
    // in-flight session.auth.getToken()/fetch() hangs until its 10s waiter
    // timeout instead of failing fast with the disconnect error.
    for (const waiter of Array.from(this.authWaiters)) {
      clearTimeout(waiter.timer)
      this.authWaiters.delete(waiter)
      waiter.reject(new NotConnectedError(error.message))
    }
  }

  private authHasTtl(auth: MiniappAuthState, minTtlMs: number): boolean {
    return auth.expiresAt - Date.now() > minTtlMs
  }

  private requestAuthRefresh(minTtlMs: number): Promise<MiniappAuthState | null> {
    if (this.authRefreshPromise) return this.authRefreshPromise
    if (!this.ready || !this.transport.isOpen()) return Promise.resolve(null)

    this.authRefreshPromise = this.sendRequest<AuthRefreshResult>({
      type: MiniappRequestType.AUTH_REFRESH,
      minTtlMs,
    })
      .then((result) => {
        const auth = result?.auth
        if (auth) this.applyAuth(auth)
        return auth ?? null
      })
      .catch((err) => {
        console.warn("[MiniappSession] auth refresh failed:", err)
        return null
      })
      .finally(() => {
        this.authRefreshPromise = null
      })

    return this.authRefreshPromise
  }

  private applyAuth(next: MiniappAuthState): void {
    this.authState = {...next}
    for (const waiter of Array.from(this.authWaiters)) {
      if (!this.authHasTtl(next, waiter.minTtlMs)) continue
      clearTimeout(waiter.timer)
      this.authWaiters.delete(waiter)
      waiter.resolve({...next})
    }
    this.emitter.emit("auth", {...next})
  }

  /**
   * Update the cached permission record. Idempotent: emits "permissions"
   * only when the record actually changed. Sanitizes incoming objects to
   * the v3 PermissionType union.
   */
  private applyPermissions(next: Partial<PermissionRecord>): void {
    let changed = false
    const updated: PermissionRecord = {...this._permissions}
    for (const k of ALL_PERMISSION_TYPES) {
      const v = next[k] === true
      if (updated[k] !== v) {
        updated[k] = v
        changed = true
      }
    }
    if (changed) {
      this._permissions = updated
      this.emitter.emit("permissions", {...updated})
    }
  }
}

/**
 * Map a manifest UPPER_CASE permission name to the lowercase canonical key
 * used by `session.permissions`. Returns null for unknown manifest keys.
 *
 * BACKGROUND_LOCATION + POST_NOTIFICATIONS map onto the same canonical keys
 * as their non-suffixed counterparts (location / notifications) since
 * `has()` is "do I have *any* form of this permission declared".
 */
function manifestKeyToCanonical(manifestKey: string): PermissionType | null {
  switch (manifestKey.toUpperCase()) {
    case "MICROPHONE":
      return "microphone"
    case "CAMERA":
      return "camera"
    case "LOCATION":
    case "BACKGROUND_LOCATION":
      return "location"
    case "READ_NOTIFICATIONS":
    case "POST_NOTIFICATIONS":
      return "notifications"
    case "CALENDAR":
      return "calendar"
    default:
      return null
  }
}

/** @internal — for the permissions module's onUpdate plumbing. */
export function _allPermissionTypes(): readonly PermissionType[] {
  return ALL_PERMISSION_TYPES
}
