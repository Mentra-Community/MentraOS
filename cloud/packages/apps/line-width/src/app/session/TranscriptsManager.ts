import {randomUUID} from "crypto"

import {TranscriptionData} from "@mentra/sdk"

import {UserSession} from "./UserSession"
import {convertToPinyin} from "../utils/ChineseUtils"

export interface TranscriptEntry {
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  timestamp: string | null
  isFinal: boolean
  receivedAt: number
}

interface SSEClient {
  send(data: any): void
}

interface CaptionSettings {
  language: string
  languageHints: string[]
  displayLines: number
  displayWidth: number
}

export class TranscriptsManager {
  readonly userSession: UserSession
  readonly logger: UserSession["logger"]

  private transcripts: TranscriptEntry[] = []
  private maxTranscripts = 100
  private sseClients: Set<SSEClient> = new Set()

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "TranscriptsManager"})
    // Note: No subscription here - UserSession owns the transcription subscription
    // and calls handleTranscription() directly
  }

  /**
   * Handle incoming transcription data from UserSession
   * This is the single entry point for all transcription processing
   */
  public async handleTranscription(transcriptData: TranscriptionData): Promise<void> {
    this.logger.info(
      {
        text: transcriptData.text,
        isFinal: transcriptData.isFinal,
        utteranceId: transcriptData.utteranceId,
        speakerId: transcriptData.speakerId,
      },
      `Received transcription: ${transcriptData.text} (final: ${transcriptData.isFinal})`,
    )

    // 1. Create entry and update transcript list
    const entry = this.createEntry(transcriptData)

    if (transcriptData.utteranceId) {
      // New utteranceId-based tracking
      this.updateByUtteranceId(entry)
    } else {
      // Backwards compatibility: old behavior without utteranceId
      if (transcriptData.isFinal) {
        this.legacyReplaceInterim(entry)
      } else {
        this.legacyUpdateInterim(entry)
      }
    }

    // 2. Broadcast transcript update to webview (transcript list)
    this.broadcast(entry)

    // 3. Process text for display (handle Pinyin conversion, etc.)
    let displayText = transcriptData.text
    const activeLanguage = await this.userSession.settings.getLanguage()
    if (activeLanguage === "Chinese (Pinyin)") {
      displayText = convertToPinyin(displayText)
      this.logger.debug("Converting Chinese to Pinyin for display")
    }

    // 4. Update glasses display via DisplayManager
    // Pass speakerId for future diarization speaker labels feature
    this.userSession.display.processAndDisplay(
      displayText,
      transcriptData.isFinal,
      transcriptData.speakerId,
    )
  }

  private createEntry(data: TranscriptionData): TranscriptEntry {
    // Use utteranceId if available, otherwise generate a random ID
    const id = data.utteranceId || randomUUID()

    // Use speakerId from diarization if available, otherwise default
    const speaker = this.formatSpeakerId(data.speakerId)

    return {
      id,
      utteranceId: data.utteranceId || null,
      speaker,
      text: data.text,
      timestamp: data.isFinal ? this.formatTimestamp(new Date()) : null,
      isFinal: data.isFinal,
      receivedAt: Date.now(),
    }
  }

  /**
   * Format speaker ID from Soniox diarization (e.g., "1" -> "Speaker 1")
   */
  private formatSpeakerId(speakerId: string | undefined): string {
    if (!speakerId) {
      return "Speaker 1" // Default when no speaker info
    }
    // Soniox returns "1", "2", etc. - format as "Speaker 1", "Speaker 2"
    return `Speaker ${speakerId}`
  }

  /**
   * Update transcript using utteranceId for correlation
   * This handles both interim updates and interim->final transitions correctly
   */
  private updateByUtteranceId(entry: TranscriptEntry): void {
    const existingIndex = this.transcripts.findIndex((t) => t.utteranceId === entry.utteranceId)

    if (existingIndex >= 0) {
      // Replace existing entry (interim->interim or interim->final)
      this.transcripts[existingIndex] = entry
      this.logger.debug(
        {
          utteranceId: entry.utteranceId,
          isFinal: entry.isFinal,
        },
        `Updated transcript for utterance`,
      )
    } else {
      // New utterance
      this.transcripts.push(entry)
      this.logger.debug(
        {
          utteranceId: entry.utteranceId,
          isFinal: entry.isFinal,
        },
        `Added new transcript for utterance`,
      )
    }

    // Enforce max transcripts limit (keep only final transcripts when trimming)
    if (this.transcripts.length > this.maxTranscripts) {
      // Keep recent transcripts, preferring finals
      const finals = this.transcripts.filter((t) => t.isFinal)
      const interims = this.transcripts.filter((t) => !t.isFinal)

      // Keep all interims (they're current) and trim finals from the beginning
      const maxFinals = this.maxTranscripts - interims.length
      const trimmedFinals = finals.slice(-maxFinals)

      this.transcripts = [...trimmedFinals, ...interims]
    }
  }

  /**
   * Legacy: Update interim transcript (no utteranceId)
   */
  private legacyUpdateInterim(entry: TranscriptEntry): void {
    // Remove all existing interim transcripts
    this.transcripts = this.transcripts.filter((t) => t.isFinal)

    // Add new interim
    this.transcripts.push(entry)

    this.logger.debug(`Legacy: Updated interim transcript: ${entry.text}`)
  }

  /**
   * Legacy: Replace interim with final (no utteranceId)
   */
  private legacyReplaceInterim(entry: TranscriptEntry): void {
    // Remove all interim transcripts
    this.transcripts = this.transcripts.filter((t) => t.isFinal)

    // Add final transcript
    this.transcripts.push(entry)

    // Enforce max transcripts limit
    if (this.transcripts.length > this.maxTranscripts) {
      this.transcripts = this.transcripts.slice(-this.maxTranscripts)
    }

    this.logger.debug(`Legacy: Added final transcript: ${entry.text}`)
  }

  private formatTimestamp(date: Date): string {
    const hours = date.getHours()
    const minutes = date.getMinutes()
    const ampm = hours >= 12 ? "PM" : "AM"
    const displayHours = hours % 12 || 12
    const displayMinutes = minutes.toString().padStart(2, "0")
    return `${displayHours}:${displayMinutes} ${ampm}`
  }

  private broadcast(entry: TranscriptEntry): void {
    const message = {
      type: entry.isFinal ? "final" : "interim",
      id: entry.id,
      utteranceId: entry.utteranceId,
      speaker: entry.speaker,
      text: entry.text,
      timestamp: entry.timestamp,
    }

    this.logger.info(
      {
        sseClientCount: this.sseClients.size,
        messageType: message.type,
        text: message.text.substring(0, 50),
      },
      `📡 Broadcasting to ${this.sseClients.size} SSE clients`,
    )

    if (this.sseClients.size === 0) {
      this.logger.warn("No SSE clients connected - transcript will not reach webview")
    }

    for (const client of this.sseClients) {
      try {
        client.send(message)
        this.logger.debug("Successfully sent to SSE client")
      } catch (error) {
        this.logger.error(`Failed to send to SSE client: ${error}`)
      }
    }
  }

  public getAll(): TranscriptEntry[] {
    return this.transcripts
  }

  public addSSEClient(client: SSEClient): void {
    this.sseClients.add(client)
    this.logger.info(`SSE client connected. Total clients: ${this.sseClients.size}`)
  }

  public removeSSEClient(client: SSEClient): void {
    const hadClient = this.sseClients.has(client)
    const sizeBefore = this.sseClients.size
    this.sseClients.delete(client)
    this.logger.info(
      `SSE client disconnected. Had client: ${hadClient}, Before: ${sizeBefore}, After: ${this.sseClients.size}`,
    )
  }

  /**
   * Broadcast display preview to all connected SSE clients
   * Called by DisplayManager when showing content on glasses
   */
  public broadcastDisplayPreview(text: string, lines: string[], isFinal: boolean): void {
    const message = {
      type: "display_preview",
      text,
      lines,
      isFinal,
      timestamp: Date.now(),
    }

    this.logger.debug(
      {
        sseClientCount: this.sseClients.size,
        isFinal,
        textLength: text.length,
        lineCount: lines.length,
      },
      `📺 Broadcasting display preview to ${this.sseClients.size} SSE clients`,
    )

    for (const client of this.sseClients) {
      try {
        client.send(message)
      } catch (error) {
        this.logger.error(`Failed to send display preview to SSE client: ${error}`)
      }
    }
  }

  /**
   * Broadcast settings update to all connected SSE clients
   * Called by SettingsManager when settings change
   */
  public broadcastSettingsUpdate(settings: CaptionSettings): void {
    const message = {
      type: "settings_update",
      settings,
    }

    this.logger.info(`Broadcasting settings update to ${this.sseClients.size} clients`)

    for (const client of this.sseClients) {
      try {
        client.send(message)
      } catch (error) {
        this.logger.error(`Failed to send settings update to SSE client: ${error}`)
      }
    }
  }

  dispose() {
    // No subscription to clean up - UserSession owns it
    this.sseClients.clear()
  }
}
