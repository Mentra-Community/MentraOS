import type {IslandUiSeams} from "./bootstrap"

export async function invokePhoneWifiSeam(ui: IslandUiSeams, payload: Record<string, unknown>) {
  if (payload.type === "miniapp_phone_is_wifi_enabled") {
    if (ui.isPhoneWifiEnabled) return ui.isPhoneWifiEnabled()
  } else if (payload.type === "miniapp_phone_request_wifi_enable") {
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
      throw Object.assign(new Error("reason must be a string"), {code: "INVALID_ARGUMENT"})
    }
    if (ui.requestPhoneWifiEnable) return ui.requestPhoneWifiEnable(payload.reason)
  }
  throw Object.assign(new Error("Phone Wi-Fi access is not configured on this host"), {code: "NOT_IMPLEMENTED"})
}
