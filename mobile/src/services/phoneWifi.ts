import type {PhoneWifiEnableResult} from "@mentra/miniapp"
import NetInfo from "@react-native-community/netinfo"
import {AppState, Linking, Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"

import {translate} from "@/i18n"
import {completePhoneWifiPrompt, requestPhoneWifiPrompt} from "./phoneWifiPrompt"

/** Read the radio directly on Android; NetInfo's cached isWifiEnabled can be stale. */
export async function isPhoneWifiEnabled(): Promise<boolean | null> {
  if (Platform.OS === "android") return WifiManager.isEnabled()
  if (Platform.OS === "ios") {
    const state = await NetInfo.refresh()
    return state.type === "wifi" && state.isConnected === true ? true : null
  }
  return null
}

type WifiSettingsTarget = "panel" | "settings"

async function openPhoneWifiSettings(): Promise<WifiSettingsTarget> {
  if (Platform.OS === "android") {
    if (Number(Platform.Version) >= 29) {
      try {
        await Linking.sendIntent("android.settings.panel.action.WIFI")
        return "panel"
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
  return "settings"
}

/** Listen before launching Settings so a fast blur/resume cannot be missed. */
function visitWifiSettings(): Promise<PhoneWifiEnableResult> {
  return new Promise((resolve, reject) => {
    let target: WifiSettingsTarget | undefined
    let sawBackground = false
    let sawBlur = false
    let active = AppState.currentState === "active"
    let focused = true
    let generation = 0
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
    const interrupted = () => {
      generation++
      clearTimeout(recheckTimer)
      checking = false
    }
    const hasReturned = () =>
      active && focused && (target === "panel" ? sawBlur || sawBackground : target === "settings" && sawBackground)
    const returned = () => {
      if (!hasReturned() || checking || settled) return
      checking = true
      const checkGeneration = generation
      // Let the radio state catch up to closing Android's settings panel.
      recheckTimer = setTimeout(() => {
        void isPhoneWifiEnabled().then(
          (enabled) => {
            if (settled || generation !== checkGeneration || !hasReturned()) return
            cleanup()
            resolve({enabled, cancelled: false})
          },
          (error: unknown) => {
            if (generation === checkGeneration) fail(error)
          },
        )
      }, 500)
    }
    subscriptions.push(
      AppState.addEventListener("change", (state) => {
        active = state === "active"
        // iOS inactive also means Control Center or a brief system interruption.
        if (state === "background") sawBackground = true
        if (active) returned()
        else interrupted()
      }),
    )
    if (Platform.OS === "android") {
      // An inline settings panel can only blur the Activity, without backgrounding it.
      subscriptions.push(
        AppState.addEventListener("blur", () => {
          focused = false
          sawBlur = true
          interrupted()
        }),
        AppState.addEventListener("focus", () => {
          focused = true
          returned()
        }),
      )
    }
    const deadline = setTimeout(() => {
      if (settled) return
      cleanup()
      resolve({enabled: null, cancelled: true})
    }, 5 * 60_000)
    void openPhoneWifiSettings().then((openedTarget) => {
      target = openedTarget
      returned()
    }, fail)
  })
}

let promptInFlight = false

/** Long enough to read "Wi-Fi is on" before the call checklist takes over. */
const WIFI_ON_HOLD_MS = 900

async function showWifiOn(): Promise<void> {
  const shown = requestPhoneWifiPrompt({
    title: translate("phoneWifi:onTitle"),
    message: translate("phoneWifi:onMessage"),
    actionLabel: translate("phoneWifi:onTitle"),
    tone: "on",
  })
  await new Promise((resolve) => setTimeout(resolve, WIFI_ON_HOLD_MS))
  completePhoneWifiPrompt(true)
  await shown
}

/** Host overlay only: never clear miniapp foreground or send UI_CLOSE to a live call. */
export async function requestPhoneWifiEnable(reason?: string): Promise<PhoneWifiEnableResult> {
  if (promptInFlight || AppState.currentState !== "active") {
    throw Object.assign(new Error("Phone Wi-Fi setup requires an available foreground host"), {code: "REQUEST_ABORTED"})
  }
  promptInFlight = true
  try {
    const enabled = await isPhoneWifiEnabled()
    if (enabled === true) return {enabled, cancelled: false}
    const ios = Platform.OS === "ios"
    const instructions = translate(ios ? "phoneWifi:instructionsIos" : "phoneWifi:instructionsAndroid")
    const actionLabel = translate(ios ? "phoneWifi:openSettings" : "phoneWifi:turnOn")
    const stillOffMessage = translate(ios ? "phoneWifi:stillOffIos" : "phoneWifi:stillOffAndroid")
    let stillOff = false
    for (;;) {
      const confirmed = await requestPhoneWifiPrompt({
        title: translate(stillOff ? "phoneWifi:stillOffTitle" : "phoneWifi:title"),
        message: stillOff
          ? stillOffMessage
          : [reason?.trim() || translate("phoneWifi:reason"), instructions].join("\n\n"),
        actionLabel,
        tone: stillOff ? "still-off" : "ask",
      })
      if (!confirmed) return {enabled: false, cancelled: true}
      const result = await visitWifiSettings()
      if (result.cancelled || result.enabled == null) return result
      if (result.enabled) {
        await showWifiOn()
        return {enabled: true, cancelled: false}
      }
      stillOff = true
    }
  } finally {
    promptInFlight = false
  }
}
