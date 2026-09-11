/**
 * MentraJS host bootstrap — the island owns the MentraJS engine itself
 * (`ensureMiniappEngine()` constructs the crash controller, UI router, JS router,
 * binds them to the native Crust module + the launcher, and starts the pump).
 *
 * This host shim attaches Mentra-app telemetry around the island-owned engine:
 * Sentry events and the user-facing alert via `router.onCrashloop` /
 * `router.onRestartToast`.
 *
 * Called once from MantleManager.initServices. Idempotent — the island engine is
 * a singleton and the host attach runs once.
 */

import {engine} from "@mentra/engine"
import {Platform} from "react-native"
import * as Sentry from "@sentry/react-native"

import {ensureMiniappEngine, getMiniappEngine} from "@mentra/engine-host-internal"

import showAlert from "@/utils/AlertUtils"

const MENTRA_JS_ENGINE = Platform.OS === "ios" ? "jsc" : "quickjs"
const MENTRA_OS_VERSION = process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? "unknown"

let hostAttached = false

export function bootstrapMentraJS() {
  // Construct (or reuse) the island-owned engine, then attach the host concerns
  // once. ensureMiniappEngine() is idempotent; the hostAttached guard keeps the
  // telemetry from re-binding on repeat calls.
  const miniappEngine = ensureMiniappEngine()
  if (hostAttached) return miniappEngine
  hostAttached = true

  const {router} = miniappEngine

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

    // Look up the miniapp's display name for the alert + report.
    const app = engine.miniapps.list().find((a) => a.packageName === packageName)
    const appName = app?.name ?? packageName

    // User-facing alert. Last so even if Sentry/reporting fails the user
    // still sees something.
    showAlert(
      `${appName} stopped working`,
      "We've filed a bug report. Try opening it again later — if the issue persists, please send us feedback.",
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

  return miniappEngine
}

/** Returns the island MentraJS engine singletons if constructed, else null. */
export function getMentraJS() {
  return getMiniappEngine()
}
