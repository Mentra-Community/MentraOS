import {ScrollView, View} from "react-native"

import {MicrophoneSelector} from "@/components/glasses/settings/MicrophoneSelector"
import {Header, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"

export default function MicrophoneScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()

  return (
    <Screen preset="fixed">
      <Header titleTx="microphoneSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="gap-6 pt-6">
          <MicrophoneSelector />
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
