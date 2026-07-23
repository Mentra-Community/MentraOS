import {engine, type ClientApp} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

export const uninstallAppUI = async (app: ClientApp): Promise<void> => {
  console.log(`Uninstalling app: ${app.packageName}`)

  const result = await showAlert({
    title: translate("appSettings:uninstallApp"),
    message: translate("appSettings:uninstallConfirm", {appName: app.name}),
    buttons: [
      {text: translate("common:cancel"), style: "cancel"},
      {text: translate("appSettings:uninstall"), style: "destructive"},
    ],
  })

  if (result !== 1) return

  if (app.running) {
    await engine.miniapps.stop(app.packageName)
  }

  const res = await engine.miniapps.uninstall(app.packageName)
  if (res.is_error()) {
    console.error("APPLET: Error uninstalling app:", res.error)
    void engine.miniapps.refresh()
    await showAlert({
      title: translate("common:error"),
      message: translate("appSettings:uninstallError", {error: res.error.message || "Unknown error"}),
      buttons: [{text: translate("common:ok")}],
    })
    return
  }

  await showAlert({
    title: translate("common:success"),
    message: translate("appSettings:uninstalledSuccess", {appName: app.name}),
    buttons: [{text: translate("common:ok")}],
  })
}
