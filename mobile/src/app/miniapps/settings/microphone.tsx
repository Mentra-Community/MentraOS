import {ScrollView, View} from "react-native"

import {SETTINGS, useSetting} from "@mentra/engine"
import {DeviceTypes} from "@mentra/engine"
import {MicrophoneGateSettings} from "@/components/glasses/settings/MicrophoneGateSettings"
import {MicrophoneSelector} from "@/components/glasses/settings/MicrophoneSelector"
import {Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"

export default function MicrophoneScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const isMentraLive =
    defaultWearable === DeviceTypes.LIVE || String(defaultWearable || "").includes(DeviceTypes.LIVE)

  return (
    <Screen preset="fixed">
      <Header titleTx="microphoneSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="gap-6 pt-6">
          <MicrophoneSelector />
          {isMentraLive && <MicrophoneGateSettings />}
          <View className="px-1">
            <Text
              style={{color: theme.colors.textDim, fontSize: 13, lineHeight: 18}}
              text={translate("microphoneSettings:infoDescription")}
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}
