import {ScrollView, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {showLeaveAppAlert} from "@/utils/AlertUtils"

const DOCS_URL = "https://docs.mentraglass.com"

export default function MiniappDeveloperSettingsScreen() {
  const {theme} = useAppTheme()
  const {goBack, push} = useNavigationStore.getState()

  return (
    <Screen preset="fixed">
      <Header titleTx="miniappDevSettings:title" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6 mt-6">
          <GlassView className="bg-primary-foreground rounded-2xl px-4 py-4 gap-3">
            <Text className="text-base font-semibold text-text" tx="miniappDevSettings:headline" />
            <Text className="text-[13px] leading-[18px] text-textDim" tx="miniappDevSettings:body" />
            <Button
              tx="miniappDevSettings:readDocs"
              onPress={() => showLeaveAppAlert(DOCS_URL)}
              preset="alternate"
              flexContainer={false}
            />
          </GlassView>

          <Group title={translate("miniappDevSettings:toolsTitle")}>
            <RouteButton
              label={translate("miniappDevSettings:scanLabel")}
              subtitle={translate("miniappDevSettings:scanSubtitle")}
              onPress={() => push("/miniapps/miniappdev/scanner")}
            />
            <RouteButton
              label={translate("miniappDevSettings:loadUrlLabel")}
              subtitle={translate("miniappDevSettings:loadUrlSubtitle")}
              onPress={() => push("/miniapps/miniappdev/developer-url")}
            />
          </Group>
        </View>
        <Spacer height={theme.spacing.s12} />
      </ScrollView>
    </Screen>
  )
}
