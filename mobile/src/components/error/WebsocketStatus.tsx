import {useEffect, useRef, useState} from "react"
import {TouchableOpacity, View} from "react-native"

import {Icon, Text, type IconTypes} from "@/components/ignite"
import {translate} from "@/i18n"
import {WebSocketStatus} from "@/services/WebSocketManager"
import {useRefresh} from "@mentra/island"
import {useConnectionStore} from "@/stores/connection"
import {BgTimer} from "@mentra/island"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useNavigationStore} from "@/stores/navigation"

type DisplayStatus = "connected" | "warning" | "disconnected"

const STATUS_CONFIG: Record<DisplayStatus, {icon: IconTypes; label: () => string; bgClass: string; iconColor: string}> = {
  connected: {
    icon: "wifi",
    label: () => translate("connection:connected"),
    bgClass: "bg-primary",
    iconColor: "#fff",
  },
  warning: {
    icon: "wifi",
    label: () => translate("connection:connecting"),
    bgClass: "bg-chart-3",
    iconColor: "#fff",
  },
  disconnected: {
    icon: "wifi-off",
    label: () => translate("connection:disconnected"),
    bgClass: "bg-destructive",
    iconColor: "#fff",
  },
}

export default function WebsocketStatus() {
  const connectionStatus = useConnectionStore((state) => state.status)
  const [displayStatus, setDisplayStatus] = useState<DisplayStatus>("connected")
  const [offlineMode] = useSetting(SETTINGS.offline_mode.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const refreshApplets = useRefresh()
  const {theme} = useAppTheme()
  const disconnectionTimerRef = useRef<number | null>(null)
  const DISCONNECTION_DELAY = 3000
  const prevConnectionStatusRef = useRef(connectionStatus)
  const {push} = useNavigationStore.getState()

  // Track whether the WS was observed as disconnected long enough that we
  // might genuinely have missed applet state changes. Flipped true by the
  // DISCONNECTION_DELAY timer below. Cleared on the next CONNECTED after
  // refresh fires. Under a reconnect storm (issue 101), the WS can flap
  // CONNECTED → DISCONNECTED → CONNECTED within a sub-second cycle; a flap
  // is not evidence we lost applet state, so refreshing on every CONNECTED
  // was amplifying the storm into a matching REST-call storm. This ref only
  // allows the refresh when the prior disconnect actually persisted past
  // the 3-second threshold the user-visible "warning → disconnected"
  // transition already respects.
  const wasSustainedDisconnectedRef = useRef(false)

  useEffect(() => {
    const prevStatus = prevConnectionStatusRef.current
    prevConnectionStatusRef.current = connectionStatus

    console.log(`WSM: useEffect: connectionStatus: ${connectionStatus}`)

    if (connectionStatus === WebSocketStatus.CONNECTED) {
      if (disconnectionTimerRef.current) {
        BgTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
      setDisplayStatus("connected")
      if (wasSustainedDisconnectedRef.current) {
        wasSustainedDisconnectedRef.current = false
        refreshApplets()
      }
      return
    }

    // Now you can compare:
    if (prevStatus === WebSocketStatus.CONNECTED) {
      // we just disconnected
      setDisplayStatus("warning")
      if (disconnectionTimerRef.current) {
        BgTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
      disconnectionTimerRef.current = BgTimer.setTimeout(() => {
        setDisplayStatus("disconnected")
        wasSustainedDisconnectedRef.current = true
        refreshApplets()
      }, DISCONNECTION_DELAY)
      return
    }

    return () => {
      if (disconnectionTimerRef.current) {
        BgTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
    }
  }, [connectionStatus])

  const config = STATUS_CONFIG[displayStatus]

  if (offlineMode) {
    return (
      <TouchableOpacity
        onPress={() => {
          push("/miniapps/settings/transcription")
        }}>
        <View
          className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-destructive`}>
          <Icon name="wifi-off" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">
            {translate("offlineMode:offlineMode")}
          </Text>
        </View>
      </TouchableOpacity>
    )
  }

  if (!superMode && displayStatus == "connected") {
    return null
  }

  return (
    <View
      className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full ${config.bgClass}`}>
      <Icon name={config.icon} size={14} color={theme.colors.secondary_foreground} />
      <Text className="text-secondary-foreground text-sm font-medium ml-2">{config.label()}</Text>
    </View>
  )
}
