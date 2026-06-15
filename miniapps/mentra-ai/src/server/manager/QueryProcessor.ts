/**
 * QueryProcessor - Orchestrates the full query → response pipeline
 *
 * This is the main entry point for processing user queries.
 * It coordinates all managers and the agent to produce responses.
 */

import type { User } from "../session/User";
import type { StoredPhoto } from "./PhotoManager";
import { generateResponse, type GenerateOptions } from "../agent/MentraAgent";
import { broadcastChatEvent } from "../api/chat";
import { formatForTTS } from "../utils/tts-formatter";

/**
 * URL the glasses fetch for the looping "thinking" sound while a query is
 * being processed. Derived from PUBLIC_URL (the public origin
 * the glasses can reach this server at) + the bundled asset path under
 * /assets/audio/start.mp3. Falls back to null if PUBLIC_URL
 * isn't set; the loop simply no-ops in that case.
 */
const PROCESSING_SOUND_URL = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/assets/audio/popping.mp3`
  : null;

/**
 * QueryProcessor — handles the full query processing pipeline.
 */
export class QueryProcessor {
  private processingSoundLooping = false;

  constructor(private user: User) {}

  /**
   * Process a user query and return the response.
   * prePhoto is a photo pre-captured at wake word time (already awaited).
   * isVisual indicates whether the query was classified as needing the camera photo.
   */
  async processQuery(query: string, speakerId?: string, prePhoto?: StoredPhoto | null, isVisual?: boolean): Promise<string> {
    const session = this.user.appSession;
    if (!session) {
      console.error(`No active session for ${this.user.userId}`);
      return "I'm not connected to your glasses right now.";
    }

    const pipelineStart = Date.now();
    const lap = (label: string) => console.log(`⏱️ [${label}] +${Date.now() - pipelineStart}ms`);

    // Read hardware capabilities directly from the SDK — the single source of
    // truth. Each is an independent flag; do NOT derive one from another
    // (HUD glasses can also have a speaker).
    const hasDisplay = session.capabilities?.hasDisplay ?? false;
    const hasCamera = session.capabilities?.hasCamera ?? false;
    const hasSpeakers = session.capabilities?.hasSpeaker ?? false;
    console.log(`🎛️ capabilities: hasDisplay=${hasDisplay} hasCamera=${hasCamera} hasSpeaker=${hasSpeakers} model=${session.capabilities?.modelName ?? 'unknown'}`);

    console.log(`⏱️ [PIPELINE-START] Query: "${query.slice(0, 60)}..." | prePhoto: ${prePhoto ? 'yes' : 'no'} | isVisual: ${isVisual ?? 'n/a'} | glasses: ${hasDisplay ? 'display' : 'camera'}`);

    // Start looping processing sound (fire and forget - don't block pipeline)
    this.startProcessingSound(hasDisplay);
    this.showStatus("Processing...", hasDisplay);
    lap('PROCESSING-SOUND');

    // Step 1: Always use pre-captured photo, or fallback capture
    let photos: Buffer[] = [];
    let photoDataUrl: string | undefined;

    if (hasCamera) {
      if (prePhoto) {
        console.log(`📸 Using pre-captured photo for ${this.user.userId}`);
        photos = this.user.photo.getPhotosForContext();
        photoDataUrl = `data:${prePhoto.mimeType};base64,${prePhoto.buffer.toString("base64")}`;
        lap('PHOTO-FROM-CACHE');
      } else {
        // No pre-photo — fallback capture with a 10s cap.
        //
        // takePhoto() resolves to null on failure (never rejects) but it can
        // stay pending until the SDK's own 30s photo timeout. We cap the wait
        // at 10s so a wedged camera can't stall the whole query pipeline.
        console.log(`📸 No pre-photo, attempting fallback capture for ${this.user.userId}`);
        const fbStart = Date.now();
        let timeoutId: NodeJS.Timeout;
        let timedOut = false;

        const currentPhoto = await Promise.race([
          this.user.photo.takePhoto(),
          new Promise<null>(r => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              console.warn(`📸 Fallback capture hit 10s cap — continuing without photo for ${this.user.userId}`);
              r(null);
            }, 10000);
          }),
        ]);
        clearTimeout(timeoutId!);

        if (currentPhoto) {
          photos = this.user.photo.getPhotosForContext();
          photoDataUrl = `data:${currentPhoto.mimeType};base64,${currentPhoto.buffer.toString("base64")}`;
          console.log(`📸 Fallback photo captured in ${Date.now() - fbStart}ms for ${this.user.userId}`);
        } else if (!timedOut) {
          console.warn(`📸 Fallback photo capture failed for ${this.user.userId}`);
        }
        lap('PHOTO-FALLBACK-CAPTURE');
      }
    }

    // Broadcast user message to frontend (with photo if available)
    broadcastChatEvent(this.user.userId, {
      type: "message",
      id: `user-${Date.now()}`,
      senderId: this.user.userId,
      recipientId: "mentra-ai",
      content: query,
      timestamp: new Date().toISOString(),
      image: photoDataUrl,
    });

    // Broadcast processing state
    broadcastChatEvent(this.user.userId, { type: "processing" });
    lap('SSE-BROADCAST-USER-MSG');

    // Step 2: Fetch location if needed
    if (this.user.location.queryNeedsLocation(query)) {
      try {
        const locationData = await session.location.getLatestLocation({ accuracy: "high" });
        if (locationData) {
          this.user.location.updateCoordinates(locationData.lat, locationData.lng);
          await this.user.location.fetchContextIfNeeded(query);
        }
      } catch (error) {
        console.warn(`Failed to get location for ${this.user.userId}:`, error);
      }
      lap('LOCATION-FETCH');
    }

    // Step 3: Get local time
    const localTime = this.getLocalTime();

    // Step 4: Build agent context (using snapshotted capabilities from pipeline start)
    const hasPhotos = photoDataUrl !== undefined; // current query's photo, not stale ones
    const context: GenerateOptions["context"] = {
      hasDisplay,
      hasSpeakers,
      hasCamera,
      hasPhotos,
      glassesType: hasDisplay ? 'display' : 'camera',
      location: this.user.location.getCachedContext(),
      localTime,
      timezone: this.user.location.getTimezone() ?? undefined,
      notifications: this.user.notifications.formatForPrompt(),
      conversationHistory: this.user.chatHistory.getRecentTurns(),
    };
    lap('BUILD-CONTEXT');

    // Step 5: Generate response
    this.showStatus("Thinking...", hasDisplay);
    let response: string;
    try {
      const result = await generateResponse({
        query,
        photos: photos.length > 0 ? photos : undefined,
        context,
        onToolCall: (toolName) => {
          if (toolName === 'search') {
            this.showStatus("Searching...", hasDisplay);
          }
        },
      });
      response = result.response;
    } catch (error) {
      console.error(`Agent error for ${this.user.userId}:`, error);
      response = "I'm sorry, I had trouble processing that. Please try again.";
    }
    lap('AI-GENERATE-RESPONSE');

    // Broadcast AI response to frontend
    broadcastChatEvent(this.user.userId, {
      type: "message",
      id: `ai-${Date.now()}`,
      senderId: "mentra-ai",
      recipientId: this.user.userId,
      content: response,
      timestamp: new Date().toISOString(),
    });

    // Broadcast idle state
    broadcastChatEvent(this.user.userId, { type: "idle" });
    lap('SSE-BROADCAST-AI-MSG');

    // Step 6: Stop processing sound loop and output response.
    // outputResponse formats per-channel (raw for HUD, TTS-formatted for speech).
    // Fire-and-forget — don't block pipeline.
    this.stopProcessingSound();
    this.outputResponse(response, context.hasSpeakers, context.hasDisplay);
    lap('OUTPUT-TO-GLASSES');

    // Step 8: Save to chat history
    const hadPhoto = photos.length > 0;
    await this.user.chatHistory.addTurn(query, response, hadPhoto, photoDataUrl);
    lap('SAVE-HISTORY');

    console.log(`⏱️ [PIPELINE-DONE] Total: ${Date.now() - pipelineStart}ms`);

    return response;
  }

  /**
   * Show a status message on the HUD (display glasses only)
   */
  private showStatus(text: string, hasDisplay?: boolean): void {
    const session = this.user.appSession;
    const isDisplay = hasDisplay ?? session?.capabilities?.hasDisplay ?? false;
    if (!session || !isDisplay) return;
    session.layouts.showTextWall(text, { durationMs: 10000 });
  }

  /**
   * Start looping the processing sound until stopProcessingSound() is called
   */
  private startProcessingSound(hasDisplay?: boolean): void {
    if (!PROCESSING_SOUND_URL || !this.user.appSession) return;
    // Don't play sound on display glasses — they have no speakers and get visual status instead
    const isDisplay = hasDisplay ?? this.user.appSession.capabilities?.hasDisplay ?? false;
    if (isDisplay) return;

    this.processingSoundLooping = true;
    this.loopProcessingSound();
  }

  /**
   * Loop that replays the processing sound until the flag is cleared
   */
  private async loopProcessingSound(): Promise<void> {
    while (this.processingSoundLooping && this.user.appSession) {
      try {
        await this.user.appSession.audio.playAudio({ audioUrl: PROCESSING_SOUND_URL! });
      } catch {
        break;
      }
    }
  }

  /**
   * Stop the processing sound loop
   */
  private stopProcessingSound(): void {
    this.processingSoundLooping = false;
  }

  /**
   * Get local time string
   */
  private getLocalTime(): string {
    // Use timezone (available even before geocoding, set from SDK settings)
    const timezone = this.user.location.getTimezone();

    try {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      };

      if (timezone) {
        options.timeZone = timezone;
      }

      return now.toLocaleString("en-US", options);
    } catch {
      return new Date().toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }
  }

  /**
   * Output the response to each available channel.
   * The HUD gets the raw response; the speaker gets a TTS-formatted version
   * so numbers/symbols/abbreviations are read naturally. Glasses with both
   * a display and a speaker get both.
   */
  private async outputResponse(
    response: string,
    hasSpeakers: boolean,
    hasDisplay: boolean
  ): Promise<void> {
    const session = this.user.appSession;
    if (!session) return;

    // Display on HUD if available — raw text, with symbols intact.
    if (hasDisplay) {
      try {
        await session.layouts.showTextWall(response, { durationMs: 10000 });
      } catch (error) {
        console.debug("Display output failed:", error);
      }
    }

    // Speak if a speaker is available (fire-and-forget — speak() blocks 3-5s).
    // Route through AudioManager, not session.audio.speak() directly: the SDK's
    // TTS URL builder mishandles our `/ws/miniapp` cloud path.
    if (hasSpeakers) {
      const spoken = formatForTTS(response);
      console.log(`🔊 speaking ${spoken.length} chars to glasses`);
      this.user.audio.speak(spoken).catch((error) => {
        console.debug("Speech output failed:", error);
      });
    } else {
      console.log("🔇 hasSpeaker=false — not speaking response");
    }
  }
}
