/**
 * client/index.ts
 *
 * Phone-side runtime for the Captions miniapp. Owns:
 *
 *   - The transcription subscription (registered once, lives for the
 *     lifetime of the runtime).
 *   - The transcript list and the in-flight interim utterance.
 *   - Display-preview formatting (the lines that go to the glasses HUD
 *     and to the webview's preview tile in the settings tab).
 *   - Settings persistence to SimpleStorage so they survive across
 *     sessions and webview remounts.
 *
 * Exposed RPCs (callable from the webview as `mentra.client.X(...)`):
 *
 *   setLanguage(lang)
 *   setLanguageHints(hints)
 *   setDisplayLines(lines)        // 2..5
 *   setDisplayWidth(width)        // 0=Narrow, 1=Medium, 2=Wide
 *   clearTranscripts()
 *
 * Compare with cloud/packages/apps/captions/src/app/session/*.ts: that
 * version needs UserSession, SettingsManager, TranscriptsManager,
 * DisplayManager, plus an Express+Bun two-server architecture and SSE
 * for transcript streaming. Here, the framework's reactive `state` and
 * typed `mentra.client` proxy collapse all of that into one file.
 */

import {session, state, exposeClient, onReady} from "@mentra/miniapp/framework"
import {
  DEFAULT_SETTINGS,
  DISPLAY_WIDTH_PERCENT,
  HUD_CHAR_PX,
  HUD_WIDTH_PX,
  type AppState,
  type CaptionSettings,
  type Transcript,
  type TranscriptionEvent,
} from "../shared/types"

state.init<AppState>({
  transcripts: [],
  settings: {...DEFAULT_SETTINGS},
  displayPreview: null,
})

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = "captions.settings.v1"

async function loadSettings(): Promise<void> {
  try {
    const raw = await session.storage.get(STORAGE_KEY)
    if (typeof raw !== "string") return
    const parsed = JSON.parse(raw)
    state.set("settings", {
      language: typeof parsed.language === "string" ? parsed.language : DEFAULT_SETTINGS.language,
      languageHints: Array.isArray(parsed.languageHints) ? parsed.languageHints : DEFAULT_SETTINGS.languageHints,
      displayLines: clampLines(parsed.displayLines),
      displayWidth: clampWidth(parsed.displayWidth),
    })
  } catch (err) {
    console.warn("[captions] failed to load settings:", err)
  }
}

async function saveSettings(): Promise<void> {
  try {
    await session.storage.set(STORAGE_KEY, JSON.stringify(state.get<CaptionSettings>("settings")))
  } catch (err) {
    console.warn("[captions] failed to save settings:", err)
  }
}

function clampLines(n: unknown): number {
  const v = typeof n === "number" ? n : DEFAULT_SETTINGS.displayLines
  return Math.min(Math.max(2, Math.round(v)), 5)
}

function clampWidth(n: unknown): number {
  const v = typeof n === "number" ? n : DEFAULT_SETTINGS.displayWidth
  return Math.min(Math.max(0, Math.round(v)), 2)
}

// ─── Transcript formatting ───────────────────────────────────────────────────

function makeId(): string {
  return Math.random().toString(36).slice(2)
}

function speakerLabel(speakerId: string | undefined): string {
  if (!speakerId) return "Speaker"
  // If the runtime gives us a numeric id, render as "Speaker N".
  // If it gives us a name, use as-is.
  return /^\d+$/.test(speakerId) ? `Speaker ${speakerId}` : speakerId
}

function formatTimestamp(): string {
  return new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})
}

/**
 * Break a transcript into HUD lines. We use a fixed-pixel width
 * approximation matching what the production DisplayManager does:
 *
 *   widthPx = HUD_WIDTH_PX * DISPLAY_WIDTH_PERCENT[displayWidth]
 *   maxChars = floor(widthPx / HUD_CHAR_PX)
 *
 * Then char-break the text into chunks of maxChars and keep the
 * trailing displayLines lines.
 */
