/**
 * client/index.ts
 *
 * Phone-side runtime code. Subscriptions register at module scope and
 * live for the runtime lifetime. There is no React, no useEffect, no
 * remount.
 *
 * Exported functions become typed RPCs the webview can call as
 * `mentra.client.setDisplayLines(...)`. No manual registration.
 */

import {session, state} from "@mentra/miniapp/framework"
import {CHARS_PER_LINE, type AppState} from "../shared/types"

state.init<AppState>({
  transcript: "",
  displayLines: 3,
  preview: [],
})

/**
 * Break a transcript into HUD lines using a simple character-width
 * approximation. Real apps respect word boundaries; this is the demo.
 */
function formatLines(text: string, maxLines: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < text.length; i += CHARS_PER_LINE) {
    lines.push(text.slice(i, i + CHARS_PER_LINE))
  }
  return lines.slice(-maxLines)
}

function render(): void {
  const lines = formatLines(state.get<string>("transcript"), state.get<number>("displayLines"))
  state.set("preview", lines)
  session.display.showText(lines.join("\n"))
}

session.onReady(() => {
  session.transcription.on((data) => {
    state.set("transcript", data.text)
    render()
  })
})

/**
 * Update the line count. Called from the webview as
 * `mentra.client.setDisplayLines(n)`. Re-renders immediately so the
 * webview preview and the glasses HUD both update before the next
 * transcription chunk arrives.
 */
export function setDisplayLines(n: number): void {
  if (n < 2 || n > 5) throw new Error("displayLines must be between 2 and 5")
  state.set("displayLines", n)
  render()
}
