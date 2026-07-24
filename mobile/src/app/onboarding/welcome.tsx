import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {SETTINGS, useSetting} from "@mentra/engine"
import {Image, TouchableOpacity, View} from "react-native"
import type {ImageSourcePropType} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import type {TxKeyPath} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"

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
}) => (
  <TouchableOpacity accessibilityRole="button" activeOpacity={0.6} className="w-full" onPress={onPress} testID={testID}>
    <GlassView className="h-[190px] flex-row items-center justify-between overflow-hidden rounded-2xl bg-primary-foreground px-8 py-6">
      <Text tx={tx} className="text-[20px] leading-7 tracking-[-0.05px] text-secondary_foreground" />
      <Image
        resizeMode="contain"
        source={imageSource}
        style={{
          height: imageHeight,
          width: imageWidth,
        }}
      />
    </GlassView>
  </TouchableOpacity>
)

export default function OnboardingWelcome() {
  const {push} = useNavigationStore.getState()
  const [_onboarding, setOnboardingCompleted] = useSetting(SETTINGS.onboarding_completed.key)

  // User has smart glasses - go to glasses selection screen
  const handleHasGlasses = async () => {
    // TODO: Track analytics event - user has glasses
    // analytics.track('onboarding_has_glasses_selected')
    setOnboardingCompleted(true)
    push("/pairing/select-glasses-model", {onboarding: true})
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
    <Screen preset="fixed" className="px-6" safeAreaEdges={["top"]}>
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
      <View className="h-12" />
      <CardButton
        imageHeight={189}
        imageSource={require("@assets/onboarding/welcome/phone.png")}
        imageWidth={130}
        onPress={handleNoGlasses}
        testID="onboarding-setup-without-glasses"
        tx="onboarding:setupWithoutGlasses"
      />
    </Screen>
  )
}
