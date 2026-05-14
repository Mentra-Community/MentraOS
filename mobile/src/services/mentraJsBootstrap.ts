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
  devServerBridge,
  localMiniappRuntime,
} from "@mentra/island"
import {File} from "expo-file-system"

import {miniappHost} from "@/components/miniapp/MiniappHost"

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
      (CrustModule as unknown as {
        mentraJsDispatchToJs: (p: string, e: Record<string, unknown>) => Promise<void>
      }).mentraJsDispatchToJs(packageName, envelope),
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
    try {
      Sentry.captureMessage(`MentraJS crashloop disabled: ${packageName}`, {
        level: "error",
        tags: baseTags(packageName),
        extra: {reason, lastLogLines: router.logRing.snapshot(packageName)},
      })
    } catch {
      /* Sentry not initialized in dev */
    }
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

  // Attach the UI router to MiniappHost so two-layer miniapps' WebViews
  // route mentra.send / mentra.on through the bound JSContext.
  miniappHost.attachUIRouter(uiRouter)

  // Wire up the dev server's "respawn-bg" signal so a touch under
  // src/background/ kills + re-spawns the JSContext with the latest
  // bundle. The WebView reload path stays separate (devServerBridge.onReload).
  devServerBridge.onRespawnBackground(async (packageName) => {
    try {
      const version = await appRegistry.getActiveVersion(packageName)
      if (!version) return
      const entry = appRegistry.getMiniappEntryPaths(packageName, version)
      const bgUri = entry?.background
      if (!bgUri) return
      const bgSource = new File(bgUri).textSync()
      await router.unregister(packageName)
      const ok = await router.spawnAndRegister(packageName, bgSource)
      if (!ok) console.warn(`MentraJS: respawn-bg failed for ${packageName}`)
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
