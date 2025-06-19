import React, {useEffect} from "react"
import {View, Text, StyleSheet} from "react-native"
import LinearGradient from "react-native-linear-gradient"
import Icon from "react-native-vector-icons/FontAwesome"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useAppTheme} from "@/utils/useAppTheme"

export default function CloudConnection() {
  const {status} = useStatus()

  useEffect(() => {
    // console.log("MentraOS Status Updated:", JSON.stringify(status, null, 2))
  }, [status])

  /**
   * Return gradient colors based on the cloud connection status
   */
  const getGradientColors = (connectionStatus: string | undefined): string[] => {
    switch (connectionStatus) {
      case "CONNECTED":
        return ["#4CAF50", "#81C784"] // Green gradient
      case "CONNECTING":
        return ["#FFA726", "#FB8C00"] // Orange gradient
      case "RECONNECTING":
        return ["#FFC107", "#FFD54F"] // Yellow-ish gradient
      case "DISCONNECTED":
      default:
        return ["#FF8A80", "#FF5252"] // Red gradient
    }
  }

  /**
   * Return icon name and color based on connection status
   */
  const getIcon = (connectionStatus: string | undefined): {name: string; color: string; label: string} => {
    switch (connectionStatus) {
      case "CONNECTED":
        return {name: "check-circle", color: "#4CAF50", label: "Connected"}
      case "CONNECTING":
        return {name: "spinner", color: "#FB8C00", label: "Connecting to cloud..."}
      case "RECONNECTING":
        return {name: "refresh", color: "#FFD54F", label: "Reconnecting to cloud..."}
      case "DISCONNECTED":
      default:
        return {name: "exclamation-circle", color: "#FF5252", label: "Disconnected from cloud"}
    }
  }

  const {theme} = useAppTheme()

  const currentStyles = theme.isDark ? darkThemeStyles : lightThemeStyles
  const {name: iconName, color: iconColor, label: statusLabel} = getIcon(status.core_info.cloud_connection_status)

  return (
    <LinearGradient
      colors={getGradientColors(status.core_info.cloud_connection_status)}
      style={currentStyles.outerContainer}>
      <View style={currentStyles.innerContainer}>
        <View style={currentStyles.row}>
          <Icon name={iconName} size={16} color={iconColor} style={currentStyles.icon} />
          <Text style={currentStyles.text}>{statusLabel}</Text>
        </View>
      </View>
    </LinearGradient>
  )
}

const lightThemeStyles = StyleSheet.create({
  icon: {
    marginRight: 6,
  },
  innerContainer: {
    backgroundColor: "#FFFFFF",
    borderRadius: 4,
    elevation: 1,
    padding: 8,
    shadowColor: "#000",
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  outerContainer: {
    borderRadius: 6,
    left: 0,
    margin: 4,
    padding: 2,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 999,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  text: {
    color: "#000",
    fontFamily: "Montserrat-Regular",
    fontSize: 14,
    fontWeight: "600",
  },
})

const darkThemeStyles = StyleSheet.create({
  ...lightThemeStyles,
  innerContainer: {
    ...lightThemeStyles.innerContainer,
    backgroundColor: "#121212",
    shadowColor: "#fff",
  },
  text: {
    ...lightThemeStyles.text,
    color: "#fff",
  },
})
