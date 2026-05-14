import {useEffect, useRef, useState} from "react"
import {useLocalSearchParams} from "expo-router"
import {File} from "expo-file-system"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {getMentraJS} from "@/services/mentraJsBootstrap"
import {useNavigationStore} from "@/stores/navigation"
import {appRegistry, devServerBridge, useAppStatusStore} from "@mentra/island"
import {storage} from "@/utils/storage/storage"

/**
 * Mount destination for a dev or installed local miniapp. Reachability
 * is decided BEFORE we land here — see decideDevLaunchRoute and the
 * entry points (AppsGrid → startApplet, scanner, URL screen).
 *
 * Two-layer flow:
 *   1. For dev miniapps: snapshot the dev server's bundle into
 *      lmas/<pkg>/dev-<ts>/ so the JSContext has a stable on-disk
 *      copy of dist/background/index.js + dist/ui/index.html.
 *   2. Spawn the JSContext via MentraJSRouter.spawnAndRegister.
 *   3. openUI with the bundle's UI HTML.
 *
 * On navigate-away the route closes the UI WebView (JSContext stays
 * alive — it's the always-on half).
 */
export default function LocalMiniAppPage() {
  const {appName, packageName, version, devUrl, iconUrl, devPort} = useLocalSearchParams<{
    appName: string
    packageName: string
    version?: string
    devUrl?: string
    iconUrl?: string
    devPort?: string
  }>()
  const {goBack, setForceGestureEnabled} = useNavigationStore.getState()

  const goBackRef = useRef(goBack)
  goBackRef.current = goBack

  useEffect(() => {
    if (!packageName) return

    const handleClose = () => {
      miniappHost.closeUI(packageName)
      goBackRef.current()
    }

    const handleBack = () => {
      const wentBack = miniappHost.goBackInWebView(packageName)
      if (!wentBack) {
        goBackRef.current()
      }
    }

    let cancelled = false

    const launch = async () => {
      let resolvedVersion: string | null = null

      if (devUrl) {
        // Snapshot the live dev bundle so we have an on-disk copy of
        // dist/background/index.js + dist/ui/index.html. The dev server
        // serves bundle.zip from a sidecar port; resolve it from the
        // route param or persisted MMKV key.
        const portNum = resolveDevPort(devPort, packageName)
        if (portNum === null) {
          console.warn(`local.tsx: no dev port for ${packageName}`)
          return
        }
        const sidecarBase = buildSidecarBaseUrl(devUrl, portNum)
        if (!sidecarBase) {
          console.warn(`local.tsx: bad dev URL "${devUrl}" for ${packageName}`)
          return
        }
        const versionOverride = `dev-${Date.now()}`
        const installRes = await appRegistry.installFromUrl(
          `${sidecarBase}/__mentra_dev/bundle.zip`,
          {versionOverride},
        )
        if (installRes.is_error()) {
          console.warn(`local.tsx: dev snapshot failed for ${packageName}:`, installRes.error)
          return
        }
        appRegistry.gcDevVersions(packageName, 2)
        devServerBridge.connect(packageName, devUrl, portNum)
        storage.save(`${packageName}_dev_last_reachable`, Date.now())
        resolvedVersion = await appRegistry.getActiveVersion(packageName)
      } else if (version) {
        resolvedVersion = version
      } else {
        console.warn(`local.tsx: ${packageName} has no devUrl or version — cannot launch`)
        return
      }

      if (!resolvedVersion || cancelled) return

      const entryPaths = appRegistry.getMiniappEntryPaths(packageName, resolvedVersion)
      if (!entryPaths?.background) {
        console.warn(`local.tsx: ${packageName}@${resolvedVersion} missing entry.background`)
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
        console.warn(`local.tsx: MentraJS not bootstrapped — cannot spawn ${packageName}`)
        return
      }

      // Spawn the JSContext if it isn't already alive. Re-foregrounding
      // a running miniapp just reopens the UI half without re-spawning.
      if (!mj.router.registeredPackages().includes(packageName)) {
        const bgSource = new File(entryPaths.background).textSync()
        const ok = await mj.router.spawnAndRegister(packageName, bgSource, {
          permissions: declaredPermissions,
        })
        if (!ok) {
          console.warn(`local.tsx: spawn failed for ${packageName}`)
          return
        }
      }

      if (cancelled) {
        await mj.router.unregister(packageName)
        return
      }

      if (entryPaths.ui) {
        miniappHost.openUI(packageName, {
          uiUri: entryPaths.ui,
          appName,
          iconUrl,
          developerMode: !!devUrl,
          onClose: handleClose,
          onBack: handleBack,
        })
      }
      useAppStatusStore.getState().setForeground(packageName)
    }

    void launch()

    return () => {
      cancelled = true
      miniappHost.closeUI(packageName)
      useAppStatusStore.getState().clearForeground()
    }
  }, [packageName, version, devUrl, devPort, appName, iconUrl])

  // Track WebView navigation state so "back" pops the WebView stack if
  // there's history, else exits the miniapp.
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  useEffect(() => {
    if (!packageName) return
    return miniappHost.subscribeCanGoBack(packageName, setWebViewCanGoBack)
  }, [packageName])

  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  if (!packageName) {
    return <Text>Missing required parameters</Text>
  }

  // MiniappHost renders the WebView at app root above the Stack so it
  // survives navigation. This route is just a hook for openUI / closeUI.
  return <View style={{flex: 1, backgroundColor: "transparent"}} pointerEvents="none" />
}

function resolveDevPort(searchParam: string | undefined, packageName: string): number | null {
  if (searchParam) {
    const n = parseInt(searchParam, 10)
    if (Number.isFinite(n)) return n
  }
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
