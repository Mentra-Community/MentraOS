/**
 * Owns the singleton `@mentra/cloud-client` (CloudClient) for the engine runtime
 * — the keystone move that pulls backend comms INTO engine.
 *
 * engine constructs the client from engine-owned pieces (the native UDP socket,
 * the MMKV secure store, the cloud-status store) plus the two things the host
 * provides through the engine front door: `auth.getSubjectToken` (the one
 * permanent seam — the OEM owns login) and the resolved cloud endpoints
 * (`config.coreUrl/runtimeUrl`, computed host-side from dev/settings). On init it
 * exposes cloud runtime methods directly from this service, so the host no longer
 * injects a cloud adapter — engine owns construction and wiring.
 *
 * The local-miniapp path drives the cloud's transcription/translation through
 * this service.
 */
import {CloudClient, setNativeHttp, setNativeUdp, setSecureStorage} from "@mentra/cloud-client/react-native"
import type {PreinstalledMiniappRegistry, RuntimeSnapshot} from "@mentra/cloud-client/react-native"
import type {SubjectTokenType} from "@mentra/cloud-client"
import {Platform} from "react-native"
import type {AudioSubscription, TranscriptionData, TranslationData} from "@mentra/cloud-protocol"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import CrustModule from "@mentra/crust"
import {getAuth, getConfigValues} from "../runtime/bootstrap"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {type CloudClientStatusSnapshot, type MiniappAuthToken} from "../runtime/config"
import {createCloudUdpSocket} from "../utils/cloudClient/RnUdpAdapter"
import {cloudSecureStore} from "../utils/cloudClient/cloudSecureStore"
import {storage as mmkvStorage} from "../utils/storage"
import {useCloudClientStatusStore} from "../stores/cloudClientStatus"
import {islandNotifications} from "./NotificationsEmitter"
import {BgTimer} from "../utils/timers"
import {logCloudV2TranscriptMetric} from "./CloudTranscriptE2EMetrics"
import {LocalMiniappUserIdentity} from "./LocalMiniappUserIdentity"
import {nativeHttpResponseBody} from "./NativeHttpResponse"

const LOG_TAG = "cloudClient"
type CloudCore = NonNullable<CloudClient["core"]>

// Persistent cloud-disconnect detector: the cloud-client reconnect loop is infinite
// and never surfaces a "giving up" signal, so "persistent failure" = the session has
// been continuously NOT connected for this long. A quick reconnect cancels it; brief
// flaps that recover don't fire. Raised as engine.notifications(connection_failed_persistent).
const CLOUD_PERSISTENT_FAILURE_MS = 60_000
const LOCAL_MINIAPP_USER_ID_KEY = "mentra.localMiniapp.userId"

/** Cancel the pending persistent-failure alarm + re-arm for the next outage. */
function clearPersistentFailureAlarm(): void {
  if (persistentFailureTimer) {
    BgTimer.clearTimeout(persistentFailureTimer)
    persistentFailureTimer = null
  }
  persistentFailureNotified = false
}

type Lc3FrameSizeBytes = 20 | 40 | 60

// Neutral last-ditch fallbacks (reachable under `adb reverse`) for when the host
// passes no endpoints. The host normally resolves the real URLs (dev override /
// Metro host / env) and hands them in via `engine.configure({config})`.
const FALLBACK_CORE_URL = "http://localhost:3000"
const FALLBACK_RUNTIME_URL = "http://localhost:3001"
const LOCAL_AUTH_PORT = 3002

let client: CloudClient | null = null
let connected = false
let persistentFailureTimer: ReturnType<typeof BgTimer.setTimeout> | null = null
let persistentFailureNotified = false
let audioSubscriptions: AudioSubscription[] = []
let transportsReady = false
/** Endpoints to build with — seeded from config, overridable via reconnect(). */
let endpointsOverride: {core: string; runtime: string} | null = null
let runtimeStatusUnsubscribe: (() => void) | null = null
let transcriptUnsubscribe: (() => void) | null = null
let translationUnsubscribe: (() => void) | null = null
let authStateUnsubscribe: (() => void) | null = null
let localDevRuntimeToken: {runtimeUrl: string; token: string; expiresAtMs: number} | null = null
let lc3FrameSizeUnsubscribe: (() => void) | null = null
let coreTokenSyncPromise: Promise<string> | null = null

