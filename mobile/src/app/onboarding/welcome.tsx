import {DeviceTypes} from "@/../../cloud/packages/types/src"
import DontHaveGlassesSvg from "@assets/glasses/dont-have.svg"
import HaveGlassesSvg from "@assets/glasses/have.svg"
import {TouchableOpacity, View} from "react-native"
import {SvgProps} from "react-native-svg"

import {Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {TxKeyPath} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import GlassView from "@/components/ui/GlassView"

const CardButton = ({
  onPress,
  tx,
  SvgComponent,
}: {
  onPress: () => void
  tx: string
  SvgComponent: React.FC<SvgProps>
}) => (
  <TouchableOpacity activeOpacity={0.6} onPress={onPress}>
    <GlassView className="p-4 h-[190px] rounded-2xl justify-center items-center bg-primary-foreground">
      <View className="w-[120px] h-[60px] items-center justify-center mb-2">
        <SvgComponent width={120} height={60} />
      </View>
      <Text tx={tx as TxKeyPath} className="text-[20px] text-secondary_foreground" />
    </GlassView>
  </TouchableOpacity>
)

export default function OnboardingWelcome() {
  const {push} = useNavigationStore.getState()
  const [_onboarding, setOnboardingCompleted] = useSetting(SETTINGS.onboarding_completed.key)
  const {theme} = useAppTheme()

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
      <View className="items-center justify-center mt-6 mb-8">
        <MentraLogoStandalone width={100} height={48} />
      </View>

      <View className="items-center w-full justify-center">
        <Text
          tx="onboarding:welcome"
          className="text-[30px] leading-[30px] text-center text-secondary_foreground font-semibold"
        />
        <View className="h-4" />
        <Text tx="onboarding:doYouHaveGlasses" className="text-[20px] text-center text-secondary_foreground" />
      </View>
      <View className="h-12" />
      <CardButton onPress={handleHasGlasses} tx="onboarding:haveGlasses" SvgComponent={HaveGlassesSvg} />
      <View className="h-8" />
      <CardButton onPress={handleNoGlasses} tx="onboarding:dontHaveGlasses" SvgComponent={DontHaveGlassesSvg} />
    </Screen>
  )
}
