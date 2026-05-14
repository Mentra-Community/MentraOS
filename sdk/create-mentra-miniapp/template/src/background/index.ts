/**
 * Background JSContext entry point. The MentraOS host spawns this file
 * inside a per-miniapp JSContext (iOS-JSC / Android-QuickJS) and calls
 * `init(session)` once on startup. All glasses-side logic lives here.
 *
 * Background runs **always** while the host app process is alive — even
 * when the user hasn't opened the miniapp's UI. Register your event
 * subscriptions inside `init`; the runtime tears them down when the
 * miniapp is disabled or uninstalled.
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import "../shared/channels"

export async function init(session: MiniappSession): Promise<void> {
  // Hydrate any persisted state from session.storage (string KV — JSON-encode
  // structured data yourself).
  // const stored = await session.storage.get("notes")
  // const notes: Note[] = stored ? JSON.parse(stored) : []

  // Glasses button → demo display.
  session.input.onButtonPress(() => {
    session.display.showTextWall("Hello from MentraJS")
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
}
