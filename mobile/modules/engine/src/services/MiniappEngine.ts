/**
 * MiniappEngine — constructs the MentraJS router singletons (crash controller,
 * UI router, JS router), binds them to the native Crust module + the launcher,
 * and starts the message pump.
 *
 * Engine owns this so a bare OEM's `engine.start()` brings up the local-miniapp
 * engine with no host construction step. Host-only concerns that remain outside
 * engine, such as Mentra-app crashloop telemetry, are attached by the host after
 * this returns via `router.onCrashloop` / `router.onRestartToast`.
 *
 * Idempotent — `ensureMiniappEngine()` returns the same singletons on every call,
 * so it's safe to call from both `engine.start()` and the host bootstrap.
 */

import CrustModule from "@mentra/crust"

import localMiniappRuntime from "./LocalMiniappRuntime"
import {miniappLauncher} from "./MiniappLauncher"
import {MentraJSCrashController} from "./MentraJSCrashController"
import {MentraJSRouter, type MentraJSCrustBinding} from "./MentraJSRouter"
import {MentraUIRouter} from "./MentraUIRouter"
import {BgTimer} from "../utils/timers"

export interface MiniappEngine {
  router: MentraJSRouter
  uiRouter: MentraUIRouter
  crashController: MentraJSCrashController
}

let engine: MiniappEngine | null = null

/**
 * Construct (once) and return the MentraJS engine singletons. Starts the router's
 * message pump on first call. Subsequent calls return the same instances.
 */
export function ensureMiniappEngine(): MiniappEngine {
  if (engine) {
    engine.router.start()
    return engine
  }

  // The Crust native module's published TS typing doesn't include the new
  // mentraJs* functions until expo prebuild regenerates it; cast to the binding
  // shapes the routers expect.
  const crust = CrustModule as unknown as MentraJSCrustBinding

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
  router.timer = BgTimer

  // Hand the router to the engine MiniappLauncher so headless launch/teardown
  // (apps.ts start/stop, the action broker, the WebView mount path) all spawn
  // through one place.
  miniappLauncher.configure({router})

  router.start()

  engine = {router, uiRouter, crashController}
  return engine
}

/** Stop the MentraJS message pump and tear down router-managed JSContexts. */
export async function stopMiniappEngine(): Promise<void> {
  const current = engine
  if (!current) return
  // Null the singleton BEFORE the async teardown below: a concurrent
  // ensureMiniappEngine() must construct fresh instead of re-starting (and
  // re-subscribing) the router that is mid-teardown, which would leak a zombie
  // Crust subscription once this function finishes.
  engine = null

  current.router.stop()

  const packages = current.router.registeredPackages()
  await Promise.all(
    packages.map(async (packageName) => {
      try {
        await current.router.unregister(packageName)
      } catch (err) {
        console.warn(`MentraJS: failed to unregister ${packageName} during stop:`, err)
      }
    }),
  )
}

/** Returns the engine singletons if already constructed, else null. */
export function getMiniappEngine(): MiniappEngine | null {
  return engine
}
