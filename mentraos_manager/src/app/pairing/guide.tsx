import React, {useState, useEffect, useRef, useCallback} from "react"
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ViewStyle,
  BackHandler,
  Platform,
} from "react-native"
import {useNavigation, useRoute} from "@react-navigation/native"
import {useFocusEffect} from "@react-navigation/native"
import Icon from "react-native-vector-icons/FontAwesome"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import coreCommunicator from "@/bridge/CoreCommunicator"
import PairingDeviceInfo from "@/components/misc/PairingDeviceInfo"
import GlassesTroubleshootingModal from "@/components/misc/GlassesTroubleshootingModal"
import GlassesPairingLoader from "@/components/misc/GlassesPairingLoader"
import {getPairingGuide} from "@/utils/getPairingGuide"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {Screen} from "@/components/ignite/Screen"
import {ThemedStyle} from "@/theme"
import {Header} from "@/components/ignite/Header"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import showAlert from "@/utils/AlertUtils"

export default function GlassesPairingGuideScreen() {
  const {goBack, push, clearHistory} = useNavigationHistory()
  const {status} = useStatus()
  const route = useRoute()
  const {glassesModelName} = route.params as {glassesModelName: string}
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const [showHelpAlert, setShowHelpAlert] = useState(false)
  const [pairingInProgress, setPairingInProgress] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasAlertShownRef = useRef(false)

  // Shared function to handle the forget glasses logic
  const handleForgetGlasses = useCallback(async () => {
    setPairingInProgress(false)
    await coreCommunicator.sendDisconnectWearable()
    await coreCommunicator.sendForgetSmartGlasses()
    // Clear NavigationHistoryContext history to prevent issues with back navigation
    clearHistory()
    // Use dismissTo to properly go back to select-glasses-model and clear the stack
    router.dismissTo("/pairing/select-glasses-model")
  }, [clearHistory])

  // Handle Android hardware back button
  useEffect(() => {
    // Only handle on Android
    if (Platform.OS !== "android") return

    const onBackPress = () => {
      // Call our custom back handler
      handleForgetGlasses()
      // Return true to prevent default back behavior and stop propagation
      return true
    }

    // Use setTimeout to ensure our handler is registered after NavigationHistoryContext
    const timeout = setTimeout(() => {
      // Add the event listener - this will be on top of the stack
      const backHandler = BackHandler.addEventListener("hardwareBackPress", onBackPress)

      // Store the handler for cleanup
      backHandlerRef.current = backHandler
    }, 100)

    // Cleanup function
    return () => {
      clearTimeout(timeout)
      if (backHandlerRef.current) {
        backHandlerRef.current.remove()
        backHandlerRef.current = null
      }
    }
  }, [handleForgetGlasses])

  // Ref to store the back handler for cleanup
  const backHandlerRef = useRef<any>(null)

  // Timer to show help message after 30 seconds
  useEffect(() => {
    // Reset state when entering screen
    hasAlertShownRef.current = false
    setShowHelpAlert(false)
    setPairingInProgress(true)

    // Set timer for showing help popup
    timerRef.current = setTimeout(() => {
      // Only show alert if not already paired and alert hasn't been shown before
      if (!status.glasses_info?.model_name && !hasAlertShownRef.current) {
        setShowHelpAlert(true)
        hasAlertShownRef.current = true
      }
    }, 30000) // 30 seconds

    return () => {
      // Clear timer on unmount
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [glassesModelName])

  // Show help alert if showHelpAlert is true
  useEffect(() => {
    if (showHelpAlert) {
      showAlert("Need Some Help?", `Having trouble pairing your ${glassesModelName}? Want some tips?`, [
        {
          text: "No, thanks.",
          style: "cancel",
          onPress: () => setShowHelpAlert(false),
        },
        {
          text: "Help Me!",
          onPress: () => {
            setShowTroubleshootingModal(true)
            setShowHelpAlert(false)
          },
        },
      ])
    }
  }, [showHelpAlert, glassesModelName])

  useEffect(() => {
    // If pairing successful, return to home
    if (status.core_info.puck_connected && status.glasses_info?.model_name) {
      // console.log("RETURN HOME FROM PAIR SCREEN: GOT MODEL NAME: " + status.glasses_info?.model_name);
      // Clear any pending timers when pairing succeeds
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      router.push({pathname: "/(tabs)/home"})
    }
  }, [status])

  const {themed, theme} = useAppTheme()
  const isDarkTheme = theme.isDark

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}}>
      <Header leftIcon="caretLeft" onLeftPress={handleForgetGlasses} />
      {pairingInProgress ? (
        // Show the beautiful animated loader while pairing is in progress
        <GlassesPairingLoader glassesModelName={glassesModelName} />
      ) : (
        // Show pairing guide if user chooses to view instructions
        <ScrollView style={styles.scrollViewContainer}>
          <View style={styles.contentContainer}>
            <PairingDeviceInfo glassesModelName={glassesModelName} />
            {getPairingGuide(glassesModelName)}

            <TouchableOpacity
              style={[styles.helpButton, {backgroundColor: isDarkTheme ? "#3b82f6" : "#007BFF"}]}
              onPress={() => setShowTroubleshootingModal(true)}>
              <Icon name="question-circle" size={16} color="#FFFFFF" style={styles.helpIcon} />
              <Text style={styles.helpButtonText}>Need Help Pairing?</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* {pairingInProgress && (
          <TouchableOpacity 
            style={[styles.instructionsButton, isDarkTheme ? styles.darkButton : styles.lightButton]}
            onPress={() => setPairingInProgress(false)}
          >
            <Text style={[styles.instructionsButtonText, isDarkTheme ? styles.darkText : styles.lightText]}>
              View Manual Pairing Instructions
            </Text>
          </TouchableOpacity>
        )}
        

        {!pairingInProgress && (
          <TouchableOpacity 
            style={[styles.instructionsButton, isDarkTheme ? styles.darkButton : styles.lightButton]}
            onPress={() => setPairingInProgress(true)}
          >
            <Text style={[styles.instructionsButtonText, isDarkTheme ? styles.darkText : styles.lightText]}>
              Return to Pairing Animation
            </Text>
          </TouchableOpacity>
        )} */}

      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        glassesModelName={glassesModelName}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  contentContainer: {
    alignItems: "center",
    justifyContent: "flex-start",
  },
  darkBackground: {
    backgroundColor: "#1c1c1c",
  },
  darkButton: {
    backgroundColor: "#333333",
  },
  darkText: {
    color: "#FFFFFF",
  },
  glassesImage: {
    height: 60,
    marginTop: 20,
    resizeMode: "contain",
    width: 100,
  },
  helpButton: {
    alignItems: "center",
    borderRadius: 8,
    flexDirection: "row",
    justifyContent: "center",
    marginBottom: 30,
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  helpButtonText: {
    color: "#FFFFFF",
    fontFamily: "Montserrat-Regular",
    fontSize: 16,
    fontWeight: "600",
  },
  helpIcon: {
    marginRight: 8,
  },
  instructionsButton: {
    alignSelf: "center",
    borderRadius: 8,
    marginBottom: 20,
    marginTop: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  instructionsButtonText: {
    fontFamily: "Montserrat-Regular",
    fontSize: 14,
    fontWeight: "500",
  },
  lightBackground: {
    //backgroundColor: '#f9f9f9',
  },
  lightButton: {
    backgroundColor: "#e5e7eb",
  },
  lightText: {
    color: "#333333",
  },
  scrollViewContainer: {
    flex: 1,
  },
  text: {
    fontSize: 16,
    marginBottom: 10,
  },
})
