/**
 * @fileoverview MentraJSRouter — RN-side host that bridges the per-miniapp
 * JS contexts (iOS-JSC and Android-QuickJS via Zipline) into the existing
 * {@link LocalMiniappRuntime} handler set.
 *
 * Rather than re-implement the 33 dispatch arms inline, the router
 * consumes Crust's `mentrajs_message` Expo event and forwards its
 * `__bridge.send(raw)` payloads to {@link LocalMiniappRuntime.handleRawMessage}.
 * The SDK envelope shape (`{type: "DISPLAY", ...}` etc.) is unchanged from
 * the WebView path, so every existing handler runs verbatim. What changes
 * is the *transport*:
 *
 *   - **Inbound** (background JS → host): `__dispatch("__bridge", "send",
 *     [rawJsonString])` → `mentrajs_message` event → router →
 *     `LocalMiniappRuntime.handleRawMessage(packageName, raw)`.
 *   - **Outbound** (host → background JS): every package registered with
 *     the router gets a `sendMessage(raw)` fn that calls
 *     `Crust.mentraJsDispatchToJs(packageName, {kind: "bridge", raw})`.
 *     The polyfill's `__deliver` recognises `kind === "bridge"` and calls
 *     `__mentraDeliverBridgeRaw(raw)`, which routes into the SDK's
 *     {@link DispatchTransport.onMessage} handler.
 *
 * Host-side handler bodies (display fan-out, mic state, transcription,
 * navigation, etc.) live untouched in `LocalMiniappRuntime.ts`.
 *
 * Cloud-message routing (`phone_stream_status`, `phone_managed_stream_status`)
 * goes straight through `LocalMiniappRuntime.handleCloudMessage` — nothing
 * for the router to do; the responses arrive inside an envelope whose
 * `sendMessage` was already registered via the same path here.
 *
 * The router also bridges native error / log / unhandled-rejection
 * events (`iface: "__log"`, `iface: "__error"`) into the standard
 * `console.*` + Sentry breadcrumb pipeline so miniapp telemetry is
 * visible without bringing up a separate sink.
 */

import type {EventSubscription} from "expo-modules-core"

import devServerBridge from "./DevServerBridge"
import type localMiniappRuntime from "./LocalMiniappRuntime"
import type {InstalledMiniappManifest} from "./LocalMiniappRuntime"
import type {MentraJSCrashController} from "./MentraJSCrashController"
import {MentraJSLogRingBuffer, MentraJSLogThrottle, redactSecrets} from "./MentraJSLogPipeline"
import {islandNotifications} from "./NotificationsEmitter"
import type {MentraUIRouter} from "./MentraUIRouter"
import {miniappRunningRegistry} from "./MiniappRunningRegistry"

/** The runtime's runtime instance type — the singleton exported from
 * LocalMiniappRuntime.ts (the file's `export default` is the instance,
 * not the class).
 */
type LocalMiniappRuntime = typeof localMiniappRuntime

/**
 * Minimal subset of the Crust native module the router uses. Keeping the
 * binding loose lets us mock the module in unit tests without bringing
 * the whole Expo module surface along.
 */
export interface MentraJSCrustBinding {
  mentraJsDispatchToJs(packageName: string, envelope: Record<string, unknown>): Promise<void> | void
  mentraJsSetManifest(packageName: string, permissions: string[]): Promise<void> | void
  mentraJsLoadPolyfillBundle?: () => string
  mentraJsSpawn?: (packageName: string, polyfill: string, miniappJs: string) => Promise<boolean> | boolean
  mentraJsKill?: (packageName: string) => Promise<void> | void
  mentraJsAlivePackages?: () => string[]
  addListener: (event: string, handler: (payload: Record<string, unknown>) => void) => EventSubscription
}

export interface OutboundMessagePayload {
  packageName: string
  iface: string
  method: string
  argsJson?: string
  args?: unknown[]
  reqId?: string
  // Implementation-internal: any extra fields the dispatcher attached on
  // .forwardToRn (e.g. payload metadata) are passed through verbatim.
  [extra: string]: unknown
}

export type RouterLogger = {
  log: (message: string, payload?: unknown) => void
  warn: (message: string, payload?: unknown) => void
  error: (message: string, payload?: unknown) => void
}

const defaultLogger: RouterLogger = {
  log: (m, p) => console.log(`[MentraJSRouter] ${m}`, p ?? ""),

  warn: (m, p) => console.warn(`[MentraJSRouter] ${m}`, p ?? ""),

  error: (m, p) => console.error(`[MentraJSRouter] ${m}`, p ?? ""),
}

