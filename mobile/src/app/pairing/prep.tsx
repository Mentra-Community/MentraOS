import {DeviceTypes, engine} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import {Image, Platform, ScrollView, View} from "react-native"
import type {ImageStyle, ViewStyle} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useState} from "react"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {CDN_BASE_URL} from "@/constants/appConfig"
import {getAr99DisplayName, getAr99ImageSource} from "@/utils/getGlassesImage"
import {ThemedStyle} from "@/theme"
import {preparePairingScan} from "@/utils/pairing/preparePairingScan"
import {isMentraLiveSecurePairingEnabled} from "@/utils/pairing/securePairingFeature"
import {deploymentStore} from "@/services/deployment"

export default function PairingPrepScreen() {
  const route = useRoute()
  const {deviceModel, ar99ProjectName} = route.params as {deviceModel: string; ar99ProjectName?: string}
  const displayName = deviceModel === DeviceTypes.AR99 ? getAr99DisplayName(ar99ProjectName) : deviceModel
  const {goBack, push, clearHistoryAndGoHome} = useNavigationStore.getState()
  const {themed} = useAppTheme()
  const useRemoteMedia = deploymentStore.getActive().kind === "consumer"

  const advanceToPairing = async () => {
    const readyToScan = await preparePairingScan(deviceModel)
    if (!readyToScan) return

    // skip pairing for simulated glasses:
    if (deviceModel.startsWith(DeviceTypes.SIMULATED)) {
      await engine.glasses.connectSimulated()
      clearHistoryAndGoHome()
      return
    }

    push("/pairing/scan", {deviceModel, ar99ProjectName})
  }

  const SimulatedPairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start">
        <Text text="Preview MentraOS" className="text-2xl font-bold mb-4 text-secondary-foreground" />
        <GlassesDisplayMirror demoText="Simulated glasses display" />
        <Text
          text="Experience the full power of MentraOS without physical glasses. Simulated Glasses provides a virtual display that mirrors exactly what you would see on real smart glasses."
          className="text-sm text-secondary-foreground mt-6"
        />
      </View>
    )
  }

  const MentraLivePairingGuide = () => {
    const CDN_BASE = `${CDN_BASE_URL}/onboarding/mentra-live/light`
    const poster = require("@assets/onboarding/live/thumbnails/ONB0_power.png")
    const steps: OnboardingStep[] = useRemoteMedia
      ? [
          {
            name: "power_on_tutorial",
            type: "video",
            source: `${CDN_BASE}/ONB1_power_button_loop.mp4`,
            poster,
            transition: false,
            title: translate("pairing:powerOn"),
            subtitle: translate("onboarding:livePowerOnTutorial"),
            info: translate("onboarding:livePowerOnInfo"),
            playCount: -1,
            showButtonImmediately: true,
          },
        ]
      : [
          {
            name: "power_on_tutorial",
            type: "image",
            source: poster,
            transition: false,
            title: translate("pairing:powerOn"),
            subtitle: translate("onboarding:livePowerOnTutorial"),
            info: translate("onboarding:livePowerOnInfo"),
          },
        ]
    if (isMentraLiveSecurePairingEnabled()) {
      steps.push({
        name: "pairing_mode_tutorial",
        type: "image",
        source: require("@assets/onboarding/live/thumbnails/ONB0_power.png"),
        transition: false,
        title: translate("pairing:livePairingModeTitle"),
        subtitle: translate("pairing:livePairingModeSubtitle"),
        info: translate("pairing:livePairingModeInfo"),
        compactHeader: true,
      })
    }

    return (
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showCloseButton={false}
        showSkipButton={false}
        showHeader={false}
        skipFn={() => {
          advanceToPairing()
        }}
        endButtonText={translate("pairing:poweredOn")}
        endButtonFn={() => {
          advanceToPairing()
        }}
      />
    )
  }

  const MentraMach1PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text
          className="text-lg text-secondary-foreground"
          text="1. Make sure your Mach1 is fully charged and turned on."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release."
        />
      </View>
    )
  }

  const VuzixZ100PairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text
          className="text-lg text-secondary-foreground"
          text="1. Make sure your Mach1 is fully charged and turned on."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="2. Make sure your device is running the latest firmware by using the Vuzix Connect app."
        />
        <Text
          className="text-lg text-secondary-foreground"
          text="3. Put your Mentra Mach1 in pairing mode: hold the power button until you see the Bluetooth icon, then release."
        />
      </View>
    )
  }

  const MentraDisplayGlassesPairingGuide = () => {
    return (
      <View className="flex-1 flex-col justify-start mt-6">
        <Text text="Mentra Display" className="text-2xl font-bold mb-4 text-secondary-foreground" />
        <Text
          text="1. Make sure your Mentra Display is fully charged and turned on."
          className="text-lg text-secondary-foreground"
        />
      </View>
    )
  }

  const G1PairingGuide = () => {
    const {theme} = useAppTheme()

    return (
      <ScrollView
        className="flex-1 mt-6"
        contentContainerStyle={{paddingBottom: theme.spacing.s6}}
        showsVerticalScrollIndicator>
        <View className="flex-col items-center justify-center bg-primary-foreground rounded-xl mb-6">
          <Image source={require("../../../assets/glasses/g1.png")} resizeMode="contain" className="w-50 h-25" />
          <Icon name="chevron-down" size={36} color={theme.colors.text} />
          <Image
            source={require("../../../assets/guide/image_g1_pair.png")}
            resizeMode="contain"
            className="w-62 h-38"
          />
        </View>

        <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text
            className="text-lg text-secondary-foreground"
            text="1. Disconnect your G1 from within the Even Realities app, or uninstall the Even Realities app"
          />
          <Text
            className="text-lg text-secondary-foreground"
            text="2. Place your G1 in the charging case with the lid open."
          />
        </View>
      </ScrollView>
    )
  }

  const G1Buttons = () => {
    const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
    return (
      <>
        <View className="gap-4">
          <Button tx="pairing:g1Ready" onPress={advanceToPairing} />
          <Button tx="pairing:g1NotReady" preset="secondary" onPress={() => setShowTroubleshootingModal(true)} />
        </View>
        <GlassesTroubleshootingModal
          isVisible={showTroubleshootingModal}
          onClose={() => setShowTroubleshootingModal(false)}
          deviceModel={deviceModel}
        />
      </>
    )
  }

  const G2PairingGuide = () => {
    const {theme} = useAppTheme()

    return (
      <ScrollView
        className="flex-1 mt-6"
        contentContainerStyle={{paddingBottom: theme.spacing.s6}}
        showsVerticalScrollIndicator>
        <View className="flex-col items-center justify-center bg-primary-foreground rounded-xl mb-6">
          <Image
            source={require("../../../assets/glasses/even_realities_g2/even_realities_g2.png")}
            resizeMode="contain"
            className="w-50 h-25"
          />
          <Icon name="chevron-down" size={36} color={theme.colors.text} />
          <Image
            source={require("../../../assets/guide/image_g1_pair.png")}
            resizeMode="contain"
            className="w-62 h-38"
          />
        </View>

        <View style={{justifyContent: "flex-start", flexDirection: "column"}}>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text
            className="text-lg text-secondary-foreground"
            text="1. Disconnect your G2 from within the Even Realities app, or uninstall the Even Realities app"
          />
          <Text className="text-lg text-secondary-foreground" text="2. Place your G2 in the charging case." />
        </View>
      </ScrollView>
    )
  }

  const G2Buttons = () => {
    const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
    return (
      <>
        <View className="gap-4">
          <Button tx="pairing:g1Ready" onPress={advanceToPairing} />
          <Button tx="pairing:g2NotReady" preset="secondary" onPress={() => setShowTroubleshootingModal(true)} />
        </View>
        <GlassesTroubleshootingModal
          isVisible={showTroubleshootingModal}
          onClose={() => setShowTroubleshootingModal(false)}
          deviceModel={deviceModel}
        />
      </>
    )
  }

  const NimoPairingGuide = () => {
    return (
      <View className="flex-1 mt-6">
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text
            className="text-lg text-secondary-foreground mb-2"
            text="1. Make sure your NIMO glasses are fully charged and turned on."
          />
          <Text
            className="text-lg text-secondary-foreground mb-2"
            text="2. Disconnect your glasses from the NIMO app, or uninstall the NIMO app."
          />
          <Text
            className="text-lg text-secondary-foreground mb-2"
            text="3. If your glasses were previously connected to the NIMO app, force stop that app, then try connecting again."
          />
          <Text
            className="text-lg text-secondary-foreground mb-2"
            text="4. If the glasses aren't responding, close both arms for about 8 seconds, then try again."
          />
          <Text
            className="text-lg text-secondary-foreground mb-2"
            text="5. If nothing else works, reset the glasses by holding the left and right touch areas at the same time for a few seconds, then restart them."
          />
          {Platform.OS === "ios" && (
            <Text
              className="text-lg text-secondary-foreground mb-2"
              text="6. If prompted, allow the Bluetooth pairing request."
            />
          )}
          <View className="h-6" />
        </ScrollView>
      </View>
    )
  }

  const Ar99PairingGuide = () => {
    return (
      <View className="flex-1 mt-6">
        <ScrollView showsVerticalScrollIndicator={false}>
          <View
            className="self-center flex-col items-center justify-center bg-primary-foreground rounded-xl mb-6 overflow-hidden"
            style={themed($ar99ImageContainer)}>
            <Image source={getAr99ImageSource(ar99ProjectName)} resizeMode="contain" style={themed($ar99Image)} />
          </View>
          <Text tx="pairing:instructions" className="text-2xl font-bold mb-4 text-secondary-foreground" />
          <Text className="text-lg text-secondary-foreground mb-2" tx="pairing:ar99Step1" />
          <Text className="text-lg text-secondary-foreground mb-2" tx="pairing:ar99Step2" />
        </ScrollView>
      </View>
    )
  }

  const renderGuide = () => {
    switch (deviceModel) {
      case DeviceTypes.SIMULATED:
        return <SimulatedPairingGuide />
      case DeviceTypes.G1:
        return <G1PairingGuide />
      case DeviceTypes.G2:
        return <G2PairingGuide />
      case DeviceTypes.LIVE:
        return <MentraLivePairingGuide />
      case DeviceTypes.MACH1:
        return <MentraMach1PairingGuide />
      case DeviceTypes.Z100:
        return <VuzixZ100PairingGuide />
      case DeviceTypes.NEX:
        return <MentraDisplayGlassesPairingGuide />
      case DeviceTypes.NIMO:
        return <NimoPairingGuide />
      case DeviceTypes.AR99:
        return <Ar99PairingGuide />
    }

    throw new Error(`Unknown model name: ${deviceModel}`)
  }

  const renderButtons = () => {
    switch (deviceModel) {
      case DeviceTypes.G1:
        return <G1Buttons />
      case DeviceTypes.G2:
        return <G2Buttons />
      case DeviceTypes.LIVE:
        return null
      default:
        return <Button tx="common:continue" onPress={advanceToPairing} />
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header
        title={displayName}
        leftIcon="chevron-left"
        onLeftPress={goBack}
        RightActionComponent={<MentraLogoStandalone />}
      />
      {renderGuide()}
      {renderButtons()}
    </Screen>
  )
}

const $ar99Image: ThemedStyle<ImageStyle> = () => ({
  height: "88%",
  width: "88%",
})

const $ar99ImageContainer: ThemedStyle<ViewStyle> = () => ({
  height: 240,
  width: 320,
})
