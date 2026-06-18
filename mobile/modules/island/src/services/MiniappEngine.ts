/**
 * MiniappEngine — constructs the MentraJS router singletons (crash controller,
 * UI router, JS router), binds them to the native Crust module + the launcher,
 * wires the dev-server background-respawn signal, and starts the message pump.
 *
 * Island owns this so a bare OEM's `toolkit.start()` brings up the local-miniapp
 * engine with no host construction step. Host-only concerns — crashloop telemetry
 * (Sentry / incident filing / user alert) and the inter-miniapp interop policy
 * (which packages count as system apps, the app-store start/stop) — are attached
 * by the host *after* this returns, via `router.onCrashloop` / `configureRuntime`.
 *
 * Idempotent — `ensureMiniappEngine()` returns the same singletons on every call,
 * so it's safe to call from both `toolkit.start()` and the host bootstrap.
 */

import CrustModule from "@mentra/crust"

import devServerBridge from "./DevServerBridge"
import localMiniappRuntime from "./LocalMiniappRuntime"
import {configureLauncher, miniappLauncher} from "./MiniappLauncher"
import {MentraJSCrashController} from "./MentraJSCrashController"
import {MentraJSRouter, type MentraJSCrustBinding} from "./MentraJSRouter"
import {MentraUIRouter} from "./MentraUIRouter"

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
  if (engine) return engine

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

  // Hand the router to the island MiniappLauncher so headless launch/teardown
  // (apps.ts start/stop, the action broker, the WebView mount path) all spawn
  // through one place.
  configureLauncher({router})

  // Wire up the dev server's "respawn-bg" signal so a touch under
  // src/background/ kills + re-spawns the JSContext with the latest bundle.
  // The WebView reload path stays separate (devServerBridge.onReload).
  //
  // Dev miniapps fetch the fresh background JS straight off the dev server over
  // HTTP (mirrors LocalMiniappView's HTTP-direct launch). Released miniapps fall
  // back to reading the installed file:// snapshot.
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
      // The respawned JSContext is a fresh MiniappSession with ui.bound false.
      // The mounted WebView won't re-fire mentra.ready() (it's latched), so
      // re-announce it so RPC replies (mentra.request) reach the UI again
      // instead of being dropped while unbound.
      uiRouter.notifyReopen(packageName)
    } catch (e) {
      console.warn(`MentraJS: respawn-bg threw for ${packageName}:`, e)
    }
  })

  router.start()

  engine = {router, uiRouter, crashController}
  return engine
}

/** Returns the engine singletons if already constructed, else null. */
export function getMiniappEngine(): MiniappEngine | null {
  return engine
}
