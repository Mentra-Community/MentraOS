import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, StyleSheet, ActivityIndicator} from "react-native"
import {Text} from "@/components/ignite"

interface LoadingOverlayProps {
  message?: string
}

/**
 * A consistent loading overlay component to be used across the app
 * for loading states, especially during transitions between screens.
 */
const LoadingOverlay: React.FC<LoadingOverlayProps> = ({message = "Loading..."}) => {
  const {themed, theme} = useAppTheme()
  const isDarkTheme = theme.isDark
  // Theme-based colors
  const theme2 = {
    backgroundColor: isDarkTheme ? "rgba(0, 0, 0, 0.8)" : "rgba(255, 255, 255, 0.85)",
    textColor: isDarkTheme ? "#FFFFFF" : "#333333",
    primaryColor: "#0088FF",
  }

  return (
    <View style={[styles.container, {backgroundColor: theme2.backgroundColor}]}>
      <View style={styles.contentContainer}>
        <ActivityIndicator size="large" color={theme2.primaryColor} style={styles.spinner} />
        <Text text={message} style={[styles.message, {color: theme2.textColor}]} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1000,
  },
  contentContainer: {
    alignItems: "center",
    borderRadius: 10,
    justifyContent: "center",
    padding: 20,
  },
  message: {
    fontSize: 16,
    fontWeight: "500",
    textAlign: "center",
  },
  spinner: {
    marginBottom: 12,
  },
})

export default LoadingOverlay
