/**
 * Background JSContext entry point — Example Miniapp ("Live Captions").
 *
 * Loaded once by the MentraOS host inside a per-miniapp JSContext.
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands;
 * controllers constructed here live for the entire session, surviving
 * WebView open/close cycles.
 *
 * Two controllers:
 *   - GlassesController: always-on captions logic + UI message bus
 *   - TesterController:  the SDK Tester surface's background dispatcher
 *
 * Both are idempotent — start() is safe to call again on respawn.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {GlassesController} from "./controllers/GlassesController"
import {TesterController} from "./controllers/TesterController"

registerMiniapp((session) => {
  new GlassesController(session).start()
  new TesterController(session).start()
})
