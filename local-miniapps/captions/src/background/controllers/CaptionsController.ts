/**
 * CaptionsController — the always-on captions logic for this local miniapp.
 *
 * Lives inside the per-miniapp JSContext (NOT the WebView). It is a faithful
 * port of the cloud app's four session managers, fused into one controller:
 *
 *   UserSession        -> start() lifecycle + transcription subscription
 *   SettingsManager    -> storage-backed settings (load on start, persist on change)
 *   TranscriptsManager -> transcript list bookkeeping + UI broadcast
 *   DisplayManager     -> CaptionsFormatter-driven glasses rendering + 40s clear
 *
 * Transport seam swaps vs. the cloud app:
 *   appSession.events.onTranscriptionForLanguage(locale, h, {hints})
 *        -> session.transcription.forLanguage(locale, h)
 *           + session.transcription.configure({languageHints})
 *           + session.transcription.on(h) for "auto"
 *   appSession.layouts.showTextWall(text, {view, durationMs})
 *        -> session.display.showTextWall(text, {view: "main", durationMs})
 *   appSession.simpleStorage.get/set
 *        -> session.storage.get/set (JSON-encode yourself)
 *   SSE broadcast(type, payload)
 *        -> session.ui.send(channel, payload)
 *
 * The on-device TranscriptionData has no utteranceId/speakerId (only text /
 * isFinal / language), so the legacy interim->final path is taken and every
 * utterance is attributed to "Speaker 1". The diarization-aware branches from
 * the cloud app are preserved verbatim for forward-compat but won't fire here.
 *
 * Subscriptions are bound to the session lifetime, not any React component.
 * Closing the WebView does NOT stop transcription — the controller survives
 * open/close cycles because the JSContext does, and re-hydrates the UI with a
 * full snapshot on every session.ui.onOpen.
 */

import type {CloudClientStatus, MiniappSession, TranscriptionData, UnsubscribeFn} from "@mentra/miniapp/background"

import {
  CaptionsFormatter,
  G1_PROFILE,
  Z100_PROFILE,
  NEX_PROFILE,
  type DisplayProfile,
  type TranscriptHistoryEntry,
} from "../../core/CaptionsFormatter"
import {convertToPinyin} from "../../core/ChineseUtils"
import {languageToLocale} from "../../core/languageLocale"
import type {Channels} from "../../shared/channels"
import type {CaptionSettings, DisplayPreview, Transcript} from "../../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(
  channel: C,
  cb: (payload: Channels[C]) => void,
) => () => void

interface TranscriptEntry {
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  timestamp: number | null
  isFinal: boolean
  receivedAt: number
}

// ── Settings defaults (mirror SettingsManager) ─────────────────────────────
const DEFAULT_SETTINGS: CaptionSettings = {
  language: "auto",
  languageHints: [],
  displayLines: 3,
  displayWidth: 1, // 0=Narrow, 1=Medium, 2=Wide
  wordBreaking: true,
}

const STORAGE_KEYS = {
  language: "language",
  languageHints: "languageHints",
  displayLines: "displayLines",
  displayWidth: "displayWidth",
  wordBreaking: "wordBreaking",
} as const

// ── Profile selection (verbatim from DisplayManager) ───────────────────────
function getProfileForModel(modelName: string | null | undefined): DisplayProfile {
  if (!modelName) return G1_PROFILE
  const lower = modelName.toLowerCase()
  if (lower.includes("g1") || lower.includes("even realities") || lower.includes("even_g1")) {
    return G1_PROFILE
  }
  if (
    lower.includes("z100") ||
    lower.includes("vuzix") ||
    lower.includes("mach1") ||
    lower.includes("mach 1")
  ) {
    return Z100_PROFILE
  }
  if (
    lower.includes("nex") ||
    lower.includes("mentra display") ||
    lower.includes("mentra_nex")
  ) {
    return NEX_PROFILE
  }
  return G1_PROFILE
}

/** Read the glasses model name from capabilities (best-effort). */
function getModelName(session: MiniappSession): string | null {
  try {
    const caps = session.capabilities as Record<string, unknown> | null
    const m = caps?.modelName
    return typeof m === "string" ? m : null
  } catch {
    return null
  }
}

export class CaptionsController {
  private subscribed = false
  private readonly unsubs: Array<() => void> = []

  private transcriptionCleanup: UnsubscribeFn | null = null
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null

