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
import {generateResponse, pollDelegation, type GenerateResult} from "../agent/MentraAgent"
import {formatForTTS} from "../lib/tts-formatter"
import type {AvailableApp, ChatEvent, DeviceAction} from "../../shared/types"
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
      // Other miniapps the agent can control (Mentra AI is a system app).
      apps: await this.listApps(),
    }
    lap("BUILD-CONTEXT")

    // Step 5: generate.
    this.deps.display.showStatus("Thinking...", 10000)
    let result: GenerateResult
    try {
      result = await generateResponse({
        session,
        query,
        photos: photos.length > 0 ? photos : undefined,
        model: this.deps.getModel(),
        context,
        onToolCall: (toolName) => {
          if (toolName === "search") this.deps.display.showStatus("Searching...", 10000)
        },
      })
    } catch (error) {
      console.error("Agent error:", error)
      result = {response: "I'm sorry, I had trouble processing that. Please try again.", toolCalls: 0}
    }
    const response = result.response
    lap("AI-GENERATE-RESPONSE")

    // Broadcast the AI response (with any action buttons) + idle state. For a
    // pending delegation `response` is just the ack — the real answer follows.
    emit({
      type: "message",
      id: `ai-${Date.now()}`,
      senderId: "mentra-ai",
      content: response,
      timestamp: new Date().toISOString(),
      ...(result.actions?.length ? {actions: result.actions} : {}),
    })
    emit({type: "idle"})
    lap("EMIT-AI-MSG")

    // Step 6: stop the processing loop, then output (raw on HUD, TTS to speaker).
    this.deps.audio.stopProcessingSound()
    this.outputResponse(response, hasSpeakers, hasDisplay)
    lap("OUTPUT-TO-GLASSES")

    // Execute any deferred app-control actions the agent chose (start/stop/invoke
    // another miniapp). Fire-and-forget — the agent already confirmed to the user.
    if (result.deviceActions?.length) {
      void this.executeDeviceActions(result.deviceActions)
    }

    // Step 7: history (+ follow-up for a delegated turn). When the giga-agent
    // ran long, `response` is the ack; the real answer is recorded by the
    // follow-up below, so we don't save the ack here.
    if (result.pendingTaskId) {
      void this.awaitFollowUp(result.pendingTaskId, query, photos.length > 0, photoDataUrl, hasSpeakers, hasDisplay)
    } else {
      this.deps.chatHistory.addTurn(query, response, photos.length > 0, photoDataUrl)
    }
    lap("SAVE-HISTORY")

    console.log(`⏱️ [PIPELINE-DONE] Total: ${Date.now() - pipelineStart}ms`)
    return response
  }

  /**
   * Wait for a pending giga-agent delegation, then deliver the answer as a
   * second turn: emit it to the webview, record it in history (the final answer,
   * not the earlier ack), and speak/show it on the glasses if connected.
   */
  private async awaitFollowUp(
    taskId: string,
    query: string,
    hadPhoto: boolean,
    photoDataUrl: string | undefined,
    hasSpeakers: boolean,
    hasDisplay: boolean,
  ): Promise<void> {
    const {session, emit} = this.deps
    const final = await pollDelegation(session, taskId)

    if (final.status === "done" && final.reply) {
      const reply = final.reply
      console.log(`🤝 delivering delegation follow-up (${reply.length} chars, ${final.actions?.length ?? 0} actions)`)
      emit({
        type: "message",
        id: `ai-${Date.now()}`,
        senderId: "mentra-ai",
        content: reply,
        timestamp: new Date().toISOString(),
        ...(final.actions?.length ? {actions: final.actions} : {}),
      })
      this.deps.chatHistory.addTurn(query, reply, hadPhoto, photoDataUrl)
      this.outputResponse(reply, hasSpeakers, hasDisplay)
    } else {
      const msg = "Sorry — that one didn't go through. Want me to try again?"
      emit({
        type: "message",
        id: `ai-${Date.now()}`,
        senderId: "mentra-ai",
        content: msg,
        timestamp: new Date().toISOString(),
      })
      this.outputResponse(msg, hasSpeakers, hasDisplay)
    }
  }

  /**
   * List the other miniapps the agent can control (system-only). Returns [] if
   * Mentra AI isn't a system app or the host rejects — the agent then simply has
   * no app-control tools that turn.
   */
  private async listApps(): Promise<AvailableApp[]> {
    try {
      const apps = await this.deps.session.miniapps.list()
      return apps
        .filter((a) => a.packageName !== "com.mentra.ai.local") // don't list self
        .map((a) => ({
          packageName: a.packageName,
          name: a.name,
          running: a.running,
          actions: a.actions.map((act) => ({
            id: act.id,
            description: act.description,
            parameters: act.parameters,
          })),
        }))
    } catch (error) {
      console.warn("Failed to list miniapps (not a system app?):", error)
      return []
    }
  }

  /**
   * Execute the agent's deferred app-control actions on-device. Each runs
   * independently; a failure (app gone, action unknown) is logged and skipped.
   */
  private async executeDeviceActions(actions: DeviceAction[]): Promise<void> {
    const {session} = this.deps
    for (const action of actions) {
      try {
        if (action.type === "start_app") {
          await session.miniapps.start(action.packageName)
        } else if (action.type === "stop_app") {
          await session.miniapps.stop(action.packageName)
        } else {
          await session.actions.invoke(action.packageName, action.actionId, action.params)
        }
        console.log(`🎛️ executed ${action.type} ${action.packageName}`)
      } catch (error) {
        console.warn(`🎛️ device action failed (${action.type} ${action.packageName}):`, error)
      }
    }
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
