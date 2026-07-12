import {useLocalSearchParams} from "expo-router"
import {useEffect, useRef} from "react"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {engine, useSetForeground} from "@mentra/engine"

/**
 * Transient handoff route for launching a DEV local miniapp from the scanner,
 * developer-url screen, or dev-offline "Try again". It does NOT mount the
 * miniapp itself — the always-on <Compositor /> overlay owns the single
 * LocalMiniappView mount (same as the home tile / app switcher launch path).
 *
 * On mount it: ensures the just-registered dev app is in the store (refresh),
 * foregrounds it so the Compositor takes over rendering, then resets the stack
 * to /home. The MiniappSplash covers the brief handoff window so there's no
 * blank frame before the overlay's open animation.
 */
export default function LocalMiniAppPage() {
  const {packageName, iconUrl} = useLocalSearchParams<{
    appName?: string
    packageName: string
    version?: string
    devUrl?: string
    iconUrl?: string
    devPort?: string
  }>()
  const {theme} = useAppTheme()
  const setForeground = useSetForeground()

  // Run the handoff exactly once. Guard so a re-render (e.g. param echo)
  // doesn't re-foreground / re-navigate mid-animation.
  const handedOff = useRef(false)

  useEffect(() => {
    if (handedOff.current) return
    handedOff.current = true

    const {clearHistoryAndGoHome} = useNavigationStore.getState()

    if (!packageName) {
      clearHistoryAndGoHome()
      return
    }

    const handoff = async () => {
      // Land the just-registered dev app in the store before foregrounding —
      // setForeground() no-ops if the package isn't in apps yet, and the
      // refresh kicked off by registerDevApp() is fire-and-forget.
      await engine.miniapps.refresh()
      // Compositor begins its fade-in + mounts LocalMiniappView (which runs its
      // own install/spawn phase machine inside the overlay).
      await setForeground(packageName)
      // Pop this route AFTER foregrounding so the overlay is already painting.
      clearHistoryAndGoHome()
    }

    void handoff()
  }, [packageName, setForeground])

  if (!packageName) {
    return <Text text="Missing required parameters" />
  }

  return (
    <View className="flex-1 bg-background">
      <MiniappSplash iconUrl={iconUrl} bgColor={theme.colors.background} isLoaded={false} />
    </View>
  )
}
