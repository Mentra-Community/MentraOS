/**
 * @fileoverview Thin host wrapper over island's cloud client (keystone #5).
 *
 * The CloudClient singleton lives in `@mentra/engine` (`cloudClientService`):
 * island constructs it from island-owned transports (UDP, MMKV secure store,
 * status store) + the host-injected `auth` seam + the resolved endpoints the
 * host passes via `engine.configure({config})`, then exposes the cloud runtime
 * surface directly through island services.
 *
 * What stays here is host-side endpoint resolution: the rebuild-free Dev
 * Settings URL switcher, which reads the host settings store + the live Metro
 * host. Existing `@/services/cloudClient` consumers keep working through this
 * delegating shim while construction and runtime wiring live in island.
 */
import {cloudClientService} from "@mentra/engine-host-internal"
import Constants from "expo-constants"

import {SETTINGS, engine} from "@mentra/engine"
import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"
import {deriveStoreUrl} from "@/utils/cloudClient/storeUrl"

type Lc3FrameSizeBytes = 20 | 40 | 60

// Team-friendly defaults for dev builds. Point every build at the Cloud V2 Dev
// environment by default so a local build with no EXPO_PUBLIC_CLOUD_* env (see
// .env.example) matches the deployed `dev` cloud, which auto-deploys from the
// dev branch. Local Cloud V2 is still one tap away via the METRO_AUTO
// dev-settings preset; it should not be the invisible default because it
// depends on a local stack plus adb reverse/LAN reachability.
const DEFAULT_CORE_URL = "https://core.dev.us-west-2.mentraglass.com"
const DEFAULT_RUNTIME_URL = "https://runtime.dev.us-west-2.mentraglass.com"
const CORE_PORT = 3000
const RUNTIME_PORT = 3001
const STORE_PORT = 3003

function metroUrl(port: number): string | undefined {
  const host = devServerHost()
  return host ? `http://${host}:${port}` : undefined
}

/**
 * Resolve an endpoint URL. Precedence (the user's in-app choice always wins):
 *   1. store override: explicit URL or METRO_AUTO resolved to the current Metro host;
 *   2. env (EXPO_PUBLIC_CLOUD_*): for CI/staging builds, never personal IPs;
 *   3. Cloud Dev: the default shared backend for team testing.
 */
function resolveUrl(settingKey: string, envValue: string | undefined, port: number, defaultUrl: string): string {
  const override = engine.settings.get(settingKey)
  if (typeof override === "string" && override.trim().length > 0) {
    const trimmed = override.trim()
    if (trimmed !== METRO_AUTO) return trimmed

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

function storeUrl(): string {
  return resolveUrl(
    SETTINGS.cloud_store_url.key,
    process.env.EXPO_PUBLIC_CLOUD_STORE_URL as string | undefined,
    STORE_PORT,
    deriveStoreUrl(coreUrl()),
  )
}

/** The endpoint URLs the client would use right now, every layer applied. */
export function resolvedEndpoints(): {core: string; store: string; runtime: string} {
  return {core: coreUrl(), store: storeUrl(), runtime: runtimeUrl()}
}

/** The LC3 frame size (bytes) the phone's encoder currently emits. */
export function lc3FrameSizeBytes(): Lc3FrameSizeBytes {
  const frameSize = engine.settings.get(SETTINGS.lc3_frame_size.key)
  return frameSize === 20 || frameSize === 40 || frameSize === 60 ? frameSize : 20
}

/**
 * The cloud config the host hands island at `engine.configure({config})`:
 * resolved endpoints + the live LC3 frame size.
 */
export function cloudConfigValues(): {
  coreUrl: string
  storeUrl: string
  runtimeUrl: string
  audioFrameSizeBytes: number
  devServerHost: () => string | undefined
  hostVersion: string
  supportedMiniappSdkRange: string
} {
  const endpoints = resolvedEndpoints()
  return {
    coreUrl: endpoints.core,
    storeUrl: endpoints.store,
    runtimeUrl: endpoints.runtime,
    audioFrameSizeBytes: lc3FrameSizeBytes(),
    devServerHost,
    hostVersion: Constants.expoConfig?.version ?? process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? "0.0.0",
    supportedMiniappSdkRange: "^0.3.0",
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
  getPreinstalledMiniappRegistry: () => cloudClientService.getPreinstalledMiniappRegistry(),
  getCoreDownloadAuthorization: () => cloudClientService.getCoreDownloadAuthorization(),
  getMiniappAuthToken: (packageName: string, opts?: {minTtlMs?: number; devAttestation?: string}) =>
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
