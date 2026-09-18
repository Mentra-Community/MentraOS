import {SETTINGS, useSetting} from "@mentra/engine"
import {Platform} from "react-native"

import {isIosCallBuildEnabled} from "@/constants/miniapps"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

import ToggleSetting from "./ToggleSetting"

export default function IosCallSetting() {
  const [showIosCall, setShowIosCall] = useSetting<boolean>(SETTINGS.show_mentra_call_ios.key)
  if (Platform.OS !== "ios") return null
  const buildEnabled = isIosCallBuildEnabled()
  return (
    <ToggleSetting
      testID="debug-show-mentra-call-ios"
      label={translate("debugSettings:showMentraCallIos")}
      subtitle={translate(
        buildEnabled ? "debugSettings:mentraCallBuildOverride" : "debugSettings:showMentraCallIosSubtitle",
      )}
      value={buildEnabled || showIosCall}
      disabled={buildEnabled}
      onValueChange={(value) => {
        void setShowIosCall(value).then((result) => {
          if (result.is_error()) {
            showAlert(translate("common:error"), translate("debugSettings:mentraCallVisibilityError"))
          }
        })
      }}
    />
  )
}
