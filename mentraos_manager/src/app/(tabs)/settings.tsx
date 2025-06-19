import React, {useState, useEffect, useRef} from "react"
import {View, Modal, ActivityIndicator} from "react-native"
import {Screen, Header, Text} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {translate} from "@/i18n"

import {useStatus} from "@/contexts/MentraOSStatusProvider"
import showAlert from "@/utils/AlertUtils"
import {useAuth} from "@/contexts/AuthContext"
import RouteButton from "@/components/ui/RouteButton"
import ActionButton from "@/components/ui/ActionButton"
import {Spacer} from "@/components/misc/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {isMentraUser} from "@/utils/isMentraUser"
import {isDeveloperBuildOrTestflight} from "@/utils/buildDetection"
import {loadSetting, saveSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import Toast from "react-native-toast-message"

export default function SettingsPage() {
  const {status} = useStatus()
  const {logout, user} = useAuth()
  const {theme} = useAppTheme()
  const {push, replace} = useNavigationHistory()
  const [devMode, setDevMode] = useState(true)
  const [isSigningOut, setIsSigningOut] = useState(false)

  useEffect(() => {
    const checkDevMode = async () => {
      const devModeSetting = await loadSetting(SETTINGS_KEYS.DEV_MODE, false)
      setDevMode(isDeveloperBuildOrTestflight() || isMentraUser(user?.email) || devModeSetting)
    }
    checkDevMode()
  }, [])

  const pressCount = useRef(0)
  const lastPressTime = useRef(0)
  const pressTimeout = useRef<NodeJS.Timeout | null>(null)

  const handleQuickPress = () => {
    push("/settings")

    const currentTime = Date.now()
    const timeDiff = currentTime - lastPressTime.current
    const maxTimeDiff = 2000
    const maxPressCount = 10
    const showAlertAtPressCount = 5

    // Reset counter if too much time has passed
    if (timeDiff > maxTimeDiff) {
      pressCount.current = 1
    } else {
      pressCount.current += 1
    }

    lastPressTime.current = currentTime

    // Clear existing timeout
    if (pressTimeout.current) {
      clearTimeout(pressTimeout.current)
    }

    // Handle different press counts
    if (pressCount.current === maxPressCount) {
      showAlert("Developer Mode", "Developer mode enabled!", [{text: translate("common:ok")}])
      saveSetting(SETTINGS_KEYS.DEV_MODE, true)
      pressCount.current = 0
    } else if (pressCount.current >= showAlertAtPressCount) {
      const remaining = maxPressCount - pressCount.current
      Toast.show({
        type: "info",
        text1: "Developer Mode",
        text2: `${remaining} more taps to enable developer mode`,
        position: "bottom",
        topOffset: 80,
        visibilityTime: 1000,
      })
    }

    // Reset counter after 2 seconds of no activity
    pressTimeout.current = setTimeout(() => {
      pressCount.current = 0
    }, maxTimeDiff)
  }

  const handleSignOut = async () => {
    try {
      console.log("Settings: Starting sign-out process")
      setIsSigningOut(true)

      await logout()

      console.log("Settings: Logout completed, navigating to login")

      // Reset the loading state before navigation
      setIsSigningOut(false)

      // Navigate to Login screen directly instead of SplashScreen
      // This ensures we skip the SplashScreen logic that might detect stale user data
      replace("/")
    } catch (err) {
      console.error("Settings: Error during sign-out:", err)
      setIsSigningOut(false)

      // Show user-friendly error but still navigate to login to prevent stuck state
      showAlert(translate("common:error"), translate("settings:signOutError"), [
        {
          text: translate("common:ok"),
          onPress: () => replace("/"),
        },
      ])
    }
  }

  const confirmSignOut = () => {
    showAlert(
      translate("settings:signOut"),
      translate("settings:signOutConfirm"),
      [
        {text: translate("common:cancel"), style: "cancel"},
        {text: translate("common:yes"), onPress: handleSignOut},
      ],
      {cancelable: false},
    )
  }

  return (
    <Screen preset="scroll" style={{paddingHorizontal: theme.spacing.lg}}>
      <Header leftTx="settings:title" onLeftPress={handleQuickPress} />

      <Spacer height={theme.spacing.xl} />

      <View style={{flex: 1, gap: theme.spacing.md}}>
        <RouteButton label={translate("settings:profileSettings")} onPress={() => push("/settings/profile")} />

        <RouteButton label={translate("settings:privacySettings")} onPress={() => push("/settings/privacy")} />

        {devMode && <RouteButton label="Theme Settings" onPress={() => push("/settings/theme")} />}

        {devMode && (
          <RouteButton
            label={translate("settings:developerSettings")}
            // subtitle={translate("settings:developerSettingsSubtitle")}
            onPress={() => push("/settings/developer")}
          />
        )}

        <ActionButton label={translate("settings:signOut")} variant="destructive" onPress={confirmSignOut} />
      </View>

      {/* Loading overlay for sign out */}
      <Modal visible={isSigningOut} transparent={true} animationType="fade">
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            justifyContent: "center",
            alignItems: "center",
          }}>
          <View
            style={{
              backgroundColor: theme.colors.background,
              padding: theme.spacing.xl,
              borderRadius: theme.spacing.md,
              alignItems: "center",
              minWidth: 200,
            }}>
            <ActivityIndicator size="large" color={theme.colors.tint} style={{marginBottom: theme.spacing.md}} />
            <Text preset="bold" style={{color: theme.colors.text}}>
              We're logging you out...
            </Text>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}
