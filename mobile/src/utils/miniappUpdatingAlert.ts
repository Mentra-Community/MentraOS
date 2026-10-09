import {engine} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

export function showMiniappUpdatingAlert(): void {
  void showAlert({
    title: translate("home:miniappUpdatingTitle"),
    message: translate("home:miniappUpdatingMessage"),
    buttons: [{text: translate("common:ok")}],
  })
}

/** Read live state: an icon or open popover can still hold an older app object. */
export function blockUpdatingMiniapp(packageName: string): boolean {
  if (!engine.miniapps.list().some((app) => app.packageName === packageName && app.updating)) return false
  showMiniappUpdatingAlert()
  return true
}
