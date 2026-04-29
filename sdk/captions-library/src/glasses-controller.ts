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
import {CHARS_PER_LINE} from "./types"

// Anti-pattern #1: subscription registered after `connect()` resolves.
// Whether early transcription frames are buffered or dropped depends
// on the transport implementation. The dev has no signal in the API
// that "subscribe before connect" vs "subscribe after connect" matters.
export const session = new MiniappSession()

// Settings live in a struct because the dev anticipates adding more
// settings later (language, hints, etc) without rewriting the API.
let settings = {displayLines: 3}

let currentTranscript = ""
let currentPreview: string[] = []

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((cb) => cb())

function formatLines(text: string, maxLines: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < text.length; i += CHARS_PER_LINE) {
    lines.push(text.slice(i, i + CHARS_PER_LINE))
  }
  return lines.slice(-maxLines)
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
  //   - the glasses keep showing 3 lines.
  //   - the webview preview keeps showing 3 lines (it reads
  //     `currentPreview`, which the handler computed with the stale 3).
  //   - the settings panel correctly shows "5 selected."
  //
  // Bug ships. Tests pass because tests do not "change setting then
  // assert display." Bug is reproducible only when paired to glasses
  // and the user changes the setting mid-session.
  //
  // The naive fix is to read `settings.displayLines` inside the
  // handler. The library cannot warn that the destructured const is
  // wrong; both versions are correct JavaScript.
  // ===========================================================
  const {displayLines} = settings

  session.transcription.on((data) => {
    currentTranscript = data.text
    const lines = formatLines(data.text, displayLines)
    currentPreview = lines
    session.layouts.showTextWall(lines.join("\n"))
    notify()
  })
})

export function getSettings() {
  return settings
}
export function getPreview() {
  return currentPreview
}

// Anti-pattern #2 enabler: every component subscribes individually.
// Each subscriber adds a closure to the listeners set; every
// transcription chunk fires every closure.
export function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setDisplayLines(n: number) {
  if (n < 2 || n > 5) throw new Error("displayLines must be 2 to 5")
  settings = {...settings, displayLines: n}

  // Re-render the preview and HUD using the new value, so the change
  // is visible without waiting for the next transcription chunk.
  // This path works because we read `n` directly here, not the
  // captured closure inside the transcription handler.
  const lines = formatLines(currentTranscript, n)
  currentPreview = lines
  session.layouts.showTextWall(lines.join("\n"))
  notify()
}