const localMiniappUserIdentity = new LocalMiniappUserIdentity({
  get(): string | null {
    const result = mmkvStorage.load<string>(LOCAL_MINIAPP_USER_ID_KEY)
    return result.is_ok() ? result.value : null
  },
  set(userId: string): void {
    const result = mmkvStorage.save(LOCAL_MINIAPP_USER_ID_KEY, userId)
    if (result.is_error()) throw result.error
  },
  remove(): void {
    const result = mmkvStorage.remove(LOCAL_MINIAPP_USER_ID_KEY)
    if (result.is_error()) throw result.error
  },
})

const transcriptListeners = new Set<(d: TranscriptionData) => void>()
const translationListeners = new Set<(d: TranslationData) => void>()
const statusListeners = new Set<(snapshot: CloudClientStatusSnapshot) => void>()
const connectionListeners = new Set<(connected: boolean) => void>()

function resolveEndpoints(): {core: string; runtime: string} {
  if (endpointsOverride) return endpointsOverride
  const cfg = getConfigValues()
  return {
    core: cfg.coreUrl?.trim() || FALLBACK_CORE_URL,
    runtime: cfg.runtimeUrl?.trim() || FALLBACK_RUNTIME_URL,
  }
}

function getCoreClient(): CloudCore {
  if (!client) construct()
  const core = client?.core
  if (!core) throw new Error("cloud client core not configured")
  return core
}

function syncCoreAccessTokenToBluetooth(): Promise<string> {
  if (coreTokenSyncPromise) return coreTokenSyncPromise

  coreTokenSyncPromise = syncCoreAccessTokenToBluetoothInternal().finally(() => {
    coreTokenSyncPromise = null
  })
  return coreTokenSyncPromise
}

async function syncCoreAccessTokenToBluetoothInternal(): Promise<string> {
  if (!client) construct()
  const c = client
  if (!c) throw new Error("cloud client not initialized")

  const token = await c.auth.getCoreToken()
  if (c !== client) {
    throw new Error("cloud client changed while syncing core token")
  }
  localMiniappUserIdentity.remember(c.auth.identity.mentraUserId)
  const result = await useSettingsStore.getState().setSetting(SETTINGS.core_token.key, token, false)
  if (result.is_error()) {
    throw result.error
  }

  try {
    await BluetoothSdk.updateBluetoothSettings({[SETTINGS.core_token.key]: token})
  } catch (err) {
    console.warn(`${LOG_TAG}: direct Bluetooth core_token sync failed: ${(err as Error)?.message ?? err}`)
  }

  return token
}

function frameSizeBytes(): Lc3FrameSizeBytes {
  // Read LIVE from the engine settings store (the source of truth) so a
  // reconnect after a glasses swap (G1=20 ↔ G2=40) picks up the new frame size,
  // not the one-time engine.configure({config}) snapshot. Falls back to the
  // config value (set at boot) then 20 when the setting is unset.
  const fromSettings = useSettingsStore.getState().getSetting(SETTINGS.lc3_frame_size.key)
  const size = fromSettings ?? getConfigValues().audioFrameSizeBytes
  return size === 20 || size === 40 || size === 60 ? size : 20
}

async function getSubjectToken(): Promise<{token: string; type: SubjectTokenType}> {
  const a = getAuth()
  if (!a) throw new Error("cloudClient: engine.configure({auth}) not called")
  const r = await a.getSubjectToken()
  // IslandAuth's SubjectTokenType is intentionally open (`string & {}`) so OEMs
  // can use other token kinds; cloud-client's is a closed union. The host's
  // actual value ("supabase") is valid — narrow at this boundary.
  return {token: r.token, type: r.type as SubjectTokenType}
}

