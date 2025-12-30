import {ScrollView} from "react-native"

import {MicrophoneSelector} from "@/components/glasses/settings/MicrophoneSelector"
import {Header, Screen} from "@/components/ignite"
import {Spacer} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"

export default function MicrophoneScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationHistory()

  return (
    <Screen preset="fixed">
      <Header titleTx="microphoneSettings:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <Spacer height={theme.spacing.s6} />
      <ScrollView>
        <MicrophoneSelector />
      </ScrollView>
    </Screen>
  )
}
