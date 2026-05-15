import {View} from "react-native"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useGlassesStore} from "@/stores/glasses"

/**
 * Shown when glasses report a captive-portal WiFi network (Android NET_CAPABILITY_CAPTIVE_PORTAL).
 */
export function CaptivePortalWifiBanner() {
  const {theme} = useAppTheme()
  const show = useGlassesStore((s) => s.wifi.state === "connected" && s.wifi.captivePortal === true)

  if (!show) {
    return null
  }

  return (
    <View
      className="rounded-xl border px-3 py-3"
      style={{
        backgroundColor: theme.colors.warningPink,
        borderColor: theme.colors.warningPinkBorder,
      }}>
      <Text className="text-base font-semibold text-text mb-1" tx="wifi:captivePortalTitle" />
      <Text className="text-sm text-text-dim leading-5" tx="wifi:captivePortalMessage" />
    </View>
  )
}
