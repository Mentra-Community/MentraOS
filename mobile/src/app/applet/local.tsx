import {useEffect, useRef, useState} from "react"
import {useLocalSearchParams} from "expo-router"
import {File} from "expo-file-system"
import {ActivityIndicator, Image, View} from "react-native"

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

  // Phase machine: drives the loading affordance until the WebView
  // takes over the screen. "ready" means the UI is open AND the
  // MiniappHost WebView is mounted on top — at that point this route
  // returns to a transparent passthrough so taps reach the WebView.
  const [phase, setPhase] = useState<
    "installing" | "spawning" | "opening" | "ready" | "error"
  >(devUrl || version ? "installing" : "error")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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
    const fail = (msg: string) => {
      if (cancelled) return
      console.warn(`local.tsx: ${packageName} ${msg}`)
      setErrorMessage(msg)
      setPhase("error")
    }

    const launch = async () => {
      let resolvedVersion: string | null = null

      if (devUrl) {
        setPhase("installing")
        const portNum = resolveDevPort(devPort, packageName)
        if (portNum === null) {
          fail("no dev port configured")
          return
        }
        const sidecarBase = buildSidecarBaseUrl(devUrl, portNum)
        if (!sidecarBase) {
          fail(`bad dev URL "${devUrl}"`)
          return
        }
        const versionOverride = `dev-${Date.now()}`
        const installRes = await appRegistry.installFromUrl(
          `${sidecarBase}/__mentra_dev/bundle.zip`,
          {versionOverride},
        )
        if (installRes.is_error()) {
          fail(`dev snapshot failed: ${installRes.error?.message ?? installRes.error}`)
          return
        }
        appRegistry.gcDevVersions(packageName, 2)
        devServerBridge.connect(packageName, devUrl, portNum)
        storage.save(`${packageName}_dev_last_reachable`, Date.now())
        resolvedVersion = await appRegistry.getActiveVersion(packageName)
      } else if (version) {
        resolvedVersion = version
      } else {
        fail("no devUrl or version — cannot launch")
        return
      }

      if (!resolvedVersion || cancelled) return

      const entryPaths = appRegistry.getMiniappEntryPaths(packageName, resolvedVersion)
      if (!entryPaths?.background) {
        fail(`${resolvedVersion} missing entry.background`)
        return
      }
      const manifest = appRegistry.getMiniappManifest(packageName, resolvedVersion) as {
        permissions?: Array<{type: string; required?: boolean; description?: string}>
        hardwareRequirements?: Array<{type: string; level: string; description?: string}>
      } | null
      const declaredPermissions = (manifest?.permissions ?? [])
        .map((p) => p.type)
        .filter((t): t is string => typeof t === "string")
      // LocalMiniappRuntime.SUBSCRIBE matches stream → permission against
      // installedManifest.permissions. Threading the full manifest (not
      // just the permission types) preserves description / required
      // fields that the SDK's PERMISSIONS_UPDATE response surfaces.
      const installedManifest = manifest
        ? {
            permissions: manifest.permissions,
            hardwareRequirements: manifest.hardwareRequirements,
          }
        : undefined

      const mj = getMentraJS()
      if (!mj) {
        fail("MentraJS runtime not bootstrapped")
        return
      }

      if (cancelled) return
      setPhase("spawning")

      // Spawn the JSContext if it isn't already alive. Re-foregrounding
      // a running miniapp just reopens the UI half without re-spawning.
      if (!mj.router.registeredPackages().includes(packageName)) {
        const bgSource = new File(entryPaths.background).textSync()
        const ok = await mj.router.spawnAndRegister(packageName, bgSource, {
          permissions: declaredPermissions,
          installedManifest,
        })
        if (!ok) {
          fail("spawn failed — see logs")
          return
        }
      }

      if (cancelled) {
        await mj.router.unregister(packageName)
        return
      }

      setPhase("opening")
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
      if (!cancelled) setPhase("ready")
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

  // Loading affordance: until the WebView is mounted on top, this route
  // is what the user sees. Without it the screen is blank for 1-10s on
  // a fresh dev install (bundle download + JSContext spawn).
  if (phase !== "ready") {
    const label =
      phase === "installing"
        ? "Downloading…"
        : phase === "spawning"
          ? "Starting…"
          : phase === "opening"
            ? "Opening…"
            : "Couldn't open"
    return (
      <View className="flex-1 items-center justify-center px-8">
        <View className="items-center gap-4">
          {iconUrl ? (
            <Image
              source={{uri: iconUrl}}
              style={{width: 72, height: 72, borderRadius: 16}}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 16,
                backgroundColor: "rgba(120,120,120,0.2)",
              }}
            />
          )}
          {appName ? (
            <Text className="text-base font-semibold text-center" text={appName} />
          ) : null}
          {phase === "error" ? (
            <Text
              className="text-[13px] text-center text-red-500 max-w-[280px]"
              text={errorMessage ?? "Couldn't open"}
            />
          ) : (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator />
              <Text className="text-[13px] text-muted-foreground" text={label} />
            </View>
          )}
        </View>
      </View>
    )
  }

  // MiniappHost renders the WebView at app root above the Stack so it
  // survives navigation. Once ready, this route is just a pointer-events:none
  // pass-through so taps reach the WebView.
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
