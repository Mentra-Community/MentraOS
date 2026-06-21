/**
 * @fileoverview Owns the singleton `@mentra/cloud-client` (CloudClient) for the
 * island runtime and exposes it as a `CloudRuntimeAdapter`.
 *
 * The island/local-miniapp path talks to the cloud through this client. The
 * island runtime drives the cloud's transcription/translation through the
 * adapter returned by `cloudClient.init()`.
 *
 * The RN transports (native UDP, secure storage) are host-injected once here
 * via `setNativeUdp` / `setSecureStorage` BEFORE the client is constructed.
 */
import {CloudClient, setNativeUdp, setSecureStorage} from "@mentra/cloud-client/react-native"
import type {RuntimeSnapshot} from "@mentra/cloud-client/react-native"
import type {AudioSubscription, TranscriptionData, TranslationData} from "@mentra/cloud-runtime/protocol"
import {
  createCloudUdpSocket,
  type CloudClientStatusSnapshot,
  type CloudRuntimeAdapter,
  type MiniappAuthToken,
} from "@mentra/island"

import mentraAuth from "@/utils/auth/authClient"
import {useCloudClientStatusStore} from "@/stores/cloudClientStatus"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"
import {cloudSecureStore} from "@/utils/cloudClient/MmkvSecureStore"

const LOG_TAG = "cloudClient"

type Lc3FrameSizeBytes = 20 | 40 | 60

// Team-friendly defaults for dev builds. Local Cloud V2 is still one tap away
// via the METRO_AUTO dev-settings preset; it should not be the invisible
// default because it depends on a local stack plus adb reverse/LAN reachability.
const DEFAULT_CORE_URL = "https://core.dev.us-west-2.mentraglass.com"
const DEFAULT_RUNTIME_URL = "https://runtime.dev.us-west-2.mentraglass.com"

const CORE_PORT = 3000
const RUNTIME_PORT = 3001
const LOCAL_AUTH_PORT = 3002

function metroUrl(port: number): string | undefined {
  const host = devServerHost()
  return host ? `http://${host}:${port}` : undefined
}

/**
 * Resolve an endpoint URL. Precedence (the user's in-app choice always wins —
 * that is the point of the rebuild-free Dev Settings switcher):
 *   1. store override — an explicit URL, or the METRO_AUTO sentinel, which
 *      resolves to the CURRENT Metro host so "my laptop" survives the laptop
 *      changing networks;
 *   2. env (EXPO_PUBLIC_CLOUD_*) — for CI/staging builds, never personal IPs;
 *   3. Cloud Dev — the default shared backend for team testing.
 * Read via the settings store's `getState()` accessor (not a hook) so this
 * service stays React-free.
 */
function resolveUrl(settingKey: string, envValue: string | undefined, port: number, defaultUrl: string): string {
  const override = useSettingsStore.getState().getSetting(settingKey)
  if (typeof override === "string" && override.trim().length > 0) {
    const trimmed = override.trim()
    if (trimmed !== METRO_AUTO) return trimmed
    // Sentinel: "my dev laptop", resolved live. If Metro is not detectable
    // (e.g. a release build), fall through to env/default instead of failing.
    const auto = metroUrl(port)
    if (auto) return auto
  }

  const envUrl = envValue?.trim()
  if (envUrl) return envUrl

  return defaultUrl
}

function coreUrl(): string {
  return resolveUrl(
    SETTINGS.cloud_core_url.key,
    process.env.EXPO_PUBLIC_CLOUD_CORE_URL as string | undefined,
    CORE_PORT,
    DEFAULT_CORE_URL,
  )
}

function runtimeUrl(): string {
  return resolveUrl(
    SETTINGS.cloud_runtime_url.key,
    process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL as string | undefined,
    RUNTIME_PORT,
    DEFAULT_RUNTIME_URL,
  )
}

/** The endpoint URLs the client would use right now, every layer applied. */
export function resolvedEndpoints(): {core: string; runtime: string} {
  return {core: coreUrl(), runtime: runtimeUrl()}
}

/**
 * Read the live Supabase access token on demand. `mentraAuth.getSession()`
 * returns the current (auto-refreshed) session, so the client always exchanges
 * a fresh subject token. Never log the token.
 */
async function getSupabaseSubjectToken(): Promise<{token: string; type: "supabase"}> {
  const res = await mentraAuth.getSession()
  if (res.is_error() || !res.value.token) {
    throw new Error("cloudClient: no Supabase session token available")
  }
  return {token: res.value.token, type: "supabase"}
}

let localDevRuntimeToken: {token: string; expiresAtMs: number} | null = null

