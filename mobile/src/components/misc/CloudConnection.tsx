import {useEffect, useRef, useState} from "react"
import {View, ViewStyle, TextStyle} from "react-native"
import LinearGradient from "react-native-linear-gradient"
import Animated, {useSharedValue, withTiming} from "react-native-reanimated"
import {Icon} from "@/components/ignite"

import {Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {WebSocketStatus} from "@/services/WebSocketManager"
import {useRefreshApplets} from "@/stores/applets"
import {useConnectionStore} from "@/stores/connection"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/contexts/ThemeContext"
import {BackgroundTimer} from "@/utils/timers"

export default function CloudConnection() {
  const connectionStatus = useConnectionStore(state => state.status)
  const {themed} = useAppTheme()
  const cloudConnectionStatusAnim = useSharedValue(1)
  const [hideCloudConnection, setHideCloudConnection] = useState(true)
  const refreshApplets = useRefreshApplets()

  // Add delay logic for disconnection alerts
  const [delayedStatus, setDelayedStatus] = useState<WebSocketStatus>(connectionStatus)
  const disconnectionTimerRef = useRef<number | null>(null)
  const firstDisconnectedTimeRef = useRef<number | null>(null)
  const DISCONNECTION_DELAY = 5000 // 5 seconds delay

  /**
   * Return gradient colors based on the cloud connection status
   */
  const getGradientColors = (connectionStatus: WebSocketStatus): string[] => {
    switch (connectionStatus) {
      case WebSocketStatus.CONNECTED:
        return ["#4CAF50", "#81C784"] // Green gradient
      case WebSocketStatus.CONNECTING:
        return ["#FFA726", "#FB8C00"] // Orange gradient
      case WebSocketStatus.ERROR:
        return ["#FFC107", "#FFD54F"] // Yellow-ish gradient
      case WebSocketStatus.DISCONNECTED:
      default:
        return ["#FF8A80", "#FF5252"] // Red gradient
    }
  }

  /**
   * Return icon name and color based on connection status
   */
  const getIcon = (connectionStatus: WebSocketStatus): {name: string; color: string; label: string} => {
    switch (connectionStatus) {
      case WebSocketStatus.CONNECTED:
        return {
          name: "check-circle",
          color: "#4CAF50",
          label: translate("connection:connected"),
        }
      case WebSocketStatus.CONNECTING:
        return {
          name: "spinner",
          color: "#FB8C00",
          label: translate("connection:connecting"),
        }
      case WebSocketStatus.ERROR:
        return {
          name: "refresh",
          color: "#FFD54F",
          label: translate("connection:reconnecting"),
        }
      case WebSocketStatus.DISCONNECTED:
      default:
        return {
          name: "exclamation-circle",
          color: "#FF5252",
          label: translate("connection:disconnected"),
        }
    }
  }

  const {name: iconName, color: iconColor, label: statusLabel} = getIcon(delayedStatus)

  useEffect(() => {
    console.log("CloudConnection: Status:", connectionStatus)

    if (connectionStatus === WebSocketStatus.CONNECTED) {
      // Reset disconnection tracking
      firstDisconnectedTimeRef.current = null

      // Clear any pending timer
      if (disconnectionTimerRef.current) {
        BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }

      // Hide the banner immediately
      setDelayedStatus(connectionStatus)
      setHideCloudConnection(true)
      cloudConnectionStatusAnim.value = withTiming(0, {duration: 500})
    } else {
      // Not connected (DISCONNECTED, CONNECTING, or ERROR)

      // Track when we first left the connected state
      if (firstDisconnectedTimeRef.current === null) {
        firstDisconnectedTimeRef.current = Date.now()

        // Start timer to show banner after delay
        disconnectionTimerRef.current = BackgroundTimer.setTimeout(() => {
          setDelayedStatus(connectionStatus)
          cloudConnectionStatusAnim.value = withTiming(1, {duration: 500})
          BackgroundTimer.setTimeout(() => {
            setHideCloudConnection(false)
          }, 500)
        }, DISCONNECTION_DELAY)
      } else {
        // We're still disconnected but status changed (e.g., DISCONNECTED -> CONNECTING)
        // Update the displayed status only if the banner is already visible
        if (!hideCloudConnection) {
          setDelayedStatus(connectionStatus)
        }
      }
    }

    if (connectionStatus === WebSocketStatus.CONNECTED || connectionStatus === WebSocketStatus.DISCONNECTED) {
      refreshApplets()
    }

    // Cleanup function
    return () => {
      if (disconnectionTimerRef.current) {
        BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
    }
  }, [connectionStatus, hideCloudConnection])

  // if (connectionStatus === WebSocketStatus.CONNECTED) {
  //   return
  // }

  if (hideCloudConnection) {
    return null
  }

  return (
    <Animated.View style={[themed($animatedContainer), {opacity: cloudConnectionStatusAnim}]}>
      <LinearGradient colors={getGradientColors(delayedStatus)} style={themed($outerContainer)}>
        <View style={themed($innerContainer)}>
          <View style={themed($row)}>
            <Icon name={iconName} size={16} color={iconColor} style={themed($icon)} />
            <Text style={themed($text)} weight="medium">
              {statusLabel}
            </Text>
          </View>
        </View>
      </LinearGradient>
    </Animated.View>
  )
}

const $animatedContainer: ThemedStyle<ViewStyle> = () => ({
  zIndex: 999,
  // marginTop: -56,
  marginBottom: 8,
})

const $outerContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  borderRadius: spacing.s4,
})

const $innerContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderRadius: spacing.s4,
  elevation: 1,
  paddingHorizontal: spacing.s4,
  paddingVertical: spacing.s2,
  margin: spacing.s1,
})

const $row: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flexDirection: "row",
  justifyContent: "center",
})

const $icon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginRight: spacing.s2,
})

const $text: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
})