  // session.ui, retyped against this miniapp's channel registry. The SDK types
  // `session.ui` as UIModule<default-channels>; cast through unknown to bind it
  // to our Channels (mirrors the example-miniapp's approach).
  private ui!: {
    send: Send
    on: On
    onOpen: (cb: () => void) => () => void
  }

  // ── Settings state (SettingsManager) ─────────────────────────────────────
  private settings: CaptionSettings = {...DEFAULT_SETTINGS}

  // ── Transcript list state (TranscriptsManager) ───────────────────────────
  private transcripts: TranscriptEntry[] = []
  private readonly maxTranscripts = 100

  // ── Display state (DisplayManager) ───────────────────────────────────────
  private formatter!: CaptionsFormatter
  private currentProfile: DisplayProfile = G1_PROFILE
  private currentDisplayWidthPx: number = G1_PROFILE.displayWidthPx
  private currentMaxLines: number = G1_PROFILE.maxLines
  private currentWordBreaking = true
  private currentWidthSetting = 1 // matches default displayWidth (Medium)
  private lastSpeakerId: string | undefined = undefined
  private lastDisplayPreview: DisplayPreview | null = null
  private cloudStatus: CloudClientStatus = {status: "disconnected", audioTransport: "none"}

  constructor(private readonly session: MiniappSession) {}

  /** Idempotent — safe to call multiple times. */
  async start(): Promise<void> {
    if (this.subscribed) return
    this.subscribed = true

    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }

    // Detect initial profile from glasses capabilities.
    this.currentProfile = getProfileForModel(getModelName(this.session))
    this.currentDisplayWidthPx = this.currentProfile.displayWidthPx
    this.currentMaxLines = this.currentProfile.maxLines
    this.createFormatter()

    // React to glasses model changes (re-pick profile).
    try {
      this.unsubs.push(
        this.session.onCapabilitiesChange(() => {
          const newProfile = getProfileForModel(getModelName(this.session))
          if (newProfile.id !== this.currentProfile.id) {
            this.updateProfile(newProfile)
          }
        }),
      )
    } catch {
      // capabilities change not available — keep default profile.
    }

    // Load persisted settings, then subscribe to transcription accordingly.
    await this.loadSettings()
    this.applySettingsToDisplay()
    this.subscribeTranscription()
    this.subscribeCloudStatus()

