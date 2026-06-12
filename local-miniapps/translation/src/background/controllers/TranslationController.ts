/**
 * TranslationController — the always-on translation logic for this local miniapp.
 *
 * Lives inside the per-miniapp JSContext (NOT the WebView). It is a faithful
 * port of the cloud app's four session managers, fused into one controller:
 *
 *   UserSession        -> start() lifecycle + translation subscription
 *   SettingsManager    -> storage-backed settings (load on start, persist on change)
 *   TranslationsManager -> translation list bookkeeping + UI broadcast
 *   DisplayManager     -> CaptionsFormatter-driven glasses rendering + 40s clear
 *
 * The source language is intentionally not a setting. The app subscribes to
 * any-source -> target-language translation so it can translate whatever the
 * user hears into one chosen language.
 *
 * Subscriptions are bound to the session lifetime, not any React component.
 * Closing the WebView does NOT stop translation — the controller survives
 * open/close cycles because the JSContext does, and re-hydrates the UI with a
 * full snapshot on every session.ui.onOpen.
 */

import type {CloudClientStatus, MiniappSession, TranslationData, UnsubscribeFn} from "@mentra/miniapp/background"

import {
  CaptionsFormatter,
  G1_PROFILE,
  Z100_PROFILE,
  NEX_PROFILE,
  type DisplayProfile,
  type TranscriptHistoryEntry,
} from "../../core/CaptionsFormatter"
import type {Channels} from "../../shared/channels"
import type {TranslationEntry, TranslationSettings, TranslationsSnapshot, DisplayPreview} from "../../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

interface RichTranslationData extends TranslationData {
  utteranceId?: string
  speakerId?: string
  originalText?: string
  transcribeLanguage?: string
  translateLanguage?: string
  startTime?: number
  endTime?: number
}

interface InternalTranslationEntry {
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  originalText?: string
  sourceLanguage?: string
  targetLanguage: string
  timestamp: number | null
  isFinal: boolean
  receivedAt: number
}

// ── Settings defaults (mirror SettingsManager) ─────────────────────────────
const DEFAULT_SETTINGS: TranslationSettings = {
  targetLanguage: "es",
  displayLines: 3,
  displayWidth: 1, // 0=Narrow, 1=Medium, 2=Wide
  wordBreaking: false,
  showOriginalText: true,
  glassesDisplayMode: "translation",
}

const STORAGE_KEYS = {
  targetLanguage: "targetLanguage",
  displayLines: "displayLines",
  displayWidth: "displayWidth",
  wordBreaking: "wordBreaking",
  showOriginalText: "showOriginalText",
  glassesDisplayMode: "glassesDisplayMode",
} as const

