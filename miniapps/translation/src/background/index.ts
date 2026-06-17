/**
 * Background JSContext entry — Local Translation miniapp.
 *
 * A faithful local (island-runtime) port of the @mentra/translation cloud app.
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands; the
 * controller constructed here lives for the entire session and survives WebView
 * open/close cycles. It subscribes to any-source -> target translation, renders
 * translated text on the glasses display, and talks to the UI WebView over the
 * typed session.ui channel bus (see shared/channels.ts).
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {TranslationController} from "./controllers/TranslationController"

registerMiniapp((session) => {
  void new TranslationController(session).start()
})
