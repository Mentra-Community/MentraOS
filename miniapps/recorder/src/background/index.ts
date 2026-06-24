/**
 * Background JSContext entry — Recorder miniapp.
 *
 * The controller constructed here lives for the whole session and survives
 * WebView open/close cycles, so recording keeps running with the phone pocketed.
 * It drives `session.recorder` (host-side audio capture → blob), manages the
 * `session.blob` library, plays recordings back via `session.speaker`, and talks
 * to the UI over the typed session.ui channel bus.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {RecorderController} from "./controllers/RecorderController"

registerMiniapp((session) => {
  void new RecorderController(session).start()
})
