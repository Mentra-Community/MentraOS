import {SETTINGS, useSetting} from "@mentra/engine"
import {Platform} from "react-native"

import {isIosCallBuildEnabled} from "@/constants/miniapps"
import {translate} from "@/i18n"
import {showAlert} from "@/utils/AlertUtils"
import {deploymentStore} from "@/services/deployment/store"
import {isDeploymentManagedCall} from "@/services/miniapps/miniappVisibility"

import ToggleSetting from "./ToggleSetting"

export default function IosMiniappSettings() {
  const [showIosCall, setShowIosCall] = useSetting<boolean>(SETTINGS.show_mentra_call_ios.key)
  const [showIosNotify, setShowIosNotify] = useSetting<boolean>(SETTINGS.show_notify_ios.key)
  if (Platform.OS !== "ios") return null
  const callBuildEnabled = isIosCallBuildEnabled()
  const workspace = deploymentStore.getActive().kind === "workspace"

  const updateSetting = async (value: boolean, setSetting: typeof setShowIosCall) => {
    const result = await setSetting(value)
    if (result.is_error()) {
      showAlert(translate("common:error"), translate("debugSettings:miniappVisibilityError"))
    }
  }

  return (
    <>
      <ToggleSetting
        testID="debug-show-mentra-call-ios"
        label={translate("debugSettings:showMentraCallIos")}
        subtitle={translate(
          workspace
            ? "debugSettings:mentraCallWorkspacePolicy"
            : callBuildEnabled
              ? "debugSettings:mentraCallBuildOverride"
              : "debugSettings:showMentraCallIosSubtitle",
        )}
        value={workspace ? isDeploymentManagedCall() : callBuildEnabled || showIosCall}
        disabled={workspace || callBuildEnabled}
        onValueChange={(value) => void updateSetting(value, setShowIosCall)}
      />
      <ToggleSetting
        testID="debug-show-notify-ios"
        label={translate("debugSettings:showNotifyIos")}
        subtitle={translate("debugSettings:showNotifyIosSubtitle")}
        value={showIosNotify}
        onValueChange={(value) => void updateSetting(value, setShowIosNotify)}
      />
    </>
  )
}
