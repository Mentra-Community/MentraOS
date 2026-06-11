/**
 * @fileoverview Agent bridge: programmatic control of the app for dev tooling.
 *
 * Driving this app through the screen (uiautomator dumps, coordinate taps,
 * screenshots) costs 30-90s per interaction and fails constantly — stale
 * bounds, reordering grids, console toggles. Everything an agent or test
 * harness actually needs already exists as a programmatic surface inside the
 * app (navigation store, settings store, cloud client, island runtime). This
 * module exposes that surface over a tiny JSON protocol so QA/debugging become
 * sub-second API calls instead of pixel archaeology.
 *
 * Transport: the app dials OUT to a harness server on the dev machine
 * (`ws://<bundle-host>:8787/bridge`) — the same reverse pattern the miniapp
 * dev sidecar uses. The bundle host is derived from where this very bundle
 * was fetched (see devHost.ts), so it is always the machine the dev is
 * actually working from; no listening socket ever opens on the device.
 *
 * SECURITY: dev builds only. The module no-ops unless `__DEV__` is true, so
 * none of this is reachable in a release build, and the outbound-only design
 * means nothing on the device accepts connections.
 *
 * Protocol (JSON text frames):
 *   harness -> app  {id, method, params?}
 *   app  -> harness {id, ok, result?, error?}        (response)
 *   app  -> harness {event, data}                    (unsolicited stream)
 */
// EVERY app-module import here is lazy (require at call time, helpers below).
// This module is started from the root layout; importing the navigation store
// (which imports expo-router's `router`) or other app singletons at root-
// layout module scope runs them BEFORE expo-router initializes and corrupts
// route registration — "/" stops matching and cold boots land on "Unmatched
// Route". Found the hard way; do not add top-level app imports back.
/* eslint-disable @typescript-eslint/no-require-imports */
import type {useCloudClientStatusStore as CloudStatusStore} from "@/stores/cloudClientStatus"
import type {useNavigationStore as NavStore} from "@/stores/navigation"
import type {useSettingsStore as SettingsStoreT} from "@/stores/settings"
import type {cloudClient as CloudClientT, resolvedEndpoints as ResolvedEndpointsT} from "@/services/cloudClient"
import type mentraAuthT from "@/utils/auth/authClient"

const lazyNav = (): typeof NavStore => require("@/stores/navigation").useNavigationStore
const lazySettings = (): typeof SettingsStoreT => require("@/stores/settings").useSettingsStore
const lazyCloudStatus = (): typeof CloudStatusStore => require("@/stores/cloudClientStatus").useCloudClientStatusStore
const lazyCloudClient = (): typeof CloudClientT => require("@/services/cloudClient").cloudClient
const lazyResolvedEndpoints = (): typeof ResolvedEndpointsT => require("@/services/cloudClient").resolvedEndpoints
const lazyAuth = (): typeof mentraAuthT => require("@/utils/auth/authClient").default
const lazyDevServerHost = (): (() => string | undefined) => require("@/utils/cloudClient/devHost").devServerHost

const LOG_TAG = "agentBridge"
const BRIDGE_PORT = 8787
const RECONNECT_MS = 3_000

type RpcRequest = {id: number; method: string; params?: Record<string, unknown>}

let socket: WebSocket | null = null
let started = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
// The adapter instance we've tapped onTranscript on. cloudClient.reconnect()
// rebuilds the client and returns a NEW adapter, so a once-only guard would
// leave the tap on the dead adapter and the harness would stop seeing
// transcripts after any reconnect (e.g. switching endpoints). Re-tap whenever
// the adapter identity changes.
let tappedAdapter: unknown = null

