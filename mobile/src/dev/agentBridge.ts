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
let transcriptTapWired = false

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
  if (transcriptTapWired) return
  transcriptTapWired = true
  // lazyCloudClient().init() is idempotent and returns the island adapter; tapping
  // its onTranscript does not disturb the island runtime's own wiring.
  try {
    const adapter = lazyCloudClient().init()
    adapter.onTranscript((t) => emit("transcript", t))
    adapter.onTranslation((t) => emit("translation", t))
  } catch (err) {
    transcriptTapWired = false
    console.warn(`${LOG_TAG}: transcript tap failed: ${(err as Error)?.message ?? err}`)
  }
}

function wireEventTaps(): void {
  if (eventTapsWired) return
  eventTapsWired = true

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
      lazyNav().getState().push(path, params.params as never)
      return {navigated: path}
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
      // Local island miniapps mount at /applet/local keyed by packageName; the
      // route runs the same launch chain a home-tile tap does.
      const packageName = String(params.packageName ?? "")
      if (!packageName) throw new Error("packageName required")
      lazyNav().getState().push("/applet/local", {packageName})
      return {launched: packageName}
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
  // Candidate hosts for the harness, most-specific first. Some builds cannot
  // introspect their bundle origin at all (no SourceCode module, no expo
  // manifest), so rather than depend on detection we rotate through the
  // standard Android dev-machine aliases until one answers: 10.0.2.2 is the
  // emulator's host loopback; localhost works under `adb reverse`. The
  // reconnect loop tries the next candidate on every retry, so whichever is
  // reachable wins and a wrong guess costs one retry interval.
  const candidates = [...new Set([lazyDevServerHost()(), "10.0.2.2", "localhost"].filter((h): h is string => !!h))]
  console.log(`${LOG_TAG}: starting (harness candidates: ${candidates.join(", ")} port ${BRIDGE_PORT})`)
  connect(candidates, 0)
}