function shouldUseLocalDevRuntimeToken(endpoints: {runtime: string}): boolean {
  if (!__DEV__) return false
  try {
    const host = new URL(endpoints.runtime).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2"
  } catch {
    return false
  }
}

async function getLocalDevRuntimeToken(opts?: {forceRefresh?: boolean}): Promise<string> {
  const now = Date.now()
  if (!opts?.forceRefresh && localDevRuntimeToken && localDevRuntimeToken.expiresAtMs - now > 60_000) {
    return localDevRuntimeToken.token
  }

  const base = new URL(runtimeUrl())
  base.port = String(LOCAL_AUTH_PORT)
  base.pathname = "/api/dev/runtime-token"
  base.search = new URLSearchParams({userId: "local-phone-user", oemId: "mentra"}).toString()
  const url = base.toString()
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`cloudClient: local dev runtime token failed (${res.status})`)
  }
  const body = (await res.json()) as {access_token?: string; expires_in?: number}
  if (!body.access_token) {
    throw new Error("cloudClient: local dev runtime token response missing access_token")
  }
  localDevRuntimeToken = {
    token: body.access_token,
    expiresAtMs: now + (body.expires_in ?? 300) * 1000,
  }
  return body.access_token
}

/**
 * Holds the singleton client plus the currently-applied audio subscription set.
 * We track the set locally (rather than reading it back off the client) so the
 * audio-capture site can gate sends with a synchronous `hasAudioSubscriptions`.
 */
let client: CloudClient | null = null
let adapter: CloudRuntimeAdapter | null = null
let connected = false
let audioSubscriptions: AudioSubscription[] = []
let transportsReady = false
let runtimeStatusUnsubscribe: (() => void) | null = null
let transcriptUnsubscribe: (() => void) | null = null
let translationUnsubscribe: (() => void) | null = null

const transcriptListeners = new Set<(d: TranscriptionData) => void>()
const translationListeners = new Set<(d: TranslationData) => void>()
const statusListeners = new Set<(snapshot: CloudClientStatusSnapshot) => void>()

function toCloudClientStatusSnapshot(snapshot: RuntimeSnapshot): CloudClientStatusSnapshot {
  return {
    status: snapshot.status,
    audioTransport: snapshot.audioTransport,
  }
}

function currentRuntimeStatus(): CloudClientStatusSnapshot {
  const state = useCloudClientStatusStore.getState()
  return {
    status: state.status,
    audioTransport: state.audioTransport,
  }
}

function setRuntimeStatus(snapshot: RuntimeSnapshot): void {
  useCloudClientStatusStore.getState().setSnapshot(snapshot)
  emitStatus(toCloudClientStatusSnapshot(snapshot))
}

function resetRuntimeStatus(): void {
  useCloudClientStatusStore.getState().reset()
  emitStatus(currentRuntimeStatus())
}

function normalizeExpiresAt(expiresAt: number): number {
  // Core/cloud-client may speak Unix seconds while the miniapp SDK uses
  // JavaScript milliseconds for easy TTL checks.
  return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt
}

function stringifyMeta(meta: unknown): string {
  if (!meta || typeof meta !== "object") return ""
  try {
    return ` ${JSON.stringify(meta)}`
  } catch {
    return ""
  }
}

const cloudLogger = {
  debug: (msg: string, meta?: unknown) => console.log(`${LOG_TAG}: debug: ${msg}${stringifyMeta(meta)}`),
  info: (msg: string, meta?: unknown) => console.log(`${LOG_TAG}: info: ${msg}${stringifyMeta(meta)}`),
  warn: (msg: string, meta?: unknown) => console.warn(`${LOG_TAG}: warn: ${msg}${stringifyMeta(meta)}`),
  error: (msg: string, meta?: unknown) => console.warn(`${LOG_TAG}: error: ${msg}${stringifyMeta(meta)}`),
}

/**
 * Listeners that want to know when the live session connects/disconnects. The
 * Local-miniapp on-device-STT fallback tracks cloud-client liveness (not the
 * v1 WebSocket). Notified on every transition out of `onConnected`/
 * `onDisconnected`.
 */
const connectionListeners = new Set<(connected: boolean) => void>()

function notifyConnectionListeners(next: boolean): void {
  for (const l of connectionListeners) {
    try {
      l(next)
    } catch (err) {
      console.warn(`${LOG_TAG}: connection listener threw: ${(err as Error)?.message ?? err}`)
    }
  }
}

function ensureTransports(): void {
  if (transportsReady) return
  transportsReady = true
  setNativeUdp(() => createCloudUdpSocket())
  setSecureStorage(cloudSecureStore)
}

