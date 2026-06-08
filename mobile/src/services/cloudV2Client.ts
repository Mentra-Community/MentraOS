/**
 * @fileoverview Owns the singleton v2 `@mentra/cloud-client` (CloudClient) and
 * exposes it to the island runtime as a `CloudRuntimeAdapter`.
 *
 * This is additive: the v1 `socketComms` path stays fully intact. During the
 * cloud-v2 transition the phone runs BOTH clouds — v1 over the existing
 * WebSocket and v2 over `@mentra/cloud-client`. The island runtime drives the
 * v2 cloud's transcription/translation through the adapter returned by
 * `initCloudV2()`, while continuing to drive v1 unchanged.
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

const LOG_TAG = "cloudV2Client"

// TODO(cloud-v2): these fallbacks are the dev laptop's LAN URLs. Set
// EXPO_PUBLIC_CLOUD_V2_CORE_URL / EXPO_PUBLIC_CLOUD_V2_RUNTIME_URL in .env to
// point at a real environment. Remove the hardcoded fallbacks before shipping.
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
    SETTINGS.cloud_v2_core_url.key,
    process.env.EXPO_PUBLIC_CLOUD_V2_CORE_URL as string | undefined,
    DEFAULT_CORE_URL,
  )
}

function runtimeUrl(): string {
  return resolveUrl(
    SETTINGS.cloud_v2_runtime_url.key,
    process.env.EXPO_PUBLIC_CLOUD_V2_RUNTIME_URL as string | undefined,
    DEFAULT_RUNTIME_URL,
  )
}

/**
 * Read the live Supabase access token on demand. `mentraAuth.getSession()`
 * returns the current (auto-refreshed) session, so the v2 client always
 * exchanges a fresh subject token. Never log the token.
 */
async function getSupabaseSubjectToken(): Promise<{token: string; type: "supabase"}> {
  const res = await mentraAuth.getSession()
  if (res.is_error() || !res.value.token) {
    throw new Error("cloud-v2: no Supabase session token available")
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

function ensureTransports(): void {
  if (transportsReady) return
  transportsReady = true
  setNativeUdp(() => createCloudUdpSocket())
  setSecureStorage(cloudSecureStore)
}

function buildAdapter(c: CloudClient): CloudRuntimeAdapter {
  return {
    setSubscriptions: async (subs: AudioSubscription[]): Promise<void> => {
      audioSubscriptions = subs
      await c.runtime.setSubscriptions(subs)
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
 * Construct (once) and connect the v2 CloudClient, returning the runtime
 * adapter the island runtime wires in. Idempotent: repeated calls return the
 * same adapter. The connect is best-effort — a failure is logged and the app
 * keeps running on the v1 path.
 */
export function initCloudV2(): CloudRuntimeAdapter {
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
    console.log(`${LOG_TAG}: v2 runtime connected`)
  })
  c.runtime.onDisconnected((info) => {
    connected = false
    console.log(`${LOG_TAG}: v2 runtime disconnected (${info.reason})`)
  })
  c.runtime.onError((err) => {
    console.warn(`${LOG_TAG}: v2 runtime error: ${err.code}`)
  })

  adapter = buildAdapter(c)

  // Best-effort connect. Do not crash the app if the dev cloud is unreachable.
  c.runtime
    .connect()
    .then(() => console.log(`${LOG_TAG}: connect() resolved`))
    .catch((err) => console.warn(`${LOG_TAG}: connect() failed: ${err?.message ?? err}`))

  return adapter
}

/**
 * Tear down the current v2 client and re-init with freshly-resolved endpoint
 * URLs. Used by the dev "Cloud V2" settings override so a new core/runtime URL
 * takes effect without an app rebuild. The CloudClient exposes its teardown via
 * `runtime.close()` (the top-level client has no `disconnect`/`close`), so we
 * close that, drop the singletons, and call `initCloudV2()` to rebuild.
 */
export function reconnectCloudV2(): void {
  try {
    client?.runtime.close()
  } catch (err) {
    console.warn(`${LOG_TAG}: reconnect close() failed: ${(err as Error)?.message ?? err}`)
  }

  client = null
  adapter = null
  connected = false
  audioSubscriptions = []

  initCloudV2()
}
