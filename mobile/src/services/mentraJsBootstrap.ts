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
  appRegistry,
  decideDevLaunchRoute,
  devServerBridge,
  type InstalledMiniappManifest,
  localMiniappRuntime,
  storage,
  useAppStatusStore,
} from "@mentra/island"
import {File} from "expo-file-system"

import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {useNavigationStore} from "@/stores/navigation"
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

  const crashController = new MentraJSCrashController()
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
      let bgSource: string | null = null
      // Carry the declared permissions + manifest across the respawn. The
      // original spawn (LocalMiniappView's launch effect) passes these to
      // spawnAndRegister; omitting them here would respawn the JSContext
      // with no permissions, so SUBSCRIBE gates and per-call dispatch
      // checks would start rejecting after a background hot-reload.
      let declaredPermissions: string[] = []
      let installedManifest: InstalledMiniappManifest | undefined

      const devUrlRes = storage.load<string>(`${packageName}_dev_url`)
      if (devUrlRes.is_ok()) {
        // Dev: re-fetch the manifest (entry path may have changed) + the
        // freshly built background bundle over HTTP.
        const devUrl = devUrlRes.value
        const route = await decideDevLaunchRoute(packageName, devUrl)
        if (route.decision === "offline" || !route.manifest) {
          console.warn(`MentraJS: respawn-bg dev server unreachable for ${packageName}`)
          return
        }
        const manifest = route.manifest
        const entry = manifest.entry as {background?: string} | undefined
        if (!entry?.background) return
        const perms = manifest.permissions as Array<{type?: string} | string> | undefined
        declaredPermissions = (perms ?? [])
          .map((p) => (typeof p === "string" ? p : p?.type))
          .filter((t): t is string => typeof t === "string")
        installedManifest = {
          permissions: manifest.permissions as InstalledMiniappManifest["permissions"],
          hardwareRequirements: manifest.hardwareRequirements as InstalledMiniappManifest["hardwareRequirements"],
        }
        const bgUrl = `${devUrl.replace(/\/$/, "")}/dist/${entry.background.replace(/^\.?\/+/, "")}`
        const res = await fetch(bgUrl)
        if (!res.ok) {
          console.warn(`MentraJS: respawn-bg fetch ${res.status} for ${packageName}`)
          return
        }
        bgSource = await res.text()
      } else {
        const version = await appRegistry.getActiveVersion(packageName)
        if (!version) return
        const entry = appRegistry.getMiniappEntryPaths(packageName, version)
        const bgUri = entry?.background
        if (!bgUri) return
        const manifest = appRegistry.getMiniappManifest(packageName, version) as {
          permissions?: Array<{type: string; required?: boolean; description?: string}>
          hardwareRequirements?: Array<{type: string; level: string; description?: string}>
        } | null
        declaredPermissions = (manifest?.permissions ?? [])
          .map((p) => p.type)
          .filter((t): t is string => typeof t === "string")
        installedManifest = manifest
          ? {permissions: manifest.permissions, hardwareRequirements: manifest.hardwareRequirements}
          : undefined
        bgSource = new File(bgUri).textSync()
      }

      if (bgSource === null) return
      await router.unregister(packageName)
      const ok = await router.spawnAndRegister(packageName, bgSource, {
        permissions: declaredPermissions,
        installedManifest,
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