// ── Profile selection (verbatim from DisplayManager) ───────────────────────
function getProfileForModel(modelName: string | null | undefined): DisplayProfile {
  if (!modelName) return G1_PROFILE
  const lower = modelName.toLowerCase()
  if (lower.includes("g1") || lower.includes("even realities") || lower.includes("even_g1")) {
    return G1_PROFILE
  }
  if (lower.includes("z100") || lower.includes("vuzix") || lower.includes("mach1") || lower.includes("mach 1")) {
    return Z100_PROFILE
  }
  if (lower.includes("nex") || lower.includes("mentra display") || lower.includes("mentra_nex")) {
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

export class TranslationController {
  private subscribed = false
  private readonly unsubs: Array<() => void> = []

  private translationCleanup: UnsubscribeFn | null = null
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
  private settings: TranslationSettings = {...DEFAULT_SETTINGS}

  // ── Translation list state ───────────────────────────────────────────────
  private translations: InternalTranslationEntry[] = []
  private readonly maxTranslations = 100

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

    // Load persisted settings, then subscribe to translation accordingly.
    await this.loadSettings()
    this.applySettingsToDisplay()
    this.subscribeTranslation()
    this.subscribeCloudStatus()

    this.registerUiHandlers()
    console.log(`LocalTranslation: started (target=${this.settings.targetLanguage}, profile=${this.currentProfile.id})`)
  }

  stop(): void {
    if (this.translationCleanup) {
      try {
        this.translationCleanup()
      } catch {
        /* ignore */
      }
      this.translationCleanup = null
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
    // Full snapshot on every WebView open (replaces SSE initial /api/translations
    // + /api/settings hydration).
    this.unsubs.push(
      this.ui.onOpen(() => {
        this.sendSnapshot()
      }),
    )

    this.unsubs.push(
      this.ui.on("translation:request-snapshot", () => {
        this.sendSnapshot()
      }),
    )

    this.unsubs.push(
      this.ui.on("translation:set-target-language", ({targetLanguage}) => {
        void this.setTargetLanguage(targetLanguage)
      }),
    )
    this.unsubs.push(
      this.ui.on("translation:set-display-lines", ({lines}) => {
        void this.setDisplayLines(lines)
      }),
    )
    this.unsubs.push(
      this.ui.on("translation:set-display-width", ({width}) => {
        void this.setDisplayWidth(width)
      }),
    )
    this.unsubs.push(
      this.ui.on("translation:set-word-breaking", ({enabled}) => {
        void this.setWordBreaking(enabled)
      }),
    )
    this.unsubs.push(
      this.ui.on("translation:set-show-original-text", ({enabled}) => {
        void this.setShowOriginalText(enabled)
      }),
    )
    this.unsubs.push(
      this.ui.on("translation:set-glasses-display-mode", ({mode}) => {
        void this.setGlassesDisplayMode(mode)
      }),
    )
    this.unsubs.push(
      this.ui.on("translation:clear", () => {
        this.clearTranscripts()
      }),
    )
  }

  private sendSnapshot(): void {
    const snapshot: TranslationsSnapshot = {
      settings: {...this.settings},
      translations: this.publicTranslations(),
      displayPreview: this.lastDisplayPreview,
      cloudStatus: {...this.cloudStatus},
    }
    this.ui.send("translation:snapshot", snapshot)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Settings (SettingsManager port)
  // ───────────────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const [targetLanguage, linesRaw, widthRaw, wbRaw, showOrigRaw, glassesModeRaw] = await Promise.all([
        this.session.storage.get(STORAGE_KEYS.targetLanguage),
        this.session.storage.get(STORAGE_KEYS.displayLines),
        this.session.storage.get(STORAGE_KEYS.displayWidth),
        this.session.storage.get(STORAGE_KEYS.wordBreaking),
        this.session.storage.get(STORAGE_KEYS.showOriginalText),
        this.session.storage.get(STORAGE_KEYS.glassesDisplayMode),
      ])

      this.settings.targetLanguage = targetLanguage || DEFAULT_SETTINGS.targetLanguage

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

      this.settings.wordBreaking = wbRaw == null ? DEFAULT_SETTINGS.wordBreaking : wbRaw === "true"
      this.settings.showOriginalText =
        showOrigRaw == null ? DEFAULT_SETTINGS.showOriginalText : showOrigRaw === "true"
      this.settings.glassesDisplayMode =
        glassesModeRaw === "both" || glassesModeRaw === "translation"
          ? glassesModeRaw
          : DEFAULT_SETTINGS.glassesDisplayMode
    } catch (err) {
      console.log("LocalTranslation: failed to load settings, using defaults", err)
      this.settings = {...DEFAULT_SETTINGS}
    }
  }

  private async setTargetLanguage(targetLanguage: string): Promise<void> {
    this.settings.targetLanguage = targetLanguage
    await this.persist(STORAGE_KEYS.targetLanguage, targetLanguage)
    this.subscribeTranslation()
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

  private async setShowOriginalText(enabled: boolean): Promise<void> {
    this.settings.showOriginalText = enabled
    await this.persist(STORAGE_KEYS.showOriginalText, enabled.toString())
    this.broadcastSettings()
  }

  private async setGlassesDisplayMode(mode: TranslationSettings["glassesDisplayMode"]): Promise<void> {
    if (mode !== "translation" && mode !== "both") return
    this.settings.glassesDisplayMode = mode
    await this.persist(STORAGE_KEYS.glassesDisplayMode, mode)
    this.broadcastSettings()
  }

  private async persist(key: string, value: string): Promise<void> {
    try {
      await this.session.storage.set(key, value)
    } catch (err) {
      console.log(`LocalTranslation: failed to persist ${key}`, err)
    }
  }

  private broadcastSettings(): void {
    this.ui.send("translation:settings-update", {...this.settings})
  }

  // ───────────────────────────────────────────────────────────────────────
  // Translation subscription
  // ───────────────────────────────────────────────────────────────────────

  private subscribeTranslation(): void {
    // Tear down any existing subscription before re-subscribing.
    if (this.translationCleanup) {
      try {
        this.translationCleanup()
      } catch {
        /* ignore */
      }
      this.translationCleanup = null
    }

    const targetLanguage = this.settings.targetLanguage

    try {
      const handler = (data: TranslationData) => {
        void this.handleTranslation(data)
      }

      // Any source language -> selected target language.
      this.translationCleanup = this.session.translation.to(targetLanguage, handler)
    } catch (err) {
      console.log(`LocalTranslation: translation subscribe failed for target=${targetLanguage}`, err)
    }
  }

  private subscribeCloudStatus(): void {
    try {
      this.unsubs.push(
        this.session.cloud.onStatusChanged((status) => {
          this.cloudStatus = {...status}
          this.ui.send("translation:cloud-status", {...this.cloudStatus})
        }),
      )
    } catch (err) {
      console.log("LocalTranslation: cloud status subscribe failed", err)
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Translation handling
  // ───────────────────────────────────────────────────────────────────────

  private async handleTranslation(data: TranslationData): Promise<void> {
    const rich = data as RichTranslationData
    const utteranceId: string | null = rich.utteranceId ?? null
    const speakerId: string | undefined = rich.speakerId

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

    this.ui.send("translation:live-translation", {
      type: entry.isFinal ? "final" : "interim",
      id: entry.id,
      utteranceId: entry.utteranceId,
      speaker: entry.speaker,
      text: entry.text,
      originalText: entry.originalText,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      timestamp: entry.timestamp,
    })

    // Glasses display: translation only, or original + translation combined
    // (the original line leads so a bilingual listener can follow the speaker).
    const displayText =
      this.settings.glassesDisplayMode === "both" && rich.originalText
        ? `${rich.originalText}\n${data.text}`
        : data.text
    this.processAndDisplay(displayText, data.isFinal, speakerId)
  }

  private createEntry(
    data: TranslationData,
    utteranceId: string | null,
    speakerId: string | undefined,
  ): InternalTranslationEntry {
    const rich = data as RichTranslationData
    const id = utteranceId || this.randomId()
    return {
      id,
      utteranceId,
      speaker: this.formatSpeakerId(speakerId),
      text: data.text,
      originalText: rich.originalText,
      sourceLanguage: rich.sourceLanguage ?? rich.transcribeLanguage,
      targetLanguage: rich.targetLanguage ?? rich.translateLanguage ?? this.settings.targetLanguage,
      timestamp: data.isFinal ? Date.now() : null,
      isFinal: data.isFinal,
      receivedAt: Date.now(),
    }
  }

  private formatSpeakerId(speakerId: string | undefined): string {
    if (!speakerId) return "Speaker 1"
    return `Speaker ${speakerId}`
  }

  private updateByUtteranceId(entry: InternalTranslationEntry): void {
    const existingIndex = this.translations.findIndex((t) => t.utteranceId === entry.utteranceId)
    if (existingIndex >= 0) {
      this.translations[existingIndex] = entry
    } else {
      this.translations.push(entry)
    }
    if (this.translations.length > this.maxTranslations) {
      const finals = this.translations.filter((t) => t.isFinal)
      const interims = this.translations.filter((t) => !t.isFinal)
      const maxFinals = this.maxTranslations - interims.length
      const trimmedFinals = finals.slice(-maxFinals)
      this.translations = [...trimmedFinals, ...interims]
    }
  }

  private legacyUpdateInterim(entry: InternalTranslationEntry): void {
    this.translations = this.translations.filter((t) => t.isFinal)
    this.translations.push(entry)
  }

  private legacyReplaceInterim(entry: InternalTranslationEntry): void {
    this.translations = this.translations.filter((t) => t.isFinal)
    this.translations.push(entry)
    if (this.translations.length > this.maxTranslations) {
      this.translations = this.translations.slice(-this.maxTranslations)
    }
  }

  private clearTranscripts(): void {
    this.translations = []
    this.ui.send("translation:translations-update", {translations: []})
  }

  private publicTranslations(): TranslationEntry[] {
    return this.translations.map((t) => ({
      id: t.id,
      utteranceId: t.utteranceId,
      speaker: t.speaker,
      text: t.text,
      originalText: t.originalText,
      sourceLanguage: t.sourceLanguage,
      targetLanguage: t.targetLanguage,
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
    this.updateDisplaySettings(this.settings.displayWidth, this.settings.displayLines, this.settings.wordBreaking)
  }

  private updateDisplaySettings(displayWidth: number, numberOfLines: number, wordBreaking: boolean): void {
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
      console.log("LocalTranslation: display error", err)
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
        console.log("LocalTranslation: clear error", err)
      }
    }, 40000)
  }

  private broadcastDisplayPreview(text: string, lines: string[], isFinal: boolean): void {
    const preview: DisplayPreview = {text, lines, isFinal, timestamp: Date.now()}
    this.lastDisplayPreview = preview
    this.ui.send("translation:display-preview", preview)
  }
}
