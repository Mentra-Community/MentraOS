/**
 * @fileoverview Thin host wrapper over island's cloud client (keystone #5).
 *
 * The CloudClient singleton now lives in `@mentra/island` (`cloudClientService`):
 * island constructs it from island-owned transports (UDP, MMKV secure store,
 * status store) + the host-injected `auth` seam + the resolved endpoints the
 * host passes via `toolkit.configure({config})`, then exposes the cloud runtime
 * surface directly through island services.
 *
 * What stays here is the host-side ENDPOINT RESOLUTION — the rebuild-free Dev
 * Settings URL switcher, which reads the host settings store + the live Metro
 * host. The host resolves the URLs and hands them to island; this file also
 * delegates the managed-photo / managed-stream / connection surface so existing
 * `@/services/cloudClient` consumers keep working unchanged. (Endpoint
 * resolution moves into island later with the `dev` domain.)
 */
import {cloudClientService, type MiniappAuthToken} from "@mentra/island"

import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"

type Lc3FrameSizeBytes = 20 | 40 | 60

// Team-friendly defaults for dev builds. Point every build at the Debug cloud
// by default so a local build with no EXPO_PUBLIC_CLOUD_* env (see
// .env.example) matches CI instead of silently diverging onto Cloud Dev. Local
// Cloud V2 is still one tap away via the METRO_AUTO dev-settings preset; it
// should not be the invisible default because it depends on a local stack plus
// adb reverse/LAN reachability.
const DEFAULT_CORE_URL = "https://core.debug.us-west-2.mentraglass.com"
const DEFAULT_RUNTIME_URL = "https://runtime.debug.us-west-2.mentraglass.com"

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
 *   3. Cloud Debug — the default shared backend for team testing.
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

/** The LC3 frame size (bytes) the phone's encoder currently emits. */
export function lc3FrameSizeBytes(): Lc3FrameSizeBytes {
  const frameSize = useSettingsStore.getState().getSetting(SETTINGS.lc3_frame_size.key)
  return frameSize === 20 || frameSize === 40 || frameSize === 60 ? frameSize : 20
}

/**
 * The cloud config the host hands island at `toolkit.configure({config})`:
 * resolved endpoints + the live LC3 frame size.
 */
export function cloudConfigValues(): {
  coreUrl: string
  runtimeUrl: string
  audioFrameSizeBytes: number
  devServerHost: () => string | undefined
} {
  const endpoints = resolvedEndpoints()
  return {
    coreUrl: endpoints.core,
    runtimeUrl: endpoints.runtime,
    audioFrameSizeBytes: lc3FrameSizeBytes(),
    devServerHost,
  }
}

/**
 * Host-facing handle to island's cloud client. Construction and live runtime
 * methods live in island (`cloudClientService`); this delegates so existing consumers
 * (PhonePhotoCoordinator, cloudStreamApi, the dev Cloud-URL switcher) are
 * untouched. `reconnect()` re-resolves the host endpoints before rebuilding.
 */
export const cloudClient = {
  init: (): void => cloudClientService.init(),
  reconnect: (): void => cloudClientService.reconnect(resolvedEndpoints()),
  getMiniappAuthToken: (packageName: string, opts?: {minTtlMs?: number}): Promise<MiniappAuthToken> =>
    cloudClientService.getMiniappAuthToken(packageName, opts),
  startManagedPhoto: (opts: Record<string, unknown> = {}) => cloudClientService.startManagedPhoto(opts),
  awaitManagedPhotoReady: (requestId: string) => cloudClientService.awaitManagedPhotoReady(requestId),
  startManagedStream: (opts: Record<string, unknown> = {}) => cloudClientService.startManagedStream(opts),
  getManagedStreamStatus: (streamId: string) => cloudClientService.getManagedStreamStatus(streamId),
  stopManagedStream: (streamId: string) => cloudClientService.stopManagedStream(streamId),
  isConnected: (): boolean => cloudClientService.isConnected(),
  onConnectionChange: (listener: (connected: boolean) => void): (() => void) =>
    cloudClientService.onConnectionChange(listener),
}
