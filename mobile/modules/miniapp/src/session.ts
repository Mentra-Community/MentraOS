/**
 * @fileoverview MiniappSession — central session object for a local miniapp.
 *
 * Owns the transport, the request/response correlation map, the readiness queue,
 * the PONG auto-reply, the visibility state, and all per-module instances.
 *
 * Lifecycle:
 *   const session = new MiniappSession()
 *   await session.connect()          // sends CONNECT, resolves on CONNECT_ACK
 *   session.display.showTextWall(...)
 *   ...
 *   session.disconnect()
 */

import {EventEmitter} from "eventemitter3"

import {
  makeRequestId,
  MiniappEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from "./envelope"
import {getMentraOSGlobals, MiniappColorScheme} from "./globals"
import {MiniappErrorCode, MiniappRequestType, MiniappResponseType} from "./protocol"
import {createTransport, CreateTransportOptions} from "./transport/auto"
import {Transport} from "./transport/types"
import {CameraModule} from "./modules/camera"
import {DashboardAPI} from "./modules/dashboard"
import {DisplayManager} from "./modules/display"
import {EventManager, type UnsubscribeFn} from "./modules/events"
import {GlassesModule} from "./modules/glasses"
import {ImuModule} from "./modules/imu"
import {InputModule} from "./modules/input"
import {LedModule} from "./modules/led"
import {LocationModule} from "./modules/location"
import {MicModule} from "./modules/mic"
import {PermissionsModule} from "./modules/permissions"
import {PhoneModule} from "./modules/phone"
import {TranscriptionModule} from "./modules/transcription"
import {TranslationModule} from "./modules/translation"
import {SimpleStorage} from "./modules/storage"
import {SpeakerModule} from "./modules/speaker"
import {StreamModule} from "./modules/stream"
import {SystemModule} from "./modules/system"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal snapshot of the currently-connected glasses. Phone-provided. */
export interface GlassesCapabilities {
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
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

type SessionEmitterEvents = {
  ready: () => void
  error: (error: Error) => void
  disconnect: (reason: string) => void
  visibility: (v: MiniappVisibility) => void
  capabilities: (cap: GlassesCapabilities | null) => void
  colorScheme: (scheme: MiniappColorScheme) => void
  permissions: (perms: PermissionRecord) => void
  speakerState: (event: import("./modules/speaker").SpeakerStateEvent) => void
}

export class MiniappSession {
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
  public readonly camera: CameraModule
  public readonly dashboard: DashboardAPI
  public readonly glasses: GlassesModule
  public readonly imu: ImuModule
  public readonly input: InputModule
  public readonly led: LedModule
  public readonly location: LocationModule
  public readonly mic: MicModule
  public readonly permissions: PermissionsModule
  public readonly phone: PhoneModule
  public readonly storage: SimpleStorage
  public readonly stream: StreamModule
  public readonly system: SystemModule
  public readonly transcription: TranscriptionModule
  public readonly translation: TranslationModule

  /** Phone-declared glasses capabilities. Null until CONNECT_ACK arrives. */
  public capabilities: GlassesCapabilities | null = null
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

    this.events = new EventManager(this)
    this.speaker = new SpeakerModule(this)
    this.camera = new CameraModule(this)
    this.dashboard = new DashboardAPI(this)
    this.display = new DisplayManager(this)
    this.glasses = new GlassesModule(this)
    this.imu = new ImuModule(this)
    this.input = new InputModule(this)
    this.led = new LedModule(this)
    this.location = new LocationModule(this)
    this.mic = new MicModule(this)
    this.permissions = new PermissionsModule(this)
    this.phone = new PhoneModule(this)
    this.storage = new SimpleStorage(this)
    this.stream = new StreamModule(this)
    this.system = new SystemModule(this)
    this.transcription = new TranscriptionModule(this)
    this.translation = new TranslationModule(this)
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

  /**
   * @internal — subscribe to a raw stream type. Domain modules call this; it
   * delegates to the EventManager registry. Underscore prefix signals "not
   * part of the public SDK surface — use session.mic.onAudioChunk /
   * session.transcription.on(...)
   * etc. instead."
   */
  _subscribe(streamType: string, handler: (data: unknown) => void): UnsubscribeFn {
    return this.events.subscribe(streamType, handler)
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
   */
  sendRequest<TResult = unknown>(payload: object): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(new NotConnectedError())
    }
    const requestId = makeRequestId()
    const envelope: MiniappEnvelope = {payload, requestId}
    return new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        requestId,
        resolve: resolve as (v: unknown) => void,
        reject,
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
        if (ack.visibility) this.visibility = ack.visibility
        if (ack.colorScheme === "light" || ack.colorScheme === "dark") {
          this.colorScheme = ack.colorScheme
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

      case MiniappResponseType.PERMISSIONS_UPDATE: {
        const next = payload.permissions as PermissionRecord | undefined
        if (next) this.applyPermissions(next)
        return
      }

      case MiniappResponseType.SPEAKER_STATE: {
        const state = payload.state as
          | "idle"
          | "loading"
          | "playing"
          | "stopped"
          | "error"
          | undefined
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
        this.events._forwardEvent(streamType, payload.data)
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
      pending.reject(error)
    }
    this.pendingRequests.clear()
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
