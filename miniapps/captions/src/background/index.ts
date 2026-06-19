/**
 * Background JSContext entry — Local Captions miniapp.
 *
 * A faithful local (island-runtime) port of the @mentra/captions cloud app.
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands; the
 * controller constructed here lives for the entire session and survives WebView
 * open/close cycles. It subscribes to transcription, renders captions on the
 * glasses display via CaptionsFormatter, and talks to the UI WebView over the
 * typed session.ui channel bus (see shared/channels.ts).
 *
 * The single-bundle proof this replaced did `transcription.on -> showTextWall`
 * inline; the real captions logic (history, speaker labels, char-level wrapping,
 * 40s inactivity clear, settings) now lives in CaptionsController.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {CaptionsController} from "./controllers/CaptionsController"

registerMiniapp((session) => {
  void new CaptionsController(session).start()
})
