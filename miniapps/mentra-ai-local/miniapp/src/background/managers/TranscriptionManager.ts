/**
 * TranscriptionManager — speech-to-text, wake word detection, and silence-based
 * query finalization for the single local user.
 *
 * Ported from the cloud app's manager. The state machine (IDLE → LISTENING →
 * processing → IDLE), utterance accumulation, post-final grace window, max
 * listening cap, duplicate detection, and wake-word pre-capture are preserved.
 *
 * Removed for the local port:
 *  - SSE client plumbing (the webview gets live transcript via the controller's
 *    onTranscript callback → chat:event channel instead).
 *  - The cloud "start.mp3" activation cue (was a server-hosted asset).
 *  - The `User` indirection — the manager takes the session + photo manager
 *    and reports out via callbacks.
 */

import type {MiniappSession, TranscriptionData} from "@mentra/miniapp/background"
import {detectWakeWord, removeWakeWord, stripWakeWordResidue} from "../lib/wake-word"
import type {PhotoManager, StoredPhoto} from "./PhotoManager"

/** Invoked when a finalized query is ready to process. */
export type OnQueryReadyCallback = (
  query: string,
  speakerId?: string,
  prePhoto?: StoredPhoto | null,
) => Promise<void>

export interface TranscriptionCallbacks {
  onQueryReady: OnQueryReadyCallback
  /** Live transcript text (interim + final), for the webview + HUD. */
  onTranscript?: (text: string, isFinal: boolean) => void
  /** Fired the moment a wake word is detected (UI glow, activation cue, …). */
  onWakeWord?: () => void
  /** Fired with the in-progress transcript while listening (for HUD "Listening…"). */
  onListeningUpdate?: (fullTranscript: string) => void
}

export class TranscriptionManager {
  private unsubscribe: (() => void) | null = null

  private isListening = false
  private isProcessing = false
  private activeSpeakerId: string | undefined = undefined

  private confirmedTranscript = ""
  private currentUtteranceText = ""
  private lastConfirmedUtteranceId: string | undefined = undefined
  private transcriptionStartTime = 0

  private pendingPhoto: Promise<StoredPhoto | null> | null = null

  private lastProcessedWords: string[] = []
  private lastProcessedTime = 0
  private readonly DUPLICATE_WINDOW_MS = 10000
  private readonly DUPLICATE_WORD_COUNT = 3

  private silenceTimeout: ReturnType<typeof setTimeout> | undefined
  private maxListeningTimeout: ReturnType<typeof setTimeout> | undefined
  private currentSilenceMs = 0

  private readonly SILENCE_TIMEOUT_MS = 2000
  private readonly FINAL_SILENCE_TIMEOUT_MS = 2000
  private readonly MAX_LISTENING_MS = 15000

  private destroyed = false

  constructor(
    private readonly session: MiniappSession,
    private readonly photo: PhotoManager,
    private readonly callbacks: TranscriptionCallbacks,
  ) {}

  /** Subscribe to transcription events. */
  setup(): void {
    this.destroyed = false
    this.unsubscribe = this.session.transcription.on((data: TranscriptionData) => {
      void this.handleTranscription(data)
    })
    console.log("🎤 TranscriptionManager ready")
  }

  get listening(): boolean {
    return this.isListening
  }

  get processing(): boolean {
    return this.isProcessing
  }

  destroy(): void {
    this.destroyed = true
    this.clearTimers()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.resetState()
  }

  /** Full accumulated transcript (confirmed + in-progress), wake-word stripped. */
  private getFullTranscript(): string {
    const raw = (this.confirmedTranscript + " " + this.currentUtteranceText).trim()
    const cleaned = removeWakeWord(raw)
    return stripWakeWordResidue(cleaned)
  }

