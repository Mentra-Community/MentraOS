/**
 * Add a miniapp: scan its QR code or paste its link (distribution spec, "Installing"). Linked from Home's miniapp
 * list for everyone; development builds have their own tools under Miniapp Developer settings. Either way ends at
 * the install sheet, which names where the miniapp comes from before anything installs.
 */
import {useState} from "react"
import {ScrollView, TextInput, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {startMiniappInstallFromLink} from "@/services/miniapps/miniappInstallFlow"
import {requestPhoneQrScan} from "@/services/qrScanRequest"
import {useNavigationStore} from "@/stores/navigation"

export default function AddMiniappScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)

  const install = async (text: string, source: "scanner" | "paste") => {
    setBusy(true)
    try {
      // Busy until the sheet (or an alert) shows: the miniapp's URL is fetched first.
      await startMiniappInstallFromLink(text, source, {onPresent: () => setBusy(false)})
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    if (!busy && url.trim()) void install(url, "paste")
  }

  const scan = async () => {
    const result = await requestPhoneQrScan({
      title: translate("miniappInstall:scanTitle"),
      hint: translate("miniappInstall:scanHint"),
    })
    if ("data" in result) await install(result.data, "scanner")
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("miniappInstall:addTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6" keyboardShouldPersistTaps="handled">
        <View className="flex gap-6 mt-4">
          <Text className="text-[13px] leading-[18px] text-muted-foreground" tx="miniappInstall:addBody" />

          <Group>
            <RouteButton
              label={translate("miniappInstall:scanLabel")}
              subtitle={translate("miniappInstall:scanSubtitle")}
              onPress={busy ? undefined : scan}
              disabled={busy}
            />
          </Group>

          <Group title={translate("miniappInstall:pasteLabel")}>
            <GlassView className="bg-primary-foreground rounded-2xl px-4 py-4 gap-2">
              <Text className="text-xs text-muted-foreground" tx="miniappInstall:pasteSubtitle" />
              <TextInput
                className="bg-background border border-primary rounded-lg px-3 py-2 text-sm mt-1 mb-1"
                style={{color: theme.colors.foreground}}
                placeholder={translate("miniappInstall:pastePlaceholder")}
                placeholderTextColor={theme.colors.muted_foreground}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!busy}
                accessibilityLabel={translate("miniappInstall:pasteLabel")}
                testID="miniappAdd.url"
              />
              <Button
                tx="miniappInstall:continue"
                onPress={submit}
                disabled={busy || !url.trim()}
                preset="alternate"
                flexContainer={false}
                testID="miniappAdd.continue"
              />
            </GlassView>
          </Group>
        </View>
      </ScrollView>
    </Screen>
  )
}
