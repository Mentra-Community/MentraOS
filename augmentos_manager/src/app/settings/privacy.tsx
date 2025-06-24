import React, {useEffect} from "react"
import {
  View,
  Text,
  StyleSheet,
  Switch,
  Platform,
  ScrollView,
  AppState,
  NativeModules,
  Linking,
  ViewStyle,
  TextStyle,
} from "react-native"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {requestFeaturePermissions, PermissionFeatures, checkFeaturePermissions} from "@/utils/PermissionsUtils"
import {
  checkNotificationAccessSpecialPermission,
  checkAndRequestNotificationAccessSpecialPermission,
} from "@/utils/NotificationServiceUtils"
// import {NotificationService} from '@/utils/NotificationServiceUtils';
import showAlert from "@/utils/AlertUtils"
import {Header, Screen} from "@/components/ignite"
import {spacing, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {translate} from "@/i18n"
import {Spacer} from "@/components/misc/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function PrivacySettingsScreen() {
  const {status} = useStatus()
  const [isSensingEnabled, setIsSensingEnabled] = React.useState(status.core_info.sensing_enabled)
  const [forceCoreOnboardMic, setForceCoreOnboardMic] = React.useState(status.core_info.force_core_onboard_mic)
  const [isContextualDashboardEnabled, setIsContextualDashboardEnabled] = React.useState(
    status.core_info.contextual_dashboard_enabled,
  )
  const [notificationsEnabled, setNotificationsEnabled] = React.useState(true)
  const [calendarEnabled, setCalendarEnabled] = React.useState(true)
  const [calendarPermissionPending, setCalendarPermissionPending] = React.useState(false)
  const [locationEnabled, setLocationEnabled] = React.useState(true)
  const [locationPermissionPending, setLocationPermissionPending] = React.useState(false)
  const [appState, setAppState] = React.useState(AppState.currentState)
  const {theme} = useAppTheme()
  const {goBack, push} = useNavigationHistory()
  // Check permissions when screen loads
  useEffect(() => {
    const checkPermissions = async () => {
      console.log("Checking permissions in PrivacySettingsScreen")
      // Check notification permissions
      if (Platform.OS === "android") {
        const hasNotificationAccess = await checkNotificationAccessSpecialPermission()
        setNotificationsEnabled(hasNotificationAccess)
      }

      // Check calendar permissions
      const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
      setCalendarEnabled(hasCalendar)

      // Check location permissions
      const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
      setLocationEnabled(hasLocation)
    }

    checkPermissions()
  }, [])

  useEffect(() => {
    console.log("Calendar enabled:", calendarEnabled)
  }, [calendarEnabled])

  // Monitor app state to detect when user returns from settings
  useEffect(() => {
    const subscription = AppState.addEventListener("change", nextAppState => {
      if (appState.match(/inactive|background/) && nextAppState === "active") {
        // App has come to the foreground - recheck permissions
        console.log("App returned to foreground, rechecking notification permissions")
        ;(async () => {
          if (Platform.OS === "android") {
            const hasNotificationAccess = await checkNotificationAccessSpecialPermission()

            // If permission was granted while away, enable notifications and start service
            if (hasNotificationAccess && !notificationsEnabled) {
              console.log("Notification permission was granted while away, enabling notifications")
              setNotificationsEnabled(true)

              // Start notification listener service
              try {
                // await NotificationService.startNotificationListenerService();
              } catch (error) {
                console.error("Error starting notification service:", error)
              }
            }
          } else {
            const hasNotifications = await checkFeaturePermissions(PermissionFeatures.READ_NOTIFICATIONS)
            if (hasNotifications && !notificationsEnabled) {
              setNotificationsEnabled(true)
            }
          }

          if (Platform.OS === "ios") {
            console.log("Adding delay before checking iOS calendar permissions")
            await new Promise(resolve => setTimeout(resolve, 1500)) // 1.5 second delay
          }

          // Also recheck calendar permissions
          const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
          if (Platform.OS === "ios" && calendarPermissionPending) {
            // If we're in the middle of requesting permissions, don't flip back to false
            if (hasCalendar) {
              setCalendarEnabled(true)
            }
            // Don't set to false even if hasCalendar is false temporarily
          } else {
            // Normal case - update if different
            if (hasCalendar !== calendarEnabled) {
              setCalendarEnabled(hasCalendar)
            }
          }

          // Also recheck location permissions
          const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
          if (Platform.OS === "ios" && locationPermissionPending) {
            // If we're in the middle of requesting permissions, don't flip back to false
            if (hasLocation) {
              setLocationEnabled(true)
            }
            // Don't set to false even if hasLocation is false temporarily
          } else {
            // Normal case - update if different
            if (hasLocation !== locationEnabled) {
              setLocationEnabled(hasLocation)
            }
          }
        })()
      }
      setAppState(nextAppState)
    })

    return () => {
      subscription.remove()
    }
  }, [appState, notificationsEnabled, calendarEnabled, locationEnabled])

  const toggleSensing = async () => {
    const newSensing = !isSensingEnabled
    await coreCommunicator.sendToggleSensing(newSensing)
    setIsSensingEnabled(newSensing)
  }

  const handleToggleNotifications = async () => {
    if (Platform.OS !== "android") {
      return
    }

    // Only request permission if not already granted
    if (!notificationsEnabled) {
      // Try to request notification access
      await checkAndRequestNotificationAccessSpecialPermission()

      // Re-check permissions after the request
      const hasAccess = await checkNotificationAccessSpecialPermission()
      if (hasAccess) {
        // Start notification listener service if permission granted
        //   await NotificationService.startNotificationListenerService();
        setNotificationsEnabled(true)
      }
    }
  }

  const handleToggleCalendar = async () => {
    // Only request permission if not already granted
    if (!calendarEnabled) {
      // Immediately set pending state to prevent toggle flicker
      setCalendarPermissionPending(true)
      try {
        const granted = await requestFeaturePermissions(PermissionFeatures.CALENDAR)
        console.log(`Calendar permission request result:`, granted)
        if (granted) {
          setCalendarEnabled(true)
        } else {
          setCalendarEnabled(false)
        }
      } catch (error) {
        console.error("Error requesting calendar permissions:", error)
        setCalendarEnabled(false)
      } finally {
        // Make sure we're setting pending to false after everything else is done
        setTimeout(() => {
          setCalendarPermissionPending(false)
        }, 300)
      }
    }
  }

  const handleToggleLocation = async () => {
    // Only request permission if not already granted
    if (!locationEnabled) {
      // Immediately set pending state to prevent toggle flicker
      setLocationPermissionPending(true)
      try {
        const granted = await requestFeaturePermissions(PermissionFeatures.LOCATION)
        console.log(`Location permission request result:`, granted)
        if (granted) {
          setLocationEnabled(true)
        } else {
          setLocationEnabled(false)
        }
      } catch (error) {
        console.error("Error requesting location permissions:", error)
        setLocationEnabled(false)
      } finally {
        // Make sure we're setting pending to false after everything else is done
        setTimeout(() => {
          setLocationPermissionPending(false)
        }, 300)
      }
    }
  }

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}}>
      <Header titleTx="privacySettings:title" leftIcon="caretLeft" onLeftPress={goBack} />
      <ScrollView>
        {/* Notification Permission - Android Only */}
        {Platform.OS === "android" && !notificationsEnabled && (
          <>
            <ToggleSetting
              label={translate("settings:notificationsLabel")}
              subtitle={translate("settings:notificationsSubtitle")}
              value={notificationsEnabled}
              onValueChange={handleToggleNotifications}
            />
            <Spacer height={theme.spacing.md} />
          </>
        )}

        {/* Calendar Permission - only show if not granted */}
        {!calendarEnabled && (
          <>
            <ToggleSetting
              label={translate("settings:calendarLabel")}
              subtitle={translate("settings:calendarSubtitle")}
              value={calendarEnabled}
              onValueChange={handleToggleCalendar}
            />
            <Spacer height={theme.spacing.md} />
          </>
        )}

        {/* Location Permission - only show if not granted */}
        {!locationEnabled && (
          <>
            <ToggleSetting
              label={translate("settings:locationLabel")}
              subtitle={translate("settings:locationSubtitle")}
              value={locationEnabled}
              onValueChange={handleToggleLocation}
            />
            <Spacer height={theme.spacing.md} />
          </>
        )}

        <ToggleSetting
          label={translate("settings:sensingLabel")}
          subtitle={translate("settings:sensingSubtitle")}
          value={isSensingEnabled}
          onValueChange={toggleSensing}
        />
      </ScrollView>
    </Screen>
  )
}
