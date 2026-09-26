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

import type {
  CloudClientStatus,
  MiniappSession,
  TranslationData,
  TranscriptionLanguage,
  UnsubscribeFn,
} from "@mentra/miniapp/background"

import {CaptionsFormatter} from "../../core/CaptionsFormatter"
import type {Channels} from "../../shared/channels"
import type {TranslationEntry, TranslationSettings, TranslationsSnapshot, DisplayPreview} from "../../shared/types"

/** Primary language subtag, lowercased ("fr-FR" -> "fr", "FR" -> "fr"). */
function primarySubtag(code: string | undefined): string {
  return (code ?? "").split("-")[0].toLowerCase()
}

/**
 * Is this event a same-language passthrough (speech already in the target
 * language, emitted by the cloud as a transcription) rather than a real
 * translation?
 *
 * When the detected source is known, compare it to the target. But on early
 * INTERIMS Soniox often has not identified the language yet, so the source
 * arrives as "auto"/absent — comparing that against the target says
 * "different language" and lets passthrough interims leak onto the glasses in
 * "Translation only" mode. Fall back to the structural tell: a cross-language
 * translation always carries `originalText` (source tokens stream in ahead of
 * the lagging translation tokens), a passthrough never does.
 */
function isSameLanguagePassthrough(
  sourceLanguage: string | undefined,
  targetLanguage: string,
  originalText: string | undefined,
): boolean {
  const src = primarySubtag(sourceLanguage)
  if (src && src !== "auto") return src === primarySubtag(targetLanguage)
  return !originalText
}

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

export class TranslationController {
  private subscribed = false
  private readonly unsubs: Array<() => void> = []

  private translationCleanup: UnsubscribeFn | null = null
  private translationTarget: string | null = null
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
  private formatter = new CaptionsFormatter()
  private renderRevision = 0
  private currentIsFinal = true
  private lastSpeakerId: string | undefined = undefined
  private currentDisplayText = ""
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

    const refresh = () => this.refreshDisplay()
    this.unsubs.push(this.session.onCapabilitiesChange(refresh))
    // Initial capabilities arrive on ready, not capabilities-change.
    this.unsubs.push(this.session.on("ready", refresh))

    // Load persisted settings, then subscribe to translation accordingly.
    await this.loadSettings()
    this.applySettingsToDisplay()
    this.subscribeTranslation()
    this.subscribeCloudStatus()