  private async handleTranscription(data: TranscriptionData): Promise<void> {
    const {text, isFinal} = data
    const speakerId = (data as TranscriptionData & {speakerId?: string}).speakerId

    console.log(
      `🎤 [TRANSCRIPT] ${isFinal ? "FINAL  " : "interim"} | "${text}"` +
        (speakerId ? ` (speaker: ${speakerId})` : ""),
    )

    this.callbacks.onTranscript?.(text, isFinal ?? false)

    if (this.isProcessing) return

    const wakeResult = detectWakeWord(text)

    if (!this.isListening) {
      if (!wakeResult.detected) return

      if (this.isDuplicateQuery(wakeResult.query)) {
        console.log(`⏱️ [WAKE] Ignoring duplicate wake word: "${text}"`)
        return
      }

      console.log(`⏱️ [WAKE] Wake word detected: "${text}"`)
      this.callbacks.onWakeWord?.()
      this.startListening(speakerId)
    }

    const cleanText = removeWakeWord(text)
    const utteranceId = (data as TranscriptionData & {utteranceId?: string}).utteranceId

    if (isFinal) {
      if (utteranceId && utteranceId === this.lastConfirmedUtteranceId) {
        // Duplicate isFinal for same utterance — skip to avoid double-append.
      } else {
        this.confirmedTranscript = (this.confirmedTranscript + " " + cleanText).trim()
        this.lastConfirmedUtteranceId = utteranceId
      }
      this.currentUtteranceText = ""
    } else {
      this.currentUtteranceText = cleanText
    }

    // Post-final grace window: never let an interim downgrade the longer timer.
    let timeoutMs: number
    if (isFinal) {
      timeoutMs = this.FINAL_SILENCE_TIMEOUT_MS
      this.currentSilenceMs = timeoutMs
    } else if (this.currentSilenceMs > this.SILENCE_TIMEOUT_MS) {
      return
    } else {
      timeoutMs = this.SILENCE_TIMEOUT_MS
      this.currentSilenceMs = timeoutMs
    }
    this.resetSilenceTimeout(timeoutMs)

    if (this.isListening) {
      this.callbacks.onListeningUpdate?.(this.getFullTranscript())
    }
  }

  private startListening(speakerId?: string): void {
    this.isListening = true
    this.activeSpeakerId = speakerId
    this.confirmedTranscript = ""
    this.currentUtteranceText = ""
    this.lastConfirmedUtteranceId = undefined
    this.transcriptionStartTime = Date.now()

    // Pre-capture a photo NOW (parallel with transcript accumulation) so visual
    // queries have the live view from the moment the user started speaking.
    const hasCamera = Boolean(this.session.capabilities?.hasCamera)
    this.pendingPhoto = hasCamera ? this.photo.takePhoto() : null

    this.maxListeningTimeout = setTimeout(() => {
      if (this.isListening && !this.isProcessing) {
        console.log(`⏰ Max listening time reached (${this.MAX_LISTENING_MS}ms)`)
        void this.processCurrentQuery()
      }
    }, this.MAX_LISTENING_MS)
  }

  private resetSilenceTimeout(overrideMs?: number): void {
    if (this.silenceTimeout) clearTimeout(this.silenceTimeout)
    this.silenceTimeout = setTimeout(() => {
      if (this.isListening && !this.isProcessing && this.getFullTranscript().length > 0) {
        void this.processCurrentQuery()
      }
    }, overrideMs ?? this.SILENCE_TIMEOUT_MS)
  }

  private async processCurrentQuery(): Promise<void> {
    if (this.isProcessing) return

    const query = this.getFullTranscript()
    if (!query) {
      this.resetState()
      return
    }

    this.isProcessing = true
    this.clearTimers()

    this.lastProcessedWords = this.extractWords(query)
    this.lastProcessedTime = Date.now()

    console.log(
      `⏱️ [SILENCE] Query ready: "${query}" (${Date.now() - this.transcriptionStartTime}ms since wake)`,
    )

    let prePhoto: StoredPhoto | null = null
    try {
      prePhoto = await (this.pendingPhoto ?? Promise.resolve(null))
    } catch {
      prePhoto = null
    }
    this.pendingPhoto = null

    if (this.destroyed) {
      console.log("🛑 Session destroyed during photo await, aborting")
      return
    }

    try {
      await this.callbacks.onQueryReady(query, this.activeSpeakerId, prePhoto)
    } catch (error) {
      console.error("Error processing query:", error)
    } finally {
      this.resetState()
    }
  }

  private resetState(): void {
    this.isListening = false
    this.isProcessing = false
    this.activeSpeakerId = undefined
    this.confirmedTranscript = ""
    this.currentUtteranceText = ""
    this.lastConfirmedUtteranceId = undefined
    this.transcriptionStartTime = 0
    this.currentSilenceMs = 0
    this.pendingPhoto = null
    this.clearTimers()
  }

  private clearTimers(): void {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout)
      this.silenceTimeout = undefined
    }
    if (this.maxListeningTimeout) {
      clearTimeout(this.maxListeningTimeout)
      this.maxListeningTimeout = undefined
    }
  }

  private extractWords(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(0, this.DUPLICATE_WORD_COUNT)
  }

  private isDuplicateQuery(query: string): boolean {
    if (this.lastProcessedWords.length === 0) return false
    if (Date.now() - this.lastProcessedTime > this.DUPLICATE_WINDOW_MS) return false

    const incomingWords = this.extractWords(query)
    if (incomingWords.length === 0) return false

    const wordsToCompare = Math.min(incomingWords.length, this.lastProcessedWords.length)
    for (let i = 0; i < wordsToCompare; i++) {
      if (incomingWords[i] !== this.lastProcessedWords[i]) return false
    }
    return true
  }
}