function formatHudLines(text: string, settings: CaptionSettings): string[] {
  const widthPx = HUD_WIDTH_PX * DISPLAY_WIDTH_PERCENT[settings.displayWidth]
  const maxChars = Math.max(8, Math.floor(widthPx / HUD_CHAR_PX))
  const lines: string[] = []
  for (let i = 0; i < text.length; i += maxChars) {
    lines.push(text.slice(i, i + maxChars))
  }
  return lines.slice(-settings.displayLines)
}

function pushDisplay(text: string, isFinal: boolean): void {
  const settings = state.get<CaptionSettings>("settings")
  const lines = formatHudLines(text, settings)
  state.set("displayPreview", {
    text,
    lines,
    isFinal,
    timestamp: Date.now(),
  })
  if (session.ready) {
    session.display.showTextWall(lines.join("\n"))
  }
}

/**
 * Apply a transcription chunk. Maintains an interim/final lifecycle:
 * interim chunks for the same utterance overwrite each other, final
 * chunks lock the entry into history. Speaker switches mid-utterance
 * commit the previous interim so dictated text is not lost.
 */
function applyTranscription(data: TranscriptionEvent): void {
  const transcripts = state.get<Transcript[]>("transcripts")
  const utteranceId = data.utteranceId ?? null
  const speaker = speakerLabel(data.speakerId)
  const next: Transcript = {
    id: utteranceId ?? makeId(),
    utteranceId,
    speaker,
    text: data.text,
    timestamp: data.isFinal ? formatTimestamp() : null,
    isFinal: data.isFinal,
  }

  // Find any existing entry for the same utterance (or the active
  // interim from the same speaker if utteranceId is missing).
  const idx = transcripts.findIndex((t) => {
    if (utteranceId !== null) return t.utteranceId === utteranceId
    return !t.isFinal && t.speaker === speaker
  })

  let updated: Transcript[]
  if (idx >= 0) {
    updated = transcripts.slice()
    updated[idx] = {...next, id: transcripts[idx].id}
  } else {
    updated = [...transcripts, next]
  }
  state.set("transcripts", updated)

  pushDisplay(data.text, data.isFinal)
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

onReady(() => {
  loadSettings().catch(() => {})
  session.transcription.on((data: TranscriptionEvent) => applyTranscription(data))
})

// ─── Exposed RPCs ────────────────────────────────────────────────────────────

export async function setLanguage(language: string): Promise<void> {
  state.set("settings", {...state.get<CaptionSettings>("settings"), language})
  await saveSettings()
}

export async function setLanguageHints(hints: string[]): Promise<void> {
  state.set("settings", {...state.get<CaptionSettings>("settings"), languageHints: hints})
  await saveSettings()
}

export async function setDisplayLines(lines: number): Promise<void> {
  const next = clampLines(lines)
  state.set("settings", {...state.get<CaptionSettings>("settings"), displayLines: next})
  // Re-format current preview with the new value so the glasses HUD
  // and the webview preview update without waiting for the next chunk.
  const preview = state.get<AppState["displayPreview"]>("displayPreview")
  if (preview) pushDisplay(preview.text, preview.isFinal)
  await saveSettings()
}

export async function setDisplayWidth(width: number): Promise<void> {
  const next = clampWidth(width)
  state.set("settings", {...state.get<CaptionSettings>("settings"), displayWidth: next})
  const preview = state.get<AppState["displayPreview"]>("displayPreview")
  if (preview) pushDisplay(preview.text, preview.isFinal)
  await saveSettings()
}

export async function clearTranscripts(): Promise<void> {
  state.set("transcripts", [])
  state.set("displayPreview", null)
}

exposeClient({
  setLanguage,
  setLanguageHints,
  setDisplayLines,
  setDisplayWidth,
  clearTranscripts,
})
