/**
 * Background JSContext entry point. The MentraOS host loads this file
 * inside a per-miniapp JSContext (iOS-JSC / Android-QuickJS) and calls
 * the `registerMiniapp` handler once CONNECT completes. All glasses-side
 * logic lives in here.
 *
 * Background runs **always** while the host app process is alive — even
 * when the user hasn't opened the miniapp's UI. Register your event
 * subscriptions inside the handler; the runtime tears them down when the
 * miniapp is disabled or uninstalled.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import type {Channels} from "../shared/channels"

registerMiniapp<Channels>(async (session) => {
  // Hydrate any persisted state from session.storage (string KV — JSON-encode
  // structured data yourself).
  // const stored = await session.storage.get("notes")
  // const notes: Note[] = stored ? JSON.parse(stored) : []

  // Glasses button → demo display. display.render() replaces the whole frame:
  // describe everything that should be on screen and the host diffs it against
  // the previous frame (stable ids update in place; render([]) clears). Box
  // coordinates are raw device px — read `session.capabilities.display`
  // (populated on the "ready" event) for the real canvas size.
  session.input.onButtonPress(() => {
    const d = session.capabilities?.display
    void session.display.render([
      {
        type: "text",
        id: "hello",
        box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288},
        text: "Hello from MentraJS",
      },
    ])
  })

  // UI bus: forward "ping" → "pong" with a roundtrip timestamp.
  session.ui.onOpen(() => {
    // Push initial state to the WebView whenever it opens.
    session.ui.send("pong", {at: Date.now(), roundtripMs: 0})
  })
  session.ui.on("ping", ({at}) => {
    const roundtripMs = Date.now() - at
    session.ui.send("pong", {at: Date.now(), roundtripMs})
  })
})
