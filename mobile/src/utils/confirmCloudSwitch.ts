import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

/**
 * Ask before a Core URL change that signs the person out. `change` is a new Core, `reset` the deployment's
 * default one. Resolves true to go ahead; dismissing the sheet counts as Cancel.
 */
export function confirmCloudSwitch(kind: "change" | "reset"): Promise<boolean> {
  return new Promise((resolve) => {
    void showAlert(
      translate(kind === "change" ? "workspace:cloudSwitchTitle" : "workspace:cloudResetTitle"),
      translate(kind === "change" ? "workspace:cloudSwitchMessage" : "workspace:cloudResetMessage"),
      [
        {text: translate("common:cancel"), style: "cancel", onPress: () => resolve(false)},
        {text: translate("workspace:cloudSwitchConfirm"), style: "destructive", onPress: () => resolve(true)},
      ],
    )
  })
}
