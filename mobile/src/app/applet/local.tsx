import {useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useRef, useState} from "react"
import {Platform, View} from "react-native"

import {Text} from "@/components/ignite"
import LocalMiniappView, {type LocalMiniappViewHandle} from "@/components/miniapp/LocalMiniappView"
import {useNavigationStore} from "@/stores/navigation"
import {useRegisterCapsule} from "@/stores/capsule"

/**
 * Route mount for a DEV local miniapp (QR scanner, developer-url, dev-offline,
 * catalog launch). Installed local miniapps are foregrounded through the
 * <Compositor /> overlay instead (see AppSwitcher → setForeground); this route
 * stays for the dev flows because the dev app often isn't in the apps store
 * yet — it gets installed during LocalMiniappView's launch.
 *
 * The route owns the capsule button + React-Navigation back-gesture wiring
 * (the Compositor owns those for the overlay path). LocalMiniappView owns the
 * WebView + JSContext lifecycle.
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

  const viewRef = useRef<LocalMiniappViewHandle | null>(null)
  const viewShotRef = useRef<View | null>(null)
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)

  // Drive React Navigation's swipe-back gesture: enabled only when the WebView
  // has no in-app history. Mirrors /applet/webview so iOS users get the native
  // pop-gesture animation when exiting the miniapp.
  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  // Capsule menu back press: pop the WebView's history first, else pop the
  // route. Mirrors webview.tsx's handleWebViewBack for the two-layer path.
  const handleCapsuleBack = useCallback(() => {
    const popped = viewRef.current?.goBack() ?? false
    if (popped) return
    if (Platform.OS === "android") {
      goBackRef.current()
    }
    // iOS handles the route pop via the gesture or the capsule's own
    // captureScreenshot+exit pipeline inside useRegisterCapsule.
  }, [])

  useRegisterCapsule({
    packageName: packageName ?? "",
    viewShotRef,
    visibleOnRoutes: ["/applet/local"],
    onBackPress: handleCapsuleBack,
  })

  if (!packageName) {
    return <Text text="Missing required parameters" />
  }

  return (
    <View ref={viewShotRef} className="flex-1 bg-background">
      <LocalMiniappView
        ref={viewRef}
        packageName={packageName}
        appName={appName}
        version={version}
        devUrl={devUrl}
        iconUrl={iconUrl}
        devPort={devPort}
        onExit={() => goBackRef.current()}
        onCanGoBackChange={setWebViewCanGoBack}
      />
    </View>
  )
}
