import type { AppSession, TranscriptionData } from "@mentra/sdk";
import type { User } from "../session/User";
import type { StoredPhoto } from "./PhotoManager";
import { detectWakeWord, removeWakeWord, stripWakeWordResidue } from "../utils/wake-word";
import { broadcastChatEvent } from "../api/chat";

/**
 * URL the glasses fetch for the short "I heard you" cue that plays the
 * moment the wake phrase is detected. Derived from PUBLIC_URL (the public
 * origin the glasses can reach this server at) + the bundled asset path
 * under /assets/audio/start.mp3. Null if PUBLIC_URL isn't set — playback
 * simply no-ops.
 */
const START_SOUND_URL = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/assets/audio/start.mp3`
  : null;

interface SSEWriter {
  write: (data: string) => void;
  userId: string;
  close: () => void;
}

/**
 * Callback signature for when a query is ready to be processed.
 * Includes pre-captured photo (taken at wake word time) and visual classification.
 */
export type OnQueryReadyCallback = (query: string, speakerId?: string, prePhoto?: StoredPhoto | null, isVisual?: boolean) => Promise<void>;

/**
 * TranscriptionManager — handles speech-to-text, wake word detection,
 * speaker locking, and SSE broadcasting for a single user.
 *
 * Simplified architecture:
 * - No follow-up mode
 * - No head position tracking
 * - No cancellation phrases
 * - Clean state machine: IDLE -> LISTENING -> (callback) -> IDLE
 */
export class TranscriptionManager {
  private sseClients: Set<SSEWriter> = new Set();
  private unsubscribe: (() => void) | null = null;

  // State
  private isListening: boolean = false;
  private isProcessing: boolean = false;
  private activeSpeakerId: string | undefined = undefined;

  // Transcript accumulation (utterance-aware)
  // SDK sends cumulative text per-utterance, but starts fresh on new utterances.
  // We track confirmed (finalized) and current (in-progress) portions separately
  // so that multi-utterance queries within the silence window are combined.
  private confirmedTranscript: string = '';
  private currentUtteranceText: string = '';
  private lastConfirmedUtteranceId: string | undefined = undefined;
  private transcriptionStartTime: number = 0;

  // Pre-captured photo (taken at wake word time, before query is ready)
  private pendingPhoto: Promise<StoredPhoto | null> | null = null;

  // Duplicate detection: store first few words of last processed query
  private lastProcessedWords: string[] = [];
  private lastProcessedTime: number = 0;
  private readonly DUPLICATE_WINDOW_MS = 10000;  // 10s window to detect duplicates
  private readonly DUPLICATE_WORD_COUNT = 3;     // Compare first 3 words

  // Timers
  private silenceTimeout: NodeJS.Timeout | undefined;
  private maxListeningTimeout: NodeJS.Timeout | undefined;
  private currentSilenceMs: number = 0; // Track current silence timer duration to prevent downgrades

  // Config
  private readonly SILENCE_TIMEOUT_MS = 2000;  // 1.5s silence = query complete for interim transcriptions
  private readonly FINAL_SILENCE_TIMEOUT_MS = 2000; // 5s after isFinal — gives user time to add another sentence
  private readonly MAX_LISTENING_MS = 15000;   // 15s max listening time

  // Callback for when query is ready
  private onQueryReady: OnQueryReadyCallback | null = null;

  // Session disconnect safety — prevents zombie query processing
  private destroyed = false;

  constructor(private user: User) {}

  /**
   * Get the full accumulated transcript (confirmed + in-progress utterance)
   */
  private getFullTranscript(): string {
    const raw = (this.confirmedTranscript + ' ' + this.currentUtteranceText).trim();
    // Safety net: first try to strip a full wake word (e.g. if "hey mentr a" accumulated),
    // then strip leading residue fragments (e.g. "a," or "tra," left by Deepgram splitting
    // "mentra" across utterance boundaries)
    const cleaned = removeWakeWord(raw);
    return stripWakeWordResidue(cleaned);
  }

  /**
   * Set the callback to be invoked when a query is ready
   */
  setOnQueryReady(callback: OnQueryReadyCallback): void {
    this.onQueryReady = callback;
  }

  /**
   * Wire up the transcription listener on the glasses session
   */
  setup(session: AppSession): void {
    // Reset zombie flag — critical for reconnect (destroy() sets this to true)
    this.destroyed = false;

    this.unsubscribe = session.events.onTranscription(
      (data: TranscriptionData) => {
        this.handleTranscription(data);
      },
    );
    console.log(`🎤 TranscriptionManager ready for ${this.user.userId}`);
  }

  /**
   * Handle incoming transcription data
   */
  private async handleTranscription(data: TranscriptionData): Promise<void> {
    const { text, isFinal, speakerId } = data as TranscriptionData & { speakerId?: string };

    // Broadcast to SSE clients
    this.broadcast(text, isFinal ?? false);

    // Transcription logging disabled for cleaner terminal
    // console.log(`🎙️ [RAW] text="${text.slice(0, 60)}" | isFinal=${isFinal ?? false} | speaker=${speakerId} | isListening=${this.isListening} | isProcessing=${this.isProcessing}`);

    // Ignore if we're currently processing a query
    if (this.isProcessing) {
      // console.log(`🚫 [DROP] Dropped (isProcessing=true): "${text.slice(0, 60)}"`);
      return;
    }

    // Speaker diarization disabled for testing — accept all speakers
    // if (this.isListening && this.activeSpeakerId && speakerId !== this.activeSpeakerId) {
    //   console.log(`🚫 [DROP] Dropped (wrong speaker ${speakerId} != ${this.activeSpeakerId}): "${text.slice(0, 60)}"`);
    //   return;
    // }

    // Check for wake word
    const wakeResult = detectWakeWord(text);

    if (!this.isListening) {
      // Not listening - look for wake word
      if (!wakeResult.detected) {
        return;  // No wake word, ignore
      }

      // Check for duplicate query (delayed transcript from already-processed utterance)
      if (this.isDuplicateQuery(wakeResult.query)) {
        console.log(`⏱️ [WAKE] Ignoring duplicate wake word: "${text}" (isFinal=${isFinal ?? false})`);
        return;
      }

      // Wake word detected! Start listening
      console.log(`⏱️ [WAKE] Wake word detected: "${text}" (isFinal=${isFinal ?? false})`);
      broadcastChatEvent(this.user.userId, { type: "wake_word" });
      this.startListening(speakerId);
    }

    // We're listening - accumulate transcript across utterances
    const cleanText = removeWakeWord(text);
    const utteranceId = (data as TranscriptionData & { utteranceId?: string }).utteranceId;

    if (isFinal) {
      // Utterance complete — snapshot into confirmed transcript
      if (utteranceId && utteranceId === this.lastConfirmedUtteranceId) {
        // Duplicate isFinal for same utterance — ignore to avoid double-appending
        // console.log(`⏱️ [ACCUMULATE] Duplicate isFinal for utterance ${utteranceId}, skipping`);
      } else {
        this.confirmedTranscript = (this.confirmedTranscript + ' ' + cleanText).trim();
        this.lastConfirmedUtteranceId = utteranceId;
        // console.log(`⏱️ [ACCUMULATE] isFinal appended | utteranceId=${utteranceId} | cleanText="${cleanText.slice(0, 60)}" | before="${before.slice(0, 60)}" | after="${this.confirmedTranscript.slice(0, 80)}"`);
      }
      this.currentUtteranceText = '';
    } else {
      // Interim update — overwrite in-progress portion (cumulative within same utterance)
      this.currentUtteranceText = cleanText;
      // console.log(`⏱️ [ACCUMULATE] interim | utteranceId=${utteranceId} | currentUtterance="${cleanText.slice(0, 60)}" | confirmed="${this.confirmedTranscript.slice(0, 60)}" | full="${this.getFullTranscript().slice(0, 80)}"`);
    }

    // After a finalized utterance, give a longer window so the user can
    // add another sentence to the same query (e.g. "what's the weather?" ...pause... "should I wear a jacket?")
    // CRITICAL: Never let an interim transcription downgrade a post-final timer.
    // When isFinal fires, we set 5s. If a new interim arrives 2s later, we should NOT
    // reset to 1.5s — the user is still in the grace period. Only reset to the shorter
    // duration once the new utterance itself finalizes (proving the user finished speaking).
    let timeoutMs: number;
    if (isFinal) {
      timeoutMs = this.FINAL_SILENCE_TIMEOUT_MS;
      this.currentSilenceMs = timeoutMs;
    } else if (this.currentSilenceMs > this.SILENCE_TIMEOUT_MS) {
      // We're in a post-final grace period and an interim arrived — keep the longer timer
      // but DON'T reset it (the user is speaking, which is good — let the existing timer run)
      // console.log(`⏱️ [TIMER] Interim arrived during post-final grace period, NOT resetting (${this.currentSilenceMs}ms remaining) | text="${text.slice(0, 50)}"`);
      return;
    } else {
      timeoutMs = this.SILENCE_TIMEOUT_MS;
      this.currentSilenceMs = timeoutMs;
    }
    // console.log(`⏱️ [TIMER] Resetting silence timer to ${timeoutMs}ms (isFinal=${isFinal ?? false}) | text="${text.slice(0, 50)}" | confirmed="${this.confirmedTranscript.slice(0, 50)}" | current="${this.currentUtteranceText.slice(0, 50)}"`);
    this.resetSilenceTimeout(timeoutMs);

    // Show live transcription on display glasses HUD
    if (this.isListening && this.user.appSession?.capabilities?.hasDisplay) {
      this.user.appSession.layouts.showTextWall(
        `Listening...\n\n${this.getFullTranscript()}`,
        { durationMs: 5000 }
      );
    }
  }

  /**
   * Start listening for a query
   */
  private startListening(speakerId?: string): void {
    this.isListening = true;
    this.activeSpeakerId = speakerId;
    this.confirmedTranscript = '';
    this.currentUtteranceText = '';
    this.lastConfirmedUtteranceId = undefined;
    this.transcriptionStartTime = Date.now();

    // Capture photo NOW while user is still speaking (parallel with transcript accumulation)
    const hasCamera = this.user.appSession?.capabilities?.hasCamera ?? false;
    if (hasCamera) {
      console.log(`📸 Pre-capturing photo at wake word for ${this.user.userId}`);
      this.pendingPhoto = this.user.photo.takePhoto();
    } else {
      this.pendingPhoto = null;
    }

    // Play the activation cue immediately on wake-phrase detection so the
    // wearer hears that we're listening. (Previously disabled because it
    // overlapped the Mentra Live camera "snap" sound — re-enabled with a
    // shorter start.mp3 served from our own /assets/audio.)
    this.playStartSound();

    // Start max listening timeout
    this.maxListeningTimeout = setTimeout(() => {
      if (this.isListening && !this.isProcessing) {
        console.log(`⏰ Max listening time reached (${this.MAX_LISTENING_MS}ms)`);
        this.processCurrentQuery();
      }
    }, this.MAX_LISTENING_MS);
  }

  /**
   * Reset the silence timeout
   */
  private resetSilenceTimeout(overrideMs?: number): void {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }

    this.silenceTimeout = setTimeout(() => {
      if (this.isListening && !this.isProcessing && this.getFullTranscript().length > 0) {
        this.processCurrentQuery();
      }
    }, overrideMs ?? this.SILENCE_TIMEOUT_MS);
  }

  /**
   * Process the current accumulated query
   */
  private async processCurrentQuery(): Promise<void> {
    if (this.isProcessing) return;

    const query = this.getFullTranscript();
    if (!query) {
      this.resetState();
      return;
    }

    this.isProcessing = true;
    this.clearTimers();

    // Store first few words for duplicate detection (lowercase, stripped of punctuation)
    this.lastProcessedWords = this.extractWords(query);
    this.lastProcessedTime = Date.now();

    const silenceDetectedAt = Date.now();
    const timeSinceWake = silenceDetectedAt - this.transcriptionStartTime;
    console.log(`⏱️ [SILENCE] Query ready: "${query}" (${timeSinceWake}ms since wake word)`);

    // Always pass the photo — no classifier, image is always included in context
    let prePhoto: StoredPhoto | null = null;
    try {
      prePhoto = await (this.pendingPhoto ?? Promise.resolve(null));
    } catch {
      prePhoto = null;
    }
    this.pendingPhoto = null;
    console.log(`⏱️ [PHOTO] photo=${prePhoto ? 'yes' : 'no'}`);

    // Bail if session destroyed during photo wait
    if (this.destroyed) {
      console.log(`🛑 Session destroyed during photo await for ${this.user.userId}, aborting`);
      return;
    }

    try {
      if (this.onQueryReady) {
        await this.onQueryReady(query, this.activeSpeakerId, prePhoto, true);
      }
    } catch (error) {
      console.error('Error processing query:', error);
    } finally {
      this.resetState();
    }
  }

  /**
   * Reset state to idle
   */
  private resetState(): void {
    this.isListening = false;
    this.isProcessing = false;
    this.activeSpeakerId = undefined;
    this.confirmedTranscript = '';
    this.currentUtteranceText = '';
    this.lastConfirmedUtteranceId = undefined;
    this.transcriptionStartTime = 0;
    this.currentSilenceMs = 0;
    this.pendingPhoto = null;
    this.clearTimers();
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = undefined;
    }
    if (this.maxListeningTimeout) {
      clearTimeout(this.maxListeningTimeout);
      this.maxListeningTimeout = undefined;
    }
  }

  /**
   * Extract first N words from a query (lowercase, punctuation stripped)
   */
  private extractWords(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')  // Remove punctuation
      .split(/\s+/)
      .filter(w => w.length > 0)
      .slice(0, this.DUPLICATE_WORD_COUNT);
  }

  /**
   * Check if a query is a duplicate of the last processed query
   */
  private isDuplicateQuery(query: string): boolean {
    // No previous query to compare
    if (this.lastProcessedWords.length === 0) {
      return false;
    }

    // Outside the duplicate detection window
    if (Date.now() - this.lastProcessedTime > this.DUPLICATE_WINDOW_MS) {
      return false;
    }

    // Extract words from incoming query
    const incomingWords = this.extractWords(query);

    // If incoming query is too short, compare what we have
    if (incomingWords.length === 0) {
      return false;
    }

    // Compare words - all incoming words must match the start of last processed
    const wordsToCompare = Math.min(incomingWords.length, this.lastProcessedWords.length);
    for (let i = 0; i < wordsToCompare; i++) {
      if (incomingWords[i] !== this.lastProcessedWords[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Play the activation sound the moment the wake phrase is detected.
   * Uses START_SOUND_URL (derived once at module load from PUBLIC_URL).
   * Fire-and-forget — a missed cue isn't worth blocking the pipeline for.
   */
  private playStartSound(): void {
    if (!START_SOUND_URL || !this.user.appSession) return;
    this.user.appSession.audio.playAudio({ audioUrl: START_SOUND_URL }).catch((err) => {
      console.debug('Start listening sound failed:', err);
    });
  }

  /**
   * Check if currently listening for a query
   */
  get listening(): boolean {
    return this.isListening;
  }

  /**
   * Check if currently processing a query
   */
  get processing(): boolean {
    return this.isProcessing;
  }

  /**
   * Push a transcription event to all connected SSE clients
   */
  broadcast(text: string, isFinal: boolean): void {
    const payload = JSON.stringify({
      text,
      isFinal,
      timestamp: Date.now(),
      userId: this.user.userId,
    });

    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  addSSEClient(client: SSEWriter): void {
    this.sseClients.add(client);
  }

  removeSSEClient(client: SSEWriter): void {
    this.sseClients.delete(client);
  }

  /**
   * Tear down listener and drop all SSE clients
   */
  destroy(): void {
    this.destroyed = true;
    this.clearTimers();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sseClients.clear();
    this.resetState();
  }
}
