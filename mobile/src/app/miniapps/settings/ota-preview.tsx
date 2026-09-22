import {MentraLiveOtaPreview} from "@mentra/engine/ota"
import {useState} from "react"
import {View} from "react-native"

import {OTA_PREVIEW_PAGES} from "@/components/dev/otaPreviewStates"
import {Header, Screen, Text} from "@/components/ignite"
import SelectSetting from "@/components/settings/SelectSetting"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"

const options = OTA_PREVIEW_PAGES.map(({label}, index) => ({label, value: String(index)}))

export default function OtaPreviewScreen() {
  const {theme} = useAppTheme()
  const [selected, setSelected] = useState("0")
  const page = OTA_PREVIEW_PAGES[Number(selected)] ?? OTA_PREVIEW_PAGES[0]

  return (
    <Screen preset="fixed">
      <Header
        title={translate("debugSettings:otaPreview")}
        leftIcon="chevron-left"
        onLeftPress={() => useNavigationStore.getState().goBack()}
      />
      <SelectSetting
        label={translate("debugSettings:otaPreviewPage")}
        value={selected}
        options={options}
        onValueChange={setSelected}
      />
      <Text tx="debugSettings:otaPreviewHint" className="text-xs text-muted-foreground text-center py-2" />
      <View className="flex-1 -mx-6">
        <MentraLiveOtaPreview
          key={selected}
          state={page.state}
          theme={{
            background: theme.colors.background,
            border: theme.colors.border,
            error: theme.colors.error,
            foreground: theme.colors.foreground,
            primary: theme.colors.primary,
            textDim: theme.colors.textDim,
          }}
          translate={(key, options) => translate(key as never, options)}
        />
      </View>
    </Screen>
  )
}