function send(payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

function emit(event: string, data: unknown): void {
  send({event, data})
}

/**
 * Wire the unsolicited event stream once per app run: transcripts as they
 * arrive from the cloud, cloud connection transitions, and runtime status
 * snapshots. These replace logcat-grepping and screenshots as the way a
 * harness observes "did the caption arrive, via which transport".
 */
let eventTapsWired = false

function wireTranscriptTap(): void {
  // lazyCloudClient().init() is idempotent and returns the CURRENT adapter
  // (a fresh one after a reconnect). Only (re)tap when the adapter changed.
  try {
    const adapter = lazyCloudClient().init()
    if (adapter === tappedAdapter) return
    tappedAdapter = adapter
    adapter.onTranscript((t) => emit("transcript", t))
    adapter.onTranslation((t) => emit("translation", t))
  } catch (err) {
    console.warn(`${LOG_TAG}: transcript tap failed: ${(err as Error)?.message ?? err}`)
  }
}

// Rolling buffer of JS errors the app has thrown/logged since boot. This is the
// primitive that lets a sweep ask "did this screen render clean?" with a query
// instead of a screenshot — the single biggest source of QA friction removed.
interface CapturedError {
  at: number
  source: "globalHandler" | "console.error"
  fatal: boolean
  message: string
}
const errorBuffer: CapturedError[] = []
const ERROR_BUFFER_MAX = 200
let errorCaptureWired = false

function recordError(source: CapturedError["source"], fatal: boolean, message: string): void {
  errorBuffer.push({at: Date.now(), source, fatal, message: message.slice(0, 600)})
  if (errorBuffer.length > ERROR_BUFFER_MAX) errorBuffer.splice(0, errorBuffer.length - ERROR_BUFFER_MAX)
  emit("error", {source, fatal, message: message.slice(0, 300)})
}

function wireErrorCapture(): void {
  if (errorCaptureWired) return
  errorCaptureWired = true

  // RN's global handler catches uncaught errors (the ones that draw the red
  // screen). Chain the existing handler so we observe without changing
  // behavior. ErrorUtils is a RN global.
  const g = globalThis as {ErrorUtils?: {getGlobalHandler?: () => unknown; setGlobalHandler?: (h: unknown) => void}}
  const prior = g.ErrorUtils?.getGlobalHandler?.() as ((e: Error, fatal?: boolean) => void) | undefined
  g.ErrorUtils?.setGlobalHandler?.((err: Error, fatal?: boolean) => {
    recordError("globalHandler", !!fatal, err?.message ? `${err.message}\n${err.stack ?? ""}` : String(err))
    prior?.(err, fatal)
  })

  // Most React render failures surface as console.error (React logs the error
  // boundary trace there) before/without hitting the global handler. Wrap it.
  const priorConsoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      recordError("console.error", false, args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "))
    } catch {
      /* never let capture break logging */
    }
    priorConsoleError(...args)
  }
}

function wireEventTaps(): void {
  if (eventTapsWired) return
  eventTapsWired = true

  wireErrorCapture()

  // The bridge starts at JS boot, BEFORE login. Constructing the cloud client
  // then would spin on a missing auth session, so the transcript tap waits for
  // the host (MantleManager) to have initialized the client — first connection
  // transition is the signal. The store/listener taps are module-level and
  // safe immediately.
  lazyCloudClient().onConnectionChange((connected) => {
    emit("cloudConnection", {connected})
    if (connected) wireTranscriptTap()
  })
  lazyCloudStatus().subscribe((state) =>
    emit("cloudStatus", {status: state.status, audioTransport: state.audioTransport}),
  )
  if (lazyCloudClient().isConnected()) wireTranscriptTap()
}