interface SpawnCache {
  miniappJs: string
  permissions: string[]
  installedManifest?: InstalledMiniappManifest
  hostTrustedSystem: boolean
}

export class MentraJSRouter {
  private subscription: EventSubscription | null = null
  private readonly registered: Set<string> = new Set()
  /** Cached spawn arguments so the crash controller can respawn after a backoff. */
  private readonly spawnCache: Map<string, SpawnCache> = new Map()
  /** Active respawn timers (so unregister() can cancel a pending respawn). */
  private readonly respawnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  /**
   * Optional crash controller. When wired, every `__error` frame from a
   * JSContext drives the state machine; an Outcome with
   * scheduleRespawnAfterMs queues a setTimeout that re-spawns the
   * miniapp's last-known JS source after the backoff delay.
   */
  crashController: MentraJSCrashController | null = null

  /** Hook called when a package transitions to CRASHLOOP_DISABLED. */
  onCrashloop: ((packageName: string, reason: string) => void) | null = null
  /** Hook called on the 2nd-within-window crash (toast UX). */
  onRestartToast: ((packageName: string, reason: string) => void) | null = null

  /**
   * Logging plumbing. Every `__log` frame passes through `redactSecrets`
   * (token/password/etc. scrubbed), then the throttle (100/min sustained
   * per pkg, 500 burst), then lands in the ring buffer + the host
   * logger. The ring buffer holds the last 200 lines/pkg so a crash
   * report can attach "last words" context.
   *
   * Replace with new instances in tests; production code uses the
   * defaults.
   */
  logThrottle: MentraJSLogThrottle = new MentraJSLogThrottle()
  logRing: MentraJSLogRingBuffer = new MentraJSLogRingBuffer()

  /**
   * Optional UI router — when wired, `__bridge.send` envelopes whose
   * inner payload type is `UI_SEND` get routed to the bound WebView
   * instead of through LocalMiniappRuntime. Two-layer miniapps set
   * this; legacy single-bundle WebView miniapps don't and the bridge
   * frames pass through unchanged.
   */
  uiRouter: MentraUIRouter | null = null

  constructor(
    private readonly runtime: LocalMiniappRuntime,
    private readonly crust: MentraJSCrustBinding,
    private readonly logger: RouterLogger = defaultLogger,
  ) {}

  /**
   * Subscribe to Crust's `mentrajs_message` event. Idempotent — calling
   * start() twice attaches a single listener.
   */
  start(): void {
    if (this.subscription) return
    this.subscription = this.crust.addListener("mentrajs_message", (raw) => {
      try {
        this.handleOutbound(raw as unknown as OutboundMessagePayload)
      } catch (e) {
        this.logger.error(`outbound handler threw`, {error: String(e), raw})
      }
    })
    // A background script unregistered for missing liveness pings is dead
    // weight: its subscriptions are gone (so the mic releases) while the
    // webview keeps rendering stale state. Route it through the same
    // respawn machinery as a crash so it comes back automatically, with
    // the crash controller's backoff + crash-loop protection.
    this.runtime.onLivenessTimeout = (packageName) => {
      this.handleCrash(packageName, "liveness: missed pings")
    }
  }

  /**
   * Detach the Crust subscription. The router can be restarted later
   * with start(); registrations survive (the runtime's app map is the
   * source of truth).
   */
  stop(): void {
    this.subscription?.remove()
    this.subscription = null
    this.runtime.onLivenessTimeout = null
  }

  /**
   * Register a JSContext with the runtime so its handlers can fire
   * `sendMessage(raw)` against the right context. The router builds a
   * `sendMessage` that calls `Crust.mentraJsDispatchToJs(packageName,
   * {kind: "bridge", raw})`; the polyfill's `__deliver` then hands the
   * envelope to `DispatchTransport.onMessage` inside the miniapp.
   *
   * Mirrors `MiniappHost.registerRuntime` on the WebView side. Callers
   * (e.g. {@link spawnAndRegister} below, or the host's miniapp launch
   * pipeline) should call this once per spawn.
   */
  registerApp(packageName: string, installedManifest?: InstalledMiniappManifest, hostTrustedSystem = false): void {
    this.runtime.registerApp(
      packageName,
      (raw: string) => {
        this.dispatchBridgeRaw(packageName, raw)
      },
      installedManifest,
      hostTrustedSystem,
    )
    this.registered.add(packageName)
    // JSContext is the source-of-truth for "miniapp running". The
    // home tile / tray reads this registry to project the `running`
    // flag — UI WebView open/close is separate.
    miniappRunningRegistry.add(packageName)
  }

