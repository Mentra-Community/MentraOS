/**
 * client/index.ts
 *
 * Phone-side runtime code. Subscriptions register at module scope and
 * live for the runtime lifetime. There is no React, no useEffect, no
 * remount.
 *
 * Functions exposed via `exposeClient({...})` become callable from the
 * webview as `mentra.client.X(...)`. v0 requires the explicit
 * registration; v1 will auto-discover module exports at build time.
 */

import {session, state, exposeClient, onReady} from "@mentra/miniapp/framework"
import {CHARS_PER_LINE, type AppState, type TranscriptionEvent, type UtteranceEntry} from "../shared/types"

state.init<AppState>({
  history: [],
  interim: null,
  displayLines: 3,
  preview: [],
})

function makeId(): string {
  return Math.random().toString(36).slice(2)
}

/** Format one utterance for display. Speaker prefix only when known. */
function formatUtterance(u: UtteranceEntry): string {
  return u.speakerId ? `[${u.speakerId}]: ${u.text}` : u.text
}

/** Last `maxLines` HUD lines from history + interim. */
function formatHudLines(history: UtteranceEntry[], interim: UtteranceEntry | null, maxLines: number): string[] {
  const utterances: UtteranceEntry[] = interim ? [...history, interim] : history
  const allLines: string[] = []
  for (const u of utterances) {
    const formatted = formatUtterance(u)
    if (formatted.length === 0) continue
    for (let i = 0; i < formatted.length; i += CHARS_PER_LINE) {
      allLines.push(formatted.slice(i, i + CHARS_PER_LINE))
    }
  }
  return allLines.slice(-maxLines)
}

function render(): void {
  const lines = formatHudLines(
    state.get<UtteranceEntry[]>("history"),
    state.get<UtteranceEntry | null>("interim"),
    state.get<number>("displayLines"),
  )
  state.set("preview", lines)
  session.display.showTextWall(lines.join("\n"))
}

/**
 * Apply a transcription chunk. Maintains:
 *   - `interim`: zero or one in-flight utterance.
 *   - `history`: the list of finalized utterances.
 *
 * Same utterance is detected by `utteranceId` when present, otherwise
 * by speaker ID continuity. A new utterance arriving while an
 * unfinalized interim exists commits the previous interim to history.
 */
function applyTranscription(data: TranscriptionEvent): void {
  const speakerId = data.speakerId ?? ""
  const interim = state.get<UtteranceEntry | null>("interim")

  if (data.isFinal) {
    const utteranceId = data.utteranceId ?? interim?.utteranceId ?? makeId()
    state.set("history", [...state.get<UtteranceEntry[]>("history"), {utteranceId, speakerId, text: data.text}])
    state.set("interim", null)
    render()
    return
  }

  const sameUtterance =
    interim != null &&
    ((data.utteranceId !== undefined && data.utteranceId === interim.utteranceId) ||
      (data.utteranceId === undefined && speakerId === interim.speakerId))

  if (sameUtterance && interim) {
    state.set("interim", {...interim, text: data.text})
  } else {
    if (interim) {
      // Speaker switched; commit the unfinalized previous interim.
      state.set("history", [...state.get<UtteranceEntry[]>("history"), interim])
    }
    state.set("interim", {
      utteranceId: data.utteranceId ?? makeId(),
      speakerId,
      text: data.text,
    })
  }
  render()
}

onReady(() => {
  // TranscriptionData carries utteranceId/speakerId as optional fields.
  // Fallbacks in applyTranscription handle absence.
  session.transcription.on((data: TranscriptionEvent) => applyTranscription(data))
})

/**
 * Update the line count. Called from the webview as
 * `mentra.client.setDisplayLines(n)`. Re-renders so the change is
 * visible immediately, before the next transcription chunk arrives.
 */
export function setDisplayLines(n: number): void {
  if (n < 2 || n > 5) throw new Error("displayLines must be between 2 and 5")
  state.set("displayLines", n)
  render()
}

// Register the RPC functions the webview can call. v0 ceremony; v1 will
// auto-discover client/ exports at build time.
exposeClient({setDisplayLines})