async function handle(req: RpcRequest): Promise<unknown> {
  const params = req.params ?? {}
  switch (req.method) {
    case "ping":
      return {
        pong: true,
        buildTime: process.env.EXPO_PUBLIC_BUILD_TIME ?? null,
        version: process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? null,
      }

    case "getState": {
      const status = lazyCloudStatus().getState()
      return {
        cloud: {
          connected: lazyCloudClient().isConnected(),
          status: status.status,
          audioTransport: status.audioTransport,
          endpoints: lazyResolvedEndpoints()(),
        },
      }
    }

    case "navigate": {
      const path = String(params.path ?? "")
      if (!path.startsWith("/")) throw new Error("path must start with /")
      const replace = params.replace === true
      const nav = lazyNav().getState()
      if (replace) nav.replaceAll(path, params.params as never)
      else nav.push(path, params.params as never)
      return {navigated: path}
    }

    case "getErrors": {
      // Errors captured since `since` (ms epoch); default = all buffered.
      const since = typeof params.since === "number" ? params.since : 0
      return {errors: errorBuffer.filter((e) => e.at >= since)}
    }

    case "clearErrors":
      errorBuffer.length = 0
      return {ok: true}

    case "currentRoute": {
      // Current pathname for sweep verification (did the app land on the route,
      // or bounce to +not-found?). The imperative accessor lives on the
      // router-store global-state singleton (not the public expo-router entry).
      try {
        const rs = require("expo-router/build/global-state/router-store") as {
          store?: {getRouteInfo?: () => {pathname?: string; segments?: string[]}}
        }
        const info = rs.store?.getRouteInfo?.()
        return {path: info?.pathname ?? null, segments: info?.segments ?? null}
      } catch (err) {
        return {path: null, error: (err as Error)?.message ?? String(err)}
      }
    }

    case "goBack":
      lazyNav().getState().goBack()
      return {ok: true}

    case "goHome":
      lazyNav().getState().replaceAll("/")
      return {ok: true}

    case "getSetting":
      return {value: lazySettings().getState().getSetting(String(params.key))}

    case "setSetting":
      await lazySettings().getState().setSetting(String(params.key), params.value, true)
      return {ok: true}

    case "cloudReconnect":
      lazyCloudClient().reconnect()
      return {ok: true}

    case "setUdpBlocked": {
      // QA: drop outbound UDP to force the client's WS-audio fallback. Lazy
      // require so this module's import graph stays clean.
      const blocked = params.blocked === true
      ;(require("@/utils/cloudClient/RnUdpAdapter") as {setUdpBlocked: (b: boolean) => void}).setUdpBlocked(blocked)
      return {udpBlocked: blocked}
    }

    case "connectRemoteGlasses": {
      // Pair the app with the laptop harness daemon, which holds REAL glasses
      // over BLE — so the emulator app drives physical hardware. Mirrors the
      // "use simulated" pairing flow but with the RemoteHarness SGC driver.
      const sdk = require("@mentra/bluetooth-sdk-internal") as {default: {connectRemoteHarness: () => Promise<void>}}
      await sdk.default.connectRemoteHarness()
      return {connected: "remote-harness"}
    }

    case "glassesText": {
      // Drive the app's own display path (JS -> native module -> SGC driver),
      // proving app->glasses output end-to-end (with RemoteHarness: real lens).
      const sdk = require("@mentra/bluetooth-sdk-internal") as {
        default: {displayText: (text: string, x?: number, y?: number, size?: number) => Promise<void>}
      }
      await sdk.default.displayText(String(params.text ?? "hello"))
      return {displayed: true}
    }

    case "login": {
      // Drive the app's real Supabase password sign-in (same path a human
      // taps through). On success Supabase fires onAuthStateChange, which the
      // AuthContext listens to, so the app advances past the login screen and
      // MantleManager initializes the cloud client on its own. Credentials
      // arrive over the loopback bridge from the harness (which reads them from
      // Doppler) — never embedded in the app.
      const email = String(params.email ?? "")
      const password = String(params.password ?? "")
      if (!email || !password) throw new Error("email and password required")
      const res = await lazyAuth().signInWithPassword({email, password})
      if (res.is_error()) throw new Error(res.error.message)
      return {loggedIn: true, email}
    }

    case "logout": {
      const res = await lazyAuth().signOut()
      if (res.is_error()) throw new Error(res.error.message)
      return {ok: true}
    }

    case "isLoggedIn": {
      const res = await lazyAuth().getSession()
      return {loggedIn: !res.is_error() && !!res.value?.token}
    }

    case "launchMiniapp": {
      const packageName = String(params.packageName ?? "")
      if (!packageName) throw new Error("packageName required")
      // A DEV miniapp (installed via `install-miniapp`) registers under the
      // single DEV_APP_PACKAGE_NAME slot, NOT its real package name — so
      // foregrounding it by real name throws "setForeground — app not found".
      // If this package is a registered dev app, foreground the dev slot the way
      // the dev-URL launch does; otherwise route to the installed-miniapp path.
      const island = require("@mentra/island") as {
        getDevAppRecords: () => Array<{packageName: string}>
        DEV_APP_PACKAGE_NAME: string
        useAppStatusStore: {getState: () => {apps: Array<{packageName: string}>; refresh: () => Promise<void>; setForeground: (p: string) => Promise<void>}}
      }
      const isDev = island.getDevAppRecords().some((r) => r.packageName === packageName)
      if (isDev) {
        await island.useAppStatusStore.getState().refresh()
        await island.useAppStatusStore.getState().setForeground(island.DEV_APP_PACKAGE_NAME)
        return {launched: packageName, via: "dev-slot"}
      }
      const isInstalled = (island.useAppStatusStore.getState().apps ?? []).some((a) => a.packageName === packageName)
      if (isInstalled) {
        lazyNav().getState().push("/applet/local", {packageName})
        return {launched: packageName, via: "applet/local"}
      }
      // Not installed and not a registered dev app. Return a clean RPC error
      // instead of pushing /applet/local, which would call the app's
      // setForeground() and log a red "app not found" console.error.
      throw new Error(`miniapp not available: ${packageName} (for a local dev miniapp, run install-miniapp <url> first)`)
    }

    case "installDevMiniapp": {
      // Load + run a local miniapp from a `mentra-miniapp dev` server URL, the
      // way the dev-URL screen does (fetch manifest, register the dev-app
      // record, foreground it) — but without the text-input + permission-UI
      // dance, which the harness can't drive. Permissions are pre-granted via
      // setup-emulator.sh, so the UI permission gate is skipped here.
      const url = String(params.url ?? "").trim().replace(/\/+$/, "")
      if (!url.startsWith("http")) throw new Error("http(s) url required")
      const island = require("@mentra/island") as {
        decideDevLaunchRoute: (pkg: string, url: string) => Promise<{decision: string; manifest: Record<string, unknown>}>
        registerDevApp: (rec: Record<string, unknown>) => void
        useAppStatusStore: {getState: () => {refresh: () => Promise<void>; setForeground: (pkg: string) => Promise<void>}}
        DEV_APP_PACKAGE_NAME: string
      }
      const res = await island.decideDevLaunchRoute("", url)
      if (res.decision === "offline") throw new Error(`dev server unreachable at ${url}`)
      const manifest = res.manifest
      const port = (() => {
        try {
          const p = Number(new URL(url).port)
          return Number.isFinite(p) && p > 0 ? p + 1 : undefined
        } catch {
          return undefined
        }
      })()
      island.registerDevApp({
        packageName: String(manifest.packageName ?? "com.dev.unknown"),
        name: String(manifest.name ?? "Dev Mini App"),
        iconUrl: `${url}/icon.png`,
        devUrl: url,
        devPort: port,
        permissions: manifest.permissions,
        hardwareRequirements: manifest.hardwareRequirements,
      })
      await island.useAppStatusStore.getState().refresh()
      await island.useAppStatusStore.getState().setForeground(island.DEV_APP_PACKAGE_NAME)
      return {installed: manifest.packageName, name: manifest.name, devPort: port}
    }

    case "setSubscriptions": {
      // Drive the cloud's transcription directly (no miniapp UI needed) — the
      // pipeline test subscribes, injects audio, and asserts the transcript
      // events that stream back through the bridge.
      const subs = params.subs
      if (!Array.isArray(subs)) throw new Error("subs array required")
      const adapter = lazyCloudClient().init()
      wireTranscriptTap()
      await adapter.setSubscriptions(subs as never)
      return {subscribed: subs.length}
    }

    case "injectAudio": {
      // Deterministic audio: the harness sends 16 kHz mono signed-16 PCM
      // (base64); we slice it into 20 ms frames and feed the SAME entry point
      // the mic capture uses (adapter.sendAudioFrame), paced near real time so
      // the STT provider sees a natural stream. Requires the session to have
      // announced codec "pcm" (set cloud_audio_codec=pcm + reconnect first).
      const b64 = String(params.pcmBase64 ?? "")
      if (!b64) throw new Error("pcmBase64 required")
      const binary = globalThis.atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const adapter = lazyCloudClient().init()
      wireTranscriptTap()
      const FRAME_BYTES = 640 // 20 ms @ 16 kHz, 16-bit mono
      const frames: Uint8Array[] = []
      for (let off = 0; off < bytes.length; off += FRAME_BYTES) {
        frames.push(bytes.subarray(off, Math.min(off + FRAME_BYTES, bytes.length)))
      }
      // ~2x real time (10 ms per 20 ms frame): fast tests, still stream-shaped.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      for (const frame of frames) {
        adapter.sendAudioFrame(frame)
        await sleep(10)
      }
      return {framesSent: frames.length, seconds: (frames.length * 20) / 1000}
    }

    default:
      throw new Error(`unknown method: ${req.method}`)
  }
}

