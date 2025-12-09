import ChevronRight from "assets/icons/component/ChevronRight"
import MicIcon from "assets/icons/component/MicIcon"
import SolarLineIconsSet4 from "assets/icons/component/SolarLineIconsSet4"
import CoreModule from "core"
import {useState} from "react"
import {ActivityIndicator, Image, ImageStyle, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {BatteryStatus} from "@/components/glasses/info/BatteryStatus"
import {Button, Icon, Text} from "@/components/ignite"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import BrightnessSetting from "@/components/settings/BrightnessSetting"
import {Divider} from "@/components/ui/Divider"
import {Spacer} from "@/components/ui/Spacer"
import {useCoreStatus} from "@/contexts/CoreStatusProvider"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
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
import {useAppTheme} from "@/utils/useAppTheme"

import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"

const getBatteryIcon = (batteryLevel: number): string => {
  if (batteryLevel >= 75) return "battery-3"
  if (batteryLevel >= 50) return "battery-2"
  if (batteryLevel >= 25) return "battery-1"
  return "battery-0"
}

export const CompactDeviceStatus = ({style}: {style?: ViewStyle}) => {
  const {status} = useCoreStatus()
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false)
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [showSimulatedGlasses, setShowSimulatedGlasses] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const glassesConnected = useGlassesStore(state => state.connected)
  const glassesStyle = useGlassesStore(state => state.style)
  const glassesColor = useGlassesStore(state => state.color)
  const caseRemoved = useGlassesStore(state => state.caseRemoved)
  const caseBatteryLevel = useGlassesStore(state => state.caseBatteryLevel)
  const caseOpen = useGlassesStore(state => state.caseOpen)
  const batteryLevel = useGlassesStore(state => state.batteryLevel)

  // If no glasses paired, show Pair Glasses button
  if (!defaultWearable || defaultWearable === "null") {
    return (
      <View style={themed($disconnectedContainer)}>
        <Button
          textStyle={[{marginLeft: theme.spacing.s12}]}
          textAlignment="left"
          LeftAccessory={() => <SolarLineIconsSet4 color={theme.colors.textAlt} />}
          RightAccessory={() => <ChevronRight color={theme.colors.textAlt} />}
          onPress={() => push("/pairing/select-glasses-model")}
          tx="home:pairGlasses"
        />
      </View>
    )
  }

  if (defaultWearable.includes(DeviceTypes.SIMULATED)) {
    return <ConnectedSimulatedGlassesInfo style={style} mirrorStyle={{backgroundColor: theme.colors.background}} />
  }

  // Show simulated glasses view for simulated glasses
  // if (defaultWearable.includes(DeviceTypes.SIMULATED)) {
  // return <ConnectedSimulatedGlassesInfo />
  // }

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
    if (status.core_info.is_searching) {
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
      return getEvenRealitiesG1Image(glassesStyle, glassesColor, state, "l", theme.isDark, caseBatteryLevel)
    }

    if (!caseRemoved) {
      image = caseOpen ? getGlassesOpenImage(defaultWearable) : getGlassesClosedImage(defaultWearable)
    }

    return image
  }

  let isSearching = status.core_info.is_searching || isCheckingConnectivity

  if (!glassesConnected || isSearching) {
    return (
      <View style={[themed($disconnectedContainer), style]}>
        <View style={themed($header)}>
          <Text style={themed($headerText)} text={defaultWearable} />
          <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
        </View>

        <View style={[themed($sideBySideContainer)]}>
          <Image source={getCurrentGlassesImage()} style={[themed($glassesImage)]} />
          <Button
            style={{width: 48, height: 48}}
            flexContainer={false}
            preset="alternate"
            onPress={() => push("/settings/glasses")}>
            <Icon name="settings" size={20} color={theme.colors.foreground} />
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
              <Button compact flex tx="home:getSupport" preset="primary" />
              <Button compact flex tx="home:connectGlasses" preset="alternate" onPress={connectGlasses} />
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
                  <ActivityIndicator size="small" color={theme.colors.textAlt} style={{marginLeft: 5}} />
                )}
                tx="home:connectingGlasses"
              />
            </>
          )}
        </View>
        {/* <View style={[themed($disconnectedImageContainer)]}> */}
        {/* </View> */}
        {/* <Button
          textStyle={[{marginLeft: theme.spacing.s12}]}
          textAlignment="left"
          LeftAccessory={() => <SolarLineIconsSet4 color={theme.colors.textAlt} />}
          RightAccessory={() => <ChevronRight color={theme.colors.textAlt} />}
          onPress={handleConnectOrDisconnect}
          tx="home:connectGlasses"
          disabled={isCheckingConnectivity}
        /> */}
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
          {/* <Icon icon="bluetooth-connected" size={18} color={theme.colors.textDim} /> */}
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
          {features?.hasWifi && <Icon name="wifi" size={18} color={theme.colors.foreground} />}
        </View>
      </View>

      {/* Glasses Image */}
      <View
        style={[
          themed($imageContainer),
          {paddingVertical: isExpanded ? theme.spacing.s6 : theme.spacing.s4},
          !isExpanded && {alignItems: "flex-start", justifyContent: "flex-start", paddingLeft: 0},
        ]}>
        <Image source={getCurrentGlassesImage()} style={themed(isExpanded ? $glassesImageExpanded : $glassesImage)} />
        {!isExpanded && (
          <Button
            flexContainer={false}
            preset="alternate"
            style={{position: "absolute", right: 0, top: 37}}
            onPress={() => push("/settings/glasses")}>
            <Icon name="settings" size={20} color={theme.colors.foreground} />
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
            <Button
              flex
              tx="home:glassesMirror"
              preset="alternate"
              onPress={() => setShowSimulatedGlasses(!showSimulatedGlasses)}
            />
            <Button flexContainer={false} preset="alternate" onPress={() => push("/settings/glasses")}>
              <Icon name="settings" size={18} color={theme.colors.foreground} />
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
