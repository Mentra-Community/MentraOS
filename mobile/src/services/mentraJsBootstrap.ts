/**
 * MentraJS bootstrap — constructs the host-side router singletons and
 * wires native crash detection into the controller. Called once from
 * MantleManager.initServices alongside the LocalMiniappRuntime init.
 *
 * Idempotent — multiple calls return the same singletons.
 */

import * as Sentry from "@sentry/react-native"
import CrustModule from "crust"

import {
  MentraJSCrashController,
  MentraJSRouter,
  MentraUIRouter,
  localMiniappRuntime,
} from "@mentra/island"

import {miniappHost} from "@/components/miniapp/MiniappHost"

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
  // miniapp packageName so on-call can see them in the dashboard.
  router.onCrashloop = (packageName: string, reason: string) => {
    try {
      Sentry.captureMessage(`MentraJS crashloop disabled: ${packageName}`, {
        level: "error",
        tags: {
          "miniapp.packageName": packageName,
          "miniapp.engine": "jsc",
        },
        extra: {reason},
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
        data: {reason},
      })
    } catch {
      /* ignore */
    }
  }

  // Attach the UI router to MiniappHost so two-layer miniapps' WebViews
  // route mentra.send / mentra.on through the bound JSContext.
  miniappHost.attachUIRouter(uiRouter)

  router.start()

  bootstrapped = {router, uiRouter, crashController}
  return bootstrapped
}

/** Returns the singletons if already bootstrapped, else null. */
export function getMentraJS() {
  return bootstrapped
}
