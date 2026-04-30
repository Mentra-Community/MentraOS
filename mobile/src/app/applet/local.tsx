import {useEffect, useRef, useState} from "react"
import {useLocalSearchParams} from "expo-router"
import {View} from "react-native"
import {Text} from "@/components/ignite"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import composer from "@/services/Composer"
import devServerBridge from "@/services/DevServerBridge"
import {installDevMiniappSnapshot, parseDevPort} from "@/services/miniapp/installDevSnapshot"
import {storage} from "@/utils/storage/storage"

/**
 * Pure mount destination for a dev or installed local miniapp. Reachability
 * is decided BEFORE we land here — see decideDevLaunchRoute and the entry
 * points (AppsGrid → startApplet, scanner, URL screen). If the dev server
 * is down, the entry point routes to /applet/dev-offline directly so we
 * never flash this route on the way there.
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
  const {goBack, setForceGestureEnabled} = useNavigationHistory()

  // Keep a stable ref to the latest goBack so we don't re-fire the mount effect
  // every render just because useNavigationHistory returned a new function.
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack

  useEffect(() => {
    if (!packageName) return

    const handleClose = () => {
      // Background the miniapp the same way installed apps are backgrounded:
      // WebView lives in 1×1 off-screen holder, JS keeps running, tile stays
      // visible in switcher / home tray. Dev miniapps are first-class
      // installed apps now (Composer-backed) so removal happens only via
      // explicit long-press → Remove, not on close.
      miniappHost.setBackground(packageName)
      goBackRef.current()
    }

    // Back press handler — if the WebView has history, pop it. Otherwise exit
    // to the Mentra home.
    const handleBack = () => {
      const wentBack = miniappHost.goBackInWebView(packageName)
      if (!wentBack) {
        goBackRef.current()
      }
    }

    let cancelled = false
    ;(async () => {
      const isDev = !!devUrl

      if (isDev) {
        // Reachability was pre-flighted by the entry point. Mount live.
        await miniappHost.mountDev(packageName, devUrl, {
          developerMode: true,
          appName,
          iconUrl,
        })
        const portNum = resolveDevPort(devPort, packageName)
        if (portNum !== null) {
          devServerBridge.connect(packageName, devUrl, portNum)
          void installDevMiniappSnapshot({packageName, devUrl, devPort: portNum}).catch((error) => {
            console.warn(`Dev miniapp snapshot failed for ${packageName}:`, error)
          })
        }
        storage.save(`${packageName}_dev_last_reachable`, Date.now())
      } else if (version) {
        const bundleDir = composer.getBundleDir(packageName, version)
        const bundleUri = `${bundleDir}/index.html`
        // Read the bundle's manifest from disk so the runtime can gate
        // SUBSCRIBE / one-shot calls against declared permissions. The
        // mountDev path fetches this from the live server; the installed
        // path reads from the unzipped bundle.
        const manifest = composer.getMiniappManifest(packageName, version) as
          | {permissions?: Array<{type: string; required?: boolean; description?: string}>; hardwareRequirements?: Array<{type: string; level: string; description?: string}>}
          | null
        miniappHost.mount(packageName, bundleUri, {
          developerMode: false,
          appName,
          iconUrl,
          manifest: manifest ?? undefined,
        })
      }

      if (cancelled) return
      miniappHost.setForeground(packageName, {onClose: handleClose, onBack: handleBack})
    })()

    return () => {
      cancelled = true
      // Background on navigate away, don't unmount — keep it alive
      miniappHost.setBackground(packageName)
    }
  }, [packageName, version, devUrl, devPort, appName, iconUrl])

  // Track WebView navigation state so we know whether "back" should pop the
  // WebView stack or exit the miniapp.
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  useEffect(() => {
    if (!packageName) return
    return miniappHost.subscribeCanGoBack(packageName, setWebViewCanGoBack)
  }, [packageName])

  // Dynamically toggle gesture handling based on webview navigation state:
  // - Page 0 (no history): force-enable React Navigation's native swipe-back
  //   so user can exit miniapp.
  // - Has history: WebView's allowsBackForwardNavigationGestures handles
  //   in-webview swipe; React Navigation's gesture stays blocked by the
  //   focusEffectPreventBack inside MiniAppCapsuleMenu.
  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  if (!packageName) {
    return <Text>Missing required parameters</Text>
  }

  // The actual WebView + CapsuleMenu render inside MiniappHost at app root so
  // they survive navigation. This route is just a hook for setForeground /
  // setBackground as the user navigates in/out.
  return <View style={{flex: 1, backgroundColor: "transparent"}} pointerEvents="box-none" />
}

/**
 * Resolve the dev server's sidecar port. Search params take precedence (fresh
 * QR scan); fall back to the persisted MMKV key (home-tile-tap path).
 */
function resolveDevPort(searchParam: string | undefined, packageName: string): number | null {
  const searchPort = parseDevPort(searchParam)
  if (searchPort !== null) return searchPort
  const stored = storage.load<number>(`${packageName}_dev_port`)
  if (stored.is_ok()) return stored.value
  return null
}