  /**
   * Convenience: spawn a JSContext via Crust, register the app, and
   * set its declared permissions. Returns true on successful spawn.
   *
   * The host's miniapp launch path
   * (`mobile/src/services/miniapps/launchLocalMiniapp.ts`) calls this
   * once per JSContext mount.
   */
  async spawnAndRegister(
    packageName: string,
    miniappJs: string,
    options?: {
      permissions?: string[]
      installedManifest?: InstalledMiniappManifest
      hostTrustedSystem?: boolean
    },
  ): Promise<boolean> {
    if (!this.crust.mentraJsSpawn) {
      this.logger.warn("mentraJsSpawn not available — host binding missing native function")
      return false
    }
    const polyfill = this.crust.mentraJsLoadPolyfillBundle?.() ?? ""
    if (!polyfill) {
      this.logger.warn(`no polyfill bundle loaded for ${packageName}; spawn will likely fail`)
    }
    const ok = await this.crust.mentraJsSpawn(packageName, polyfill, miniappJs)
    if (!ok) {
      this.logger.error(`spawn failed for ${packageName}`)
      return false
    }
    // Two distinct permission gates:
    //   1. Native dispatcher (JSContext → native bridge): `mentraJsSetManifest`
    //      checks per-call iface, e.g. __dispatch("mic", "start", ...) requires
    //      MICROPHONE.
    //   2. LocalMiniappRuntime (SUBSCRIBE envelope): `registerApp(...,
    //      installedManifest)` carries the full manifest so SUBSCRIBE's gate
    //      can match stream → permission against declared types.
    if (options?.permissions && options.permissions.length > 0) {
      await this.crust.mentraJsSetManifest(packageName, options.permissions)
    }
    this.registerApp(packageName, options?.installedManifest, options?.hostTrustedSystem ?? false)
    // Cache spawn arguments so the crash controller can respawn the
    // same code after a backoff. permissions + manifest are cached too
    // because the native side resets setManifest on every spawn and
    // LocalMiniappRuntime's installedManifest entry is keyed by
    // connect-time registration.
    this.spawnCache.set(packageName, {
      miniappJs,
      permissions: options?.permissions ?? [],
      installedManifest: options?.installedManifest,
      hostTrustedSystem: options?.hostTrustedSystem ?? false,
    })
    this.crashController?.onSpawn(packageName)

    // Fire the `init` envelope so the polyfill's __deliver handler
    // resolves `__mentraInitCallback(sessionId)`. The SDK's
    // `registerMiniapp(handler)` wires that callback to construct
    // MiniappSession and call the user's handler. Without this
    // dispatch the user's code never runs — `registerMiniapp` just
    // assigns to a global and waits.
    const sessionId = `${packageName}-${Date.now().toString(36)}`
    void this.crust.mentraJsDispatchToJs(packageName, {kind: "init", sessionId})

    return true
  }

