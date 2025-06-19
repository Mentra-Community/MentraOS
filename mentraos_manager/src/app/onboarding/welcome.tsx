import React from "react"
import {View, Text, StyleSheet} from "react-native"
import {Screen} from "@/components/ignite"
import {saveSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {Button} from "@/components/ignite/Button"
import {FontAwesome} from "@expo/vector-icons"
import {Spacer} from "@/components/misc/Spacer"

export default function OnboardingWelcome() {
  const {appStatus, optimisticallyStopApp, clearPendingOperation, refreshAppStatus} = useAppStatus()
  const {theme, themed} = useAppTheme()
  const isDarkTheme = theme.isDark
  const {goBack, push, replace} = useNavigationHistory()
  const backendComms = BackendServerComms.getInstance()

  const stopAllApps = async () => {
    const runningApps = appStatus.filter(app => app.is_running)
    for (const runningApp of runningApps) {
      optimisticallyStopApp(runningApp.packageName)
      try {
        await backendComms.stopApp(runningApp.packageName)
        clearPendingOperation(runningApp.packageName)
      } catch (error) {
        console.error("stop app error:", error)
        refreshAppStatus()
      }
    }
  }

  // Skip onboarding and go directly to home
  const handleSkip = () => {
    // Mark onboarding as completed when skipped
    saveSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true)
    replace("/(tabs)/home")
  }

  // Continue to glasses selection screen
  const handleContinue = async () => {
    // Mark that onboarding should be shown on Home screen
    saveSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, false)

    // deactivate all running apps:
    await stopAllApps()

    router.push("/pairing/select-glasses-model")
  }

  return (
    <Screen preset="fixed" style={{backgroundColor: theme.colors.background}}>
      <View style={styles.mainContainer}>
        {/* <View style={styles.logoContainer}>
          <Icon
            name="augmented-reality"
            size={100}
            color={isDarkTheme ? '#FFFFFF' : '#2196F3'}
          />
        </View> */}

        <View style={styles.infoContainer}>
          <Text style={[styles.title, {color: theme.colors.text}]}>Welcome to MentraOS</Text>

          <Text style={[styles.description, {color: theme.colors.text}]}>
            Let's go through a quick tutorial to get you started with MentraOS.
          </Text>
        </View>

        <Button
          onPress={handleContinue}
          tx="common:continue"
          textAlignment="center"
          LeftAccessory={() => <FontAwesome name="chevron-right" size={16} color={theme.colors.text} />}
        />

        <Spacer height={10} />
        <Button
          onPress={handleSkip}
          tx="welcomeScreen:skipOnboarding"
          LeftAccessory={() => <FontAwesome name="step-forward" size={16} color={theme.colors.text} />}
        />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  buttonContainer: {
    alignItems: "center",
    flex: 0,
    justifyContent: "flex-end",
    paddingBottom: 40,
    width: "100%",
  },
  darkBackground: {
    backgroundColor: "#1c1c1c",
  },
  darkSubtext: {
    color: "#4a4a4a",
  },
  darkText: {
    color: "#1a1a1a",
  },
  description: {
    fontSize: 18,
    lineHeight: 26,
    marginBottom: 32,
    paddingHorizontal: 24,
    textAlign: "center",
  },
  infoContainer: {
    alignItems: "center",
    flex: 0,
    justifyContent: "center",
    marginBottom: 40,
    width: "100%",
  },
  lightBackground: {
    backgroundColor: "#f8f9fa",
  },
  lightSubtext: {
    color: "#e0e0e0",
  },
  lightText: {
    color: "#FFFFFF",
  },
  logoContainer: {
    alignItems: "center",
    flex: 0,
    justifyContent: "flex-end",
    paddingBottom: 40,
  },
  mainContainer: {
    flex: 1,
    flexDirection: "column",
    justifyContent: "center",
    padding: 24,
  },
  skipButtonContainer: {
    alignItems: "center",
    marginTop: 16,
    width: "100%",
  },
  title: {
    fontFamily: "Montserrat-Bold",
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 20,
    textAlign: "center",
  },
})
