/**
 * QueryProcessor — orchestrates the full query → response pipeline.
 *
 * Ported from the cloud app. Key changes for the local port:
 *  - Photos are data-URL strings (not Buffers); the agent and the webview both
 *    consume that form.
 *  - `broadcastChatEvent(userId, …)` → `emit(event)` which the controller
 *    forwards to the `chat:event` UI channel (replacing SSE).
 *  - Location comes from `session.location.getOnce()`.
 *  - The looping cloud "processing" sound is dropped (was a server-hosted asset);
 *    HUD glasses still get visual "Processing…/Thinking…/Searching…" status.
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import {generateResponse} from "../agent/MentraAgent"
import {formatForTTS} from "../lib/tts-formatter"
import type {ChatEvent} from "../../shared/types"
import type {AudioManager} from "./AudioManager"
import type {ChatHistoryManager} from "./ChatHistoryManager"
import type {DisplayManager} from "./DisplayManager"
import type {LocationManager} from "./LocationManager"
import type {NotificationManager} from "./NotificationManager"
import type {PhotoManager, StoredPhoto} from "./PhotoManager"

export interface QueryProcessorDeps {
  session: MiniappSession
  audio: AudioManager
  display: DisplayManager
  location: LocationManager
  notifications: NotificationManager
  photo: PhotoManager
  chatHistory: ChatHistoryManager
  /** Current OpenRouter model slug from settings, sent with each agent request. */
  getModel: () => string
  /** Forward a chat event to the webview (chat:event channel). */
  emit: (event: ChatEvent) => void
}

export class QueryProcessor {
  constructor(private readonly deps: QueryProcessorDeps) {}

