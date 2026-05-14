/**
 * Launch (or re-open) a local two-layer miniapp's UI half.
 *
 * Called from Compositor's foregroundApp effect when the apps-store
 * `foreground` flag changes. The two-layer model:
 *   - JSContext (always-on background) — spawned via MentraJSRouter.
 *   - UI WebView (transient) — created on demand via miniappHost.openUI.
 *
 * Idempotent: if the JSContext is already alive, this just re-opens the
 * UI half. Re-foregrounding a running miniapp pays the WebView mount
 * cost but not the JSContext spawn cost.
 *
 * For dev miniapps (`isMiniappDev === true`), the dev server's
 * bundle.zip is snapshotted into lmas/<pkg>/dev-<ts>/ first so the
 * JSContext can read background JS from disk. The WebView still mounts
 * from the local snapshot (not the dev URL) so reload signals route
 * through the host's normal `webView.reload()` path.
 */

import {File} from "expo-file-system"

import {miniappHost} from "@/components/miniapp/MiniappHost"
import {getMentraJS} from "@/services/mentraJsBootstrap"
import {storage} from "@/utils/storage/storage"
import {appRegistry, devServerBridge, type ClientApp} from "@mentra/island"

export interface LaunchLocalMiniappCallbacks {
  onClose?: () => void
  onBack?: () => void
}

export async function launchLocalMiniapp(
  app: ClientApp,
  callbacks: LaunchLocalMiniappCallbacks = {},
): Promise<void> {
  const {packageName, name: appName, logoUrl: iconUrl, version, devUrl, isMiniappDev} = app

  // If the UI is already open for this package, just refresh callbacks.
  if (miniappHost.isOpen(packageName)) {
    // openUI replaces the existing entry's callbacks atomically.
    // Re-opening with the latest URI keeps the WebView mounted.
    return
  }

  // Resolve the on-disk version. For dev miniapps that's a fresh
  // snapshot of the dev bundle; for installed ones it's the existing
  // active version.
  let resolvedVersion: string | null = null
  if (isMiniappDev && devUrl) {
    resolvedVersion = await snapshotDevBundle(packageName, devUrl)
    if (!resolvedVersion) return
  } else if (version) {
    resolvedVersion = version
  } else {
    console.warn(`launchLocalMiniapp: ${packageName} has no devUrl or version — cannot launch`)
    return
  }

  const entryPaths = appRegistry.getMiniappEntryPaths(packageName, resolvedVersion)
  if (!entryPaths?.background) {
    console.warn(`launchLocalMiniapp: ${packageName}@${resolvedVersion} missing entry.background`)
    return
  }
  const manifest = appRegistry.getMiniappManifest(packageName, resolvedVersion) as {
    permissions?: Array<{type: string; required?: boolean; description?: string}>
  } | null
  const declaredPermissions = (manifest?.permissions ?? [])
    .map((p) => p.type)
    .filter((t): t is string => typeof t === "string")

  const mj = getMentraJS()
  if (!mj) {
    console.warn(`launchLocalMiniapp: MentraJS not bootstrapped — cannot spawn ${packageName}`)
    return
  }

  // Spawn the JSContext if not already alive.
  if (!mj.router.registeredPackages().includes(packageName)) {
    const bgSource = new File(entryPaths.background).textSync()
    const ok = await mj.router.spawnAndRegister(packageName, bgSource, {
      permissions: declaredPermissions,
    })
    if (!ok) {
      console.warn(`launchLocalMiniapp: spawn failed for ${packageName}`)
      return
    }
  }

  // Open the UI WebView if the manifest declared one. Background-only
  // miniapps (type: "background") skip this.
  if (entryPaths.ui) {
    miniappHost.openUI(packageName, {
      uiUri: entryPaths.ui,
      appName,
      iconUrl,
      developerMode: !!isMiniappDev,
      ...callbacks,
    })
  }
}

/**
 * Snapshot the dev server's current bundle into lmas/<pkg>/dev-<ts>/
 * so the JSContext can read background JS from disk. Returns the new
 * version string (or null on failure).
 *
 * Side-effects:
 *   - GCs prior dev versions (keeps the 2 most recent)
 *   - Connects the devServerBridge for hot-reload signals
 *   - Records the last-reachable timestamp in MMKV
 */
async function snapshotDevBundle(packageName: string, devUrl: string): Promise<string | null> {
  const portNum = resolveDevPort(packageName)
  if (portNum === null) {
    console.warn(`launchLocalMiniapp: no dev port for ${packageName}`)
    return null
  }
  const sidecarBase = buildSidecarBaseUrl(devUrl, portNum)
  if (!sidecarBase) {
    console.warn(`launchLocalMiniapp: bad dev URL "${devUrl}" for ${packageName}`)
    return null
  }
  const versionOverride = `dev-${Date.now()}`
  const installRes = await appRegistry.installFromUrl(`${sidecarBase}/__mentra_dev/bundle.zip`, {
    versionOverride,
  })
  if (installRes.is_error()) {
    console.warn(`launchLocalMiniapp: dev snapshot failed for ${packageName}:`, installRes.error)
    return null
  }
  appRegistry.gcDevVersions(packageName, 2)
  devServerBridge.connect(packageName, devUrl, portNum)
  storage.save(`${packageName}_dev_last_reachable`, Date.now())
  return appRegistry.getActiveVersion(packageName)
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
