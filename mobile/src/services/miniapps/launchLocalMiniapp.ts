/**
 * Mount + foreground a local miniapp via the imperative miniappHost API.
 *
 * This is the side-effect that previously lived inside the /applet/local
 * route's useEffect. The Compositor now drives mounting reactively from the
 * apps store's `foreground` flag, so this helper is the shared call site.
 */

import {File} from "expo-file-system"
import CrustModule from "crust"

import {miniappHost} from "@/components/miniapp/MiniappHost"
import {getMentraJS} from "@/services/mentraJsBootstrap"
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
    const manifest = appRegistry.getMiniappManifest(packageName, version) as
      | {
          permissions?: Array<{type: string; required?: boolean; description?: string}>
          hardwareRequirements?: Array<{type: string; level: string; description?: string}>
          entry?: {background?: string; ui?: string}
        }
      | null

    // Phase 4+ two-layer detection: when the manifest declares
    // `entry.background`, spawn a JSContext via MentraJSRouter and open
    // the WebView (if any) via miniappHost.openUI. Legacy single-bundle
    // miniapps continue to mount the persistent off-screen WebView.
    const isTwoLayer = !!manifest?.entry?.background
    if (isTwoLayer && manifest) {
      await launchTwoLayer(packageName, version, manifest, {appName, iconUrl})
    } else {
      const bundleUri = `${bundleDir}/index.html`
      miniappHost.mount(packageName, bundleUri, {
        developerMode: false,
        appName,
        iconUrl,
        manifest: manifest ?? undefined,
      })
    }
  } else {
    console.warn(`launchLocalMiniapp: ${packageName} has no devUrl or version — cannot mount`)
    return
  }

  miniappHost.setForeground(packageName, callbacks)
}

async function launchTwoLayer(
  packageName: string,
  version: string,
  manifest: {
    permissions?: Array<{type: string; required?: boolean}>
    entry?: {background?: string; ui?: string}
  },
  options: {appName?: string; iconUrl?: string},
): Promise<void> {
  const mj = getMentraJS()
  if (!mj) {
    console.warn(`launchLocalMiniapp: two-layer ${packageName} but MentraJS not bootstrapped`)
    return
  }
  const entryPaths = appRegistry.getMiniappEntryPaths?.(packageName, version)
  const bgUri = entryPaths?.background
  if (!bgUri) {
    console.warn(
      `launchLocalMiniapp: two-layer ${packageName} declares entry.background but file is missing on disk`,
    )
    return
  }

  // Read the background bundle source from disk. The host's
  // Crust.mentraJsSpawn() takes the JS source string + polyfill bundle.
  // expo-file-system's `File` is the standard reader path elsewhere
  // in this repo. The URI from `getMiniappEntryPaths` is file:// so it
  // resolves directly.
  const bgSource = new File(bgUri).textSync()

  const declaredPermissions = (manifest.permissions ?? [])
    .map((p) => p.type)
    .filter((t): t is string => typeof t === "string")

  // Spawn the JSContext if it isn't already alive — re-foregrounding
  // an already-running two-layer miniapp doesn't need a fresh spawn.
  if (!mj.router.registeredPackages().includes(packageName)) {
    const ok = await mj.router.spawnAndRegister(packageName, bgSource, {permissions: declaredPermissions})
    if (!ok) {
      console.warn(`launchLocalMiniapp: spawn failed for ${packageName}`)
      return
    }
    // Best-effort: auto-grant declared permissions in dev (the JIT
    // modal flow runs in production-grade builds). This mirrors the
    // existing "implicit grant at install" behaviour the spec calls
    // out for non-OS-sensitive types.
    const crustGrant = (CrustModule as unknown as {
      mentraJsGrantPermission?: (p: string, x: string, y: boolean) => Promise<void>
    }).mentraJsGrantPermission
    if (typeof crustGrant === "function") {
      for (const perm of declaredPermissions) {
        void crustGrant(packageName, perm, true)
      }
    }
  }

  // Open the UI WebView (if the manifest declares one).
  const uiUri = entryPaths?.ui
  if (uiUri) {
    miniappHost.openUI(packageName, {
      uiUri,
      appName: options.appName,
      iconUrl: options.iconUrl,
      developerMode: false,
    })
  }
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
