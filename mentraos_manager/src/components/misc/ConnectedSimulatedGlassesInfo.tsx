import React, {useEffect, useRef} from "react"
import {View, Text, StyleSheet, TouchableOpacity, Animated, Linking} from "react-native"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useGlassesMirror} from "@/contexts/GlassesMirrorContext"
import GlassesDisplayMirror from "./GlassesDisplayMirror"
import {useAppTheme} from "@/utils/useAppTheme"
import {translate} from "@/i18n/translate"
import {useCameraPermissions} from "expo-camera"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import showAlert from "@/utils/AlertUtils"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"

export default function ConnectedSimulatedGlassesInfo() {
  const fadeAnim = useRef(new Animated.Value(0)).current
  const scaleAnim = useRef(new Animated.Value(0.8)).current
  const {status} = useStatus()
  const {events} = useGlassesMirror()
  const {theme} = useAppTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const {push} = useNavigationHistory()

  // Get the last event to display in the mirror
  const lastEvent = events.length > 0 ? events[events.length - 1] : null

  useEffect(() => {
    // Start animations
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 1200,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 8,
        tension: 60,
        useNativeDriver: true,
      }),
    ]).start()

    // Cleanup function
    return () => {
      fadeAnim.stopAnimation()
      scaleAnim.stopAnimation()
    }
  }, [])

  const sendDisconnectWearable = async () => {
    console.log("Disconnecting simulated wearable")
    try {
      await coreCommunicator.sendDisconnectWearable()
      await coreCommunicator.sendForgetSmartGlasses()
    } catch (error) {
      console.error("Error disconnecting simulated wearable:", error)
    }
  }

  // Function to navigate to fullscreen mode
  const navigateToFullScreen = async () => {
    // Check if camera permission is already granted
    if (permission?.granted) {
      push("/mirror/fullscreen")
      return
    }

    // Show alert asking for camera permission
    showAlert(
      translate("mirror:cameraPermissionRequired"),
      translate("mirror:cameraPermissionRequiredMessage"),
      [
        {
          text: translate("common:continue"),
          onPress: async () => {
            const permissionResult = await requestPermission()
            if (permissionResult.granted) {
              // Permission granted, navigate to fullscreen
              push("/mirror/fullscreen")
            } else if (!permissionResult.canAskAgain) {
              // Permission permanently denied, show settings alert
              showAlert(
                translate("mirror:cameraPermissionRequired"),
                translate("mirror:cameraPermissionRequiredMessage"),
                [
                  {
                    text: translate("common:cancel"),
                    style: "cancel",
                  },
                  {
                    text: translate("mirror:openSettings"),
                    onPress: () => Linking.openSettings(),
                  },
                ],
              )
            }
            // If permission denied but can ask again, do nothing (user can try again)
          },
        },
      ],
      {
        iconName: "camera",
      },
    )
  }

  return (
    <View style={styles.connectedContent}>
      {/* Mirror Display Area - Takes up all available space above bottom bar */}
      <Animated.View
        style={[
          styles.mirrorWrapper,
          {
            opacity: fadeAnim,
            transform: [{scale: scaleAnim}],
          },
        ]}>
        <View style={{flex: 1, width: "100%", position: "relative"}}>
          <GlassesDisplayMirror layout={lastEvent?.layout} fallbackMessage="Simulated Glasses Display" />
          {/* absolute position bottom right fullscreen button */}
          <TouchableOpacity style={{position: "absolute", bottom: 10, right: 10}} onPress={navigateToFullScreen}>
            {/* <Text>Fullscreen</Text> */}
            <Icon name="fullscreen" size={24} color={theme.colors.text} />
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  bottomBar: {
    alignItems: "center",
    backgroundColor: "#6750A414",
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 10,
    width: "100%",
  },
  connectedContent: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    marginBottom: 0,
  },
  deviceInfoContainer: {
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    height: 230,
    justifyContent: "space-between",
    marginTop: 16,
    paddingBottom: 0,
    paddingHorizontal: 10,
    paddingTop: 10,
    width: "100%", // Increased space above component to match ConnectedDeviceInfo
  },
  disconnectButton: {
    alignItems: "center",
    backgroundColor: "#E24A24",
    borderRadius: 12,
    flexDirection: "row",
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  disconnectText: {
    color: "#fff",
    fontFamily: "Montserrat-Regular",
    fontSize: 12,
    fontWeight: "500",
  },
  mirrorContainer: {
    height: "100%",
    padding: 0,
    width: "100%",
  },
  mirrorWrapper: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    marginBottom: 0,
    width: "100%",
  },
  simulatedGlassesText: {
    fontFamily: "Montserrat-Bold",
    fontSize: 16,
    fontWeight: "bold",
  },
})