function connect(candidates: string[], index: number): void {
  const host = candidates[index % candidates.length]
  const url = `ws://${host}:${BRIDGE_PORT}/bridge`
  try {
    socket = new WebSocket(url)
  } catch {
    scheduleReconnect(candidates, index + 1)
    return
  }

  socket.onopen = () => {
    console.log(`${LOG_TAG}: connected to harness at ${url}`)
    // Heartbeat so the server can reap half-open sockets (a network drop can
    // leave both ends believing the socket is alive); the server closes any
    // bridge socket silent for >15s, which fires our onclose -> rotate.
    const hb = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) emit("hb", null)
      else clearInterval(hb)
    }, 5_000)
    emit("hello", {
      platform: "android",
      buildTime: process.env.EXPO_PUBLIC_BUILD_TIME ?? null,
      version: process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? null,
    })
    wireEventTaps()
  }

  socket.onmessage = (e) => {
    let req: RpcRequest
    try {
      req = JSON.parse(String(e.data))
    } catch {
      return
    }
    if (typeof req?.id !== "number" || typeof req?.method !== "string") return
    handle(req)
      .then((result) => send({id: req.id, ok: true, result}))
      .catch((err) => send({id: req.id, ok: false, error: (err as Error)?.message ?? String(err)}))
  }

  // The harness being down is the normal state (it only runs during agent
  // sessions); retry quietly forever, rotating candidates. onerror precedes
  // onclose, so reconnect is scheduled from onclose alone.
  socket.onerror = () => {}
  socket.onclose = () => scheduleReconnect(candidates, index + 1)
}