    this.registerUiHandlers()
    console.log(
      `LocalCaptions: started (lang=${this.settings.language}, profile=${this.currentProfile.id})`,
    )
  }

  stop(): void {
    if (this.transcriptionCleanup) {
      try {
        this.transcriptionCleanup()
      } catch {
        /* ignore */
      }
      this.transcriptionCleanup = null
    }
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
    this.subscribed = false
  }

  // ───────────────────────────────────────────────────────────────────────
  // UI bus
  // ───────────────────────────────────────────────────────────────────────

  private registerUiHandlers(): void {
    // Full snapshot on every WebView open (replaces SSE initial /api/transcripts
    // + /api/settings hydration).
    this.unsubs.push(
      this.ui.onOpen(() => {
        this.ui.send("captions:snapshot", {
          settings: {...this.settings},
          transcripts: this.publicTranscripts(),
          displayPreview: this.lastDisplayPreview,
          cloudStatus: {...this.cloudStatus},
        })
      }),
    )

    // UI → background settings writes (replace the REST POST endpoints).
    this.unsubs.push(
      this.ui.on("captions:set-language", ({language}) => {
        void this.setLanguage(language)
      }),
    )
    this.unsubs.push(
      this.ui.on("captions:set-language-hints", ({hints}) => {
        void this.setLanguageHints(hints)
      }),
    )
    this.unsubs.push(
      this.ui.on("captions:set-display-lines", ({lines}) => {
        void this.setDisplayLines(lines)
      }),
    )
    this.unsubs.push(
      this.ui.on("captions:set-display-width", ({width}) => {
        void this.setDisplayWidth(width)
      }),
    )
    this.unsubs.push(
      this.ui.on("captions:set-word-breaking", ({enabled}) => {
        void this.setWordBreaking(enabled)
      }),
    )
    this.unsubs.push(
      this.ui.on("captions:clear", () => {
        this.clearTranscripts()
      }),
    )
  }

  // ───────────────────────────────────────────────────────────────────────
  // Settings (SettingsManager port)
  // ───────────────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const [language, hintsRaw, linesRaw, widthRaw, wbRaw] = await Promise.all([
        this.session.storage.get(STORAGE_KEYS.language),
        this.session.storage.get(STORAGE_KEYS.languageHints),
        this.session.storage.get(STORAGE_KEYS.displayLines),
        this.session.storage.get(STORAGE_KEYS.displayWidth),
        this.session.storage.get(STORAGE_KEYS.wordBreaking),
      ])

      this.settings.language = language || "auto"

      this.settings.languageHints = (() => {
        if (!hintsRaw) return []
        try {
          const parsed = JSON.parse(hintsRaw)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })()

      this.settings.displayLines = (() => {
        if (!linesRaw) return 3
        const p = parseInt(linesRaw, 10)
        return isNaN(p) ? 3 : p
      })()

      this.settings.displayWidth = (() => {
        if (!widthRaw) return 1
        const p = parseInt(widthRaw, 10)
        if (isNaN(p) || p < 0 || p > 2) return 1
        return p
      })()

      this.settings.wordBreaking = wbRaw == null ? true : wbRaw === "true"
    } catch (err) {
      console.log("LocalCaptions: failed to load settings, using defaults", err)
      this.settings = {...DEFAULT_SETTINGS}
    }
  }

  private async setLanguage(language: string): Promise<void> {
    this.settings.language = language
    await this.persist(STORAGE_KEYS.language, language)
    // Re-subscribe transcription with the new language + hints.
    this.subscribeTranscription()
    this.broadcastSettings()
  }

  private async setLanguageHints(hints: string[]): Promise<void> {
    this.settings.languageHints = hints
    await this.persist(STORAGE_KEYS.languageHints, JSON.stringify(hints))
    this.subscribeTranscription()
    this.broadcastSettings()
  }

  private async setDisplayLines(lines: number): Promise<void> {
    if (lines < 2 || lines > 5) return
    this.settings.displayLines = lines
    await this.persist(STORAGE_KEYS.displayLines, lines.toString())
    this.applySettingsToDisplay()
    this.broadcastSettings()
  }

  private async setDisplayWidth(width: number): Promise<void> {
    if (width < 0 || width > 2) return
    this.settings.displayWidth = width
    await this.persist(STORAGE_KEYS.displayWidth, width.toString())
    this.applySettingsToDisplay()
    this.broadcastSettings()
  }

  private async setWordBreaking(enabled: boolean): Promise<void> {
    this.settings.wordBreaking = enabled
    await this.persist(STORAGE_KEYS.wordBreaking, enabled.toString())
    this.applySettingsToDisplay()
    this.broadcastSettings()
  }

  private async persist(key: string, value: string): Promise<void> {
    try {
      await this.session.storage.set(key, value)
    } catch (err) {
      console.log(`LocalCaptions: failed to persist ${key}`, err)
    }
  }

  private broadcastSettings(): void {
    this.ui.send("captions:settings-update", {...this.settings})
  }

  // ───────────────────────────────────────────────────────────────────────
  // Transcription subscription (UserSession.initialize port)
  // ───────────────────────────────────────────────────────────────────────

  private subscribeTranscription(): void {
    // Tear down any existing subscription before re-subscribing.
    if (this.transcriptionCleanup) {
      try {
        this.transcriptionCleanup()
      } catch {
        /* ignore */
      }
      this.transcriptionCleanup = null
    }

    const language = this.settings.language
    const hints = this.settings.languageHints

    try {
      if (hints.length > 0) {
        this.session.transcription.configure({languageHints: hints})
      }

      const handler = (data: TranscriptionData) => {
        void this.handleTranscription(data)
      }

      if (language === "auto") {
        // Auto-detect: subscribe to all languages.
        this.transcriptionCleanup = this.session.transcription.on(handler)
      } else {
        const locale = languageToLocale(language)
        this.transcriptionCleanup = this.session.transcription.forLanguage(locale, handler)
      }
    } catch (err) {
      console.log("LocalCaptions: transcription subscribe failed, falling back to en-US", err)
      this.transcriptionCleanup = this.session.transcription.forLanguage("en-US", (data) => {
        void this.handleTranscription(data)
      })
    }
  }

  private subscribeCloudStatus(): void {
    try {
      this.unsubs.push(
        this.session.cloud.onStatusChanged((status) => {
          this.cloudStatus = {...status}
          this.ui.send("captions:cloud-status", {...this.cloudStatus})
        }),
      )
    } catch (err) {
      console.log("LocalCaptions: cloud status subscribe failed", err)
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Transcription handling (TranscriptsManager port)
  // ───────────────────────────────────────────────────────────────────────

  private async handleTranscription(data: TranscriptionData): Promise<void> {
    // On-device TranscriptionData has only {text, isFinal, language?}. There is
    // no utteranceId/speakerId, so we take the legacy interim/final path and
    // attribute every utterance to Speaker 1.
    const utteranceId: string | null = (data as {utteranceId?: string}).utteranceId ?? null
    const speakerId: string | undefined = (data as {speakerId?: string}).speakerId

    const entry = this.createEntry(data, utteranceId, speakerId)

    if (utteranceId) {
      this.updateByUtteranceId(entry)
    } else {
      if (data.isFinal) {
        this.legacyReplaceInterim(entry)
      } else {
        this.legacyUpdateInterim(entry)
      }
    }

    // 2. Broadcast this transcript frame to the UI.
    this.ui.send("captions:live-transcript", {
      type: entry.isFinal ? "final" : "interim",
      id: entry.id,
      utteranceId: entry.utteranceId,
      speaker: entry.speaker,
      text: entry.text,
      timestamp: entry.timestamp,
    })

    // 3. Process text for the glasses display (pinyin conversion if configured).
    let displayText = data.text
    if (this.settings.language === "Chinese (Pinyin)") {
      displayText = convertToPinyin(displayText)
    }

    // 4. Render on glasses.
    this.processAndDisplay(displayText, data.isFinal, speakerId)
  }

  private createEntry(
    data: TranscriptionData,
    utteranceId: string | null,
    speakerId: string | undefined,
  ): TranscriptEntry {
    const id = utteranceId || this.randomId()
    return {
      id,
      utteranceId,
      speaker: this.formatSpeakerId(speakerId),
      text: data.text,
      timestamp: data.isFinal ? Date.now() : null,
      isFinal: data.isFinal,
      receivedAt: Date.now(),
    }
  }

  private formatSpeakerId(speakerId: string | undefined): string {
    if (!speakerId) return "Speaker 1"
    return `Speaker ${speakerId}`
  }

  private updateByUtteranceId(entry: TranscriptEntry): void {
    const existingIndex = this.transcripts.findIndex((t) => t.utteranceId === entry.utteranceId)
    if (existingIndex >= 0) {
      this.transcripts[existingIndex] = entry
    } else {
      this.transcripts.push(entry)
    }
    if (this.transcripts.length > this.maxTranscripts) {
      const finals = this.transcripts.filter((t) => t.isFinal)
      const interims = this.transcripts.filter((t) => !t.isFinal)
      const maxFinals = this.maxTranscripts - interims.length
      const trimmedFinals = finals.slice(-maxFinals)
      this.transcripts = [...trimmedFinals, ...interims]
    }
  }

  private legacyUpdateInterim(entry: TranscriptEntry): void {
    this.transcripts = this.transcripts.filter((t) => t.isFinal)
    this.transcripts.push(entry)
  }

  private legacyReplaceInterim(entry: TranscriptEntry): void {
    this.transcripts = this.transcripts.filter((t) => t.isFinal)
    this.transcripts.push(entry)
    if (this.transcripts.length > this.maxTranscripts) {
      this.transcripts = this.transcripts.slice(-this.maxTranscripts)
    }
  }

  private clearTranscripts(): void {
    this.transcripts = []
    this.ui.send("captions:transcripts-update", {transcripts: []})
  }

  private publicTranscripts(): Transcript[] {
    return this.transcripts.map((t) => ({
      id: t.id,
      utteranceId: t.utteranceId,
      speaker: t.speaker,
      text: t.text,
      timestamp: t.timestamp,
      isFinal: t.isFinal,
    }))
  }

  private randomId(): string {
    // crypto.randomUUID may not exist in the JSContext; fall back to a cheap id.
    try {
      const c = (globalThis as {crypto?: {randomUUID?: () => string}}).crypto
      if (c && typeof c.randomUUID === "function") return c.randomUUID()
    } catch {
      /* ignore */
    }
    return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  // ───────────────────────────────────────────────────────────────────────
  // Display (DisplayManager port)
  // ───────────────────────────────────────────────────────────────────────

  private createFormatter(): void {
    this.formatter = new CaptionsFormatter(this.currentProfile, {
      maxFinalTranscripts: 30,
      breakMode: this.currentWordBreaking ? "character" : "word",
      displayWidthPx: this.currentDisplayWidthPx,
      maxLines: this.currentMaxLines,
    })
  }

  private calculateDisplayWidth(widthSetting: number, profile: DisplayProfile): number {
    const maxWidthPx = profile.displayWidthPx
    let widthPercent: number
    switch (widthSetting) {
      case 0:
        widthPercent = 0.7
        break
      case 1:
        widthPercent = 0.85
        break
      case 2:
      default:
        widthPercent = 1.0
        break
    }
    return Math.round(maxWidthPx * widthPercent)
  }

  /** Apply the current settings object to the display formatter. */
  private applySettingsToDisplay(): void {
    this.updateDisplaySettings(
      this.settings.displayWidth,
      this.settings.displayLines,
      this.settings.wordBreaking,
    )
  }

  private updateDisplaySettings(
    displayWidth: number,
    numberOfLines: number,
    wordBreaking: boolean,
  ): void {
    this.currentWidthSetting = displayWidth
    this.currentDisplayWidthPx = this.calculateDisplayWidth(displayWidth, this.currentProfile)
    this.currentMaxLines = Math.min(Math.max(2, numberOfLines), this.currentProfile.maxLines)
    this.currentWordBreaking = wordBreaking

    const previousHistory = this.formatter.getFinalTranscriptHistory()
    this.createFormatter()
    this.restoreHistory(previousHistory)
    this.refreshDisplay()
  }

  private updateProfile(newProfile: DisplayProfile): void {
    const previousHistory = this.formatter.getFinalTranscriptHistory()
    this.currentProfile = newProfile
    this.currentDisplayWidthPx = this.calculateDisplayWidth(this.currentWidthSetting, newProfile)
    this.currentMaxLines = Math.min(this.currentMaxLines, newProfile.maxLines)
    this.createFormatter()
    this.restoreHistory(previousHistory)
    this.refreshDisplay()
  }

  private restoreHistory(previousHistory: TranscriptHistoryEntry[]): void {
    for (const e of previousHistory) {
      this.formatter.processTranscription(e.text, true, e.speakerId, e.hadSpeakerChange)
    }
  }

  private refreshDisplay(): void {
    const history = this.formatter.getFinalTranscriptHistory()
    if (history.length === 0) {
      this.broadcastDisplayPreview("", [""], true)
      return
    }
    const result = this.formatter.processTranscription("", true, undefined, false)
    if (result.displayText.trim()) {
      const cleaned = this.cleanTranscriptText(result.displayText)
      const lines = cleaned.split("\n")
      this.showTextWall(cleaned)
      this.broadcastDisplayPreview(cleaned, lines, true)
    }
  }

  private processAndDisplay(text: string, isFinal: boolean, speakerId?: string): void {
    const speakerChanged = speakerId !== undefined && speakerId !== this.lastSpeakerId
    if (speakerChanged) {
      this.lastSpeakerId = speakerId
    }
    const result = this.formatter.processTranscription(text, isFinal, speakerId, speakerChanged)
    this.showOnGlasses(result.displayText, isFinal)
    this.resetInactivityTimer()
  }

  private showOnGlasses(text: string, isFinal: boolean): void {
    const cleaned = this.cleanTranscriptText(text)
    const lines = cleaned.split("\n")
    this.showTextWall(cleaned)
    this.broadcastDisplayPreview(cleaned, lines, isFinal)
  }

  private showTextWall(text: string): void {
    try {
      this.session.display.showTextWall(text, {view: "main"})
    } catch (err) {
      console.log("LocalCaptions: display error", err)
    }
  }

  private cleanTranscriptText(text: string): string {
    // Strip leading punctuation (Western + Chinese), preserving [N]: speaker labels.
    return text
      .split("\n")
      .map((line) => {
        const speakerLabelMatch = line.match(/^\[\d+\]:\s*/)
        if (speakerLabelMatch) {
          const label = speakerLabelMatch[0]
          const rest = line.substring(label.length)
          return label + rest.replace(/^[.,;:!?。，；：！？]+/, "").trim()
        }
        return line.replace(/^[.,;:!?。，；：！？]+/, "").trim()
      })
      .join("\n")
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
    }
    // Clear the formatter + glasses display after 40s of inactivity.
    this.inactivityTimer = setTimeout(() => {
      this.formatter.clear()
      this.lastSpeakerId = undefined
      try {
        this.session.display.clear()
      } catch (err) {
        console.log("LocalCaptions: clear error", err)
      }
    }, 40000)
  }

  private broadcastDisplayPreview(text: string, lines: string[], isFinal: boolean): void {
    const preview: DisplayPreview = {text, lines, isFinal, timestamp: Date.now()}
    this.lastDisplayPreview = preview
    this.ui.send("captions:display-preview", preview)
  }
}
