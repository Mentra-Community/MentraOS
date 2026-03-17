import {View} from "react-native"

import {Text} from "@/components/ignite"
import {OptionList} from "@/components/ui/Options"
import {translate} from "@/i18n/translate"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/contexts/ThemeContext"

const MIC_OPTIONS = [
  {
    key: "auto",
    label: translate("microphoneSettings:auto"),
    badge: translate("deviceSettings:recommended"),
  },
  {
    key: "glasses",
    label: translate("microphoneSettings:glasses"),
  },
  {
    key: "phone",
    label: translate("microphoneSettings:phone"),
  },
  {
    key: "bluetooth",
    label: translate("microphoneSettings:bluetooth"),
  },
]

export function MicrophoneSelector() {
  const [preferredMic, setPreferredMic] = useSetting(SETTINGS.preferred_mic.key)
  const {theme} = useAppTheme()

  const setMic = async (val: string) => {
    if (val === "phone") {
      const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
      if (!hasMicPermission) {
        showAlert(
          translate("microphoneSettings:microphonePermissionRequired"),
          translate("microphoneSettings:microphonePermissionRequiredMessage"),
          [{text: translate("common:ok")}],
          {
            iconName: "microphone",
            iconColor: theme.colors.primary,
          },
        )
        return
      }
    }

    await setPreferredMic(val)
  }

  return (
    <View className="gap-3">
      <Text tx="microphoneSettings:preferredMic" className="text-text text-base font-semibold" />
      <OptionList options={MIC_OPTIONS} selected={preferredMic} onSelect={setMic} />
    </View>
  )
}
