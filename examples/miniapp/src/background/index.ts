/**
 * Background JSContext entry point — Mentra Example miniapp.
 *
 * Loaded once by the MentraOS host inside a per-miniapp JSContext.
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands;
 * controllers constructed here live for the entire session, surviving
 * WebView open/close cycles.
 *
 * Controllers:
 *   - GlassesController: always-on captions logic + UI message bus
 *   - TesterController:  the SDK Tester surface's background dispatcher
 *   - ElevenLabsController: ConvAI mic → WebSocket repro (RN example port)
 *
 * All are idempotent — start() is safe to call again on respawn.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {ElevenLabsController} from "./controllers/ElevenLabsController"
import {GlassesController} from "./controllers/GlassesController"
import {TesterController} from "./controllers/TesterController"

registerMiniapp((session) => {
  // Start each controller independently — a throw in one must not prevent
  // the others from initializing for this session.
  try {
    new GlassesController(session).start()
  } catch (err) {
    console.error("[example-miniapp] GlassesController failed to start", err)
  }
  try {
    new TesterController(session).start()
  } catch (err) {
    console.error("[example-miniapp] TesterController failed to start", err)
  }
  try {
    new ElevenLabsController(session).start()
  } catch (err) {
    console.error("[example-miniapp] ElevenLabsController failed to start", err)
  }
})