  /**
   * Crash-controller integration. Called from the `__error` frame
   * handler. The controller returns an outcome that tells us whether
   * to respawn (with delay) or leave the context dead.
   */
  private handleCrash(packageName: string, reason: string): void {
    // The native context is dead the instant a crash is observed — invalidate
    // its CONNECT handshake NOW so waitForConnect() blocks through the respawn
    // backoff window instead of resolving immediately against the dead context
    // (an action invoked mid-backoff would otherwise be delivered to nothing).
    this.runtime.resetHandshake(packageName)
    const controller = this.crashController
    if (!controller) return
    const cached = this.spawnCache.get(packageName)
    if (!cached) {
      this.logger.warn(`crash for ${packageName} but no cached spawn args — cannot respawn`)
      controller.onCrash(packageName, reason)
      return
    }
    const outcome = controller.onCrash(packageName, reason)
    if (outcome.surfaceCrashloopBanner) {
      this.onCrashloop?.(packageName, reason)
      islandNotifications.emit({kind: "miniapp_crashloop", packageName, reason, timestamp: Date.now()})
      return
    }
    if (outcome.showRestartToast) {
      this.onRestartToast?.(packageName, reason)
    }
    if (outcome.scheduleRespawnAfterMs == null) return
    // Cancel any prior pending respawn before scheduling a new one.
    const existing = this.respawnTimers.get(packageName)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.respawnTimers.delete(packageName)
      void (async () => {
        try {
          await this.crust.mentraJsKill?.(packageName)
        } catch {
          /* native may have already torn down */
        }
        const ok = await this.crust.mentraJsSpawn?.(
          packageName,
          this.crust.mentraJsLoadPolyfillBundle?.() ?? "",
          cached.miniappJs,
        )
        if (!ok) {
          this.logger.error(`crash respawn failed for ${packageName}`)
          return
        }
        if (cached.permissions.length > 0) {
          await this.crust.mentraJsSetManifest(packageName, cached.permissions)
        }
        this.registerApp(packageName, cached.installedManifest, cached.hostTrustedSystem)
        controller.onSpawn(packageName)
        // Re-fire the init envelope so the respawned context's
        // `registerMiniapp` handler runs again.
        const sessionId = `${packageName}-${Date.now().toString(36)}`
        void this.crust.mentraJsDispatchToJs(packageName, {kind: "init", sessionId})
        this.logger.log(`respawned ${packageName} after crash`)
      })()
    }, outcome.scheduleRespawnAfterMs)
    this.respawnTimers.set(packageName, timer)
  }

  private summarizeReason(payload: unknown, method: string): string {
    if (payload && typeof payload === "object" && "message" in (payload as Record<string, unknown>)) {
      return `${method}: ${(payload as {message: string}).message}`
    }
    return method
  }

  /**
   * Tear down a JSContext and unregister from the runtime. Synchronous
   * teardown — the spec drops the 50ms WILL_DISCONNECT grace window
   * because there's no transport handshake to flush in the JSC world.
   */
  async unregister(packageName: string): Promise<void> {
    if (!this.registered.has(packageName)) return
    // Cancel any pending crash-respawn before tearing down — we don't
    // want a stale timer to re-spawn a miniapp the user just disabled.
    const pending = this.respawnTimers.get(packageName)
    if (pending) {
      clearTimeout(pending)
      this.respawnTimers.delete(packageName)
    }
    this.spawnCache.delete(packageName)
    this.crashController?.onKill(packageName)
    this.runtime.unregisterApp(packageName)
    this.registered.delete(packageName)
    // JSContext torn down → miniapp is no longer "running".
    miniappRunningRegistry.remove(packageName)
    if (this.crust.mentraJsKill) {
      try {
        await this.crust.mentraJsKill(packageName)
      } catch (e) {
        this.logger.warn(`mentraJsKill threw for ${packageName}: ${String(e)}`)
      }
    }
  }

  /** List packages the router has registered. */
  registeredPackages(): string[] {
    return Array.from(this.registered)
  }

  /**
   * Validate that a reused background JSContext is still responsive when its
   * WebView comes foreground. The runtime owns the ping/timeout mechanics; the
   * router gates this to registered packages and keeps LocalMiniappView from
   * reaching into runtime internals.
   */
  probeForegroundLiveness(packageName: string, reason = "foreground-open"): void {
    if (!this.registered.has(packageName)) return
    this.runtime.probeForegroundLiveness(packageName, reason)
  }

  // ----------------------------------------------------------------
  // Outbound message handling
  // ----------------------------------------------------------------

  private handleOutbound(msg: OutboundMessagePayload): void {
    const {packageName, iface, method} = msg
    if (!packageName || !iface || !method) {
      this.logger.warn(`bad mentrajs_message — missing fields`, msg)
      return
    }

    // 1) Bridge frames: the SDK's DispatchTransport.send(raw) lands here.
    //    Forward raw envelope into LocalMiniappRuntime.handleRawMessage
    //    so every existing handler arm runs verbatim.
    if (iface === "__bridge" && method === "send") {
      const raw = this.coerceArgsToBridgeRaw(msg)
      if (raw == null) {
        this.logger.warn(`__bridge.send had no raw payload`, msg)
        return
      }
      // If the payload is a UI_SEND envelope, route it to the bound
      // WebView instead of LocalMiniappRuntime.
      // session.ui.send → DispatchTransport.send → here.
      if (this.uiRouter) {
        const innerPayload = this.peekBridgePayloadType(raw)
        if (innerPayload?.type === "UI_SEND") {
          this.uiRouter.routeFromBackground(packageName, innerPayload)
          return
        }
      }
      this.runtime.handleRawMessage(packageName, raw)
      return
    }

    // 2) Log frames — console.* rewired through host. We tag with the
    //    packageName so Sentry breadcrumbs can be filtered downstream.
    //    Pipeline:
    //      raw args → redactSecrets → throttle decision → ring buffer
    //               → host logger (which surfaces to dev console / Sentry)
    if (iface === "__log") {
      const rawArgs = this.tryParseArgs(msg.argsJson)
      const safeArgs = redactSecrets(rawArgs)
      const decision = this.logThrottle.consume(packageName)
      const tag = `[${packageName}]`
      const fn =
        method === "warn"
          ? this.logger.warn
          : method === "error" || method === "fatal"
            ? this.logger.error
            : this.logger.log
      // Emit a synthetic "[throttled N]" line in place of the next
      // would-be-allowed log to summarise drops.
      if (!decision.allowed) {
        if (decision.throttledLine) {
          fn(`${tag} ${decision.throttledLine}`)
          this.logRing.push(packageName, `${decision.throttledLine}`)
        }
        return
      }
      const formatted = `${tag} console.${method}`
      fn(formatted, safeArgs)
      // Stringify into the ring buffer for crash-report attachment.
      let line: string
      try {
        line = `${method}: ${JSON.stringify(safeArgs)}`
      } catch {
        line = `${method}: <unserializable>`
      }
      this.logRing.push(packageName, line)
      // Forward to the `mentra-miniapp dev` sidecar (if one is connected
      // for this package). Source="background" so the CLI tags lines as
      // [MentraJS]. The bridge silently drops when no dev server is up,
      // which makes this safe to call unconditionally in prod.
      const argsForBridge = Array.isArray(safeArgs) ? (safeArgs as unknown[]) : [safeArgs]
      devServerBridge.forwardLog(packageName, method, argsForBridge, Date.now(), "background")
      return
    }

    // 3) Error / unhandled rejection frames — surface as warnings AND
    //    drive the crash state machine when one is attached. The
    //    controller's outcome may schedule a respawn after a backoff;
    //    if it doesn't (CRASHLOOP_DISABLED), we leave the JSContext
    //    dead and let the host surface a "tap to retry" banner.
    if (iface === "__error") {
      const payload = this.tryParseArgs(msg.argsJson)
      this.logger.error(`[${packageName}] ${method}`, payload)
      if (this.crashController) {
        // Only treat "exception" + "unhandledRejection" + "uncaught" as
        // crash signals. `console.error` calls also flow through the
        // log path — those don't end the JSContext.
        const isCrash = method === "exception" || method === "unhandledRejection" || method === "uncaught"
        if (isCrash) {
          this.handleCrash(packageName, this.summarizeReason(payload, method))
        }
      }
      return
    }

    // 4) Anything else is a `forwardToRn` from the dispatcher — a
    //    handler the native dispatcher didn't know about. We don't have
    //    inline handlers for any of these; the runtime's existing path
    //    treats them as legacy WebView envelopes by falling through.
    //    Log so unknown ifaces surface in dev.
    this.logger.log(`unhandled iface=${iface} method=${method} from ${packageName}`)
  }

  /**
   * The wire format for `__bridge.send` is `argsJson = JSON.stringify([raw])`
   * — a single-element array containing the original raw envelope. The
   * dispatcher passes the parsed array through as either:
   *   - `msg.args` when the dispatcher unpacked (Android path that turns
   *     `argsJson` into a List on the way to RN), or
   *   - `msg.argsJson` (iOS path that ships the string verbatim).
   * Cover both shapes here.
   */
  /**
   * Parse a raw bridge envelope just enough to peek at the inner
   * payload's `type` field. Used by the UI_SEND interception path.
   * Returns null if the envelope isn't a valid bridge frame.
   */
  private peekBridgePayloadType(raw: string): {type: string; [k: string]: unknown} | null {
    try {
      const env = JSON.parse(raw) as {payload?: {type?: string}}
      if (env && typeof env.payload === "object" && env.payload && typeof env.payload.type === "string") {
        return env.payload as {type: string; [k: string]: unknown}
      }
    } catch {
      return null
    }
    return null
  }

  private coerceArgsToBridgeRaw(msg: OutboundMessagePayload): string | null {
    if (Array.isArray(msg.args)) {
      const v = msg.args[0]
      return typeof v === "string" ? v : null
    }
    if (typeof msg.argsJson === "string") {
      try {
        const parsed = JSON.parse(msg.argsJson) as unknown
        if (Array.isArray(parsed) && typeof parsed[0] === "string") {
          return parsed[0]
        }
      } catch {
        // fall through
      }
    }
    return null
  }

  private tryParseArgs(argsJson: string | undefined): unknown {
    if (!argsJson) return null
    try {
      return JSON.parse(argsJson)
    } catch {
      return argsJson
    }
  }

  /**
   * Push a `kind="bridge"` envelope into the named JSContext's
   * `globalThis.__deliver`. Used both by the per-app `sendMessage`
   * registered via {@link registerApp} and by ad-hoc callers (e.g.
   * cloud-relayed stream-status responses route through
   * `LocalMiniappRuntime.handleCloudMessage`, which then calls the
   * `app.sendMessage(serialized)` registered above).
   */
  private dispatchBridgeRaw(packageName: string, raw: string): void {
    void this.crust.mentraJsDispatchToJs(packageName, {kind: "bridge", raw})
  }
}
