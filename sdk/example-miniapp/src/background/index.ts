/**
 * Background JSContext entry point — Example Miniapp ("Live Captions").
 *
 * Spawned once by the MentraOS host inside a per-miniapp JSContext.
 * `init(session)` runs once after spawn; subscriptions wired here live
 * for the entire session, surviving WebView open/close cycles.
 *
 * Two controllers:
 *   - GlassesController: the always-on captions logic + UI message bus
 *   - TesterController:  the SDK Tester surface's background dispatcher
 *
 * Both are idempotent — start() is safe on respawn after a crash.
 */

import type {MiniappSession} from "@mentra/miniapp/background"

import {GlassesController} from "./controllers/GlassesController"
import {TesterController} from "./controllers/TesterController"

export function init(session: MiniappSession): void {
  new GlassesController(session).start()
  new TesterController(session).start()
}