function scheduleReconnect(candidates: string[], nextIndex: number): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect(candidates, nextIndex)
  }, RECONNECT_MS)
}

/** Start the bridge. No-op outside dev builds. */
export function startAgentBridge(): void {
  if (!__DEV__ || started) return
  started = true
  // Capture errors from the very first tick so a route that crashes during the
  // initial render is recorded even before the harness has connected. Cheap,
  // side-effect-free, and the buffer is queryable the moment the harness joins.
  wireErrorCapture()
  // Candidate hosts for the harness, most-specific first. Some builds cannot
  // introspect their bundle origin at all (no SourceCode module, no expo
  // manifest), so rather than depend on detection we rotate through the
  // standard Android dev-machine aliases until one answers: 10.0.2.2 is the
  // emulator's host loopback; localhost works under `adb reverse`. The
  // reconnect loop tries the next candidate on every retry, so whichever is
  // reachable wins and a wrong guess costs one retry interval.
  // localhost FIRST: it rides adb-reverse (the adb transport itself), which
  // survives airplane mode / network drops on both emulators and USB phones —
  // exactly when a fault-injection scenario most needs the bridge alive.
  // 10.0.2.2 (emulator NAT) and the detected bundle host die with the network.
  const candidates = [...new Set(["localhost", "10.0.2.2", lazyDevServerHost()()].filter((h): h is string => !!h))]
  console.log(`${LOG_TAG}: starting (harness candidates: ${candidates.join(", ")} port ${BRIDGE_PORT})`)
  connect(candidates, 0)
}
