/**
 * MentraJS bootstrap — constructs the host-side router singletons and
 * wires native crash detection into the controller. Called once from
 * MantleManager.initServices alongside the LocalMiniappRuntime init.
 *
 * Idempotent — multiple calls return the same singletons.
 */

import {Platform} from "react-native"
import * as Sentry from "@sentry/react-native"
import CrustModule from "crust"

import {
  MentraJSCrashController,
  MentraJSRouter,
  MentraUIRouter,
  configureLauncher,
  configureRuntime,
  devServerBridge,
  localMiniappRuntime,
  miniappLauncher,
  useAppStatusStore,
} from "@mentra/island"

import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {SYSTEM_APPS} from "@/constants/miniapps"
import {useNavigationStore} from "@/stores/navigation"
import {logEvent} from "@/utils/analytics"
import showAlert from "@/utils/AlertUtils"

const MENTRA_JS_ENGINE = Platform.OS === "ios" ? "jsc" : "quickjs"
const MENTRA_OS_VERSION = process.env.EXPO_PUBLIC_MENTRAOS_VERSION ?? "unknown"

let bootstrapped: {
  router: MentraJSRouter
  uiRouter: MentraUIRouter
  crashController: MentraJSCrashController
} | null = null

export function bootstrapMentraJS() {
  if (bootstrapped) return bootstrapped
  // The Crust native module type doesn't include the new mentraJs*
  // functions in the codebase's published TS typing until expo prebuild
  // runs; cast to a loose shape so the bootstrap compiles cleanly.
  const crust = CrustModule as unknown as ConstructorParameters<typeof MentraJSRouter>[1]

  const crashController = new MentraJSCrashController({
    maxRetries: 3,
  })
  const uiRouter = new MentraUIRouter({
    mentraJsDispatchToJs: (packageName: string, envelope: Record<string, unknown>) =>
      (
        CrustModule as unknown as {
          mentraJsDispatchToJs: (p: string, e: Record<string, unknown>) => Promise<void>
        }
      ).mentraJsDispatchToJs(packageName, envelope),
  })
  const router = new MentraJSRouter(localMiniappRuntime, crust)
  router.crashController = crashController
  router.uiRouter = uiRouter

  // Hand the router to the island MiniappLauncher so headless launch/teardown
  // (apps.ts start/stop, the action broker, the WebView mount path) all spawn
  // through one place. The router is host-constructed (needs the native Crust
  // binding) and injected here — same DI seam as configureRuntime.
  configureLauncher({router})

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
  // step needed. The router is reachable on the bootstrapped singleton.

  // Wire up the dev server's "respawn-bg" signal so a touch under
  // src/background/ kills + re-spawns the JSContext with the latest
  // bundle. The WebView reload path stays separate (devServerBridge.onReload).
  //
  // Dev miniapps fetch the fresh background JS straight off the dev server
  // over HTTP (mirrors LocalMiniappView's HTTP-direct launch). Released
  // miniapps fall back to reading the installed file:// snapshot.
  devServerBridge.onRespawnBackground(async (packageName) => {
    try {
      // Re-resolve the freshly built bundle (dev: HTTP off the dev server;
      // released: file:// snapshot) via the launcher's shared recipe. Carries
      // the declared permissions + manifest across the respawn — omitting them
      // would respawn the JSContext with no permissions, so SUBSCRIBE gates and
      // per-call dispatch checks would start rejecting after a background
      // hot-reload.
      const resolved = await miniappLauncher.resolveBundle(packageName)
      if (!resolved) {
        console.warn(`MentraJS: respawn-bg could not resolve bundle for ${packageName}`)
        return
      }
      // Force a respawn (kill + spawn) rather than launcher.ensureRunning,
      // which is idempotent and would no-op an already-registered context.
      await router.unregister(packageName)
      const ok = await router.spawnAndRegister(packageName, resolved.bgSource, {
        permissions: resolved.declaredPermissions,
        installedManifest: resolved.installedManifest,
      })
      if (!ok) {
        console.warn(`MentraJS: respawn-bg failed for ${packageName}`)
        return
      }
      // The respawned JSContext is a fresh MiniappSession with ui.bound
      // false. The mounted WebView won't re-fire mentra.ready() (it's
      // latched), so re-announce it so RPC replies (mentra.request) reach
      // the UI again instead of being dropped while unbound.
      uiRouter.notifyReopen(packageName)
    } catch (e) {
      console.warn(`MentraJS: respawn-bg threw for ${packageName}:`, e)
    }
  })

  router.start()

  bootstrapped = {router, uiRouter, crashController}
  return bootstrapped
}

/** Returns the singletons if already bootstrapped, else null. */
export function getMentraJS() {
  return bootstrapped
}
