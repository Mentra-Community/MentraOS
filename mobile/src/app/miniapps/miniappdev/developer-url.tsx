import {useState} from "react"
import {ScrollView, TextInput, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import {startMiniappInstallFromLink} from "@/services/miniapps/miniappInstallFlow"

export default function MiniappDeveloperUrlScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)

  // Every miniapp URL installs as any link does, through the install sheet: a local address (the URL `mentra dev`
  // prints) installs as a development build, and opens.
  const handleLoadUrl = async () => {
    const trimmed = url.trim()
    if (!trimmed) {
      showAlert(translate("debugSettings:miniappUrlEmptyTitle"), translate("debugSettings:miniappUrlEmptyBody"), [
        {text: "OK"},
      ])
      return
    }
    setLoading(true)
    try {
      await startMiniappInstallFromLink(trimmed, "paste")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("debugSettings:miniappUrlTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6">
          <Group title={translate("debugSettings:miniappUrlGroupTitle")}>
            <GlassView className="bg-primary-foreground rounded-2xl px-4 py-4 gap-2">
              <Text className="text-base text-text" tx="debugSettings:miniappUrlLabel" />
              <Text className="text-xs text-textDim flex-row flex-wrap">
                {translate("debugSettings:miniappUrlSubtitlePrefix")}
                <Text className="font-mono text-text" text="/miniapp.json" />
                {translate("debugSettings:miniappUrlSubtitleSuffix")}
              </Text>
              <TextInput
                className="bg-background border border-primary rounded-lg px-3 py-2 text-sm mt-1 mb-1 text-text"
                placeholder="http://192.168.1.50:3000"
                placeholderTextColor={theme.colors.textDim}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!loading}
              />
              <Button
                tx={loading ? "debugSettings:miniappUrlLoadingButton" : "debugSettings:miniappUrlLoadButton"}
                onPress={handleLoadUrl}
                disabled={loading}
                preset="alternate"
                flexContainer={false}
              />
            </GlassView>
          </Group>

          <Spacer height={theme.spacing.s12} />
        </View>
      </ScrollView>
    </Screen>
  )
}
