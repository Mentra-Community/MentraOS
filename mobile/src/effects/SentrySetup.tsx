import * as Sentry from "@sentry/react-native"

import {SETTINGS, useSettingsStore} from "@/stores/settings"

export const SentryNavigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
  routeChangeTimeoutMs: 1_000, // default: 1_000
  ignoreEmptyBackNavigationTransactions: true, // default: true
})

export const SentrySetup = () => {
  // Only initialize Sentry if DSN is provided
  const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN
  const isChina = useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)

  if (!sentryDsn || sentryDsn === "secret" || sentryDsn.trim() === "") {
    return
  }
  if (isChina) {
    return
  }

  const release = `${process.env.EXPO_PUBLIC_MENTRAOS_VERSION}`
  const dist = `${process.env.EXPO_PUBLIC_BUILD_TIME}-${process.env.EXPO_PUBLIC_BUILD_COMMIT}`
  const branch = process.env.EXPO_PUBLIC_BUILD_BRANCH
  const isProd = branch == "main" || branch == "staging"
  const sampleRate = isProd ? 0.1 : 1.0

  Sentry.init({
    dsn: sentryDsn,

    // Adds more context data to events (IP address, cookies, user, etc.)
    // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
    sendDefaultPii: true,

    // send 1/10th of events in prod:
    tracesSampleRate: sampleRate,

    // debug: true,
    _experiments: {
      enableUnhandledCPPExceptionsV2: true,
    },
    //   enableNativeCrashHandling: false,
    //   enableNativeNagger: false,
    //   enableNative: false,
    //   enableLogs: false,
    //   enabled: false,
    release: release,
    dist: dist,
    integrations: [Sentry.feedbackIntegration({})],

    // Reduce breadcrumb count to prevent memory issues during high-frequency BLE logging
    maxBreadcrumbs: 50,

    // Truncate noisy BLE breadcrumbs to prevent Sentry crashes (see MENTRA-OS-13Z, 13K, 13N, 13P)
    beforeBreadcrumb: breadcrumb => {
      if (breadcrumb.category === "console" && breadcrumb.message) {
        const msg = breadcrumb.message
        // Truncate high-frequency BLE reconnection logs
        if (msg.includes("G1:")) {
          breadcrumb.message = `[G1 BLE] ${msg.substring(0, 50)}...`
        } else if (msg.includes("peripheral")) {
          breadcrumb.message = `[BLE peripheral] ${msg.substring(0, 50)}...`
        }
      }
      return breadcrumb
    },
  })
}
