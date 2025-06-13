import React, {useEffect, useState} from "react"
import {View, Text, StyleSheet, TouchableOpacity, Platform, ScrollView, AppState, Alert} from "react-native"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import {
  displayPermissionDeniedWarning,
  doesHaveAllPermissions,
  requestGrantPermissions as requestGrantBasicPermissions,
  requestAugmentOSPermissions,
  PermissionFeatures,
  requestFeaturePermissions,
  requestBasicPermissions,
  markPermissionRequested,
} from "@/utils/PermissionsUtils"
import {Button} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {router} from "expo-router"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

const GrantPermissionsScreen: React.FC = () => {
  const {goBack, push, replace} = useNavigationHistory()
  const {theme} = useAppTheme()
  const [appState, setAppState] = useState(AppState.currentState)
  const [isMonitoringAppState, setIsMonitoringAppState] = useState(false)

  useEffect(() => {
    ;(async () => {
      if (await doesHaveAllPermissions()) {
        // Alert, you already have the perms! Why are you even here? Go away!

        replace("/home")
        return
      }
    })()
  }, [])

  useEffect(() => {
    let subscription: any

    if (isMonitoringAppState) {
      subscription = AppState.addEventListener("change", async nextAppState => {
        if (appState.match(/inactive|background/) && nextAppState === "active") {
          console.log("App has come to foreground!")

          if (await doesHaveAllPermissions()) {
            // Check if we have background location
            const hasBackgroundLocation = await requestFeaturePermissions(PermissionFeatures.BACKGROUND_LOCATION)
            // Battery optimization temporarily disabled
            // const hasBatteryOptimization = await requestFeaturePermissions(PermissionFeatures.BATTERY_OPTIMIZATION);

            replace("/home")
            return
          } else {
            await displayPermissionDeniedWarning("Required Permissions")
          }
        }
        setAppState(nextAppState)
      })
    }

    return () => {
      if (subscription) {
        subscription.remove()
      }
    }
  }, [appState, isMonitoringAppState])

  const triggerGrantPermissions = async () => {
    // Request all basic permissions first
    let basicPermissionsGranted = await requestBasicPermissions()
    console.log("Basic permissions request completed")

    if (basicPermissionsGranted) {
      // Request notification permissions with explanation
      Alert.alert(
        "Notification Access",
        "AugmentOS would like to access your notifications to forward them to your smart glasses. This enhances your experience by showing phone notifications on your glasses.",
        [
          {
            text: "Grant Access",
            onPress: async () => {
              await requestFeaturePermissions(PermissionFeatures.READ_NOTIFICATIONS)
              requestCalendarAccess()
            },
          },
          {
            text: "Skip for Now",
            style: "cancel",
            onPress: () => requestCalendarAccess(),
          },
        ],
      )
    } else {
      // Basic permissions were denied
      await displayPermissionDeniedWarning("Required Permissions")
    }
  }

  const requestCalendarAccess = () => {
    // After notification permission flow, request optional calendar permission
    Alert.alert(
      "Calendar Access",
      "AugmentOS would like to access your calendar to display events on your smart glasses. This permission is optional.",
      [
        {
          text: "Grant Access",
          onPress: async () => {
            await requestFeaturePermissions(PermissionFeatures.CALENDAR)
            proceedToNextScreen()
          },
        },
        {
          text: "Skip",
          style: "cancel",
          onPress: () => proceedToNextScreen(),
        },
      ],
    )
  }

  const proceedToNextScreen = async () => {
    // Mark that we've shown all permission requests, even if some were skipped
    // This will prevent the permissions screen from showing again
    await markPermissionRequested(PermissionFeatures.BASIC)
    await markPermissionRequested(PermissionFeatures.READ_NOTIFICATIONS)
    await markPermissionRequested(PermissionFeatures.CALENDAR)

    console.log("Proceeding to next screen regardless of optional permissions")

    // Add a small delay to ensure state updates have completed
    setTimeout(() => {
      replace("/home")
    }, 100)
  }

  return (
    <View style={[styles.container, theme.isDark ? styles.darkBackground : styles.lightBackground]}>
      <ScrollView style={styles.scrollViewContainer}>
        <View style={styles.contentContainer}>
          <View style={styles.iconContainer}>
            <Icon name="shield-check" size={80} color={theme.isDark ? "#FFFFFF" : "#2196F3"} />
          </View>

          <Text style={[styles.title, theme.isDark ? styles.lightText : styles.darkText]}>Permissions Required</Text>

          <Text style={[styles.description, theme.isDark ? styles.lightSubtext : styles.darkSubtext]}>
            AugmentOS needs permissions to function properly. Please grant access to continue using all features.
          </Text>
          <Button
            disabled={false}
            onPress={() => {
              triggerGrantPermissions()
            }}>
            Grant Permissions
          </Button>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollViewContainer: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100%",
  },
  iconContainer: {
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    fontFamily: "Montserrat-Bold",
    textAlign: "center",
    marginBottom: 16,
  },
  description: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 40,
    lineHeight: 24,
    paddingHorizontal: 24,
  },
  button: {
    backgroundColor: "#2196F3",
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    width: "100%",
    maxWidth: 300,
    elevation: 3,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  buttonText: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 18,
    fontWeight: "600",
  },
  darkBackground: {
    backgroundColor: "#1c1c1c",
  },
  lightBackground: {
    backgroundColor: "#f8f9fa",
  },
  darkText: {
    color: "#1a1a1a",
  },
  lightText: {
    color: "#FFFFFF",
  },
  darkSubtext: {
    color: "#4a4a4a",
  },
  lightSubtext: {
    color: "#e0e0e0",
  },
})

export default GrantPermissionsScreen
