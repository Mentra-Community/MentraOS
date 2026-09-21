import type {PhoneWifiEnableResult} from "@mentra/miniapp"
import NetInfo from "@react-native-community/netinfo"
import {AppState, Linking, Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"

import {translate} from "@/i18n"
import {requestPhoneWifiPrompt} from "./phoneWifiPrompt"

/** Read the radio directly on Android; NetInfo's cached isWifiEnabled can be stale. */
export async function isPhoneWifiEnabled(): Promise<boolean | null> {
  if (Platform.OS === "android") return WifiManager.isEnabled()
  if (Platform.OS === "ios") {
    const state = await NetInfo.refresh()
    return state.type === "wifi" && state.isConnected === true ? true : null
  }
  return null
}

async function openPhoneWifiSettings(): Promise<void> {
  if (Platform.OS === "android") {
    if (Number(Platform.Version) >= 29) {
      try {
        await Linking.sendIntent("android.settings.panel.action.WIFI")
        return
      } catch {
        // Some OEMs don't implement the panel. The full settings page is the fallback.
      }
    }
    await Linking.sendIntent("android.settings.WIFI_SETTINGS")
  } else {
    // iOS has no public URL for Wi-Fi settings. The prompt explains how to get
    // there from the app's Settings page. Avoid private App-prefs URLs.
    await Linking.openSettings()
  }
}

/** Listen before launching Settings so a fast blur/resume cannot be missed. */
function visitWifiSettings(): Promise<PhoneWifiEnableResult> {
  return new Promise((resolve, reject) => {
    let leftApp = false
    let settled = false
    let checking = false
    let recheckTimer: ReturnType<typeof setTimeout> | undefined
    const subscriptions: {remove(): void}[] = []
    const cleanup = () => {
      settled = true
      clearTimeout(deadline)
      clearTimeout(recheckTimer)
      subscriptions.forEach((subscription) => subscription.remove())
    }
    const fail = (error: unknown) => {
      if (settled) return
      cleanup()
      reject(error)
    }
    const returned = () => {
      if (!leftApp || checking || settled) return
      checking = true
      // Let the radio state catch up to closing Android's settings panel.
      recheckTimer = setTimeout(() => {
        void isPhoneWifiEnabled().then((enabled) => {
          if (settled) return
          cleanup()
          resolve({enabled, cancelled: false})
        }, fail)
      }, 500)
    }
    subscriptions.push(
      AppState.addEventListener("change", (state) => {
        if (state !== "active") leftApp = true
        else returned()
      }),
    )
    if (Platform.OS === "android") {
      // An inline settings panel can only blur the Activity, without backgrounding it.
      subscriptions.push(
        AppState.addEventListener("blur", () => {
          leftApp = true
        }),
        AppState.addEventListener("focus", returned),
      )
    }
    const deadline = setTimeout(() => {
      if (settled) return
      cleanup()
      resolve({enabled: null, cancelled: true})
    }, 5 * 60_000)
    void openPhoneWifiSettings().catch(fail)
  })
}

let promptInFlight = false

/** Host overlay only: never clear miniapp foreground or send UI_CLOSE to a live call. */
export async function requestPhoneWifiEnable(reason?: string): Promise<PhoneWifiEnableResult> {
  if (promptInFlight || AppState.currentState !== "active") {
    throw Object.assign(new Error("Phone Wi-Fi setup requires an available foreground host"), {code: "REQUEST_ABORTED"})
  }
  promptInFlight = true
  try {
    const enabled = await isPhoneWifiEnabled()
    if (enabled === true) return {enabled, cancelled: false}
    const message = [
      reason?.trim() || translate("phoneWifi:reason"),
      translate(Platform.OS === "ios" ? "phoneWifi:instructionsIos" : "phoneWifi:instructionsAndroid"),
    ].join("\n\n")
    const confirmed = await requestPhoneWifiPrompt({
      title: translate("phoneWifi:title"),
      message,
      actionLabel: translate(Platform.OS === "ios" ? "phoneWifi:openSettings" : "phoneWifi:turnOn"),
    })
    if (!confirmed) return {enabled, cancelled: true}
    return await visitWifiSettings()
  } finally {
    promptInFlight = false
  }
}
