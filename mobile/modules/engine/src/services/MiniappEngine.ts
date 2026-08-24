/**
 * MiniappEngine — constructs the MentraJS router singletons (crash controller,
 * UI router, JS router), binds them to the native Crust module + the launcher,
 * wires the dev-server background-respawn signal, and starts the message pump.
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

import devServerBridge from "./DevServerBridge"
import localMiniappRuntime from "./LocalMiniappRuntime"
import {miniappLauncher} from "./MiniappLauncher"
import {MentraJSCrashController} from "./MentraJSCrashController"
import {MentraJSRouter, type MentraJSCrustBinding} from "./MentraJSRouter"
import {MentraUIRouter} from "./MentraUIRouter"

export interface MiniappEngine {
  router: MentraJSRouter
  uiRouter: MentraUIRouter
  crashController: MentraJSCrashController
}

let engine: MiniappEngine | null = null

function wireDevServerRespawnBackground(router: MentraJSRouter, uiRouter: MentraUIRouter): void {
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
        hostTrustedSystem: resolved.hostTrustedSystem,
      })
      if (!ok) {
        console.warn(`MentraJS: respawn-bg failed for ${packageName}`)
        return
      }
      // The respawned JSContext is a fresh MiniappSession with ui.bound false.
      // The mounted WebView won't re-fire mentra.ready() (it's latched), so
      // re-announce it so RPC replies (mentra.request) reach the UI again
      // instead of being dropped while unbound.
      uiRouter.notifyReopen(packageName)
    } catch (e) {
      console.warn(`MentraJS: respawn-bg threw for ${packageName}:`, e)
    }
  })
}

/**
 * Construct (once) and return the MentraJS engine singletons. Starts the router's
 * message pump on first call. Subsequent calls return the same instances.
 */
export function ensureMiniappEngine(): MiniappEngine {
  if (engine) {
    wireDevServerRespawnBackground(engine.router, engine.uiRouter)
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

  // Hand the router to the engine MiniappLauncher so headless launch/teardown
  // (apps.ts start/stop, the action broker, the WebView mount path) all spawn
  // through one place.
  miniappLauncher.configure({router})

  // Wire up the dev server's "respawn-bg" signal so a touch under
  // src/background/ kills + re-spawns the JSContext with the latest bundle.
  // The WebView reload path stays separate (devServerBridge.onReload).
  wireDevServerRespawnBackground(router, uiRouter)

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

  devServerBridge.clearRespawnBackgroundHandler()
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
