import {DeviceTypes, engine, SETTINGS, useSetting} from "@mentra/engine"
import {useEffect} from "react"
import {Image, Platform, Pressable, useWindowDimensions, View} from "react-native"
import type {ImageSourcePropType, ImageStyle, ViewStyle} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {MiniappInstallStatus} from "@/components/home/MiniappInstallStatus"
import {Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import type {TxKeyPath} from "@/i18n"
import {isGlassesModelAllowedByDeployment} from "@/services/deployment/glassesPolicy"
import {useNavigationStore} from "@/stores/navigation"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"

const CardButton = ({
  imageHeight,
  imageSource,
  imageWidth,
  onPress,
  testID,
  tx,
}: {
  imageHeight: number
  imageSource: ImageSourcePropType
  imageWidth: number
  onPress: () => void
  testID: string
  tx: TxKeyPath
}) => {
  const {width: screenWidth} = useWindowDimensions()
  const horizontalPadding = screenWidth < 390 ? 16 : 32

  return (
    <Pressable
      accessibilityRole="button"
      className="w-full"
      onAccessibilityTap={onPress}
      onPress={onPress}
      style={({pressed}) => ({opacity: pressed ? 0.6 : 1})}
      testID={testID}>
      <GlassView
        className="h-[190px] flex-row items-center justify-between gap-2 overflow-hidden rounded-2xl bg-primary-foreground py-6"
        style={{paddingHorizontal: horizontalPadding}}>
        <Text tx={tx} className="shrink text-[20px] leading-7 tracking-[-0.05px] text-secondary_foreground" />
        <Image
          resizeMode="contain"
          source={imageSource}
          style={[$shrinkableImage, {height: imageHeight, width: imageWidth}]}
        />
      </GlassView>
    </Pressable>
  )
}

export default function OnboardingWelcome() {
  const {goHomeAndPush, push} = useNavigationStore.getState()
  const [_onboarding, setOnboardingCompleted] = useSetting(SETTINGS.onboarding_completed.key)
  const simulatedGlassesAllowed = isGlassesModelAllowedByDeployment(DeviceTypes.SIMULATED)

  // A phone still bonded with Mentra Live has glasses: after a reinstall or cleared app data, skip the question
  // and let the scan screen connect them, with no pairing mode. Android only: iOS can't read its bonds.
  useEffect(() => {
    if (Platform.OS !== "android") return
    let left = false
    void engine.pairing.bondedGlasses().then((device) => {
      if (!device || left) return
      setOnboardingCompleted(true)
      goHomeAndPush("/pairing/scan", {deviceModel: DeviceTypes.LIVE})
    })
    return () => {
      left = true
    }
    // Once, when the question is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // User has smart glasses - go to glasses selection screen
  const handleHasGlasses = async () => {
    // TODO: Track analytics event - user has glasses
    // analytics.track('onboarding_has_glasses_selected')
    setOnboardingCompleted(true)
    // A reinstall or cleared data also revoked Nearby devices, which hid the bond above. Asked for now, it shows
    // glasses the phone is bonded with, and the scan screen connects them without choosing a model.
    if (
      Platform.OS === "android" &&
      (await requestFeaturePermissions(PermissionFeatures.BLUETOOTH)) &&
      (await engine.pairing.bondedGlasses())
    ) {
      goHomeAndPush("/pairing/scan", {deviceModel: DeviceTypes.LIVE})
      return
    }
    goHomeAndPush("/pairing/select-glasses-model", {onboarding: true})
  }

  // User doesn't have glasses yet - go directly to simulated glasses
  const handleNoGlasses = () => {
    // TODO: Track analytics event - user doesn't have glasses
    // analytics.track('onboarding_no_glasses_selected')
    setOnboardingCompleted(true)
    // Go directly to simulated glasses pairing screen
    push("/pairing/prep", {deviceModel: DeviceTypes.SIMULATED})
  }

  return (
    <Screen preset="auto" className="px-6" contentContainerStyle={$content} safeAreaEdges={["top"]}>
      <View className="mb-12 mt-6 items-center justify-center">
        <MentraLogoStandalone width={108} height={58} />
      </View>

      <View className="w-full items-center justify-center">
        <Text
          tx="onboarding:welcome"
          className="text-center text-[30px] font-semibold leading-9 text-secondary_foreground"
        />
        <View className="h-4" />
        <Text
          tx="onboarding:doYouHaveGlasses"
          className="text-center text-[20px] leading-7 text-secondary_foreground"
        />
      </View>
      <View className="h-12" />
      <CardButton
        imageHeight={187}
        imageSource={require("@assets/onboarding/welcome/glasses.png")}
        imageWidth={122}
        onPress={handleHasGlasses}
        testID="onboarding-setup-with-glasses"
        tx="onboarding:setupWithGlasses"
      />
      {simulatedGlassesAllowed && (
        <>
          <View className="h-12" />
          <CardButton
            imageHeight={189}
            imageSource={require("@assets/onboarding/welcome/phone.png")}
            imageWidth={130}
            onPress={handleNoGlasses}
            testID="onboarding-setup-without-glasses"
            tx="onboarding:setupWithoutGlasses"
          />
        </>
      )}
      <View className="h-6" />
      <MiniappInstallStatus />
    </Screen>
  )
}

const $content: ViewStyle = {
  paddingBottom: 24,
}

const $shrinkableImage: ImageStyle = {
  flexShrink: 1,
}
