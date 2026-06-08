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
import type {AudioSubscription, TranscriptionData, TranslationData} from "@mentra/cloud-runtime/protocol"
import type {CloudRuntimeAdapter} from "@mentra/island"

import mentraAuth from "@/utils/auth/authClient"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {createCloudUdpSocket} from "@/utils/cloudClient/RnUdpAdapter"
import {cloudSecureStore} from "@/utils/cloudClient/MmkvSecureStore"

const LOG_TAG = "cloudClient"

// TODO: these fallbacks are the dev laptop's LAN URLs. Set
// EXPO_PUBLIC_CLOUD_CORE_URL / EXPO_PUBLIC_CLOUD_RUNTIME_URL in .env to point at
// a real environment. Remove the hardcoded fallbacks before shipping.
export const DEFAULT_CORE_URL = "http://10.0.0.161:3000"
export const DEFAULT_RUNTIME_URL = "http://10.0.0.161:8010"

/**
 * Resolve an endpoint URL with precedence: local dev store override -> env ->
 * hardcoded default. The store override is read via the settings store's
 * `getState()` accessor (not a hook) so this service stays React-free.
 */
function resolveUrl(settingKey: string, envValue: string | undefined, fallback: string): string {
  const override = useSettingsStore.getState().getSetting(settingKey)
  if (typeof override === "string" && override.trim().length > 0) {
    return override
  }
  return envValue || fallback
}

function coreUrl(): string {
  return resolveUrl(
    SETTINGS.cloud_core_url.key,
    process.env.EXPO_PUBLIC_CLOUD_CORE_URL as string | undefined,
    DEFAULT_CORE_URL,
  )
}

function runtimeUrl(): string {
  return resolveUrl(
    SETTINGS.cloud_runtime_url.key,
    process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL as string | undefined,
    DEFAULT_RUNTIME_URL,
  )
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

/**
 * Listeners that want to know when the live session connects/disconnects. The
 * host wires the LocalSttFallbackCoordinator's `cloudConnection` adapter to
 * these so the local-miniapp on-device-STT fallback tracks cloud liveness (not
 * the v1 WebSocket). Notified on every transition out of `onConnected`/
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

function buildAdapter(c: CloudClient): CloudRuntimeAdapter {
  return {
    setSubscriptions: async (subs: AudioSubscription[]): Promise<void> => {
      // Cache the desired state unconditionally so it survives a not-yet-
      // connected session and reconnects. Only push to the runtime when the
      // session is actually connected. `c.runtime.setSubscriptions` throws
      // "Cannot set subscriptions before the session is connected" otherwise,
      // and nothing would retry. The `onConnected` handler re-applies the
      // cached set, so subscribe-before-connect self-heals.
      audioSubscriptions = subs
      if (connected) {
        await c.runtime.setSubscriptions(subs)
      }
    },
    sendAudioFrame: (frame: Uint8Array): void => {
      c.runtime.sendAudioFrame(frame)
    },
    onTranscript: (cb: (d: TranscriptionData) => void): (() => void) => c.runtime.onTranscript(cb),
    onTranslation: (cb: (d: TranslationData) => void): (() => void) => c.runtime.onTranslation(cb),
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
  /**
   * Construct (once) and connect the CloudClient, returning the runtime adapter
   * the island runtime wires in. Idempotent: repeated calls return the same
   * adapter. The connect is best-effort — a failure is logged and the app keeps
   * running.
   */
  init(): CloudRuntimeAdapter {
    if (adapter) return adapter

    ensureTransports()

    client = new CloudClient({
      endpoints: {core: coreUrl(), runtime: runtimeUrl()},
      // The phone LC3-encodes mic audio (even in phone/simulated mode), so we
      // announce LC3 at 16 kHz to match what the capture site sends.
      audio: {codec: "lc3", sampleRate: 16000},
      auth: {getSubjectToken: getSupabaseSubjectToken},
    })

    const c = client
    c.runtime.onConnected(() => {
      connected = true
      console.log(`${LOG_TAG}: runtime connected`)
      // Re-apply any subscriptions queued before connect (or dropped across a
      // reconnect). Without this the local miniapp's transcription subscription
      // would never land and the cloud would never power its captions. Best-
      // effort: log on failure, never throw out of the connect handler.
      if (audioSubscriptions.length > 0) {
        try {
          c.runtime.setSubscriptions(audioSubscriptions)
        } catch (err) {
          console.warn(`${LOG_TAG}: re-applying queued subscriptions failed: ${(err as Error)?.message ?? err}`)
        }
      }
      notifyConnectionListeners(true)
    })
    c.runtime.onDisconnected((info) => {
      connected = false
      console.log(`${LOG_TAG}: runtime disconnected (${info.reason})`)
      notifyConnectionListeners(false)
    })
    c.runtime.onError((err) => {
      console.warn(`${LOG_TAG}: runtime error: ${err.code}`)
    })

    adapter = buildAdapter(c)

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

    const wasConnected = connected
    client = null
    adapter = null
    connected = false
    audioSubscriptions = []
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
