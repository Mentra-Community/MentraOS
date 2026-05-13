/**
 * Mount + foreground a local miniapp via the imperative miniappHost API.
 *
 * This is the side-effect that previously lived inside the /applet/local
 * route's useEffect. The Compositor now drives mounting reactively from the
 * apps store's `foreground` flag, so this helper is the shared call site.
 */

import {miniappHost} from "@/components/miniapp/MiniappHost"
import {storage} from "@/utils/storage/storage"
import {appRegistry, devServerBridge, type ClientApp} from "@mentra/island"

export interface LaunchLocalMiniappCallbacks {
  onClose?: () => void
  onBack?: () => void
}

/**
 * Mount a local (installed or dev) miniapp into MiniappHost and put it in
 * foreground state. Idempotent: re-calling for an already-foregrounded app
 * is a no-op besides re-applying callbacks.
 */
export async function launchLocalMiniapp(
  app: ClientApp,
  callbacks: LaunchLocalMiniappCallbacks = {},
): Promise<void> {
  const {packageName, name: appName, logoUrl: iconUrl, version, devUrl, isMiniappDev} = app

  // Already mounted (e.g. /applet/local route mounted it) — just re-foreground.
  if (miniappHost.isRunning(packageName)) {
    miniappHost.setForeground(packageName, callbacks)
    return
  }

  if (isMiniappDev && devUrl) {
    await miniappHost.mountDev(packageName, devUrl, {
      developerMode: true,
      appName,
      iconUrl,
    })
    const portNum = resolveDevPort(packageName)
    if (portNum !== null) {
      devServerBridge.connect(packageName, devUrl, portNum)
      const sidecarBase = buildSidecarBaseUrl(devUrl, portNum)
      if (sidecarBase) {
        const versionOverride = `dev-${Date.now()}`
        void appRegistry
          .installFromUrl(`${sidecarBase}/__mentra_dev/bundle.zip`, {versionOverride})
          .then((res) => {
            if (res.is_error()) {
              console.warn(`launchLocalMiniapp: dev snapshot failed for ${packageName}:`, res.error)
            } else {
              appRegistry.gcDevVersions(packageName, 2)
            }
          })
      }
    }
    storage.save(`${packageName}_dev_last_reachable`, Date.now())
  } else if (version) {
    const bundleDir = appRegistry.getBundleDir(packageName, version)
    const bundleUri = `${bundleDir}/index.html`
    const manifest = appRegistry.getMiniappManifest(packageName, version) as
      | {
          permissions?: Array<{type: string; required?: boolean; description?: string}>
          hardwareRequirements?: Array<{type: string; level: string; description?: string}>
        }
      | null
    miniappHost.mount(packageName, bundleUri, {
      developerMode: false,
      appName,
      iconUrl,
      manifest: manifest ?? undefined,
    })
  } else {
    console.warn(`launchLocalMiniapp: ${packageName} has no devUrl or version — cannot mount`)
    return
  }

  miniappHost.setForeground(packageName, callbacks)
}

function resolveDevPort(packageName: string): number | null {
  const stored = storage.load<number>(`${packageName}_dev_port`)
  if (stored.is_ok()) return stored.value
  return null
}

function buildSidecarBaseUrl(devUrl: string, sidecarPort: number): string | null {
  try {
    const url = new URL(devUrl)
    return `${url.protocol}//${url.hostname}:${sidecarPort}`
  } catch {
    return null
  }
}
