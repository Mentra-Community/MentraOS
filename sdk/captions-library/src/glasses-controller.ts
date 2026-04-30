/**
 * glasses-controller.ts
 *
 * Convention from the proposed-template approach: "all glasses runtime
 * logic goes here, components do not import from @mentra/miniapp."
 *
 * This file is what a senior React developer writes when faithfully
 * following that convention with the existing @mentra/miniapp library.
 * It compiles. It runs. It is reasonable code.
 *
 * The five anti-patterns it carries are annotated inline by number,
 * matching README.md.
 */

import {MiniappSession} from "@mentra/miniapp"
import {CHARS_PER_LINE, type TranscriptionEvent, type UtteranceEntry} from "./types"

// Anti-pattern #1: subscription registered after `connect()` resolves.
// Whether early transcription frames are buffered or dropped depends
// on the transport implementation. The dev has no signal in the API
// that "subscribe before connect" vs "subscribe after connect" matters.
export const session = new MiniappSession()

// Settings live in a struct because the dev anticipates adding more
// settings later (language, hints, etc) without rewriting the API.
let settings = {displayLines: 3}

// Transcript state. History is the list of finalized utterances;
// interim is the current in-flight one (or null).
let history: UtteranceEntry[] = []
let interim: UtteranceEntry | null = null
let currentPreview: string[] = []

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((cb) => cb())

function makeId(): string {
  return Math.random().toString(36).slice(2)
}

function formatUtterance(u: UtteranceEntry): string {
  return u.speakerId ? `[${u.speakerId}]: ${u.text}` : u.text
}

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

session.connect().then(() => {
  // ===========================================================
  // Anti-pattern #4: stale closure on settings.
  //
  // The senior dev pulls settings into local consts at the top of
  // handler setup for readability. `displayLines` is captured at the
  // moment `session.connect().then(...)` resolves. The transcription
  // handler closes over that captured value, not the live `settings`
  // object.
  //
  // When the user changes `displayLines` from 3 to 5 via the webview:
  //   - settings is reassigned to a new object, fine.
  //   - the webview re-renders, fine.
  //   - the captured `displayLines` const inside this closure is still 3.
  //   - setDisplayLines() formats the preview correctly with the new
  //     value (because it reads the const named `n` directly), so the
  //     webview slider change appears to take effect immediately.
  //   - but the next transcription chunk overwrites `currentPreview`
  //     using the stale captured `displayLines`, reverting back to 3.
  //   - the user sees the slider jump to 5, the HUD briefly show 5
  //     lines, then snap back to 3 on the next word.
  //
  // Bug ships. Tests pass because tests do not "change setting then
  // assert HUD lines under live transcription." Bug is reproducible
  // only when paired to glasses, the user changes the setting, and
  // they keep speaking.
  //
  // The naive fix is to read `settings.displayLines` inside the
  // handler. The library cannot warn that the destructured const is
  // wrong; both versions are correct JavaScript.
  // ===========================================================
  const {displayLines} = settings

  session.transcription.on((data: TranscriptionEvent) => {
    const speakerId = data.speakerId ?? ""

    if (data.isFinal) {
      const utteranceId = data.utteranceId ?? interim?.utteranceId ?? makeId()
      history = [...history, {utteranceId, speakerId, text: data.text}]
      interim = null
    } else {
      const sameUtterance =
        interim != null &&
        ((data.utteranceId !== undefined && data.utteranceId === interim.utteranceId) ||
          (data.utteranceId === undefined && speakerId === interim.speakerId))

      if (sameUtterance && interim) {
        interim = {...interim, text: data.text}
      } else {
        if (interim) {
          // Speaker switched without finalizing the previous interim.
          // Commit what we have so the user does not lose dictated text.
          history = [...history, interim]
        }
        interim = {
          utteranceId: data.utteranceId ?? makeId(),
          speakerId,
          text: data.text,
        }
      }
    }

    // Format with the captured displayLines, not the live settings value.
    // This is the bug that ships.
    currentPreview = formatHudLines(history, interim, displayLines)
    session.display.showTextWall(currentPreview.join("\n"))
    notify()
  })
})

export function getSettings() {
  return settings
}
export function getHistory() {
  return history
}
export function getInterim() {
  return interim
}
export function getPreview() {
  return currentPreview
}

// Anti-pattern #2 enabler: every component subscribes individually.
export function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setDisplayLines(n: number) {
  if (n < 2 || n > 5) throw new Error("displayLines must be 2 to 5")
  settings = {...settings, displayLines: n}

  // Re-render preview using the new value, so the change is visible
  // without waiting for the next transcription chunk. This path uses
  // `n` directly, not the captured closure inside the transcription
  // handler, so the slider appears to work. Until the next chunk arrives
  // and the handler overwrites currentPreview using the stale value.
  currentPreview = formatHudLines(history, interim, n)
  session.display.showTextWall(currentPreview.join("\n"))
  notify()
}
