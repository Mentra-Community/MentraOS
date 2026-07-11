import {useEffect, useRef, useState} from "react"
import {ImageStyle, TextStyle, View, ViewStyle} from "react-native"
import LinearGradient from "react-native-linear-gradient"
import Animated, {useSharedValue, withTiming} from "react-native-reanimated"

import {Icon, Text, type IconTypes} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import {engine, useRefresh} from "@mentra/engine"
import {ThemedStyle} from "@/theme"
import {BgTimer} from "@mentra/engine"

// Mirrors engine's CloudClientConnectionStatus (not exported from the public
// engine surface). The banner now renders the cloud-v2 runtime connection,
// not the retired Cloud V1 websocket.
type CloudStatus = "connected" | "connecting" | "reconnecting" | "disconnected"

export default function CloudConnection() {
  const connectionStatus = useEngineSnapshot(
    () => engine.session.status().status as CloudStatus,
    (onChange) => engine.session.onStatus(() => onChange()),
  )
  const {themed} = useAppTheme()
  const cloudConnectionStatusAnim = useSharedValue(1)
  const [hideCloudConnection, setHideCloudConnection] = useState(true)
  const refreshApplets = useRefresh()

  // Add delay logic for disconnection alerts
  const [delayedStatus, setDelayedStatus] = useState<CloudStatus>(connectionStatus)
  const disconnectionTimerRef = useRef<number | null>(null)
  const firstDisconnectedTimeRef = useRef<number | null>(null)
  const DISCONNECTION_DELAY = 5000 // 5 seconds delay

  /**
   * Return gradient colors based on the cloud connection status
   */
  const getGradientColors = (connectionStatus: CloudStatus): string[] => {
    switch (connectionStatus) {
      case "connected":
        return ["#4CAF50", "#81C784"] // Green gradient
      case "connecting":
        return ["#FFA726", "#FB8C00"] // Orange gradient
      case "reconnecting":
        return ["#FFC107", "#FFD54F"] // Yellow-ish gradient
      case "disconnected":
      default:
        return ["#FF8A80", "#FF5252"] // Red gradient
    }
  }

  /**
   * Return icon name and color based on connection status
   */
  const getIcon = (connectionStatus: CloudStatus): {name: IconTypes; color: string; label: string} => {
    switch (connectionStatus) {
      case "connected":
        return {
          name: "check-circle",
          color: "#4CAF50",
          label: translate("connection:connected"),
        }
      case "connecting":
        return {
          name: "spinner",
          color: "#FB8C00",
          label: translate("connection:connecting"),
        }
      case "reconnecting":
        return {
          name: "refresh",
          color: "#FFD54F",
          label: translate("connection:reconnecting"),
        }
      case "disconnected":
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

    if (connectionStatus === "connected") {
      // Reset disconnection tracking
      firstDisconnectedTimeRef.current = null

      // Clear any pending timer
      if (disconnectionTimerRef.current) {
        BgTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }

      // Hide the banner immediately
      setDelayedStatus(connectionStatus)
      setHideCloudConnection(true)
      cloudConnectionStatusAnim.value = withTiming(0, {duration: 500})
    } else {
      // Not connected (disconnected, connecting, or reconnecting)

      // Track when we first left the connected state
      if (firstDisconnectedTimeRef.current === null) {
        firstDisconnectedTimeRef.current = Date.now()

        // Start timer to show banner after delay
        disconnectionTimerRef.current = BgTimer.setTimeout(() => {
          setDelayedStatus(connectionStatus)
          cloudConnectionStatusAnim.value = withTiming(1, {duration: 500})
          BgTimer.setTimeout(() => {
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

    if (connectionStatus === "connected" || connectionStatus === "disconnected") {
      refreshApplets()
    }

    // Cleanup function
    return () => {
      if (disconnectionTimerRef.current) {
        BgTimer.clearTimeout(disconnectionTimerRef.current)
        disconnectionTimerRef.current = null
      }
    }
  }, [connectionStatus, hideCloudConnection])

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

const $icon: ThemedStyle<ImageStyle> = ({spacing}) => ({
  marginRight: spacing.s2,
})

const $text: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
})
