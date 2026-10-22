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
import {
  AuthExpiredError,
  DEFAULT_REFRESH_TOKEN_KEY,
  HttpError,
  SessionChangedError,
  decodeClaims,
} from "@mentra/cloud-client"
import type {RuntimeSnapshot} from "@mentra/cloud-client/react-native"
import type {FleetReportOutcome, SubjectTokenType} from "@mentra/cloud-client"
import {Platform} from "react-native"
import type {
  AudioPosition,
  AudioSubscription,
  FleetDesiredState,
  FleetReport,
  TranscriptionData,
  TranslationData,
} from "@mentra/cloud-protocol"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import CrustModule, {nativeHttpRequest} from "@mentra/crust"
import {getAuth, getConfigValues, isFeatureEnabled} from "../runtime/bootstrap"
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
import {resolveCloudEndpoints} from "./cloudEndpointPolicy"
import type {DesiredStateClient} from "./fleet/assignmentReconciler"
import {sameCoreUrl} from "./fleet/coreUrl"

const LOG_TAG = "cloudClient"
type CloudCore = NonNullable<CloudClient["core"]>

/** Which account on which Core the client speaks for. */
export interface CoreSession {
  /** The Core URL the current client was built with: its requests go there, whatever the resolver says now. */
  coreUrl: string
  /**
   * The Core account the client's token belongs to; while it holds no token (offline), the verified identity kept
   * for the signed-in account; null when neither is known.
   */
  mentraUserId: string | null
}

/** A sign-in, a sign-out, or a rebuilt client. */
export interface CoreSessionChange {
  reason: "signed_in" | "signed_out" | "reconnect"
  /** The Core URL the current client was built with, or null when there is no client with a Core. */
  coreUrl: string | null
  /** Null when signed out, or when the account is not known yet (a sign-in forgets the previous one). */
  mentraUserId: string | null
}

/**
 * What `core.fleet.reportAs` came to: a Fleet answer, `session_changed` (the client no longer speaks for that account
 * on that Core, and nothing was sent), or `unauthorized` (Core refused the credentials, or there were none; the token
 * was force-refreshed once).
 */
export type FleetSendOutcome = FleetReportOutcome | {kind: "session_changed"} | {kind: "unauthorized"}

const SESSION_CHANGED: FleetSendOutcome = {kind: "session_changed"}

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

const LOCAL_AUTH_PORT = 3002

let client: CloudClient | null = null
/** The Core URL `client` was built with (null without a client or without a Core). */
let clientCoreUrl: string | null = null
/** Bumped by `stop()`: work begun for a client before then must not build another after it. */
let clientLifecycle = 0
/** The client whose Core credentials a sign-in is clearing, until the client for the new session is built. */
let replacingCoreSessionOf: CloudClient | null = null
let connected = false
let persistentFailureTimer: ReturnType<typeof BgTimer.setTimeout> | null = null
let persistentFailureNotified = false
let audioSubscriptions: AudioSubscription[] = []
let transportsReady = false
/** Endpoints to build with — seeded from config, overridable via reconnect(). */
let endpointsOverride: {core?: string; runtime: string} | null = null
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
const coreSessionListeners = new Set<(change: CoreSessionChange) => void>()

/** The Core account of the token `c` holds now, or null if it holds none. Reads no network. */
function tokenAccount(c: CloudClient): string | null {
  try {
    return c.auth.identity.mentraUserId || null
  } catch {
    return null
  }
}

/** The Core account a Core access token belongs to (its `sub`), or null if it is not a readable token. */
function accountOfToken(token: string): string | null {
  try {
    const sub = decodeClaims(token).sub
    return typeof sub === "string" && sub ? sub : null
  } catch {
    return null
  }
}

function currentCoreSession(): CoreSession | null {
  const c = client
  if (!c?.core || !clientCoreUrl) return null
  return {coreUrl: clientCoreUrl, mentraUserId: tokenAccount(c) ?? localMiniappUserIdentity.get()}
}

function emitCoreSessionChanged(reason: CoreSessionChange["reason"]): void {
  const session = currentCoreSession()
  const account = session?.mentraUserId ?? null
  const change: CoreSessionChange = {
    reason,
    coreUrl: session?.coreUrl ?? null,
    mentraUserId: reason === "signed_out" ? null : account,
  }
  for (const l of coreSessionListeners) {
    try {
      l(change)
    } catch (err) {
      console.warn(`${LOG_TAG}: core session listener threw: ${(err as Error)?.message ?? err}`)
    }
  }
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof AuthExpiredError || (error instanceof HttpError && error.status === 401)
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error("The Fleet report was aborted")
  error.name = "AbortError"
  return error
}

