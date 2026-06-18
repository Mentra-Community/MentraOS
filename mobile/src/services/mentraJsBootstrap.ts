/**
 * MentraJS host bootstrap — the island owns the MentraJS engine itself
 * (`ensureMiniappEngine()` constructs the crash controller, UI router, JS router,
 * binds them to the native Crust module + the launcher, and starts the pump).
 *
 * This host shim attaches the concerns that are genuinely host-owned:
 *  - the inter-miniapp interop policy (which packages count as system apps, the
 *    app-store start/stop, the audit trail) via `configureRuntime`, and
 *  - crashloop telemetry — Sentry events, automatic incident filing, the
 *    user-facing alert — via `router.onCrashloop` / `router.onRestartToast`.
 *
 * Called once from MantleManager.initServices. Idempotent — the island engine is
 * a singleton and the host attach runs once.
 */

import {Platform} from "react-native"
import * as Sentry from "@sentry/react-native"

import {
  configureRuntime,
  ensureMiniappEngine,
  getMiniappEngine,
  miniappLauncher,
  useAppStatusStore,
} from "@mentra/island"

import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {SYSTEM_APPS} from "@/constants/miniapps"
import {logEvent} from "@/utils/analytics"
import showAlert from "@/utils/AlertUtils"

const MENTRA_JS_ENGINE = Platform.OS === "ios" ? "jsc" : "quickjs"
const MENTRA_OS_VERSION = process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? "unknown"

let hostAttached = false

export function bootstrapMentraJS() {
  // Construct (or reuse) the island-owned engine, then attach the host concerns
  // once. ensureMiniappEngine() is idempotent; the hostAttached guard keeps the
  // interop hook + telemetry from re-binding on repeat calls.
  const engine = ensureMiniappEngine()
  if (hostAttached) return engine
  hostAttached = true

  const {router} = engine

  // Wire the inter-miniapp interop adapter (session.miniapps + session.actions
  // .invoke). The host owns the system-app policy (SYSTEM_APPS + dev sideloads)
  // and the app-store operations; the runtime enforces the protocol. Merged
  // into the runtime hooks — doesn't clobber other configureRuntime() calls.
  configureRuntime({
    interop: {
      isSystemApp: (pkg: string) => {
        if (SYSTEM_APPS.includes(pkg)) return true
        // Dev sideloads are trusted (same trust model as adb on Android) — this
        // is how the Mentra AI team iterates before it ships as a built-in.
        const app = useAppStatusStore.getState().apps.find((a) => a.packageName === pkg)
        return app?.isMiniappDev === true
      },
      listApps: () => useAppStatusStore.getState().apps,
      startApp: async (pkg: string) => {
        const app = useAppStatusStore.getState().apps.find((a) => a.packageName === pkg)
        if (!app) return false
        // An intent-started miniapp runs HEADLESS: spawn its background JS
        // context with NO foreground change and NO navigation — the user's phone
        // routing is untouched, and the calling miniapp is never stopped by
        // foreground arbitration. The app still shows as "running" (the launcher
        // registers it); its WebView only mounts later if the user opens it.
        // Native offline built-ins / cloud apps aren't headless, so they keep the
        // normal foregrounding start().
        if (app.local) {
          try {
            await miniappLauncher.ensureConnected(pkg)
            return true
          } catch (e) {
            console.warn(`mentraJsBootstrap: headless start failed for ${pkg}`, e)
            return false
          }
        }
        // Native offline built-ins / cloud apps have no background-only mode, so
        // they go through the normal start (which runs the host gates — hardware
        // compat, captions STT/transcriber setup, etc.). But pass skipNavigation
        // so an intent-start still never changes the user's route.
        return useAppStatusStore.getState().start(app, {skipNavigation: true})
      },
      stopApp: (pkg: string) => useAppStatusStore.getState().stop(pkg),
      // Headless wake for action invoke: spawn the background context + wait for
      // CONNECT. Same headless path as startApp for local miniapps.
      wakeMiniapp: (pkg: string) => miniappLauncher.ensureConnected(pkg),
      // Audit trail — one analytics event per interop call. An LLM caller
      // (Mentra AI) will eventually do something a user wants to trace.
      audit: (event) => {
        void logEvent("miniapp_interop", {
          caller: event.caller,
          op: event.op,
          target: event.target ?? "",
          actionId: event.actionId ?? "",
          ok: event.ok,
          errorCode: event.errorCode ?? "",
        })
      },
    },
  })

  // Surface crashloop transitions as Sentry events tagged with the
  // miniapp packageName + engine + host version + platform so on-call
  // can filter the dashboard. Per spec — every miniapp event ships
  // the same tag set.
  const baseTags = (packageName: string) => ({
    "miniapp.packageName": packageName,
    "miniapp.engine": MENTRA_JS_ENGINE,
    "miniapp.sdk_version": "0.3.0",
    "miniapp.host_version": MENTRA_OS_VERSION,
    "device.platform": Platform.OS,
  })
  router.onCrashloop = (packageName: string, reason: string) => {
    // Sentry first (best-effort) so we don't lose telemetry if the rest
    // of the chain throws.
    const lastLogLines = router.logRing.snapshot(packageName)
    try {
      Sentry.captureMessage(`MentraJS crashloop disabled: ${packageName}`, {
        level: "error",
        tags: baseTags(packageName),
        extra: {reason, lastLogLines},
      })
    } catch {
      /* Sentry not initialized in dev */
    }

    // Look up the miniapp's display name for the alert + incident.
    const app = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)
    const appName = app?.name ?? packageName

    // File an automatic incident. Dedupe so a flapping miniapp doesn't
    // generate one incident per crashloop transition.
    void submitAutomaticBugIncident({
      categorization: {
        submissionMode: "AUTOMATIC",
        triggerArea: "miniapp_crashloop",
        triggerReason: "mentrajs_crashloop_disabled",
        sourceAppletPackageName: packageName,
        sourceAppletName: appName,
      },
      expectedBehavior: `${appName} should run without crashing.`,
      actualBehavior: JSON.stringify({reason, lastLogLines}, null, 2),
      severityRating: 7,
      dedupeKey: `mentrajs_crashloop:${packageName}`,
      logTag: "MentraJSCrashloop",
    })

    // User-facing alert. Last so even if Sentry/incident fail the user
    // still sees something.
    showAlert(
      `${appName} stopped working`,
      "We've filed an incident report. Try opening it again later — if the issue persists, please send us feedback.",
      [{text: "OK"}],
    )
  }
  router.onRestartToast = (packageName: string, reason: string) => {
    try {
      Sentry.addBreadcrumb({
        category: "miniapp.respawn",
        level: "warning",
        message: `Respawned ${packageName}`,
        data: {reason, ...baseTags(packageName)},
      })
    } catch {
      /* ignore */
    }
  }

  // The /applet/local route binds the UI router to its WebView directly
  // via `getMentraJS().uiRouter.bindWebView(...)` — no global attach
  // step needed. The router is reachable on the island engine singleton.

  return engine
}

/** Returns the island MentraJS engine singletons if constructed, else null. */
export function getMentraJS() {
  return getMiniappEngine()
}
