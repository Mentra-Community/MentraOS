import * as Sentry from "@sentry/react-native"
import {SETTINGS, engine} from "@mentra/engine"
import {deploymentStore} from "@/services/deployment"

export const SentryNavigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
  routeChangeTimeoutMs: 1_000, // default: 1_000
  ignoreEmptyBackNavigationTransactions: true, // default: true
})

/**
 * Demote known third-party fatal errors to non-fatal Sentry reports so the
 * app doesn't get torn down by them. Currently filters:
 *   - PostHog session-id uuidv7 generation throwing `RangeError: invalid field value`
 *     (MENTRA-OS-1SE). Affects devices with clock skew; can't be fixed from app code
 *     without upgrading @posthog/core.
 */
let knownErrorFilterInstalled = false
let sentryInitialized = false
let sentryInitializationBlocked = false
let requestedSentryState = false
let reconcilingSentryState = false
let deploymentSubscriptionInstalled = false

const installKnownErrorFilter = () => {
  if (knownErrorFilterInstalled) return
  knownErrorFilterInstalled = true
  const ErrorUtils = (global as any).ErrorUtils
  if (!ErrorUtils || typeof ErrorUtils.getGlobalHandler !== "function") return
  const previous = ErrorUtils.getGlobalHandler()
  ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
    try {
      const msg = error?.message ?? String(error)
      const stack = error?.stack ?? ""
      const isPosthogUuidV7 =
        msg === "invalid field value" &&
        (stack.includes("fromFieldsV7") || stack.includes("uuidv7") || stack.includes("getSessionId"))
      if (isPosthogUuidV7) {
        Sentry.captureException(error, {
          tags: {filtered: "posthog_uuidv7_rangeerror"},
          level: "warning",
        })
        return
      }
    } catch {
      // fall through to default handler on any meta-error
    }
    previous?.(error, isFatal)
  })
}

function initializeSentry() {
  if (sentryInitialized) return
  // Always install — the filter prevents a known-fatal PostHog bug from killing
  // the app even when Sentry itself isn't initialized.
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
  installKnownErrorFilter()
  if (!deploymentSubscriptionInstalled) {
    deploymentSubscriptionInstalled = true
    // DeploymentStore notifies synchronously. This starts disabling Sentry at
    // the selection boundary rather than waiting for a React effect after the
    // workspace screen has rendered or begun fetching its manifest.
    deploymentStore.subscribe(updateSentryForActiveDeployment)
  }
  updateSentryForActiveDeployment()
}
