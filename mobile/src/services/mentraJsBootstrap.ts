/**
 * MentraJS host bootstrap — the island owns the MentraJS engine itself
 * (`ensureMiniappEngine()` constructs the crash controller, UI router, JS router,
 * binds them to the native Crust module + the launcher, and starts the pump).
 *
 * This host shim attaches Mentra-app telemetry around the island-owned engine:
 * Sentry events, automatic incident filing, and the user-facing alert via
 * `router.onCrashloop` / `router.onRestartToast`.
 *
 * Called once from MantleManager.initServices. Idempotent — the island engine is
 * a singleton and the host attach runs once.
 */

import {Platform} from "react-native"
import * as Sentry from "@sentry/react-native"

import {ensureMiniappEngine, getMiniappEngine, useAppStatusStore} from "@mentra/island"

import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import showAlert from "@/utils/AlertUtils"

const MENTRA_JS_ENGINE = Platform.OS === "ios" ? "jsc" : "quickjs"
const MENTRA_OS_VERSION = process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? "unknown"

let hostAttached = false

export function bootstrapMentraJS() {
  // Construct (or reuse) the island-owned engine, then attach the host concerns
  // once. ensureMiniappEngine() is idempotent; the hostAttached guard keeps the
  // telemetry from re-binding on repeat calls.
  const engine = ensureMiniappEngine()
  if (hostAttached) return engine
  hostAttached = true

  const {router} = engine

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
