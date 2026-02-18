import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule, {GlassesNotReadyEvent} from "core"
import {useState, useEffect} from "react"
import {ActivityIndicator, Image, ImageStyle, Linking, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {BatteryStatus} from "@/components/glasses/info/BatteryStatus"
import {Button, Icon, Text} from "@/components/ignite"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import BrightnessSetting from "@/components/settings/BrightnessSetting"
import {Divider} from "@/components/ui/Divider"
import {StatusCard} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {
  getEvenRealitiesG1Image,
  getGlassesClosedImage,
  getGlassesImage,
  getGlassesOpenImage,
} from "@/utils/getGlassesImage"

import MicIcon from "assets/icons/component/MicIcon"
import {useCoreStore} from "@/stores/core"

const getBatteryIcon = (batteryLevel: number): string => {
  if (batteryLevel >= 75) return "battery-3"
  if (batteryLevel >= 50) return "battery-2"
  if (batteryLevel >= 25) return "battery-1"
  return "battery-0"
}

export const CompactDeviceStatus = ({style}: {style?: ViewStyle}) => {
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false)
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [showSimulatedGlasses, setShowSimulatedGlasses] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const glassesStyle = useGlassesStore((state) => state.style)
  const color = useGlassesStore((state) => state.color)
  const caseRemoved = useGlassesStore((state) => state.caseRemoved)
  const caseBatteryLevel = useGlassesStore((state) => state.caseBatteryLevel)
  const caseOpen = useGlassesStore((state) => state.caseOpen)
  const batteryLevel = useGlassesStore((state) => state.batteryLevel)
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const wifiSsid = useGlassesStore((state) => state.wifiSsid)
  const searching = useCoreStore((state) => state.searching)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  // Listen for glasses_not_ready event to know when glasses are actually booting
  useEffect(() => {
    const sub = CoreModule.addListener("glasses_not_ready", (_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      sub.remove()
    }
  }, [])

  // Reset booting state when glasses become fully booted or disconnected
  useEffect(() => {
    if (glassesFullyBooted || !glassesConnected) {
      setShowGlassesBooting(false)
    }
  }, [glassesFullyBooted, glassesConnected])

  if (defaultWearable.includes(DeviceTypes.SIMULATED)) {
    return <ConnectedSimulatedGlassesInfo style={style} mirrorStyle={{backgroundColor: theme.colors.background}} />
  }

  const connectGlasses = async () => {
    if (!defaultWearable) {
      push("/pairing/select-glasses-model")
      return
    }

    // setIsCheckingConnectivity(true)

    try {
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }
    } catch (error) {
      console.error("connect to glasses error:", error)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    } finally {
      // setIsCheckingConnectivity(false)
    }
    await CoreModule.connectDefault()
  }

  const handleConnectOrDisconnect = async () => {
    if (searching) {
      await CoreModule.disconnect()
      setIsCheckingConnectivity(false)
    } else {
      await connectGlasses()
    }
  }

  const getCurrentGlassesImage = () => {
    let image = getGlassesImage(defaultWearable)

    if (defaultWearable === DeviceTypes.G1) {
      let state = "folded"
      if (!caseRemoved) {
        state = caseOpen ? "case_open" : "case_close"
      }
      return getEvenRealitiesG1Image(glassesStyle, color, state, "l", theme.isDark, caseBatteryLevel)
    }

    if (!caseRemoved) {
      image = caseOpen ? getGlassesOpenImage(defaultWearable) : getGlassesClosedImage(defaultWearable)
    }

    return image
  }

  let isSearching = searching || isCheckingConnectivity
  let connectingText = translate("home:connectingGlasses")
  // Only show booting message when we've received a glasses_not_ready event
  if (showGlassesBooting) {
    connectingText = "Glasses are booting..."
  }

  const handleGetSupport = () => {
    showAlert(translate("home:getSupport"), translate("home:getSupportMessage"), [
      {text: translate("common:cancel"), style: "cancel"},
      {
        text: translate("common:continue"),
        onPress: () => Linking.openURL("https://mentraglass.com/contact"),
      },
    ])
  }

  if (!glassesConnected || !glassesFullyBooted || isSearching) {
    return (
      <View style={[themed($disconnectedContainer), style]}>
        <View style={themed($header)}>
          <Text style={themed($headerText)} text={defaultWearable} />
          <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
        </View>

        <View style={[themed($sideBySideContainer)]}>
          <Image source={getCurrentGlassesImage()} style={[themed($glassesImage)]} />
          <Button compactIcon preset="alternate" onPress={() => push("/settings/glasses")}>
            <Icon name="settings" size={24} color={theme.colors.foreground} />
          </Button>
        </View>

        <Divider />
        <Spacer height={theme.spacing.s6} />

        <View
          style={{
            flexDirection: "row",
            gap: theme.spacing.s2,
          }}>
          {!isSearching ? (
            <>
              <Button compact tx="home:getSupport" preset="alternate" onPress={handleGetSupport} />
              <Button compact flex tx="home:connectGlasses" preset="primary" onPress={connectGlasses} />
            </>
          ) : (
            <>
              <Button compactIcon flexContainer={false} preset="alternate" onPress={handleConnectOrDisconnect}>
                <Icon name="x" size={20} color={theme.colors.foreground} />
              </Button>
              <Button
                flex
                compact
                LeftAccessory={() => (
                  <ActivityIndicator size="small" color={theme.colors.primary_foreground} style={{marginRight: 8}} />
                )}
                text={connectingText}
                // tx="home:connectingGlasses"
              />
            </>
          )}
        </View>
      </View>
    )
  }

  const features = getModelCapabilities(defaultWearable)

  if (showSimulatedGlasses) {
    return (
      <View style={[themed($container), style]}>
        <View style={themed($header)}>
          <View style={{flexDirection: "row", alignItems: "center", gap: theme.spacing.s2}}>
            <Image source={getCurrentGlassesImage()} style={[themed($glassesImage), {width: 54, maxHeight: 24}]} />
            <Text style={themed($headerText)}>{defaultWearable}</Text>
          </View>
        </View>
        <View style={{marginHorizontal: -theme.spacing.s6}}>
          <ConnectedSimulatedGlassesInfo showHeader={false} mirrorStyle={{backgroundColor: theme.colors.background}} />
        </View>
        <View style={{flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.s2}}>
          <Button
            flexContainer={false}
            preset="alternate"
            onPress={() => setShowSimulatedGlasses(!showSimulatedGlasses)}>
            <Icon name="arrow-left" size={18} color={theme.colors.foreground} />
          </Button>
          <Button flexContainer={false} preset="alternate" onPress={() => push("/settings/glasses")}>
            <Icon name="settings" size={18} color={theme.colors.foreground} />
          </Button>
        </View>
      </View>
    )
  }

  return (
    <View style={[themed($container), style]}>
      {/* Header with device name and icons */}
      <View style={themed($header)}>
        <Text style={themed($headerText)}>{defaultWearable}</Text>
        <View style={themed($iconRow)}>
          {!isExpanded && batteryLevel !== -1 && (
            <View style={{flexDirection: "row", alignItems: "center", gap: theme.spacing.s1}}>
              <Icon name={getBatteryIcon(batteryLevel)} size={18} color={theme.colors.foreground} />
              <Text style={themed($iconText)}>{batteryLevel}%</Text>
            </View>
          )}
          <MicIcon width={18} height={18} />
          <Icon name="bluetooth-connected" size={18} color={theme.colors.foreground} />
          {features?.hasWifi &&
            (wifiConnected ? (
              <Button compactIcon className="bg-transparent -m-2" onPress={() => push("/wifi/scan")}>
                <Icon name="wifi" size={18} color={theme.colors.foreground} />
              </Button>
            ) : (
              <Button compactIcon className="bg-transparent -m-2" onPress={() => push("/wifi/scan")}>
                <Icon name="wifi-off" size={18} color={theme.colors.foreground} />
              </Button>
            ))}
        </View>
      </View>

      {/* Glasses Image */}
      <View
        style={[
          themed($imageContainer),
          {paddingVertical: isExpanded ? theme.spacing.s6 : theme.spacing.s4},
          !isExpanded && {
            alignItems: "center",
            justifyContent: "space-between",
            flexDirection: "row",
            paddingHorizontal: 0,
          },
        ]}>
        <Image source={getCurrentGlassesImage()} style={themed(isExpanded ? $glassesImageExpanded : $glassesImage)} />
        {!isExpanded && (
          <Button preset="alternate" onPress={() => push("/settings/glasses")}>
            <Icon name="settings" size={24} color={theme.colors.foreground} />
          </Button>
        )}
      </View>

      {/* Expanded Content */}
      {isExpanded && (
        <View style={themed($statusContainer)}>
          {/* Brightness Settings */}
          {features?.display?.adjustBrightness && glassesConnected && (
            <BrightnessSetting
              icon={<Icon name="brightness-half" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("deviceSettings:autoBrightness")}
              autoBrightnessValue={autoBrightness}
              brightnessValue={brightness}
              onAutoBrightnessChange={setAutoBrightness}
              onBrightnessChange={() => {}}
              onBrightnessSet={setBrightness}
              style={{backgroundColor: theme.colors.background}}
            />
          )}

          <BatteryStatus compact={true} />

          <View style={{flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.s2}}>
            {/* Glasses Mirror - only show for devices with display */}
            {features?.display && (
              <Button
                flex
                tx="home:glassesMirror"
                preset="alternate"
                onPress={() => setShowSimulatedGlasses(!showSimulatedGlasses)}
              />
            )}
            {/* WiFi Status - show for devices with WiFi but no display */}
            {features?.hasWifi && !features?.display && (
              <StatusCard
                style={{
                  flex: 1,
                  backgroundColor: theme.colors.background,
                  paddingHorizontal: theme.spacing.s4,
                }}
                label={translate("wifi:wifi")}
                onPress={() => push("/wifi/scan")}
                iconEnd={
                  <View className="flex-row items-center gap-1">
                    <Icon name={wifiConnected ? "wifi" : "wifi-off"} size={16} color={theme.colors.text} />
                    <Text className="text-sm font-semibold text-secondary-foreground" numberOfLines={1}>
                      {wifiConnected ? wifiSsid || "Connected" : "Disconnected"}
                    </Text>
                  </View>
                }
              />
            )}
            <Button compactIcon preset="alternate" onPress={() => push("/settings/glasses")}>
              <Icon name="settings" size={24} color={theme.colors.foreground} />
            </Button>
          </View>
          <Spacer height={theme.spacing.s3} />
        </View>
      )}

      {/* Expand/Collapse Button */}
      <Divider />
      <TouchableOpacity style={themed($expandButton)} onPress={() => setIsExpanded(!isExpanded)} activeOpacity={0.7}>
        <Icon name={isExpanded ? "chevron-up" : "chevron-down"} size={24} color={theme.colors.foreground} />
      </TouchableOpacity>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  backgroundColor: colors.primary_foreground,
  padding: spacing.s6,
})

const $imageContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 2,
  alignItems: "center",
  justifyContent: "center",
  alignSelf: "stretch",
  paddingHorizontal: spacing.s4,
})

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  maxWidth: 180,
  height: 90,
  resizeMode: "contain",
})

const $glassesImageExpanded: ThemedStyle<ImageStyle> = () => ({
  maxWidth: 200,
  height: 100,
  resizeMode: "contain",
})

const $header: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $headerText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.secondary_foreground,
  fontSize: 20,
  fontWeight: 600,
})

const $iconRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s3,
})

const $iconText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.secondary_foreground,
  fontSize: 14,
  fontWeight: 500,
})

const $sideBySideContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  paddingVertical: spacing.s6,
  alignItems: "center",
})

const $statusContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  gap: spacing.s3,
})

const $expandButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  paddingTop: spacing.s4,
})

const $disconnectedContainer: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  backgroundColor: colors.primary_foreground,
  padding: spacing.s6,
})
