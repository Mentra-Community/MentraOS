/**
 * Background JSContext entry point — Mentra AI (local).
 *
 * Loaded once by the MentraOS host in a per-miniapp JSContext. The controller
 * constructed here owns the whole assistant (transcription → agent → speak/
 * display) and lives for the entire session, surviving webview open/close.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {MentraAIController} from "./MentraAIController"

registerMiniapp((session) => {
  void new MentraAIController(session).start()
})
