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

import {SETTINGS, engine} from "@mentra/engine"
import {devServerHost} from "@/utils/cloudClient/devHost"
import {deploymentStore, type ActiveDeployment} from "@/services/deployment"
import {deploymentDebugScope, resolveDeploymentManifest} from "@/services/deployment/debugOverrides"

type Lc3FrameSizeBytes = 20 | 40 | 60

/** The selected manifest with its deployment-scoped debug overrides applied. */
export function resolvedEndpoints(): {core: string; runtime: string} {
  const manifest = resolveDeploymentManifest(deploymentStore.getActive())
  return {core: manifest.services.coreUrl!, runtime: manifest.services.runtimeUrl!}
}

export const activeDeploymentEndpoints = resolvedEndpoints

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
  coreUrl: string | null
  runtimeUrl: string | null
  audioFrameSizeBytes: number
  devServerHost: () => string | undefined
  runtimeRealtimeSession?: boolean
  localMiniappAllowlist?: string[] | null
  localMiniappPolicy?: {
    systemPackageNames: string[] | null
    managed: Array<{
      packageName: string
      version: string
      sha256: string
      deploymentId: string
      deploymentOrigin: string
    }>
  }
  miniappConfiguration?: Readonly<Record<string, Readonly<Record<string, string>>>>
  cloudDebugScope?: string
  resolveCloudEndpoints?: () => {core: string; runtime: string}
  cloudAuthStorageKey?: string
  otaManifestUrl?: string | null
  allowLegacyOtaFallback?: boolean
  features?: {
    managedStreams: boolean
    nativeMeetings: boolean
    cloudSpeech: boolean
    onDeviceSpeech: boolean
    navigation: boolean
  }
} {
  return deploymentCloudConfigValues(deploymentStore.getActive())
}

export function deploymentCloudConfigValues(deployment: ActiveDeployment): ReturnType<typeof cloudConfigValues> {
  const manifest = resolveDeploymentManifest(deployment)
  const systemAllowlist = manifest.systemMiniapps.approvedPackageNamesOverride
  const authStorageKey =
    deployment.kind === "workspace"
      ? `mentra.cloud-client.${manifest.deploymentId}.${encodeURIComponent(deployment.workspaceOrigin)}.refreshToken`
      : undefined
  return {
    coreUrl: manifest.services.coreUrl,
    runtimeUrl: manifest.services.runtimeUrl,
    runtimeRealtimeSession: manifest.features.runtimeRealtimeSession,
    // Island's local registry contains both embedded SYSTEM miniapps and
    // manifest-managed userland miniapps. Keep the manifest concepts separate,
    // then combine them only at this internal registry boundary.
    localMiniappAllowlist:
      systemAllowlist === null
        ? null
        : [...new Set([...systemAllowlist, ...manifest.miniapps.managed.map((entry) => entry.packageName)])],
    localMiniappPolicy:
      deployment.kind === "workspace"
        ? {
            systemPackageNames: systemAllowlist,
            managed: manifest.miniapps.managed.map((entry) => ({
              packageName: entry.packageName,
              version: entry.version,
              sha256: entry.sha256.toLowerCase(),
              deploymentId: manifest.deploymentId,
              deploymentOrigin: deployment.workspaceOrigin,
            })),
          }
        : undefined,
    miniappConfiguration: manifest.miniapps.configuration,
    cloudAuthStorageKey: authStorageKey,
    // Preserve official legacy-glasses/embedded-engine OTA fallback semantics.
    otaManifestUrl: manifest.artifacts.mentraLiveOtaManifestUrl,
    allowLegacyOtaFallback: deployment.kind === "consumer",
    cloudDebugScope: deploymentDebugScope(deployment),
    resolveCloudEndpoints: resolvedEndpoints,
    features: {
      managedStreams: manifest.features.managedStreams,
      nativeMeetings: manifest.features.nativeMeetings,
      cloudSpeech: manifest.features.cloudSpeech,
      onDeviceSpeech: manifest.features.onDeviceSpeech,
      navigation: manifest.features.navigation,
    },
    audioFrameSizeBytes: lc3FrameSizeBytes(),
    devServerHost,
  }
}

/**
 * Host-facing handle to island's cloud client. Construction and live runtime
 * methods live in island (`cloudClientService`); this delegates so existing consumers
 * (PhonePhotoCoordinator, cloudStreamApi, the dev Cloud-URL switcher) are
 * untouched. `reconnect()` re-resolves the active deployment's endpoints before
 * rebuilding. Overrides apply equally to official and workspace deployments.
 */
export const cloudClient = {
  clearAuthSession: (): Promise<void> => cloudClientService.clearAuthSession(),
  init: (): void => cloudClientService.init(),
  reconnect: (): void => {
    // Use the live host resolver instead of freezing today's Metro address as
    // an explicit engine reconnect pin.
    cloudClientService.reconnect(null)
  },
  getPreinstalledMiniappRegistry: () => cloudClientService.getPreinstalledMiniappRegistry(),
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