function normalizeExpiresAt(expiresAt: number): number {
  return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt
}

function shouldUseLocalDevRuntimeToken(endpoints: {runtime: string}): boolean {
  if (!__DEV__) return false
  try {
    const host = new URL(endpoints.runtime).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2"
  } catch {
    return false
  }
}

async function getLocalDevRuntimeToken(runtimeEndpoint: string, opts?: {forceRefresh?: boolean}): Promise<string> {
  const now = Date.now()
  if (
    !opts?.forceRefresh &&
    localDevRuntimeToken?.runtimeUrl === runtimeEndpoint &&
    localDevRuntimeToken.expiresAtMs - now > 60_000
  ) {
    return localDevRuntimeToken.token
  }

  const base = new URL(runtimeEndpoint)
  base.port = String(LOCAL_AUTH_PORT)
  base.pathname = "/api/dev/runtime-token"
  base.search = new URLSearchParams({userId: "local-phone-user", tenantId: "mentra"}).toString()

  const res = await fetch(base.toString())
  if (!res.ok) {
    throw new Error(`cloudClient: local dev runtime token failed (${res.status})`)
  }
  const body = (await res.json()) as {access_token?: string; expires_in?: number}
  if (!body.access_token) {
    throw new Error("cloudClient: local dev runtime token response missing access_token")
  }
  localDevRuntimeToken = {
    runtimeUrl: runtimeEndpoint,
    token: body.access_token,
    expiresAtMs: now + (body.expires_in ?? 300) * 1000,
  }
  return body.access_token
}

function toCloudClientStatusSnapshot(snapshot: RuntimeSnapshot): CloudClientStatusSnapshot {
  return {status: snapshot.status, audioTransport: snapshot.audioTransport}
}

function currentRuntimeStatus(): CloudClientStatusSnapshot {
  const state = useCloudClientStatusStore.getState()
  return {status: state.status, audioTransport: state.audioTransport}
}

function setRuntimeStatus(snapshot: RuntimeSnapshot): void {
  useCloudClientStatusStore.getState().setSnapshot(snapshot)
  emitStatus(toCloudClientStatusSnapshot(snapshot))
}

function resetRuntimeStatus(): void {
  useCloudClientStatusStore.getState().reset()
  emitStatus(currentRuntimeStatus())
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

function notifyConnectionListeners(next: boolean): void {
  for (const l of connectionListeners) {
    try {
      l(next)
    } catch (err) {
      console.warn(`${LOG_TAG}: connection listener threw: ${(err as Error)?.message ?? err}`)
    }
  }
}

function extractUnsubscribe(sub: unknown): (() => void) | null {
  const candidates: unknown[] = []
  const s = sub as Record<string, unknown> | null | undefined
  if (s && typeof s === "object") {
    candidates.push(s)
    candidates.push((s.value as Record<string, unknown>)?.subscription)
    candidates.push((s.data as Record<string, unknown>)?.subscription)
    candidates.push(s.subscription)
  }
  for (const c of candidates) {
    const unsub = (c as {unsubscribe?: unknown})?.unsubscribe
    if (typeof unsub === "function") return unsub as () => void
  }
  return null
}

function ensureAuthWatch(): void {
  if (authStateUnsubscribe) return
  authStateUnsubscribe = () => {}

  const auth = getAuth()
  if (!auth?.onStateChange) return

  let reconnectPending = false
  try {
    const sub = auth.onStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        localMiniappUserIdentity.forget()
        return
      }
      // A new sign-in may belong to a different account. Force the next
      // storage request to resolve and persist that account's Core identity.
      if (event === "SIGNED_IN") localMiniappUserIdentity.forget()
      if (!session?.token) return
      if (connected || reconnectPending) return

      reconnectPending = true
      console.log(`${LOG_TAG}: auth session available (${event}) while disconnected — reconnecting`)
      try {
        cloudClientService.reconnect()
      } finally {
        setTimeout(() => {
          reconnectPending = false
        }, 0)
      }
    })

    const unsub = extractUnsubscribe(sub)
    if (unsub) authStateUnsubscribe = unsub
  } catch (err) {
    console.warn(`${LOG_TAG}: auth watch subscribe failed: ${(err as Error)?.message ?? err}`)
  }
}

