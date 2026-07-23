import {registerMiniapp} from "@mentra/miniapp/background"
import type {CloudClientStatus, MiniappSession, TranscriptionData, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  FrequencyMode,
  AnswerLanguage,
  MergeAnalysisTrigger,
  MergeBackendStatus,
  MergeDecision,
  MergeDecisionAction,
  MergeInsight,
  MergeInsightProfiling,
  MergeInsightSource,
  MergeSettings,
  MergeSnapshot,
  MergeTranscript,
} from "../shared/types"
import {speakInsightText} from "./speech"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

type BackendInsightResponse =
  | {
      type: "silent"
      reasoning?: string
      confidence?: number
      urgency?: "low" | "medium" | "high"
      sources?: MergeInsightSource[]
      searchQueries?: string[]
      profiling?: MergeInsightProfiling
    }
  | {
      type: "defer"
      reasoning?: string
      confidence?: number
      urgency?: "low" | "medium" | "high"
      sources?: MergeInsightSource[]
      searchQueries?: string[]
      profiling?: MergeInsightProfiling
    }
  | {
      type: "insight"
      text: string
      agentType?: string
      reasoning?: string
      displayAction?: "show" | "replace" | "queue" | "drop"
      confidence?: number
      urgency?: "low" | "medium" | "high"
      sources?: MergeInsightSource[]
      searchQueries?: string[]
      profiling?: MergeInsightProfiling
    }

interface AnalysisChunk {
  id: string
  text: string
  trigger: MergeAnalysisTrigger
  transcriptId: string
  isFinal: boolean
  language: string | null
  startedAt: number
  endedAt: number
}

const DEFAULT_BACKEND_URL = "https://merge3.mentraglass.com"
const SETTINGS_KEY = "merge:settings"
const DISPLAY_DURATION_MS = 10_000
const MAX_TRANSCRIPTS = 40
const MAX_INSIGHTS = 50
const MAX_DECISIONS = 50
const MIN_FINAL_CHARS = 12
const MIN_ANALYSIS_CHARS = 20
const INTERIM_INTERVAL_MS = 8_000
const INTERIM_INTERVAL_CHARS = 140
const MAX_PENDING_CHUNKS = 8

function configuredBackendUrl(): string {
  const fromEnv = process.env.MENTRA_PUBLIC_MERGE_BACKEND_URL?.trim()
  return (fromEnv || DEFAULT_BACKEND_URL).replace(/\/+$/, "")
}

class MergeController {
  private readonly unsubs: Array<() => void> = []
  private transcriptionCleanup: UnsubscribeFn | null = null
  private transcripts: MergeTranscript[] = []
  private insights: MergeInsight[] = []
  private decisions: MergeDecision[] = []
  private finalCount = 0
  private interimCount = 0
  private processing = false
  private pendingChunks: AnalysisChunk[] = []
  private displayQueue: MergeInsight[] = []
  private analyzedFinalIds = new Set<string>()
  private analyzedTextByUtterance = new Map<string, string>()
  private lastInterimAnalysisAtByUtterance = new Map<string, number>()
  private recentInsightKeys: string[] = []
  private activeDisplayUntil = 0
  private displayTimer: ReturnType<typeof setTimeout> | null = null
  private cloudStatus: CloudClientStatus = {status: "disconnected", audioTransport: "none"}
  private backendStatus: MergeBackendStatus = "idle"
  private lastError: string | null = null
  private settings: MergeSettings = {frequency: "medium", answerLanguage: "English"}
  private readonly backendUrl = configuredBackendUrl()

  private ui!: {
    send: Send
    on: On
    onOpen: (cb: () => void) => () => void
  }

  constructor(private readonly session: MiniappSession) {}

  async start(): Promise<void> {
    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }

    await this.loadSettings()
    this.wireUI()
    this.wireCloudStatus()
    this.transcriptionCleanup = this.session.transcription.on((data) => {
      this.handleTranscription(data)
    })

