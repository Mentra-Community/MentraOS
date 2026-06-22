/**
 * Background JSContext entry — Teleprompter miniapp.
 *
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands; the
 * controller constructed here lives for the entire session and survives WebView
 * open/close cycles. It wraps the user's script to the connected glasses, drives
 * scrolling from either voice or a WPM timer, renders to the display, and talks
 * to the UI WebView over the typed session.ui channel bus.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {TeleprompterController} from "./controllers/TeleprompterController"

registerMiniapp((session) => {
  void new TeleprompterController(session).start()
})