function stopAuthWatch(): void {
  authStateUnsubscribe?.()
  authStateUnsubscribe = null
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

function ensureTransports(): void {
  if (transportsReady) return
  transportsReady = true
  setNativeUdp(() => createCloudUdpSocket())
  setSecureStorage(cloudSecureStore)
  if (Platform.OS !== "android") return
  setNativeHttp(async (input, init) => {
    if (typeof input !== "string" || (init?.body != null && typeof init.body !== "string")) {
      return globalThis.fetch(input, init)
    }
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const result = await CrustModule.nativeHttpRequest(
      init?.method ?? "GET",
      input,
      headers,
      (init?.body as string | undefined) ?? null,
    )
    return new Response(nativeHttpResponseBody(result.status, result.body), {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    })
  })
}

function clearRuntimeEventSubscriptions(): void {
  runtimeStatusUnsubscribe?.()
  runtimeStatusUnsubscribe = null
  transcriptUnsubscribe?.()
  transcriptUnsubscribe = null
  translationUnsubscribe?.()
  translationUnsubscribe = null
}

function startLc3FrameSizeWatcher(): void {
  if (lc3FrameSizeUnsubscribe) return

  let last = frameSizeBytes()
  lc3FrameSizeUnsubscribe = useSettingsStore.subscribe(
    (state) => state.getSetting(SETTINGS.lc3_frame_size.key),
    () => {
      const next = frameSizeBytes()
      if (next === last) return
      last = next
      if (!client) return
      console.log(`${LOG_TAG}: LC3 frame size changed to ${next}; reconnecting runtime`)
      cloudClientService.reconnect()
    },
  )
}

function stopLc3FrameSizeWatcher(): void {
  lc3FrameSizeUnsubscribe?.()
  lc3FrameSizeUnsubscribe = null
}

function construct(): void {
  ensureTransports()

  const endpoints = resolveEndpoints()
  console.log(`${LOG_TAG}: endpoints ${JSON.stringify(endpoints)}`)

  const coreAuth = {getSubjectToken}
  const auth = shouldUseLocalDevRuntimeToken(endpoints)
    ? {
        core: coreAuth,
        runtime: {getToken: (opts?: {forceRefresh?: boolean}) => getLocalDevRuntimeToken(endpoints.runtime, opts)},
      }
    : {core: coreAuth, runtime: {source: "core" as const}}

  client = new CloudClient({
    endpoints,
    // The phone LC3-encodes mic audio (even in phone/simulated mode); announce
    // LC3 at 16 kHz with the frame size the encoder emits.
    audio: {codec: "lc3", sampleRate: 16000, frameSizeBytes: frameSizeBytes()},
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
    logCloudV2TranscriptMetric(data)
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
    // Cloud is up — cancel any pending persistent-failure alarm and re-arm for the
    // next outage.
    clearPersistentFailureAlarm()
    // Re-apply the authoritative subscription set, including the empty set, so
    // a fresh phone launch clears any stale server-side audio subscriptions.
    c.runtime
      .setSubscriptions(audioSubscriptions)
      .catch((err) =>
        console.warn(`${LOG_TAG}: re-applying queued subscriptions failed: ${(err as Error)?.message ?? err}`),
      )
    notifyConnectionListeners(true)
  })
  c.runtime.onDisconnected((info) => {
    if (c !== client) return
    connected = false
    console.log(`${LOG_TAG}: runtime disconnected (${info.reason})`)
    // Arm the persistent-failure alarm once; if we're still down when it fires, raise
    // the notification. A reconnect within the window cancels it (onConnected above).
    if (!persistentFailureTimer && !persistentFailureNotified) {
      persistentFailureTimer = BgTimer.setTimeout(() => {
        persistentFailureTimer = null
        if (connected) return
        persistentFailureNotified = true
        islandNotifications.emit({
          kind: "connection_failed_persistent",
          reason: `Cloud session has been disconnected for over ${Math.round(CLOUD_PERSISTENT_FAILURE_MS / 1000)}s`,
          metadata: {downForMs: CLOUD_PERSISTENT_FAILURE_MS, lastReason: info.reason},
          timestamp: Date.now(),
        })
      }, CLOUD_PERSISTENT_FAILURE_MS)
    }
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

  syncCoreAccessTokenToBluetooth().catch((err) =>
    console.warn(`${LOG_TAG}: initial Bluetooth core_token sync failed: ${(err as Error)?.message ?? err}`),
  )

  startLc3FrameSizeWatcher()
}

/**
 * engine's cloud client. Owns the singleton CloudClient, its connection state,
 * and the runtime-hook wiring.
 */
export const cloudClientService = {
  /**
   * Construct (once) + connect the client. Idempotent. Best-effort connect — a
   * failure is logged and the app keeps running. Requires
   * `engine.configure({auth, config})` first.
   */
  init(): void {
    if (client) return
    ensureAuthWatch()
    construct()
  },

  /**
   * Tear down + rebuild. Pass new endpoints to switch URLs; pass `null` to CLEAR
   * a prior override and fall back to the boot config (so cleared/default cloud
   * URLs don't keep reconnecting to a stale override); omit to keep the current.
   */
  reconnect(endpoints?: {core: string; runtime: string} | null): void {
    if (endpoints !== undefined) endpointsOverride = endpoints
    try {
      client?.runtime.close()
    } catch (err) {
      console.warn(`${LOG_TAG}: reconnect close() failed: ${(err as Error)?.message ?? err}`)
    }
    clearRuntimeEventSubscriptions()
    clearPersistentFailureAlarm()

    const wasConnected = connected
    client = null
    localDevRuntimeToken = null
    connected = false
    resetRuntimeStatus()
    if (wasConnected) notifyConnectionListeners(false)

    construct()
  },

  async getPreinstalledMiniappRegistry(): Promise<PreinstalledMiniappRegistry> {
    if (!client) this.init()
    const c = client
    if (!c?.core) throw new Error("cloud client core is unavailable")
    return c.core.miniapps.getRegistry()
  },

  /**
   * Resolve the stable Core-owned Mentra user id.
   *
   * Storage must use this identity rather than the short-lived Core access
   * token. A previously verified id is restored from MMKV so local miniapps
   * remain available after an offline process restart. On first sign-in,
   * callers join the auth module's single-flight exchange/refresh instead of
   * falling back to an anonymous namespace.
   */
  async resolveMentraUserId(): Promise<string> {
    return localMiniappUserIdentity.resolve(async () => {
      if (!client) this.init()
      const c = client
      if (!c) throw new Error("cloud client not initialized")

      await c.auth.getCoreToken()
      if (c !== client) throw new Error("cloud client changed while resolving user identity")
      return c.auth.identity.mentraUserId
    })
  },

  /** Read the stable Mentra user id after async identity resolution. */
  getMentraUserId(): string {
    const userId = localMiniappUserIdentity.get()
    if (!userId) throw new Error("Mentra user identity is unavailable")
    return userId
  },

  async getMiniappAuthToken(
    packageName: string,
    opts?: {minTtlMs?: number; devAttestation?: string},
  ): Promise<MiniappAuthToken> {
    if (!client) this.init()
    const c = client
    if (!c) throw new Error("cloud client not initialized")

    const {token, expiresAt} = await c.auth.getMiniappToken(packageName, opts)
    const identity = c.auth.identity
    return {
      mentraUserId: identity.mentraUserId,
      tenantId: identity.tenantId,
      token,
      expiresAt: normalizeExpiresAt(expiresAt),
    }
  },

  /** Tear down the client + connection (the engine.stop() lifecycle). */
  stop(): void {
    try {
      client?.runtime.close()
    } catch (err) {
      console.warn(`${LOG_TAG}: stop close() failed: ${(err as Error)?.message ?? err}`)
    }
    stopLc3FrameSizeWatcher()
    stopAuthWatch()
    clearRuntimeEventSubscriptions()
    clearPersistentFailureAlarm()
    const wasConnected = connected
    client = null
    // stop() is part of the logout lifecycle and runs before the host emits
    // SIGNED_OUT. Remove the persisted namespace owner here so a later account
    // can never inherit it. A force-stop/process kill does not call stop(), so
    // the cached id still survives the offline cold-start case.
    localMiniappUserIdentity.forget()
    localDevRuntimeToken = null
    connected = false
    resetRuntimeStatus()
    if (wasConnected) notifyConnectionListeners(false)
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

  /** Current live-session connection state (handshake completed). */
  isConnected(): boolean {
    return connected
  },

  /** Subscribe to connection-state transitions. Returns an unsubscribe fn. */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    connectionListeners.add(listener)
    return () => {
      connectionListeners.delete(listener)
    }
  },

  /** Replace the v2 cloud's audio subscription set for the live session. */
  async setSubscriptions(subs: AudioSubscription[]): Promise<void> {
    // Cache unconditionally so the desired set survives a not-yet-connected
    // session and reconnects; the onConnected handler re-applies the cached set.
    audioSubscriptions = subs
    const c = client
    if (connected && c) {
      await c.runtime.setSubscriptions(subs)
    }
  },

  sendAudioFrame(frame: Uint8Array): void {
    client?.runtime.sendAudioFrame(frame)
  },

  onTranscript(cb: (d: TranscriptionData) => void): () => void {
    transcriptListeners.add(cb)
    return () => {
      transcriptListeners.delete(cb)
    }
  },

  onTranslation(cb: (d: TranslationData) => void): () => void {
    translationListeners.add(cb)
    return () => {
      translationListeners.delete(cb)
    }
  },

  getStatus(): CloudClientStatusSnapshot {
    return currentRuntimeStatus()
  },

  getCoreUrl(): string {
    return resolveEndpoints().core
  },

  syncCoreTokenToBluetooth(): Promise<string> {
    return syncCoreAccessTokenToBluetooth()
  },

  onStatusChanged(cb: (snapshot: CloudClientStatusSnapshot) => void): () => void {
    statusListeners.add(cb)
    return () => {
      statusListeners.delete(cb)
    }
  },

  tts: {
    speak(text: string, options?: Parameters<CloudClient["runtime"]["tts"]["speak"]>[1]) {
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.tts.speak(text, options)
    },
  },

  maps: {
    directions(req: Parameters<CloudClient["runtime"]["maps"]["directions"]>[0]) {
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.directions(req)
    },
    reverseGeocode(coord: Parameters<CloudClient["runtime"]["maps"]["reverseGeocode"]>[0]) {
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.reverseGeocode(coord)
    },
    placeAutocomplete(req: Parameters<CloudClient["runtime"]["maps"]["placeAutocomplete"]>[0]) {
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.placeAutocomplete(req)
    },
    placeDetails(req: Parameters<CloudClient["runtime"]["maps"]["placeDetails"]>[0]) {
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.placeDetails(req)
    },
  },

  core: {
    reports: {
      submit(...args: Parameters<CloudCore["reports"]["submit"]>) {
        return getCoreClient().reports.submit(...args)
      },
      addLogs(...args: Parameters<CloudCore["reports"]["addLogs"]>) {
        return getCoreClient().reports.addLogs(...args)
      },
      addScreenshots(...args: Parameters<CloudCore["reports"]["addScreenshots"]>) {
        return getCoreClient().reports.addScreenshots(...args)
      },
      complete(...args: Parameters<CloudCore["reports"]["complete"]>) {
        return getCoreClient().reports.complete(...args)
      },
    },
    supportProfile: {
      update(...args: Parameters<CloudCore["supportProfile"]["update"]>) {
        return getCoreClient().supportProfile.update(...args)
      },
    },
  },

  hasAudioSubscriptions(): boolean {
    return audioSubscriptions.length > 0
  },
}