    this.registerUiHandlers()
    this.registerActions()
    console.log(`LocalTranslation: started (target=${this.settings.targetLanguage})`)
  }

  stop(): void {
    this.renderRevision++
    if (this.translationCleanup) {
      try {
        this.translationCleanup()
      } catch {
        /* ignore */
      }
      this.translationCleanup = null
      this.translationTarget = null
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

  // ───────────────────────────────────────────────────────────────────────
  // Actions (cross-miniapp / AI)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Declared in miniapp.json. A system miniapp (e.g. Mentra AI) invokes this to
   * start live translation — the host headless-wakes us if we're stopped, and
   * by the time this runs start() has already subscribed to any-source → the
   * saved target. We then apply any caller-requested target/source and confirm.
   */
  private registerActions(): void {
    try {
      this.unsubs.push(this.session.actions.handle("start_translation", (params) => this.startTranslation(params)))
    } catch (err) {
      // actions module unavailable on this host, or already registered — the
      // miniapp still runs, it just can't be started via the action.
      console.log("LocalTranslation: failed to register actions", err)
    }
  }

  private async startTranslation(params: Record<string, unknown>): Promise<{targetLanguage: string; status: string}> {
    const target =
      typeof params.targetLanguage === "string" && params.targetLanguage.trim() ? params.targetLanguage.trim() : null

    if (target && target !== this.settings.targetLanguage) {
      // setTargetLanguage persists, re-subscribes, and broadcasts to the UI.
      await this.setTargetLanguage(target)
    } else {
      // Target unchanged — re-subscribe to ensure translation is live (e.g. a
      // fresh start on a just-woken session).
      this.subscribeTranslation()
    }

    // subscribeTranslation swallows subscribe failures (it logs and leaves
    // translationCleanup null). Don't claim "translating" if nothing attached —
    // surface it as an action error so the caller (e.g. Mentra AI) knows.
    if (!this.translationCleanup) {
      throw new Error("Failed to start translation — no active subscription")
    }

    return {targetLanguage: this.settings.targetLanguage, status: "translating"}
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
      this.settings.showOriginalText = showOrigRaw == null ? DEFAULT_SETTINGS.showOriginalText : showOrigRaw === "true"
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
    if (targetLanguage === this.settings.targetLanguage) {
      this.subscribeTranslation()
      this.broadcastSettings()
      return
    }
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
    if (mode === this.settings.glassesDisplayMode) return
    this.settings.glassesDisplayMode = mode
    await this.persist(STORAGE_KEYS.glassesDisplayMode, mode)
    // Re-render the currently shown line in the new mode immediately. Without
    // this the toggle only takes effect on the NEXT spoken utterance, so
    // flipping "Translation + transcription" looks like it does nothing (the
    // reported no-op). The combined text is baked into the formatter history at
    // render time, so a plain refresh cannot recombine — rebuild from the
    // stored translations instead.
    this.rebuildGlassesDisplay()
    this.broadcastSettings()
  }

  /**
   * Rebuild the glasses formatter from the stored final translations,
   * recombining each with its original transcription per the current
   * glassesDisplayMode, then refresh. Mirrors updateDisplaySettings' rebuild
   * but recomputes the per-line content for the new mode.
   */
  private rebuildGlassesDisplay(): void {
    this.currentDisplayText = ""
    const both = this.settings.glassesDisplayMode === "both"
    this.createFormatter()
    let lastSpeaker: string | undefined
    for (const entry of this.translations) {
      if (!entry.isFinal) continue
      // Same-language transcriptions (source === target) show on the glasses
      // only in "both" mode — matches the live path in
      // handleSameLanguageTranscription.
      const sameLanguage = isSameLanguagePassthrough(entry.sourceLanguage, entry.targetLanguage, entry.originalText)
      if (sameLanguage && !both) continue
      const speakerChanged = entry.speaker !== lastSpeaker
      lastSpeaker = entry.speaker
      const displayText = both && entry.originalText ? `${entry.text}\n${entry.originalText}` : entry.text
      this.formatter.processTranscription(displayText, true, entry.speaker, speakerChanged)
    }
    this.refreshDisplay()
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
    const targetLanguage = this.settings.targetLanguage
    if (this.translationCleanup && this.translationTarget === targetLanguage) return

    try {
      const handler = (data: TranslationData) => {
        void this.handleTranslation(data)
      }

      // Any source language -> selected target language. Translating whatever
      // is spoken into one chosen language is the app's whole model; the source
      // is intentionally not configurable (see the file header).
      // Attach the replacement before releasing the old subscription. This
      // keeps the microphone/cloud translation union live while settings are
      // changed and preserves the working subscription if replacement fails.
      const previousCleanup = this.translationCleanup
      const nextCleanup = this.session.translation.to(targetLanguage as TranscriptionLanguage, handler)
      this.translationCleanup = nextCleanup
      this.translationTarget = targetLanguage
      if (previousCleanup) {
        try {
          previousCleanup()
        } catch {
          /* ignore */
        }
      }
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

    // Glasses display: translation only, or translation + transcription
    // combined — the translation leads (it's what the wearer reads), with the
    // source-language transcription under it.
    //
    // Same-language passthrough events (the cloud emits speech ALREADY in the
    // target language as a transcription; source == target) always land in the
    // UI history above, but reach the glasses only in "Translation +
    // transcription" mode — same-language on the display is opt-in.
    const sameLanguage = isSameLanguagePassthrough(entry.sourceLanguage, entry.targetLanguage, rich.originalText)
    if (sameLanguage && this.settings.glassesDisplayMode !== "both") return
    const displayText =
      this.settings.glassesDisplayMode === "both" && rich.originalText
        ? `${data.text}\n${rich.originalText}`
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
    this.formatter = new CaptionsFormatter()
  }

  private applySettingsToDisplay(): void {
    this.refreshDisplay()
  }

  private refreshDisplay(): void {
    if (this.currentDisplayText) {
      this.showTextWall(this.currentDisplayText)
      return
    }
    const history = this.formatter.getFinalTranscriptHistory()
    if (history.length === 0) {
      this.broadcastDisplayPreview("", [""], true)
      return
    }
    const result = this.formatter.processTranscription("", true, undefined, false)
    if (result.displayText.trim()) {
      const cleaned = this.cleanTranscriptText(result.displayText)
      this.showTextWall(cleaned)
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
    this.currentIsFinal = isFinal
    const cleaned = this.cleanTranscriptText(text)
    this.showTextWall(cleaned)
  }

  private showTextWall(text: string): void {
    this.currentDisplayText = text
    const revision = ++this.renderRevision
    const d = this.session.capabilities?.display
    const widthFraction = [0.7, 0.85, 1][this.settings.displayWidth] ?? 1
    const isFinal = this.currentIsFinal
    void this.session.display
      .render(
        [
          {
            type: "text",
            id: "translation",
            box: {
              x: 0,
              y: 0,
              w: Math.round((d?.width ?? d?.resolution?.width ?? 576) * widthFraction),
              h: d?.height ?? d?.resolution?.height ?? 288,
            },
            text,
            style: {
              maxLines: this.settings.displayLines,
              textWindow: "end",
              breakMode: this.settings.wordBreaking ? "character" : "word",
            },
          },
        ],
        {includeTextLayout: true},
      )
      .then((result) => {
        if (revision !== this.renderRevision) return
        const lines = result.textLayout?.translation?.lines.map((line) => line.text)
        if (lines) this.broadcastDisplayPreview(lines.join("\n"), lines, isFinal)
      })
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
      this.renderRevision++
      this.currentDisplayText = ""
      this.formatter.clear()
      this.lastSpeakerId = undefined
      void this.session.display.render([])
    }, 40000)
  }

  private broadcastDisplayPreview(text: string, lines: string[], isFinal: boolean): void {
    const preview: DisplayPreview = {text, lines, isFinal, timestamp: Date.now()}
    this.lastDisplayPreview = preview
    this.ui.send("translation:display-preview", preview)
  }
}
