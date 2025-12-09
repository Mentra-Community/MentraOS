import CoreModule from "core"
import {useEffect, useState} from "react"
import {AppState, Platform, ScrollView} from "react-native"

import {Header, Screen} from "@/components/ignite"
import PermissionButton from "@/components/settings/PermButton"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles} from "@/theme"
import {checkAndRequestNotificationAccessSpecialPermission} from "@/utils/NotificationServiceUtils"
import {checkFeaturePermissions, PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export default function PrivacySettingsScreen() {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [calendarEnabled, setCalendarEnabled] = useState(true)
  const [calendarPermissionPending, setCalendarPermissionPending] = useState(false)
  const [locationEnabled, setLocationEnabled] = useState(true)
  const [locationPermissionPending, setLocationPermissionPending] = useState(false)
  const [appState, setAppState] = useState(AppState.currentState)
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [sensingEnabled, setSensingEnabled] = useSetting(SETTINGS.sensing_enabled.key)

  // Check permissions when screen loads
  useEffect(() => {
    const checkPermissions = async () => {
      console.log("Checking permissions in PrivacySettingsScreen")
      // Check notification permissions
      if (Platform.OS === "android") {
        const hasNotificationAccess = await CoreModule.hasNotificationListenerPermission()
        setNotificationsEnabled(hasNotificationAccess)
      }

      // Check calendar permissions
      const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
      setCalendarEnabled(hasCalendar)

      // Check location permissions
      const hasLocation = await checkFeaturePermissions(PermissionFeatures.BACKGROUND_LOCATION)
      setLocationEnabled(hasLocation)
    }

    checkPermissions()
  }, [])

  const checkPermissions = async () => {
    if (Platform.OS === "android") {
      const hasNotificationAccess = await CoreModule.hasNotificationListenerPermission()

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
  }

  // Monitor app state to detect when user returns from settings
  useEffect(() => {
    const subscription = AppState.addEventListener("change", nextAppState => {
      if (appState.match(/inactive|background/) && nextAppState === "active") {
        // App has come to the foreground - recheck permissions
        console.log("App returned to foreground, rechecking notification permissions")
        checkPermissions()
      }
      setAppState(nextAppState)
    })

    return () => {
      subscription.remove()
    }
  }, []) // subscribe only once

  const toggleSensing = async () => {
    const newSensing = !sensingEnabled
    await setSensingEnabled(newSensing)
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
      const hasAccess = await CoreModule.hasNotificationListenerPermission()
      if (hasAccess) {
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
        let granted = await requestFeaturePermissions(PermissionFeatures.LOCATION)
        console.log(`Location permission request result:`, granted)
        if (Platform.OS === "ios" && granted) {
          granted = await requestFeaturePermissions(PermissionFeatures.BACKGROUND_LOCATION)
          console.log(`Background location permission request result:`, granted)
        }
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
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header titleTx="privacySettings:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView>
        {/* Notification Permission - Android Only */}
        {Platform.OS === "android" && !notificationsEnabled && (
          <>
            <PermissionButton
              label={translate("settings:notificationsLabel")}
              subtitle={translate("settings:notificationsSubtitle")}
              value={notificationsEnabled}
              onPress={handleToggleNotifications}
            />
            <Spacer height={theme.spacing.s4} />
          </>
        )}

        {/* Calendar Permission - only show if not granted */}
        {!calendarEnabled && (
          <>
            <PermissionButton
              label={translate("settings:calendarLabel")}
              subtitle={translate("settings:calendarSubtitle")}
              value={calendarEnabled}
              onPress={handleToggleCalendar}
            />
            <Spacer height={theme.spacing.s4} />
          </>
        )}

        {/* Location Permission - only show if not granted */}
        {!locationEnabled && (
          <>
            <PermissionButton
              label={translate("settings:locationLabel")}
              subtitle={translate("settings:locationSubtitle")}
              value={locationEnabled}
              onPress={handleToggleLocation}
            />
            <Spacer height={theme.spacing.s4} />
          </>
        )}

        <ToggleSetting
          label={translate("settings:sensingLabel")}
          subtitle={translate("settings:sensingSubtitle")}
          value={sensingEnabled}
          onValueChange={toggleSensing}
        />
      </ScrollView>
    </Screen>
  )
}
