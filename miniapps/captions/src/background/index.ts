/**
 * Background JSContext entry point — Mentra Example miniapp.
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

  // Declared actions (see miniapp.json -> actions). A system miniapp such as
  // Mentra AI can invoke these with:
  //   session.actions.invoke("com.mentra.example", "show_text", {text: "hi"})
  // `handle` is open to all miniapps; only the *caller* side (invoke) is
  // SYSTEM-gated. `ctx.callerPackageName` is host-stamped (trustworthy).
  session.actions.handle("echo", (params, ctx) => ({
    echoed: params.message,
    caller: ctx.callerPackageName,
  }))
  session.actions.handle("show_text", (params) => {
    const text = typeof params.text === "string" ? params.text : ""
    session.display.showTextWall(text)
    return {shown: text}
  })
})
