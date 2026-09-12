import * as Sentry from "@sentry/react-native"
import {SETTINGS, engine} from "@mentra/engine"
import {deploymentStore} from "@/services/deployment"

export const SentryNavigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
  routeChangeTimeoutMs: 1_000, // default: 1_000
  ignoreEmptyBackNavigationTransactions: true, // default: true
})

let sentryInitialized = false
let sentryInitializationBlocked = false
let requestedSentryState = false
let reconcilingSentryState = false
let deploymentSubscriptionInstalled = false

function initializeSentry() {
  if (sentryInitialized) return
  // Only initialize Sentry if DSN is provided
  const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN
  const isChina = engine.settings.get(SETTINGS.china_deployment.key)

  if (!sentryDsn || sentryDsn === "secret" || sentryDsn.trim() === "") {
    sentryInitializationBlocked = true
    return
  }
  if (isChina) {
    sentryInitializationBlocked = true
    return
  }

  const release = `${process.env.EXPO_PUBLIC_MENTRAOS_VERSION}`
  const dist = `${process.env.EXPO_PUBLIC_BUILD_TIME}-${process.env.EXPO_PUBLIC_BUILD_COMMIT}`
  // const sampleRate = isProd ? 0.1 : 1.0
  const sampleRate = 1.0

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
    maxBreadcrumbs: 100,

    // Truncate noisy BLE breadcrumbs to prevent Sentry crashes (see MENTRA-OS-13Z, 13K, 13N, 13P)
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === "console" && breadcrumb.message) {
        const msg = breadcrumb.message
        // Truncate high-frequency BLE reconnection logs
        if (msg.includes("G1:")) {
          breadcrumb.message = `[G1 BLE] ${msg.substring(0, 50)}...`
        } else if (msg.includes("peripheral")) {
          breadcrumb.message = `[BLE peripheral] ${msg.substring(0, 50)}...`
        }
      }
      // Ignore touch breadcrumbs
      if (breadcrumb.category === "touch") {
        return null
      }
      return breadcrumb
    },
  })
  sentryInitialized = true
}

async function reconcileSentryState() {
  if (reconcilingSentryState) return
  reconcilingSentryState = true
  try {
    while (requestedSentryState !== sentryInitialized && !sentryInitializationBlocked) {
      if (requestedSentryState) {
        initializeSentry()
        // A missing DSN or China profile intentionally leaves the SDK off.
        if (!sentryInitialized) return
      } else {
        Sentry.setUser(null)
        await Sentry.close()
        sentryInitialized = false
      }
    }
  } finally {
    reconcilingSentryState = false
    if (requestedSentryState !== sentryInitialized && !sentryInitializationBlocked) void reconcileSentryState()
  }
}

export const updateSentryForActiveDeployment = () => {
  requestedSentryState = deploymentStore.isTelemetryAllowed()
  void reconcileSentryState()
}

export const SentrySetup = () => {
  if (!deploymentSubscriptionInstalled) {
    deploymentSubscriptionInstalled = true
    // DeploymentStore notifies synchronously. This starts disabling Sentry at
    // the selection boundary rather than waiting for a React effect after the
    // workspace screen has rendered or begun fetching its manifest.
    deploymentStore.subscribe(updateSentryForActiveDeployment)
  }
  updateSentryForActiveDeployment()
}
