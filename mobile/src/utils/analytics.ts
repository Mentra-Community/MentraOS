import {SETTINGS, useSettingsStore} from "@/stores/settings"

let analyticsModule: typeof import("@react-native-firebase/analytics") | null = null
let initialized = false

function isChina(): boolean {
  return useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key) === true
}

async function getAnalytics() {
  if (isChina()) return null
  if (!analyticsModule) {
    try {
      analyticsModule = require("@react-native-firebase/analytics")
    } catch {
      console.warn("Firebase Analytics not available")
      return null
    }
  }
  return analyticsModule.default()
}

export async function initAnalytics() {
  if (initialized || isChina()) return
  const analytics = await getAnalytics()
  if (!analytics) return
  await analytics.setAnalyticsCollectionEnabled(true)
  initialized = true
  console.log("Firebase Analytics initialized")
}

export async function logEvent(name: string, params?: Record<string, string | number | boolean>) {
  const analytics = await getAnalytics()
  if (!analytics) return
  await analytics.logEvent(name, params)
}

export async function setUserId(id: string | null) {
  const analytics = await getAnalytics()
  if (!analytics) return
  await analytics.setUserId(id)
}

export async function setUserProperty(name: string, value: string | null) {
  const analytics = await getAnalytics()
  if (!analytics) return
  await analytics.setUserProperty(name, value)
}

export async function logScreenView(screenName: string, screenClass?: string) {
  const analytics = await getAnalytics()
  if (!analytics) return
  await analytics.logScreenView({screen_name: screenName, screen_class: screenClass ?? screenName})
}
