import React, {useCallback, useEffect, useRef, useState} from "react"
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  Switch,
  ViewStyle,
  TextStyle,
} from "react-native"
import {useFocusEffect} from "@react-navigation/native"
import {Button, Icon} from "@/components/ignite"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import {getGlassesImage} from "@/utils/getGlassesImage"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {getBatteryColor, getBatteryIcon} from "@/utils/getBatteryIcon"
import {Slider} from "react-native-elements"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import ToggleSetting from "../settings/ToggleSetting"
import SliderSetting from "../settings/SliderSetting"
import {FontAwesome, MaterialCommunityIcons} from "@expo/vector-icons"
import {translate} from "@/i18n/translate"
import showAlert from "@/utils/AlertUtils"
import SunIcon from "assets/icons/component/SunIcon"
import ChevronRight from "assets/icons/component/ChevronRight"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import RouteButton from "../ui/RouteButton"
import ActionButton from "../ui/ActionButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {glassesFeatures} from "@/config/glassesFeatures"

export default function DeviceSettings() {
  const fadeAnim = useRef(new Animated.Value(0)).current
  const scaleAnim = useRef(new Animated.Value(0.8)).current
  const slideAnim = useRef(new Animated.Value(-50)).current
  const {theme, themed} = useAppTheme()
  const [connectedGlasses, setConnectedGlasses] = useState("")
  const {status} = useStatus()
  const [preferredMic, setPreferredMic] = useState(status.core_info.preferred_mic)

  const [isConnectButtonDisabled, setConnectButtonDisabled] = useState(false)
  const [isDisconnectButtonDisabled, setDisconnectButtonDisabled] = useState(false)
  const {push} = useNavigationHistory()

  const {model_name} = status.glasses_info ?? {}
  const {default_wearable} = status.core_info ?? {}

  useFocusEffect(
    useCallback(() => {
      // Reset animations to initial values
      fadeAnim.setValue(0)
      scaleAnim.setValue(0.8)
      slideAnim.setValue(-50)

      // Update connectedGlasses state when default_wearable changes
      if (status.core_info.default_wearable) {
        setConnectedGlasses(status.core_info.default_wearable)
      }

      // Start animations if device is connected
      if (status.core_info.puck_connected) {
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
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 700,
            useNativeDriver: true,
          }),
        ]).start()
      }
      if (status.core_info.default_wearable !== "") {
        setDisconnectButtonDisabled(false)
      }
      // Cleanup function
      return () => {
        fadeAnim.stopAnimation()
        scaleAnim.stopAnimation()
        slideAnim.stopAnimation()
      }
    }, [status.core_info.default_wearable, status.core_info.puck_connected, fadeAnim, scaleAnim, slideAnim]),
  )

  const sendDisconnectWearable = async () => {
    setDisconnectButtonDisabled(true)
    setConnectButtonDisabled(false)

    console.log("Disconnecting wearable")

    try {
      await coreCommunicator.sendDisconnectWearable()
    } catch (error) {}
  }

  let [autoBrightness, setAutoBrightness] = useState(status?.glasses_settings?.auto_brightness ?? true)
  let [brightness, setBrightness] = useState(status?.glasses_settings?.brightness ?? 50)

  useEffect(() => {
    setBrightness(status?.glasses_settings?.brightness ?? 50)
    setAutoBrightness(status?.glasses_settings?.auto_brightness ?? true)
  }, [status?.glasses_settings?.brightness, status?.glasses_settings?.auto_brightness])

  const setMic = async (val: string) => {
    if (val === "phone") {
      // We're potentially about to enable the mic, so request permission
      const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
      if (!hasMicPermission) {
        // Permission denied, don't toggle the setting
        console.log("Microphone permission denied, cannot enable phone microphone")
        showAlert(
          "Microphone Permission Required",
          "Microphone permission is required to use the phone microphone feature. Please grant microphone permission in settings.",
          [{text: "OK"}],
          {
            iconName: "microphone",
            iconColor: "#2196F3",
          },
        )
        return
      }
    }

    setPreferredMic(val)
    await coreCommunicator.sendSetPreferredMic(val)
  }

  const confirmForgetGlasses = () => {
    showAlert(
      translate("settings:forgetGlasses"),
      translate("settings:forgetGlassesConfirm"),
      [
        {text: translate("common:cancel"), style: "cancel"},
        {
          text: translate("common:yes"),
          onPress: () => {
            coreCommunicator.sendForgetSmartGlasses()
          },
        },
      ],
      {
        cancelable: false,
      },
    )
  }

  let hasBrightness = true
  if (status?.glasses_info?.model_name === "Simulated Glasses") {
    hasBrightness = false
  }
  if (status?.glasses_info?.model_name?.toLowerCase().includes("live")) {
    hasBrightness = false
  }
  if (!status?.glasses_info?.model_name) {
    hasBrightness = false
  }

  // Check if we need to show any helper text
  const needsGlassesPaired = !status.core_info.default_wearable
  const hasDisplay = status.core_info.default_wearable && glassesFeatures[status.core_info.default_wearable]?.display

  // Check if no glasses are paired at all
  if (!status.core_info.default_wearable) {
    return (
      <View style={themed($container)}>
        <View style={themed($emptyStateContainer)}>
          <Text style={themed($emptyStateText)}>
            Glasses settings will appear here.{'\n'}Pair glasses to adjust settings.
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View style={themed($container)}>
      {/* Show helper text if glasses are paired but not connected */}
      {!status.glasses_info?.model_name && status.core_info.default_wearable && (
        <View style={themed($infoContainer)}>
          <Text style={themed($infoText)}>Changes to glasses settings will take effect when glasses are connected.</Text>
        </View>
      )}

      {hasBrightness && (
        <View style={themed($settingsGroup)}>
          <ToggleSetting
            label="Auto Brightness"
            value={autoBrightness}
            onValueChange={value => {
              setAutoBrightness(value)
              coreCommunicator.setGlassesBrightnessMode(brightness, value)
            }}
            containerStyle={{paddingHorizontal: 0, paddingTop: 0, paddingBottom: autoBrightness ? 0 : undefined}}
          />

          {!autoBrightness && (
            <>
              <View style={{height: 1, backgroundColor: theme.colors.separator, marginBottom: theme.spacing.xs}} />
              <SliderSetting
                label="Brightness"
                value={brightness}
                onValueChange={setBrightness}
                min={0}
                max={100}
                onValueSet={value => {
                  coreCommunicator.setGlassesBrightnessMode(value, autoBrightness)
                }}
                containerStyle={{paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0}}
              />
            </>
          )}
        </View>
      )}

      <View style={themed($settingsGroup)}>
        <TouchableOpacity
          style={{flexDirection: "row", justifyContent: "space-between", paddingVertical: 8}}
          onPress={() => setMic("phone")}>
          <Text style={{color: theme.colors.text}}>{translate("deviceSettings:phoneMic")}</Text>
          <MaterialCommunityIcons
            name="check"
            size={24}
            color={preferredMic === "phone" ? theme.colors.checkmark : "transparent"}
          />
        </TouchableOpacity>
        {/* divider */}
        <View style={{height: 1, backgroundColor: theme.colors.separator, marginVertical: 4}} />
        <TouchableOpacity
          style={{flexDirection: "row", justifyContent: "space-between", paddingVertical: 8}}
          onPress={() => setMic("glasses")}>
          <View style={{flexDirection: "column", gap: 4}}>
            <Text style={{color: theme.colors.text}}>{translate("deviceSettings:glassesMic")}</Text>
            {/* {!status.glasses_info?.model_name && (
              <Text style={themed($subtitle)}>{translate("deviceSettings:glassesNeededForGlassesMic")}</Text>
            )} */}
          </View>
          <MaterialCommunityIcons
            name="check"
            size={24}
            color={preferredMic === "glasses" ? theme.colors.checkmark : "transparent"}
          />
        </TouchableOpacity>
      </View>

      {/* Only show WiFi settings if connected glasses support WiFi */}
      {status.glasses_info?.model_name && glassesFeatures[status.glasses_info.model_name]?.wifi && (
        <RouteButton
          label={translate("settings:glassesWifiSettings")}
          subtitle={translate("settings:glassesWifiDescription")}
          onPress={() => {
            push({
              pathname: "/pairing/glasseswifisetup",
              params: {deviceModel: status.glasses_info?.model_name || "Glasses"},
            })
          }}
        />
      )}


      <RouteButton
        label={translate("settings:dashboardSettings")}
        subtitle={translate("settings:dashboardDescription")}
        onPress={() => push("/settings/dashboard")}
      />

      <RouteButton
        label={translate("settings:screenSettings")}
        subtitle={translate("settings:screenDescription")}
        onPress={() => push("/settings/screen")}
      />

      {status.glasses_info?.model_name && (
        <ActionButton
          label={translate("settings:disconnectGlasses")}
          variant="destructive"
          onPress={() => {
            coreCommunicator.sendDisconnectWearable()
          }}
        />
      )}

      {status.core_info.default_wearable && (
        <ActionButton
          label={translate("settings:forgetGlasses")}
          variant="destructive"
          onPress={confirmForgetGlasses}
        />
      )}

      <View style={{height: 30}}>{/* this just gives the user a bit more space to scroll */}</View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  borderRadius: 12,
  width: "100%",
  minHeight: 240,
  justifyContent: "center",
  marginTop: 16, // Increased space above component
  // backgroundColor: colors.palette.neutral200,
  backgroundColor: "transparent",
  gap: 16,
})