  /**
   * Process a user query and return the response.
   * prePhoto is a photo pre-captured at wake-word time (already awaited).
   */
  async processQuery(query: string, _speakerId?: string, prePhoto?: StoredPhoto | null): Promise<string> {
    const {session, emit} = this.deps
    const pipelineStart = Date.now()
    const lap = (label: string) => console.log(`⏱️ [${label}] +${Date.now() - pipelineStart}ms`)

    // Capabilities are the single source of truth; each flag is independent.
    const hasDisplay = Boolean(session.capabilities?.hasDisplay)
    const hasCamera = Boolean(session.capabilities?.hasCamera)
    const hasSpeakers = Boolean(session.capabilities?.hasSpeaker)
    console.log(
      `🎛️ capabilities: hasDisplay=${hasDisplay} hasCamera=${hasCamera} hasSpeaker=${hasSpeakers} model=${session.capabilities?.modelName ?? "unknown"}`,
    )

    // Start the looping "thinking" sound. Gated SOLELY on hasSpeaker inside
    // AudioManager — only Mentra Live / camera glasses with a speaker play it.
    // Display (HUD) glasses with no speaker get the visual "Processing…" status
    // instead and stay silent. Stopped before output; never blocks the pipeline.
    this.deps.audio.startProcessingSound()
    this.deps.display.showStatus("Processing...", 10000)

    // Step 1: photo — pre-captured, else fallback capture (10s cap).
    let photos: string[] = []
    let photoDataUrl: string | undefined

    if (hasCamera) {
      if (prePhoto) {
        photos = this.deps.photo.getPhotosForContext()
        photoDataUrl = prePhoto.dataUrl
        lap("PHOTO-FROM-CACHE")
      } else {
        let timeoutId: ReturnType<typeof setTimeout>
        let timedOut = false
        const currentPhoto = await Promise.race([
          this.deps.photo.takePhoto(),
          new Promise<null>((r) => {
            timeoutId = setTimeout(() => {
              timedOut = true
              console.warn("📸 Fallback capture hit 10s cap — continuing without photo")
              r(null)
            }, 10000)
          }),
        ])
        clearTimeout(timeoutId!)

        if (currentPhoto) {
          photos = this.deps.photo.getPhotosForContext()
          photoDataUrl = currentPhoto.dataUrl
        } else if (!timedOut) {
          console.warn("📸 Fallback photo capture failed")
        }
        lap("PHOTO-FALLBACK-CAPTURE")
      }
    }

    // Broadcast the user message (with photo, if any) + processing state.
    emit({
      type: "message",
      id: `user-${Date.now()}`,
      senderId: "user",
      content: query,
      timestamp: new Date().toISOString(),
      image: photoDataUrl,
    })
    emit({type: "processing"})
    lap("EMIT-USER-MSG")

    // Step 2: location, if the query needs it.
    if (this.deps.location.queryNeedsLocation(query)) {
      try {
        const locationData = await session.location.getOnce()
        if (locationData) {
          this.deps.location.updateCoordinates(locationData.lat, locationData.lng)
          await this.deps.location.fetchContextIfNeeded(query)
        }
      } catch (error) {
        console.warn("Failed to get location:", error)
      }
      lap("LOCATION-FETCH")
    }

    // Step 3: local time.
    const localTime = this.getLocalTime()

    // Step 4: agent context.
    const hasPhotos = photoDataUrl !== undefined
    const context = {
      hasDisplay,
      hasSpeakers,
      hasCamera,
      hasPhotos,
      glassesType: (hasDisplay ? "display" : "camera") as "display" | "camera",
      location: this.deps.location.getCachedContext(),
      localTime,
      timezone: this.deps.location.getTimezone() ?? undefined,
      notifications: this.deps.notifications.formatForPrompt(),
      conversationHistory: this.deps.chatHistory.getRecentTurns(),
    }
    lap("BUILD-CONTEXT")

    // Step 5: generate.
    this.deps.display.showStatus("Thinking...", 10000)
    let response: string
    try {
      const result = await generateResponse({
        session,
        query,
        photos: photos.length > 0 ? photos : undefined,
        model: this.deps.getModel(),
        context,
        onToolCall: (toolName) => {
          if (toolName === "search") this.deps.display.showStatus("Searching...", 10000)
        },
      })
      response = result.response
    } catch (error) {
      console.error("Agent error:", error)
      response = "I'm sorry, I had trouble processing that. Please try again."
    }
    lap("AI-GENERATE-RESPONSE")

    // Broadcast the AI response + idle state.
    emit({
      type: "message",
      id: `ai-${Date.now()}`,
      senderId: "mentra-ai",
      content: response,
      timestamp: new Date().toISOString(),
    })
    emit({type: "idle"})
    lap("EMIT-AI-MSG")

    // Step 6: stop the processing loop, then output (raw on HUD, TTS to speaker).
    this.deps.audio.stopProcessingSound()
    this.outputResponse(response, hasSpeakers, hasDisplay)
    lap("OUTPUT-TO-GLASSES")

    // Step 7: save history.
    this.deps.chatHistory.addTurn(query, response, photos.length > 0, photoDataUrl)
    lap("SAVE-HISTORY")

    console.log(`⏱️ [PIPELINE-DONE] Total: ${Date.now() - pipelineStart}ms`)
    return response
  }

  private getLocalTime(): string {
    const timezone = this.deps.location.getTimezone()
    const options: Intl.DateTimeFormatOptions = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }
    try {
      if (timezone) options.timeZone = timezone
      return new Date().toLocaleString("en-US", options)
    } catch {
      delete options.timeZone
      return new Date().toLocaleString("en-US", options)
    }
  }

  /**
   * Output the response to each available channel: HUD gets raw text (symbols
   * intact); speaker gets a TTS-formatted version. Glasses with both get both.
   */
  private outputResponse(response: string, hasSpeakers: boolean, hasDisplay: boolean): void {
    if (hasDisplay) {
      this.deps.display.showResponse(response, 10000)
    }
    if (hasSpeakers) {
      const spoken = formatForTTS(response)
      console.log(`🔊 speaking ${spoken.length} chars to glasses`)
      this.deps.audio.speak(spoken).catch((error) => console.debug("Speech output failed:", error))
    } else {
      console.log("🔇 hasSpeaker=false — not speaking response")
    }
  }
}
