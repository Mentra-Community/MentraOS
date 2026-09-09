import {ScrollView, View} from "react-native"

import {SETTINGS, useSetting} from "@mentra/engine"

import {Button, Header, Screen, Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {deploymentStore} from "@/services/deployment"
import {showLeaveAppAlert} from "@/utils/AlertUtils"

const CONSUMER_DOCS_URL = "https://docs.mentraglass.com"

export default function MiniappDeveloperSettingsScreen() {
  const {theme} = useAppTheme()
  const {goBack, push} = useNavigationStore.getState()
  const [showOnHomeScreen, setShowOnHomeScreen] = useSetting(SETTINGS.miniapp_dev_mode.key)
  const deployment = deploymentStore.getActive()
  const documentationUrl =
    deployment.kind === "workspace" ? deployment.manifest.links.documentationUrl : CONSUMER_DOCS_URL

  return (
    <Screen preset="fixed">
      <Header titleTx="miniappDevSettings:title" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6 mt-6">
          <GlassView className="bg-primary-foreground rounded-2xl px-4 py-4 gap-3">
            <Text className="text-base font-semibold text-text" tx="miniappDevSettings:headline" />
            <Text className="text-[13px] leading-[18px] text-textDim" tx="miniappDevSettings:body" />
            {documentationUrl && (
              <Button
                tx="miniappDevSettings:readDocs"
                onPress={() => showLeaveAppAlert(documentationUrl)}
                preset="alternate"
                flexContainer={false}
              />
            )}
          </GlassView>

          <Group title={translate("miniappDevSettings:preferencesTitle")}>
            <ToggleSetting
              label={translate("miniappDevSettings:showOnHomeScreenLabel")}
              subtitle={translate("miniappDevSettings:showOnHomeScreenSubtitle")}
              value={showOnHomeScreen}
              onValueChange={setShowOnHomeScreen}
            />
          </Group>

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
