import {useEffect, useRef, useState} from "react"
import {TouchableOpacity, View} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {WebSocketStatus} from "@/services/WebSocketManager"
import {useRefreshApplets} from "@/stores/applets"
import {useConnectionStore} from "@/stores/connection"
import {BackgroundTimer} from "@/utils/timers"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

type DisplayStatus = "connected" | "warning" | "disconnected"

const STATUS_CONFIG: Record<DisplayStatus, {icon: string; label: () => string; bgClass: string; iconColor: string}> = {
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
  const refreshApplets = useRefreshApplets()
  const {theme} = useAppTheme()
  const disconnectionTimerRef = useRef<number | null>(null)
  const DISCONNECTION_DELAY = 3000
  const prevConnectionStatusRef = useRef(connectionStatus)
  const {push} = useNavigationHistory()

  useEffect(() => {
    const prevStatus = prevConnectionStatusRef.current
    prevConnectionStatusRef.current = connectionStatus

    console.log(`WSM: useEffect: connectionStatus: ${connectionStatus}`)

    if (connectionStatus === WebSocketStatus.CONNECTED) {
      if (disconnectionTimerRef.current) {
        BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
      setDisplayStatus("connected")
      refreshApplets()
      return
    }

    // Now you can compare:
    if (prevStatus === WebSocketStatus.CONNECTED) {
      // we just disconnected
      setDisplayStatus("warning")
      if (disconnectionTimerRef.current) {
        BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
      disconnectionTimerRef.current = BackgroundTimer.setTimeout(() => {
        setDisplayStatus("disconnected")
        refreshApplets()
      }, DISCONNECTION_DELAY)
      return
    }

    return () => {
      if (disconnectionTimerRef.current) {
        BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
    }
  }, [connectionStatus])

  const config = STATUS_CONFIG[displayStatus]

  if (offlineMode) {
    return (
      <TouchableOpacity
        onPress={() => {
          push("/settings/transcription")
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