    console.log(`LocalMerge: started proactive AI listener backend=${this.backendUrl}`)
  }

  stop(): void {
    this.clearDisplayTimer()
    // Leaving/minimizing the app must not leave a spoken insight playing.
    try {
      this.session.speaker.stop()
    } catch {
      /* transport may already be closing during disconnect */
    }
    if (this.transcriptionCleanup) {
      this.transcriptionCleanup()
      this.transcriptionCleanup = null
    }
    for (const unsub of this.unsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
  }

  private wireUI(): void {
    this.unsubs.push(this.ui.onOpen(() => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("merge:request-snapshot", () => this.sendSnapshot()))
    this.unsubs.push(
      this.ui.on("merge:clear", () => {
        this.transcripts = []
        this.insights = []
        this.decisions = []
        this.finalCount = 0
        this.interimCount = 0
        this.pendingChunks = []
        this.displayQueue = []
        this.analyzedFinalIds.clear()
        this.analyzedTextByUtterance.clear()
        this.lastInterimAnalysisAtByUtterance.clear()
        this.recentInsightKeys = []
        this.activeDisplayUntil = 0
        this.clearDisplayTimer()
        this.lastError = null
        this.backendStatus = "idle"
        void this.session.display.render([])
        this.session.speaker.stop()
        this.sendSnapshot()
      }),
    )
    this.unsubs.push(
      this.ui.on("merge:set-frequency", ({frequency}) => {
        void this.setFrequency(frequency)
      }),
    )
    this.unsubs.push(
      this.ui.on("merge:set-answer-language", ({answerLanguage}) => {
        void this.setAnswerLanguage(answerLanguage)
      }),
    )
  }

  private wireCloudStatus(): void {
    try {
      this.unsubs.push(
        this.session.cloud.onStatusChanged((status) => {
          this.cloudStatus = {...status}
          this.ui.send("merge:cloud-status", {...this.cloudStatus})
        }),
      )
    } catch (err) {
      console.log("LocalMerge: cloud status subscribe failed", err)
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await this.session.storage.get(SETTINGS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<MergeSettings>
      this.settings = {
        frequency: isFrequencyMode(parsed.frequency) ? parsed.frequency : this.settings.frequency,
        answerLanguage: isAnswerLanguage(parsed.answerLanguage) ? parsed.answerLanguage : this.settings.answerLanguage,
      }
    } catch (err) {
      console.log("LocalMerge: failed to load settings", err)
    }
  }

  private async setFrequency(frequency: FrequencyMode): Promise<void> {
    this.settings = {...this.settings, frequency}
    this.sendSnapshot()
    await this.saveSettings()
  }

  private async setAnswerLanguage(answerLanguage: AnswerLanguage): Promise<void> {
    this.settings = {...this.settings, answerLanguage}
    this.sendSnapshot()
    await this.saveSettings()
  }

  private async saveSettings(): Promise<void> {
    try {
      await this.session.storage.set(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch (err) {
      console.log("LocalMerge: failed to save settings", err)
    }
  }

  private handleTranscription(data: TranscriptionData): void {
    if (data.isFinal) this.finalCount += 1
    else this.interimCount += 1

    const entry: MergeTranscript = {
      id: (data as {utteranceId?: string}).utteranceId ?? `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      utteranceId: (data as {utteranceId?: string}).utteranceId ?? null,
      text: data.text.trim(),
      language: data.language ?? null,
      speakerId: (data as {speakerId?: string}).speakerId ?? null,
      isFinal: data.isFinal,
      receivedAt: Date.now(),
    }

    this.upsertTranscript(entry)
    this.ui.send("merge:transcript", entry)

    if (entry.isFinal) this.enqueueFinalAnalysis(entry)
    else this.enqueueInterimAnalysis(entry)
  }

  private upsertTranscript(entry: MergeTranscript): void {
    if (entry.utteranceId) {
      const existing = this.transcripts.findIndex((t) => t.utteranceId === entry.utteranceId)
      if (existing >= 0) this.transcripts[existing] = entry
      else this.transcripts.push(entry)
    } else if (entry.isFinal) {
      this.transcripts = this.transcripts.filter((t) => t.isFinal)
      this.transcripts.push(entry)
    } else {
      this.transcripts = [...this.transcripts.filter((t) => t.isFinal), entry]
    }

    if (this.transcripts.length > MAX_TRANSCRIPTS) this.transcripts = this.transcripts.slice(-MAX_TRANSCRIPTS)
  }

  private enqueueFinalAnalysis(entry: MergeTranscript): void {
    if (entry.text.length < MIN_FINAL_CHARS) return

    const finalId = entry.utteranceId ?? entry.id
    if (this.analyzedFinalIds.has(finalId)) return
    this.analyzedFinalIds.add(finalId)

    const priorAnalyzed = this.analyzedTextByUtterance.get(finalId) ?? ""
    const delta = transcriptDelta(entry.text, priorAnalyzed)
    this.analyzedTextByUtterance.set(finalId, entry.text)
    this.enqueueChunk({
      id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: delta.length >= MIN_ANALYSIS_CHARS ? delta : entry.text,
      trigger: "final",
      transcriptId: entry.id,
      isFinal: true,
      language: entry.language,
      startedAt: entry.receivedAt,
      endedAt: Date.now(),
    })
  }

  private enqueueInterimAnalysis(entry: MergeTranscript): void {
    if (entry.text.length < MIN_ANALYSIS_CHARS) return

    const key = entry.utteranceId ?? "live-interim"
    const completedPrefix = completedSentencePrefix(entry.text)
    const analyzedText = this.analyzedTextByUtterance.get(key) ?? ""

    if (completedPrefix.length >= MIN_ANALYSIS_CHARS && completedPrefix.length > analyzedText.length) {
      const delta = transcriptDelta(completedPrefix, analyzedText)
      if (delta.length >= MIN_ANALYSIS_CHARS) {
        this.analyzedTextByUtterance.set(key, completedPrefix)
        this.lastInterimAnalysisAtByUtterance.set(key, Date.now())
        this.enqueueChunk({
          id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          text: delta,
          trigger: "sentence",
          transcriptId: entry.id,
          isFinal: false,
          language: entry.language,
          startedAt: entry.receivedAt,
          endedAt: Date.now(),
        })
        return
      }
    }

    const now = Date.now()
    const lastAnalysisAt = this.lastInterimAnalysisAtByUtterance.get(key) ?? 0
    const delta = transcriptDelta(entry.text, analyzedText)
    if (delta.length >= INTERIM_INTERVAL_CHARS && now - lastAnalysisAt >= INTERIM_INTERVAL_MS) {
      this.analyzedTextByUtterance.set(key, entry.text)
      this.lastInterimAnalysisAtByUtterance.set(key, now)
      this.enqueueChunk({
        id: `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: clampAtWordBoundary(delta, 320),
        trigger: "interval",
        transcriptId: entry.id,
        isFinal: false,
        language: entry.language,
        startedAt: entry.receivedAt,
        endedAt: now,
      })
    }
  }

  private enqueueChunk(chunk: AnalysisChunk): void {
    const text = chunk.text.trim()
    if (text.length < MIN_ANALYSIS_CHARS) return
    this.pendingChunks.push({...chunk, text})
    if (this.pendingChunks.length > MAX_PENDING_CHUNKS) {
      this.pendingChunks = this.pendingChunks.slice(-MAX_PENDING_CHUNKS)
    }
    if (!this.processing) void this.drainAnalysisQueue()
  }

  private async drainAnalysisQueue(): Promise<void> {
    if (this.processing || this.pendingChunks.length === 0) return
    const chunks = this.pendingChunks.splice(0)
    await this.analyze(chunks)
  }

  private async analyze(chunks: AnalysisChunk[]): Promise<void> {
    const primary = chunks[chunks.length - 1]
    const chunkText = chunks
      .map((chunk) => chunk.text)
      .join("\n")
      .trim()
    if (!chunkText) return

    const currentTranscript = this.transcripts.find((t) => t.id === primary.transcriptId)
    const isFinal = primary.isFinal && primary.trigger === "final"
    const isInterim = !isFinal

    this.setProcessing(true)
    this.setBackendStatus("processing", null)

    try {
      const requestStartedAt = Date.now()
      const res = await this.session.auth.fetch(`${this.backendUrl}/api/insights`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          userId: this.session.userId,
          frequency: this.settings.frequency,
          settings: {
            answerLanguage: this.settings.answerLanguage,
          },
          analysis: {
            id: chunks.map((chunk) => chunk.id).join("+"),
            trigger: primary.trigger,
            chunkText,
            chunkStartedAt: chunks[0]?.startedAt ?? Date.now(),
            chunkEndedAt: primary.endedAt,
            timezone: userTimezone(),
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
            locale: userLocale(),
            localTime: userLocalTime(),
            pendingChunkCount: chunks.length,
            isFinal,
            isInterim,
            canDefer: isInterim,
          },
          utterance: {
            id: primary.transcriptId,
            text: chunkText,
            fullText: currentTranscript?.text ?? chunkText,
            isFinal,
            language: primary.language,
            timestamp: primary.endedAt,
          },
          history: {
            transcripts: this.transcripts
              .filter((t) => t.isFinal || t.id === primary.transcriptId)
              .slice(-10)
              .map((t) => t.text),
            conversation: this.transcripts.slice(-10).map((t) => ({
              id: t.id,
              text: t.text,
              isFinal: t.isFinal,
              language: t.language,
              timestamp: t.receivedAt,
            })),
            insights: this.insights.slice(-8).map((i) => i.text),
            activeInsight: this.activeInsightForPrompt(),
          },
        }),
      })

      if (!res.ok) {
        throw new Error(`backend ${res.status}`)
      }

      const body = (await res.json()) as BackendInsightResponse
      const profiling = body.profiling
        ? {
            ...body.profiling,
            clientRoundTripMs: Date.now() - requestStartedAt,
          }
        : undefined
      this.setBackendStatus("ok", null)
      if (body.type === "insight" && body.text.trim()) {
        const insight: MergeInsight = {
          id: `insight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          text: body.text.trim(),
          timestamp: Date.now(),
          agentType: body.agentType ?? "Initial",
          reasoning: body.reasoning,
          transcriptId: primary.transcriptId,
          displayAction: body.displayAction ?? "show",
          urgency: body.urgency,
          confidence: body.confidence,
          sources: body.sources ?? [],
          searchQueries: body.searchQueries ?? [],
          profiling,
        }
        this.recordDecision({
          action: insight.displayAction ?? "show",
          trigger: primary.trigger,
          chunkText,
          reasoning: body.reasoning,
          insightText: insight.text,
          confidence: body.confidence,
          urgency: body.urgency,
          sources: body.sources ?? [],
          searchQueries: body.searchQueries ?? [],
          profiling,
        })
        this.addInsight(insight)
      } else if (body.type === "defer") {
        this.recordDecision({
          action: "defer",
          trigger: primary.trigger,
          chunkText,
          reasoning: body.reasoning ?? "Waiting for more conversation context",
          confidence: body.confidence,
          urgency: body.urgency,
          sources: body.sources ?? [],
          searchQueries: body.searchQueries ?? [],
          profiling,
        })
      } else {
        this.recordDecision({
          action: "silent",
          trigger: primary.trigger,
          chunkText,
          reasoning: body.reasoning ?? "Model stayed silent",
          confidence: body.confidence,
          urgency: body.urgency,
          sources: body.sources ?? [],
          searchQueries: body.searchQueries ?? [],
          profiling,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Insight request failed"
      this.setBackendStatus(message.includes("GEMINI_API_KEY") ? "unconfigured" : "error", message)
      this.recordDecision({
        action: "error",
        trigger: primary.trigger,
        chunkText,
        reasoning: message,
      })
      console.log(`LocalMerge: insight backend failed: ${message}`)
    } finally {
      this.setProcessing(false)
      if (this.pendingChunks.length > 0) void this.drainAnalysisQueue()
    }
  }

  private addInsight(insight: MergeInsight): void {
    const key = normalizeInsight(insight.text)
    if (this.recentInsightKeys.includes(key)) {
      this.recordDecision({
        action: "drop",
        trigger: "final",
        chunkText: insight.text,
        reasoning: "Duplicate insight",
        insightText: insight.text,
        confidence: insight.confidence,
        urgency: insight.urgency,
        sources: insight.sources ?? [],
        searchQueries: insight.searchQueries ?? [],
        profiling: insight.profiling,
      })
      return
    }
    this.recentInsightKeys.push(key)
    if (this.recentInsightKeys.length > 12) this.recentInsightKeys = this.recentInsightKeys.slice(-12)

    this.insights.push(insight)
    if (this.insights.length > MAX_INSIGHTS) this.insights = this.insights.slice(-MAX_INSIGHTS)
    this.ui.send("merge:insight", insight)
    this.scheduleDisplay(insight)
  }

  private scheduleDisplay(insight: MergeInsight): void {
    const action = chooseDisplayAction(insight, this.activeDisplayUntil)
    if (action === "drop") return
    if (action === "queue") {
      this.displayQueue.push(insight)
      if (this.displayQueue.length > 3) this.displayQueue = this.displayQueue.slice(-3)
      this.scheduleNextQueuedDisplay()
      return
    }
    this.showInsight(insight)
  }

  private showInsight(insight: MergeInsight): void {
    this.clearDisplayTimer()
    this.activeDisplayUntil = Date.now() + DISPLAY_DURATION_MS
    if (capabilityHasDisplay(this.session.capabilities)) {
      // Full-canvas text element; durationMs auto-clears after the display
      // window, same semantics as the legacy layout options.
      const d = this.session.capabilities?.display
      void this.session.display.render(
        [
          {
            type: "text",
            id: "insight",
            box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288},
            text: `// Merge\n${insight.text}`,
            style: {breakMode: "word"},
          },
        ],
        {durationMs: DISPLAY_DURATION_MS},
      )
    } else {
      // No display (e.g. Mentra Live): speak the insight so the app is still
      // useful on audio-only glasses. Fire-and-forget — speak() only resolves
      // when playback finishes, but display pacing stays on the
      // DISPLAY_DURATION_MS window driven by scheduleNextQueuedDisplay().
      void this.speakInsight(insight)
    }
    this.scheduleNextQueuedDisplay()
  }

  private async speakInsight(insight: MergeInsight): Promise<void> {
    try {
      // stopOtherAudio mirrors "replace" display semantics for audio: a newer
      // insight cuts off one that is still being spoken instead of overlapping.
      await speakInsightText(this.session.speaker, insight.text)
    } catch (err) {
      console.log("LocalMerge: failed to speak insight", err)
    }
  }

  private clearDisplayTimer(): void {
    if (!this.displayTimer) return
    clearTimeout(this.displayTimer)
    this.displayTimer = null
  }

  private scheduleNextQueuedDisplay(): void {
    if (this.displayTimer || this.displayQueue.length === 0) return
    const waitMs = Math.max(250, this.activeDisplayUntil - Date.now() + 250)
    this.displayTimer = setTimeout(() => {
      this.displayTimer = null
      const next = this.displayQueue.shift()
      if (next) this.showInsight(next)
    }, waitMs)
  }

  private setProcessing(processing: boolean): void {
    this.processing = processing
    this.ui.send("merge:processing", {processing})
  }

  private setBackendStatus(status: MergeBackendStatus, lastError: string | null): void {
    this.backendStatus = status
    this.lastError = lastError
    this.ui.send("merge:backend-status", {status, lastError})
  }

  private recordDecision(input: Omit<MergeDecision, "id" | "timestamp">): void {
    const decision: MergeDecision = {
      id: `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      ...input,
      chunkText: clampAtWordBoundary(input.chunkText, 180),
    }
    this.decisions.push(decision)
    if (this.decisions.length > MAX_DECISIONS) this.decisions = this.decisions.slice(-MAX_DECISIONS)
    this.ui.send("merge:decision", decision)
  }

  private activeInsightForPrompt(): {text: string; ageMs: number} | null {
    if (this.activeDisplayUntil <= Date.now() || this.insights.length === 0) return null
    const latest = this.insights[this.insights.length - 1]
    return {text: latest.text, ageMs: Date.now() - latest.timestamp}
  }

  private sendSnapshot(): void {
    const snapshot: MergeSnapshot = {
      transcripts: [...this.transcripts],
      insights: [...this.insights],
      decisions: [...this.decisions],
      finalCount: this.finalCount,
      interimCount: this.interimCount,
      cloudStatus: {...this.cloudStatus},
      settings: {...this.settings},
      backendUrl: this.backendUrl,
      backendStatus: this.backendStatus,
      processing: this.processing,
      lastError: this.lastError,
    }
    this.ui.send("merge:snapshot", snapshot)
  }
}

function isFrequencyMode(value: unknown): value is FrequencyMode {
  return value === "low" || value === "medium" || value === "high"
}

function isAnswerLanguage(value: unknown): value is AnswerLanguage {
  return (
    value === "English" ||
    value === "Spanish" ||
    value === "French" ||
    value === "German" ||
    value === "Italian" ||
    value === "Portuguese" ||
    value === "Japanese" ||
    value === "Korean" ||
    value === "Chinese" ||
    value === "Auto"
  )
}

function normalizeInsight(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function completedSentencePrefix(text: string): string {
  const matches = text.match(/[\s\S]*[.!?。！？](?=\s|$)/)
  return matches?.[0]?.trim() ?? ""
}

function transcriptDelta(current: string, analyzed: string): string {
  const currentText = current.trim()
  const analyzedText = analyzed.trim()
  if (!analyzedText) return currentText
  if (currentText.startsWith(analyzedText)) return currentText.slice(analyzedText.length).trim()
  if (currentText.includes(analyzedText)) {
    const index = currentText.lastIndexOf(analyzedText)
    return currentText.slice(index + analyzedText.length).trim()
  }
  return currentText
}

function clampAtWordBoundary(text: string, maxChars: number): string {
  const value = text.trim()
  if (value.length <= maxChars) return value
  const clipped = value.slice(0, maxChars)
  const lastSpace = clipped.lastIndexOf(" ")
  return (lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim()
}

function chooseDisplayAction(
  insight: MergeInsight,
  activeDisplayUntil: number,
): NonNullable<MergeInsight["displayAction"]> {
  if (insight.displayAction === "drop") return "drop"
  if (Date.now() >= activeDisplayUntil) return insight.displayAction ?? "show"
  if (insight.displayAction === "replace" || insight.urgency === "high") return "replace"
  return "queue"
}

function capabilityHasDisplay(caps: unknown): boolean {
  // Capability shapes vary across host versions; accept the common flags.
  // Default to display output when the shape is unreadable so we never surprise
  // a display-equipped user with unexpected audio.
  if (!caps || typeof caps !== "object") return true
  const record = caps as Record<string, unknown>
  if (typeof record.hasDisplay === "boolean") return record.hasDisplay
  const display = record.display
  if (typeof display === "boolean") return display
  if (display === null) return false
  if (display && typeof display === "object") {
    return (display as {present?: boolean}).present !== false
  }
  return true
}

function userTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function userLocale(): string {
  const nav = globalThis as {navigator?: {language?: string; languages?: readonly string[]}}
  return nav.navigator?.languages?.[0] ?? nav.navigator?.language ?? "en-US"
}

function userLocalTime(): string {
  try {
    return new Date().toLocaleString(undefined, {
      timeZone: userTimezone(),
      dateStyle: "full",
      timeStyle: "long",
    })
  } catch {
    return new Date().toString()
  }
}

registerMiniapp((session) => {
  const controller = new MergeController(session)
  void controller.start()
  session.onBeforeDisconnect(() => {
    controller.stop()
  })
})