const $settingsGroup: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderRadius: spacing.md,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.sm,
})

const $infoContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.sm,
  marginBottom: spacing.sm,
})

const $infoText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  textAlign: "center",
})

const $emptyStateContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.xxl,
  minHeight: 300,
})

const $emptyStateText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.text,
  fontSize: 20,
  textAlign: "center",
  lineHeight: 28,
  fontWeight: "500",
})

const styles = StyleSheet.create({
  glassesImage: {
    width: "80%",
    height: 120,
    resizeMode: "contain",
  },
  statusValue: {
    fontSize: 14,
    fontWeight: "bold",
    fontFamily: "Montserrat-Bold",
  },
  connectedDot: {
    fontSize: 14,
    marginRight: 2,
    fontFamily: "Montserrat-Bold",
  },
  separator: {
    marginHorizontal: 10,
    fontSize: 16,
    fontWeight: "bold",
    fontFamily: "Montserrat-Bold",
  },
  connectedTextGreen: {
    color: "#28a745",
    marginLeft: 4,
    marginRight: 2,
    fontSize: 16,
    fontWeight: "bold",
    fontFamily: "Montserrat-Bold",
  },
  connectedTextTitle: {
    fontSize: 16,
    fontWeight: "bold",
    fontFamily: "Montserrat-Bold",
  },
  statusLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    letterSpacing: -0.08,
    fontFamily: "SF Pro",
  },
  connectText: {
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 10,
    fontFamily: "Montserrat-Bold",
  },
  noGlassesText: {
    color: "black",
    textAlign: "center",
    fontSize: 16,
    marginBottom: 10,
  },
  connectButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    // backgroundColor moved to dynamic styling with theme
    padding: 10,
    borderRadius: 8,
    width: "80%",
  },
  connectingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    // backgroundColor moved to dynamic styling with theme
    padding: 10,
    borderRadius: 8,
    width: "80%",
  },
  disabledButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    // backgroundColor moved to dynamic styling with theme
    padding: 10,
    borderRadius: 8,
    width: "80%",
  },
  disabledDisconnectButton: {
    // backgroundColor moved to dynamic styling with theme
  },
  icon: {
    marginRight: 4,
  },
  buttonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
    fontFamily: "Montserrat-Bold",
  },
  disconnectButton: {
    flexDirection: "row",
    // backgroundColor moved to dynamic styling with theme
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    justifyContent: "center",
    marginRight: 5,
    width: "40%",
  },
  disconnectText: {
    // color moved to dynamic styling with theme
    fontSize: 12,
    fontWeight: "500",
    fontFamily: "Montserrat-Regular",
  },
  statusIndicatorsRow: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    //height: 30,
  },
  iconContainer: {
    // backgroundColor moved to dynamic styling with theme
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
  },
  wifiContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 18,
  },
  wifiSsidText: {
    fontSize: 12,
    // color moved to dynamic styling with theme
    fontWeight: "bold",
    marginRight: 5,
    maxWidth: 120,
  },
})