/** Core refused `c`'s credentials: refresh its token once (a dead session stays dead) and say so. */
async function refreshAfterAuthFailure(c: CloudClient): Promise<FleetSendOutcome> {
  if (c !== client) return SESSION_CHANGED
  try {
    await c.auth.getCoreToken({forceRefresh: true})
  } catch (err) {
    console.warn(`${LOG_TAG}: Fleet token refresh failed: ${(err as Error)?.message ?? err}`)
  }
  return {kind: "unauthorized"}
}

function resolveEndpoints(): {core?: string; runtime: string} {
  return resolveCloudEndpoints(getConfigValues(), endpointsOverride)
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

  // A saved JS token is not a successful native sync. Let callers record a
  // failed synchronization rather than ask glasses to upload with an old token.
  await BluetoothSdk.updateBluetoothSettings({[SETTINGS.core_token.key]: token})

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
  if (!a?.getSubjectToken) throw new Error("cloudClient: Core subject-token auth is not configured")
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

/**
 * A sign-in replaced the host's session while `previous` holds Core credentials exchanged from the session before it,
 * which may be another account's. The client keeps them, and its refresh token is persisted, so a client rebuilt over
 * the same storage would resume them too. Clear them (revoking that Core session, as logout does), and only then
 * build the client that exchanges the new session's subject token. Listeners hear of the sign-in once that client
 * exists. A stop (logout) while the credentials are being cleared leaves everything to the next start.
 */
async function replaceCoreSession(previous: CloudClient): Promise<void> {
  const lifecycle = clientLifecycle
  replacingCoreSessionOf = previous
  try {
    await previous.auth.clearSession()
  } catch (err) {
    // Local credentials are gone either way; Core may keep the old session until it expires.
    console.warn(`${LOG_TAG}: revoking the previous Core session failed: ${(err as Error)?.message ?? err}`)
  } finally {
    if (replacingCoreSessionOf === previous) replacingCoreSessionOf = null
  }
  if (lifecycle !== clientLifecycle || !client) return
  console.log(`${LOG_TAG}: signed in; rebuilding the client for the new session`)
  try {
    cloudClientService.reconnect()
  } finally {
    emitCoreSessionChanged("signed_in")
  }
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
        emitCoreSessionChanged("signed_out")
        return
      }
      // A new sign-in may belong to a different account. Force the next
      // storage request to resolve and persist that account's Core identity.
      if (event === "SIGNED_IN") localMiniappUserIdentity.forget()
      // The client's Core credentials were exchanged from the session this sign-in replaced: rebuild from the new one,
      // whether or not the Runtime is connected. A replacement already under way covers this sign-in too.
      const current = client
      if (event === "SIGNED_IN" && session?.token && current?.core) {
        if (replacingCoreSessionOf !== current) void replaceCoreSession(current)
        return
      }
      try {
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
      } finally {
        // After any rebuild, so listeners see the client the sign-in left behind.
        if (event === "SIGNED_IN") emitCoreSessionChanged("signed_in")
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
    const result = await nativeHttpRequest(
      CrustModule,
      init?.method ?? "GET",
      input,
      headers,
      (init?.body as string | undefined) ?? null,
      init?.signal ?? undefined,
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

  const configuredAuth = getAuth()
  if (!configuredAuth) throw new Error("cloudClient: engine.configure({auth}) not called")
  const coreAuth = configuredAuth.getSubjectToken ? {getSubjectToken} : undefined
  const auth = configuredAuth.getRuntimeToken
    ? {
        ...(coreAuth && endpoints.core ? {core: coreAuth} : {}),
        runtime: {getToken: configuredAuth.getRuntimeToken},
      }
    : shouldUseLocalDevRuntimeToken(endpoints)
      ? {
          ...(coreAuth ? {core: coreAuth} : {}),
          runtime: {getToken: (opts?: {forceRefresh?: boolean}) => getLocalDevRuntimeToken(endpoints.runtime, opts)},
        }
      : coreAuth && endpoints.core
        ? {core: coreAuth, runtime: {source: "core" as const}}
        : null
  if (!auth) throw new Error("cloudClient: no Runtime authentication mode is configured")

  client = new CloudClient({
    endpoints,
    // The phone LC3-encodes mic audio (even in phone/simulated mode); announce
    // LC3 at 16 kHz with the frame size the encoder emits.
    audio: {codec: "lc3", sampleRate: 16000, frameSizeBytes: frameSizeBytes()},
    auth,
    authStorageKey: getConfigValues().cloudAuthStorageKey,
    timers: {
      setTimeout: (callback, delayMs) => BgTimer.setTimeout(callback, delayMs),
      clearTimeout: (handle) => BgTimer.clearTimeout(handle as number),
      setInterval: (callback, intervalMs) => BgTimer.setInterval(callback, intervalMs),
      clearInterval: (handle) => BgTimer.clearInterval(handle as number),
    },
    logger: cloudLogger,
  })
  // Captured with the client: getCoreUrl() re-resolves, and may already name another Core than this client talks to.
  clientCoreUrl = client.core && endpoints.core ? endpoints.core : null

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
    console.log(`${LOG_TAG}: debug: ws-session-debug connected`)
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
    console.log(
      `${LOG_TAG}: debug: ws-session-debug disconnected reason=${
        info.reason
      } willStayDown=${/superseded by newer session/i.test(info.reason)}`,
    )
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

  if (getConfigValues().runtimeRealtimeSession !== false) {
    // Best-effort connect. Do not crash the app if the dev cloud is unreachable.
    c.runtime
      .connect()
      .then(() => console.log(`${LOG_TAG}: connect() resolved`))
      .catch((err) => console.warn(`${LOG_TAG}: connect() failed: ${err?.message ?? err}`))
    startLc3FrameSizeWatcher()
  } else {
    console.log(`${LOG_TAG}: Runtime live session disabled; REST capabilities remain available`)
  }

  if (c.core) {
    syncCoreAccessTokenToBluetooth().catch((err) =>
      console.warn(`${LOG_TAG}: initial Bluetooth core_token sync failed: ${(err as Error)?.message ?? err}`),
    )
  }
}

/**
 * engine's cloud client. Owns the singleton CloudClient, its connection state,
 * and the runtime-hook wiring.
 */
export const cloudClientService = {
  async createTeamsMeeting(options: {subject?: string; durationMinutes?: number}, teamsUserAadToken?: string) {
    if (!client) construct()
    const current = client
    if (!current) throw new Error("Cloud client is unavailable")
    const result = await current.runtime.meetings.createTeamsMeeting(options, teamsUserAadToken)
    if (current !== client) throw new Error("Deployment changed while creating the meeting")
    return result
  },
  async retireTeamsMeeting(meetingRef: string) {
    if (!client) construct()
    const current = client
    if (!current) throw new Error("Cloud client is unavailable")
    await current.runtime.meetings.retireTeamsMeeting(meetingRef)
    if (current !== client) throw new Error("Deployment changed while retiring the meeting")
  },
  async getMeetingCredential(teamsUserAadToken?: string) {
    if (!client) construct()
    const current = client
    if (!current) throw new Error("Cloud client is unavailable")
    const credential = await current.runtime.meetings.getAcsCredential(teamsUserAadToken)
    if (current !== client) throw new Error("Deployment changed while obtaining meeting credentials")
    return credential
  },
  async clearAuthSession(): Promise<void> {
    if (client) {
      await client.auth.clearSession()
      return
    }
    await cloudSecureStore.delete(getConfigValues().cloudAuthStorageKey ?? DEFAULT_REFRESH_TOKEN_KEY)
  },

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
   * a prior override and resume the host resolver or boot config (so cleared/default cloud
   * URLs don't keep reconnecting to a stale override); omit to keep the current.
   */
  reconnect(endpoints?: {core?: string; runtime: string} | null): void {
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
    clientCoreUrl = null
    localDevRuntimeToken = null
    connected = false
    resetRuntimeStatus()
    if (wasConnected) notifyConnectionListeners(false)

    try {
      construct()
    } finally {
      emitCoreSessionChanged("reconnect")
    }
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
      const hostIdentity = getAuth()?.getUserId
      if (hostIdentity) return await hostIdentity()
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
    opts?: {minTtlMs?: number; fresh?: boolean},
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
    clientCoreUrl = null
    clientLifecycle += 1
    replacingCoreSessionOf = null
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
  startManagedPhoto() {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.startManagedPhoto()
  },
  awaitManagedPhotoReady(requestId: string) {
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.awaitManagedPhotoReady(requestId)
  },

  /** Managed stream (cloud-v2): provision ingest+playback on the runtime. */
  startManagedStream(opts: Record<string, unknown> = {}) {
    if (!isFeatureEnabled("managedStreams")) throw new Error("managed streams are disabled by this deployment")
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.startManagedStream(opts)
  },
  getManagedStreamStatus(streamId: string) {
    if (!isFeatureEnabled("managedStreams")) throw new Error("managed streams are disabled by this deployment")
    if (!client) throw new Error("cloud client not connected")
    return client.runtime.getManagedStreamStatus(streamId)
  },
  stopManagedStream(streamId: string) {
    if (!isFeatureEnabled("managedStreams")) throw new Error("managed streams are disabled by this deployment")
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

  getAudioPosition(): AudioPosition | null {
    return client?.runtime.getAudioPosition() ?? null
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
    const core = resolveEndpoints().core
    if (!core) throw new Error("cloud client core is unavailable")
    return core
  },

  hasCore(): boolean {
    return Boolean(client?.core)
  },

  /** Which account on which Core the current client speaks for, without touching the network; null without a Core. */
  getCoreSession(): CoreSession | null {
    return currentCoreSession()
  },

  /**
   * The same, once the client's Core token is current (exchanged or refreshed as needed). When Core refused the
   * credentials, or there are none, it answers with what is known, like `getCoreSession`. When the token cannot be
   * had for any other reason (offline, Core unavailable), it answers with the identity kept for the signed-in account
   * if there is one, and otherwise rejects with that failure: the account is not known yet, which is not the same as
   * there being none.
   */
  async resolveCoreSession(): Promise<CoreSession | null> {
    const c = client
    if (!c?.core) return null
    try {
      await c.auth.getCoreToken()
    } catch (error) {
      const known = currentCoreSession()
      if (!isAuthFailure(error) && !known?.mentraUserId) throw error
      return known
    }
    return currentCoreSession()
  },

  /** Subscribe to sign-ins, sign-outs and rebuilt clients. Returns an unsubscribe fn. */
  onCoreSessionChanged(listener: (change: CoreSessionChange) => void): () => void {
    coreSessionListeners.add(listener)
    return () => {
      coreSessionListeners.delete(listener)
    }
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
      if (!isFeatureEnabled("cloudSpeech")) throw new Error("cloud speech is disabled by this deployment")
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.tts.speak(text, options)
    },
  },

  maps: {
    directions(req: Parameters<CloudClient["runtime"]["maps"]["directions"]>[0]) {
      if (!isFeatureEnabled("navigation")) throw new Error("navigation is disabled by this deployment")
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.directions(req)
    },
    reverseGeocode(coord: Parameters<CloudClient["runtime"]["maps"]["reverseGeocode"]>[0]) {
      if (!isFeatureEnabled("navigation")) throw new Error("navigation is disabled by this deployment")
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.reverseGeocode(coord)
    },
    placeAutocomplete(req: Parameters<CloudClient["runtime"]["maps"]["placeAutocomplete"]>[0]) {
      if (!isFeatureEnabled("navigation")) throw new Error("navigation is disabled by this deployment")
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.placeAutocomplete(req)
    },
    placeDetails(req: Parameters<CloudClient["runtime"]["maps"]["placeDetails"]>[0]) {
      if (!isFeatureEnabled("navigation")) throw new Error("navigation is disabled by this deployment")
      if (!client) throw new Error("cloud client not connected")
      return client.runtime.maps.placeDetails(req)
    },
  },

  core: {
    reports: {
      getLogCollection(...args: Parameters<CloudCore["reports"]["getLogCollection"]>) {
        return getCoreClient().reports.getLogCollection(...args)
      },
      submit(...args: Parameters<CloudCore["reports"]["submit"]>) {
        return getCoreClient().reports.submit(...args)
      },
      updateLogCollection(...args: Parameters<CloudCore["reports"]["updateLogCollection"]>) {
        return getCoreClient().reports.updateLogCollection(...args)
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
    fleet: {
      report(...args: Parameters<CloudCore["fleet"]["report"]>) {
        return getCoreClient().fleet.report(...args)
      },

      /**
       * Sends a Fleet batch as `expected` and only as it. The current client must have been built for the same Core
       * as `expected.coreUrl` (compared the way Fleet partitions compare Core URLs, so another spelling of one Core
       * is that Core), and the Core token it hands out now must belong to `expected.mentraUserId`. That token is
       * then the request's bearer: the account checked is the account of the token sent, with nothing awaited in
       * between. Otherwise nothing is sent and the answer is `session_changed`. Never builds a client.
       *
       * An authentication failure force-refreshes the token once and answers `unauthorized`. Rejects only when
       * `opts.signal` is aborted.
       */
      async reportAs(
        expected: {coreUrl: string; mentraUserId: string},
        batch: FleetReport,
        opts?: {signal?: AbortSignal},
      ): Promise<FleetSendOutcome> {
        const signal = opts?.signal
        const c = client
        if (!c?.core || !clientCoreUrl || !sameCoreUrl(clientCoreUrl, expected.coreUrl)) return SESSION_CHANGED
        let token: string
        try {
          token = await c.auth.getCoreToken()
        } catch (err) {
          if (signal?.aborted) throw abortError(signal)
          if (c !== client) return SESSION_CHANGED
          return isAuthFailure(err) ? refreshAfterAuthFailure(c) : {kind: "unavailable", retryAfterSeconds: null}
        }
        if (signal?.aborted) throw abortError(signal)
        const core = c.core
        if (c !== client || !core || accountOfToken(token) !== expected.mentraUserId) return SESSION_CHANGED
        try {
          return await core.fleet.report(batch, {bearer: token, ...(signal ? {signal} : {})})
        } catch (err) {
          if (!signal?.aborted && isAuthFailure(err)) return refreshAfterAuthFailure(c)
          throw err
        }
      },

      /**
       * The desired state of `expected` and only of it. Refused with `SessionChangedError` unless the current client
       * was built for the same Core (compared like `reportAs`) and holds that account's token; an answer that comes
       * back after the client was rebuilt is dropped the same way. Never builds a client. Every other failure rejects
       * as `cloud.core.fleet.desiredState` does, so no failure reads as an empty or `unmanaged` answer.
       */
      async desiredStateAs(
        expected: {coreUrl: string; mentraUserId: string},
        opts?: {signal?: AbortSignal},
      ): Promise<FleetDesiredState> {
        const c = client
        if (!c?.core) throw new SessionChangedError("signed_out")
        if (!clientCoreUrl || !sameCoreUrl(clientCoreUrl, expected.coreUrl))
          throw new SessionChangedError("other_account")
        const state = await c.core.fleet.desiredState({
          expectedAccount: expected.mentraUserId,
          ...(opts?.signal ? {signal: opts.signal} : {}),
        })
        if (c !== client) throw new SessionChangedError("other_account")
        return state
      },
    },
    /** The signed-in person's workspace calls. Each is made as one account (`SessionChangedError` after a switch). */
    workspaces: {
      mine(...args: Parameters<CloudCore["workspaces"]["mine"]>) {
        return getCoreClient().workspaces.mine(...args)
      },
      pendingInvitations(...args: Parameters<CloudCore["workspaces"]["pendingInvitations"]>) {
        return getCoreClient().workspaces.pendingInvitations(...args)
      },
      acceptInvitation(...args: Parameters<CloudCore["workspaces"]["acceptInvitation"]>) {
        return getCoreClient().workspaces.acceptInvitation(...args)
      },
      declineInvitation(...args: Parameters<CloudCore["workspaces"]["declineInvitation"]>) {
        return getCoreClient().workspaces.declineInvitation(...args)
      },
      leave(...args: Parameters<CloudCore["workspaces"]["leave"]>) {
        return getCoreClient().workspaces.leave(...args)
      },
    },
  },

  hasAudioSubscriptions(): boolean {
    return audioSubscriptions.length > 0
  },
}

/**
 * The assignment reconciler's desired-state client: the desired state of the account the client speaks for when the
 * fetch starts, which is the session the reconciler just read. Rejects on every failure, and with no account.
 */
export const fleetDesiredStateClient: DesiredStateClient = {
  async fetch() {
    const session = currentCoreSession()
    if (!session?.mentraUserId) throw new SessionChangedError("signed_out")
    return cloudClientService.core.fleet.desiredStateAs({coreUrl: session.coreUrl, mentraUserId: session.mentraUserId})
  },
}
