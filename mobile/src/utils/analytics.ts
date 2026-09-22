import {SETTINGS, engine} from "@mentra/engine"

import {deploymentStore} from "@/services/deployment"

let analyticsModule: typeof import("@react-native-firebase/analytics") | null = null
let initialized = false
// Enable/disable transitions run one at a time. Each call re-reads the
// deployment policy after it acquires the turn so a disable that arrived while
// an enable was awaiting native code cannot be overtaken by that enable.
let transition: Promise<void> = Promise.resolve()

function isChina(): boolean {
  return engine.settings.get(SETTINGS.china_deployment.key) === true
}

function isCollectionAllowed(): boolean {
  return deploymentStore.isTelemetryAllowed()
}

function loadAnalyticsModule(): typeof import("@react-native-firebase/analytics") | null {
  if (!analyticsModule) {
    try {
      analyticsModule = require("@react-native-firebase/analytics")
    } catch {
      console.warn("Firebase Analytics not available")
      return null
    }
  }
  return analyticsModule
}

async function getAnalytics() {
  if (isChina() || !isCollectionAllowed()) return null
  const module = loadAnalyticsModule()
  if (!module) return null
  return module.default()
}

function serializeCollectionTransition(operation: () => Promise<void>): Promise<void> {
  const next = transition.then(operation, operation)
  transition = next.catch(() => undefined)
  return next
}

async function applyCollectionPolicy(): Promise<void> {
  const allowed = !isChina() && isCollectionAllowed()
  if (allowed === initialized) return
  if (allowed) {
    const analytics = await getAnalytics()
    if (!analytics) return
    await analytics.setAnalyticsCollectionEnabled(true)
    initialized = true
    console.log("Firebase Analytics initialized")
    return
  }
  const module = loadAnalyticsModule()
  if (!module) return
  await module.default().setAnalyticsCollectionEnabled(false)
  initialized = false
}

/** Enable collection if the current deployment policy allows it. */
export function initAnalytics(): Promise<void> {
  return serializeCollectionTransition(applyCollectionPolicy)
}

/** Disable collection. Runs after any in-flight enable so the final state wins. */
export function disableAnalytics(): Promise<void> {
  return serializeCollectionTransition(async () => {
    if (!analyticsModule && !initialized) return
    const module = loadAnalyticsModule()
    if (!module) return
    await module.default().setAnalyticsCollectionEnabled(false)
    initialized = false
  })
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
