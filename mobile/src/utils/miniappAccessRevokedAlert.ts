import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

/** The engine refused a launch because the miniapp's server no longer admits this account. */
export function showMiniappAccessRevokedAlert(app: {packageName: string; name?: string}): void {
  void showAlert({
    title: translate("fleet:accessRevoked", {name: app.name || app.packageName}),
    buttons: [{text: translate("common:ok")}],
  })
}