function lc3FrameSizeBytes(): Lc3FrameSizeBytes {
  const frameSize = useSettingsStore.getState().getSetting(SETTINGS.lc3_frame_size.key)
  return frameSize === 20 || frameSize === 40 || frameSize === 60 ? frameSize : 20
}

function emitTranscript(data: TranscriptionData): void {
  for (const l of transcriptListeners) {
    try {
      l(data)
    } catch (err) {
      console.warn(`${LOG_TAG}: transcript listener threw: ${(err as Error)?.message ?? err}`)
    }
  }
}

function emitTranslation(data: TranslationData): void {
  for (const l of translationListeners) {
    try {
      l(data)
    } catch (err) {
      console.warn(`${LOG_TAG}: translation listener threw: ${(err as Error)?.message ?? err}`)
    }
  }
}

function emitStatus(snapshot: CloudClientStatusSnapshot): void {
  for (const l of statusListeners) {
    try {
      l(snapshot)
    } catch (err) {
      console.warn(`${LOG_TAG}: status listener threw: ${(err as Error)?.message ?? err}`)
    }
  }
}

function clearRuntimeEventSubscriptions(): void {
  runtimeStatusUnsubscribe?.()
  runtimeStatusUnsubscribe = null
  transcriptUnsubscribe?.()
  transcriptUnsubscribe = null
  translationUnsubscribe?.()
  translationUnsubscribe = null
}

function buildAdapter(): CloudRuntimeAdapter {
  return {
    setSubscriptions: async (subs: AudioSubscription[]): Promise<void> => {
      // Cache the desired state unconditionally so it survives a not-yet-
      // connected session and reconnects. Only push to the runtime when the
      // session is actually connected. `c.runtime.setSubscriptions` throws
      // "Cannot set subscriptions before the session is connected" otherwise,
      // and nothing would retry. The `onConnected` handler re-applies the
      // cached set, so subscribe-before-connect self-heals.
      audioSubscriptions = subs
      const c = client
      if (connected && c) {
        await c.runtime.setSubscriptions(subs)
      }
    },
    sendAudioFrame: (frame: Uint8Array): void => {
      client?.runtime.sendAudioFrame(frame)
    },
    onTranscript: (cb: (d: TranscriptionData) => void): (() => void) => {
      transcriptListeners.add(cb)
      return () => {
        transcriptListeners.delete(cb)
      }
    },
    onTranslation: (cb: (d: TranslationData) => void): (() => void) => {
      translationListeners.add(cb)
      return () => {
        translationListeners.delete(cb)
      }
    },
    getStatus: (): CloudClientStatusSnapshot => currentRuntimeStatus(),
    onStatusChanged: (cb: (snapshot: CloudClientStatusSnapshot) => void): (() => void) => {
      statusListeners.add(cb)
      return () => {
        statusListeners.delete(cb)
      }
    },
    tts: {
      speak: (text, options) => {
        if (!client) throw new Error("cloud client not connected")
        return client.runtime.tts.speak(text, options)
      },
    },
    maps: {
      directions: req => {
        if (!client) throw new Error("cloud client not connected")
        return client.runtime.maps.directions(req)
      },
      reverseGeocode: coord => {
        if (!client) throw new Error("cloud client not connected")
        return client.runtime.maps.reverseGeocode(coord)
      },
    },
    hasAudioSubscriptions: (): boolean => audioSubscriptions.length > 0,
    isConnected: (): boolean => connected,
  }
}

/**
 * The island runtime's cloud client. Owns the singleton CloudClient and its
 * connection state, and exposes the runtime adapter the island runtime wires
 * in.
 */
