import React, {useState, useEffect} from "react"
import {View, StyleSheet, TouchableOpacity, Platform, Alert, AppState} from "react-native"
import {Text} from "@/components/ignite"
import Icon from "react-native-vector-icons/MaterialIcons"
import {checkNotificationAccessSpecialPermission} from "@/utils/NotificationServiceUtils"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {showAlert} from "@/utils/AlertUtils"
import {useRoute} from "@react-navigation/native"
import {router} from "expo-router"

interface HeaderProps {
  isDarkTheme: boolean
  navigation: any
}

const Header: React.FC<HeaderProps> = ({isDarkTheme, navigation}) => {
  const [isDropdownVisible, setDropdownVisible] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(true)
  const [hasNotificationListenerPermission, setHasNotificationListenerPermission] = useState(true)
  const [hasCalendarPermission, setHasCalendarPermission] = useState(true)
  const [appState, setAppState] = useState(AppState.currentState)
  const route = useRoute()

  // Check permissions when component mounts
  // and when app comes back to foreground
  useEffect(() => {
    const checkPermissions = async () => {
      // Check notification permission
      if (Platform.OS === "android") {
        const hasNotificationPermission = await checkNotificationAccessSpecialPermission()
        setHasNotificationListenerPermission(hasNotificationPermission)
      } else {
        // TODO: ios (there's no way to get the notification permission on ios so just set to true to disable the warning)
        setHasNotificationListenerPermission(true)
      }

      // Check calendar permission
      const hasCalPermission = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
      setHasCalendarPermission(hasCalPermission)
    }

    // Check permissions on component mount
    checkPermissions()

    // Set up AppState listener to check permissions when app comes back to foreground
    const subscription = AppState.addEventListener("change", nextAppState => {
      if (appState.match(/inactive|background/) && nextAppState === "active") {
        // App has come to the foreground
        console.log("App has come to foreground, checking permissions")
        checkPermissions()
      }
      setAppState(nextAppState)
    })

    // Clean up subscription
    return () => {
      subscription.remove()
    }
  }, [appState, route.name])

  const handleNotificationAlert = () => {
    // Show explanation alert before navigating to privacy settings
    showAlert(
      "Additional Features Available",
      "Enhance your MentraOS experience by enabling additional permissions.",
      [
        {
          text: "Go to Settings",
          onPress: () => {
            // Navigate to PrivacySettingsScreen after explaining
            router.push({pathname: "/settings/privacy"})
          },
        },
      ],
      {
        iconName: "information-outline",
        iconColor: "#007AFF",
      },
    )
  }

  const textColor = isDarkTheme ? "#FFFFFF" : "#000000"

  return (
    <View style={styles.headerContainer}>
      <Text text="MentraOS" style={[styles.title, {color: textColor}]} numberOfLines={1} />

      {(!hasNotificationListenerPermission || !hasCalendarPermission) && (
        <TouchableOpacity style={styles.alertIconContainer} onPress={handleNotificationAlert}>
          <Icon name="notifications-off" size={24} color="#FF3B30" />
          <View style={styles.alertDot} />
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  alertDot: {
    backgroundColor: "#FF3B30",
    borderColor: "#FFFFFF",
    borderRadius: 5,
    borderWidth: 1,
    height: 10,
    position: "absolute",
    right: 4,
    top: 4,
    width: 10,
  },
  alertIconContainer: {
    padding: 8,
    position: "relative",
  },
  dropdown: {
    borderRadius: 8,
    elevation: 5,
    padding: 8,
    position: "absolute",
    right: 16,
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.3,
    shadowRadius: 3,
    top: 70,
    zIndex: 2,
  },
  dropdownItem: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  dropdownItemText: {
    fontSize: 16,
  },
  headerContainer: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginLeft: 8,
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 12,
    zIndex: 1,
    ...Platform.select({
      ios: {
        paddingTop: 16,
      },
      android: {
        paddingTop: 16,
      },
    }),
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
  },
})

export default Header