export const cloudClient = {
  async getMiniappAuthToken(packageName: string, opts?: {minTtlMs?: number}): Promise<MiniappAuthToken> {
    if (!client) {
      this.init()
    }
    const c = client
    if (!c) throw new Error("cloud client not initialized")

    const {token, expiresAt} = await c.auth.getMiniappToken(packageName, opts)
    const identity = c.auth.identity
    return {
      mentraUserId: identity.mentraUserId,
      oemId: identity.oemId,
      token,
      expiresAt: normalizeExpiresAt(expiresAt),
    }
  },

  /** Device-side managed photo (cloud-v2): presign now, deliver bytes, await ready. */
  startManagedPhoto(opts: Record<string, unknown> = {}) {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.startManagedPhoto(opts)
  },
  awaitManagedPhotoReady(requestId: string) {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.awaitManagedPhotoReady(requestId)
  },

  /** Managed stream (cloud-v2): provision ingest+playback on the runtime. */
  startManagedStream(opts: Record<string, unknown> = {}) {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.startManagedStream(opts)
  },
  getManagedStreamStatus(streamId: string) {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.getManagedStreamStatus(streamId)
  },
  stopManagedStream(streamId: string) {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.stopManagedStream(streamId)
  },

  /**
   * Construct (once) and connect the CloudClient, returning the runtime adapter
   * the island runtime wires in. Idempotent: repeated calls return the same
   * adapter. The connect is best-effort — a failure is logged and the app keeps
   * running.
   */
  init(): CloudRuntimeAdapter {
    if (adapter && client) return adapter

    ensureTransports()
    if (!adapter) {
      adapter = buildAdapter()
    }

    const endpoints = {core: coreUrl(), runtime: runtimeUrl()}
    console.log(`${LOG_TAG}: endpoints ${JSON.stringify(endpoints)}`)

    const coreAuth = {getSubjectToken: getSupabaseSubjectToken}
    const auth = shouldUseLocalDevRuntimeToken(endpoints)
      ? {core: coreAuth, runtime: {getToken: getLocalDevRuntimeToken}}
      : {core: coreAuth, runtime: {source: "core" as const}}

    client = new CloudClient({
      endpoints,
      // The phone LC3-encodes mic audio (even in phone/simulated mode), so we
      // announce LC3 at 16 kHz with the same frame size the encoder emits.
      audio: {codec: "lc3", sampleRate: 16000, frameSizeBytes: lc3FrameSizeBytes()},
      auth,
      logger: cloudLogger,
    })

    const c = client
    clearRuntimeEventSubscriptions()
    runtimeStatusUnsubscribe = c.runtime.onStatusChanged((status) => {
      if (c !== client) return
      setRuntimeStatus(status)
    })
    transcriptUnsubscribe = c.runtime.onTranscript((data) => {
      if (c !== client) return
      emitTranscript(data)
    })
    translationUnsubscribe = c.runtime.onTranslation((data) => {
      if (c !== client) return
      emitTranslation(data)
    })
    setRuntimeStatus(c.runtime.getStatus())

    c.runtime.onConnected(() => {
      if (c !== client) return
      connected = true
      console.log(`${LOG_TAG}: runtime connected`)
      // Re-apply any subscriptions queued before connect (or dropped across a
      // reconnect). Without this the local miniapp's transcription subscription
      // would never land and the cloud would never power its captions. Best-
      // effort: log on failure, never throw out of the connect handler.
      if (audioSubscriptions.length > 0) {
        c.runtime
          .setSubscriptions(audioSubscriptions)
          .catch((err) =>
            console.warn(`${LOG_TAG}: re-applying queued subscriptions failed: ${(err as Error)?.message ?? err}`),
          )
      }
      notifyConnectionListeners(true)
    })
    c.runtime.onDisconnected((info) => {
      if (c !== client) return
      connected = false
      console.log(`${LOG_TAG}: runtime disconnected (${info.reason})`)
      notifyConnectionListeners(false)
    })
    c.runtime.onError((err) => {
      console.warn(`${LOG_TAG}: runtime error: ${err.code}`)
    })

    // Best-effort connect. Do not crash the app if the dev cloud is unreachable.
    c.runtime
      .connect()
      .then(() => console.log(`${LOG_TAG}: connect() resolved`))
      .catch((err) => console.warn(`${LOG_TAG}: connect() failed: ${err?.message ?? err}`))

    return adapter
  },

  /**
   * Tear down the current client and re-init with freshly-resolved endpoint
   * URLs. Used by the dev "Cloud V2" settings override so a new core/runtime URL
   * takes effect without an app rebuild. The CloudClient exposes its teardown
   * via `runtime.close()` (the top-level client has no `disconnect`/`close`), so
   * we close that, drop the singletons, and call `init()` to rebuild.
   */
  reconnect(): void {
    try {
      client?.runtime.close()
    } catch (err) {
      console.warn(`${LOG_TAG}: reconnect close() failed: ${(err as Error)?.message ?? err}`)
    }
    clearRuntimeEventSubscriptions()

    const wasConnected = connected
    client = null
    localDevRuntimeToken = null
    connected = false
    resetRuntimeStatus()
    // Notify so the local-miniapp STT fallback engages while the client is torn
    // down and before the rebuilt client completes its handshake.
    if (wasConnected) {
      notifyConnectionListeners(false)
    }

    this.init()
  },

  /** Current live-session connection state (handshake completed). */
  isConnected(): boolean {
    return connected
  },

  /**
   * Subscribe to connection-state transitions. Returns an unsubscribe fn. Used
   * by the host to drive the local-miniapp STT fallback off cloud liveness.
   */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    connectionListeners.add(listener)
    return () => {
      connectionListeners.delete(listener)
    }
  },
}
