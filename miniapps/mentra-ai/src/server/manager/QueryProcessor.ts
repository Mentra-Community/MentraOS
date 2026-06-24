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
import { agentBridge, type AgentAction, type AgentContextPayload, type AgentTaskResult } from "./AgentBridge";
import { delegations } from "./DelegationManager";
import { isDelegationEnabled, AGENT_DELEGATION, resolveModel } from "../constants/config";
import { UserSettings } from "../db/schemas/user-settings.schema";
import type { DelegateOutcome } from "../agent/tools/askAgent.tool";

/**
 * Where the control plane POSTs a delegation result when it runs long.
 * Derived from PUBLIC_URL; null disables the webhook (poll backstop still runs).
 */
const AGENT_WEBHOOK_URL = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/agent/webhook`
  : undefined;

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

    // Wire up giga-agent delegation for this turn (only if configured). The
    // closure captures this query's photo + device context so the ask_agent
    // tool can forward them. `pendingDelegation` tells the history step to
    // defer: when a delegation goes async the turn's response is just the ack,
    // and the real answer is recorded later in deliverFollowUp().
    const hadPhoto = photos.length > 0;
    let pendingDelegation = false;
    let delegatedActions: AgentAction[] = [];
    const delegate = isDelegationEnabled()
      ? async (task: string): Promise<DelegateOutcome> => {
          const outcome = await this.delegateToAgent(task, { query, photoDataUrl, hadPhoto, context });
          if (outcome.status === "pending") {
            pendingDelegation = true;
            return { status: "working" };
          }
          delegatedActions = outcome.actions;
          return { status: "done", reply: outcome.reply };
        }
      : undefined;

    const model = await this.resolveUserModel();

    let response: string;
    try {
      const result = await generateResponse({
        query,
        photos: photos.length > 0 ? photos : undefined,
        context,
        delegate,
        model,
        onToolCall: (toolName) => {
          if (toolName === 'search') {
            this.showStatus("Searching...", hasDisplay);
          } else if (toolName === 'ask_agent') {
            this.showStatus("On it...", hasDisplay);
          }
        },
      });
      response = result.response;
    } catch (error) {
      console.error(`Agent error for ${this.user.userId}:`, error);
      response = "I'm sorry, I had trouble processing that. Please try again.";
    }
    lap('AI-GENERATE-RESPONSE');

    // Broadcast AI response to frontend (with any action buttons from a fast
    // delegation, e.g. an OAuth "Connect Gmail" link).
    broadcastChatEvent(this.user.userId, {
      type: "message",
      id: `ai-${Date.now()}`,
      senderId: "mentra-ai",
      recipientId: this.user.userId,
      content: response,
      timestamp: new Date().toISOString(),
      ...(delegatedActions.length ? { actions: delegatedActions } : {}),
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

    // Step 8: Save to chat history. For a pending delegation the turn's
    // "response" is only the ack — the final answer is recorded later in
    // deliverFollowUp(), so we skip recording here to keep history coherent.
    if (!pendingDelegation) {
      await this.user.chatHistory.addTurn(query, response, hadPhoto, photoDataUrl);
    }
    lap('SAVE-HISTORY');

    console.log(`⏱️ [PIPELINE-DONE] Total: ${Date.now() - pipelineStart}ms`);

    return response;
  }

  /**
   * Process a query typed into the webview chat box (no glasses required).
   *
   * Runs the same agent + delegation pipeline as the voice path, but as a text
   * channel: no photo, no HUD/speaker output, relaxed length. The reply (and any
   * async delegation follow-up) is broadcast to the chat SSE stream; the final
   * answer is also returned so the caller can render it directly.
   */
  async processTextQuery(text: string): Promise<{ response: string; actions: AgentAction[] }> {
    const userId = this.user.userId;

    // Echo the user's message into the chat thread + show the typing state.
    broadcastChatEvent(userId, {
      type: "message",
      id: `user-${Date.now()}`,
      senderId: userId,
      recipientId: "mentra-ai",
      content: text,
      timestamp: new Date().toISOString(),
    });
    broadcastChatEvent(userId, { type: "processing" });

    // Text-only channel: no device I/O, relaxed length. Location/time/notes/
    // history are included when available (webview-only users have none).
    const context: GenerateOptions["context"] = {
      hasDisplay: false,
      hasSpeakers: false,
      hasCamera: false,
      hasPhotos: false,
      glassesType: "camera",
      location: this.user.location.getCachedContext(),
      localTime: this.getLocalTime(),
      timezone: this.user.location.getTimezone() ?? undefined,
      notifications: this.user.notifications.formatForPrompt(),
      conversationHistory: this.user.chatHistory.getRecentTurns(),
      channel: "chat",
    };

    let pendingDelegation = false;
    let delegatedActions: AgentAction[] = [];
    const delegate = isDelegationEnabled()
      ? async (task: string): Promise<DelegateOutcome> => {
          const outcome = await this.delegateToAgent(task, { query: text, hadPhoto: false, context });
          if (outcome.status === "pending") {
            pendingDelegation = true;
            return { status: "working" };
          }
          delegatedActions = outcome.actions;
          return { status: "done", reply: outcome.reply };
        }
      : undefined;

    const model = await this.resolveUserModel();

    let response: string;
    try {
      const result = await generateResponse({ query: text, context, delegate, model });
      response = result.response;
    } catch (error) {
      console.error(`Chat agent error for ${userId}:`, error);
      response = "I'm sorry, I had trouble with that. Please try again.";
    }

    broadcastChatEvent(userId, {
      type: "message",
      id: `ai-${Date.now()}`,
      senderId: "mentra-ai",
      recipientId: userId,
      content: response,
      timestamp: new Date().toISOString(),
      ...(delegatedActions.length ? { actions: delegatedActions } : {}),
    });
    broadcastChatEvent(userId, { type: "idle" });

    // Skip history on a pending delegation — deliverFollowUp records the final answer.
    if (!pendingDelegation) {
      await this.user.chatHistory.addTurn(text, response, false);
    }

    return { response, actions: delegatedActions };
  }

  /**
   * Delegate a task to the user's giga-agent via the control plane.
   *
   * Blocks up to the grace window for a fast answer; otherwise registers the
   * pending task so deliverFollowUp() runs when it completes (webhook primary,
   * poll backstop). Returns a shape the ask_agent tool can act on.
   */
  private async delegateToAgent(
    task: string,
    turn: { query: string; photoDataUrl?: string; hadPhoto: boolean; context: GenerateOptions["context"] },
  ): Promise<{ status: "done"; reply: string; actions: AgentAction[] } | { status: "pending"; taskId: string }> {
    const userId = this.user.userId;
    const result = await agentBridge.message({
      userId,
      text: task,
      image: turn.photoDataUrl,
      context: this.buildAgentContext(turn.context),
      waitMs: AGENT_DELEGATION.graceMs,
      webhookUrl: AGENT_WEBHOOK_URL,
    });

    if (result.status === "done") {
      return { status: "done", reply: result.reply, actions: result.actions };
    }
    if (result.status === "working") {
      // Register the follow-up: when the agent finishes, deliver it as a
      // second turn through the normal output path.
      delegations.register(result.taskId, userId, (final) =>
        this.deliverFollowUp(turn.query, final, { photoDataUrl: turn.photoDataUrl, hadPhoto: turn.hadPhoto }),
      );
      return { status: "pending", taskId: result.taskId };
    }

    // Failed synchronously — surface it as a spoken answer rather than hanging.
    console.error(`🤝 [Delegation] message failed for ${userId}: ${result.error}`);
    return { status: "done", reply: "I couldn't reach your agent just now. Please try again.", actions: [] };
  }

  /**
   * Deliver a completed delegation back to the user as a follow-up turn.
   *
   * Re-enters the SAME output path a normal answer uses (HUD / speaker decided
   * by capabilities) when the glasses session is still live, always mirrors it
   * into the webview chat thread, and records the FINAL answer in history so
   * the fast agent's next turn reflects what the agent actually said.
   */
  async deliverFollowUp(
    originalQuery: string,
    result: AgentTaskResult,
    opts: { photoDataUrl?: string; hadPhoto: boolean },
  ): Promise<void> {
    const userId = this.user.userId;

    if (result.status !== "done" || !result.reply) {
      // Failed/timed-out delegation: tell the user something went wrong, in the
      // chat thread and on the glasses if they're still connected.
      const msg = "Sorry — that one didn't go through. Want me to try again?";
      broadcastChatEvent(userId, {
        type: "message",
        id: `ai-${Date.now()}`,
        senderId: "mentra-ai",
        recipientId: userId,
        content: msg,
        timestamp: new Date().toISOString(),
      });
      if (this.user.appSession) {
        const session = this.user.appSession;
        this.outputResponse(msg, session.capabilities?.hasSpeaker ?? false, session.capabilities?.hasDisplay ?? false);
      }
      return;
    }

    const reply = result.reply;
    const actions = result.actions ?? [];
    console.log(`🤝 [Delegation] delivering follow-up to ${userId} (${reply.length} chars, ${actions.length} actions)`);

    // Always land it in the webview chat thread (durable record + the surface
    // for any action buttons). Queues if no SSE client is connected.
    broadcastChatEvent(userId, {
      type: "message",
      id: `ai-${Date.now()}`,
      senderId: "mentra-ai",
      recipientId: userId,
      content: reply,
      timestamp: new Date().toISOString(),
      ...(actions.length ? { actions } : {}),
    });

    // Record the FINAL answer (not the earlier ack) so history stays in sync.
    await this.user.chatHistory.addTurn(originalQuery, reply, opts.hadPhoto, opts.photoDataUrl);

    // Speak / show on the glasses if the session is still live; if not, the
    // chat-thread broadcast above is the fallback (no separate push needed).
    const session = this.user.appSession;
    if (session) {
      this.outputResponse(reply, session.capabilities?.hasSpeaker ?? false, session.capabilities?.hasDisplay ?? false);
    } else {
      console.log(`🤝 [Delegation] session gone for ${userId}; follow-up left in chat thread only`);
    }
  }

  /**
   * Resolve the Mastra model string from the user's saved Settings → Model
   * choice. Falls back to the default model on any error or missing setting.
   */
  private async resolveUserModel(): Promise<string | undefined> {
    try {
      const settings = await UserSettings.findOne({ userId: this.user.userId });
      return resolveModel(settings?.model);
    } catch (error) {
      console.warn(`Failed to load model setting for ${this.user.userId}:`, error);
      return undefined; // createMentraAgent falls back to AGENT_SETTINGS.model
    }
  }

  /**
   * Map this turn's device context into the flat shape the control plane
   * prepends for the agent (so it never re-asks for what the device knows).
   */
  private buildAgentContext(context: GenerateOptions["context"]): AgentContextPayload {
    const payload: AgentContextPayload = {};

    const loc = context.location;
    if (loc) {
      const parts = [loc.neighborhood, loc.city, loc.state, loc.country].filter(Boolean);
      if (parts.length) payload.location = parts.join(", ");
    }
    if (context.localTime) payload.localTime = context.localTime;

    const model = this.user.appSession?.capabilities?.modelName;
    if (model) payload.device = model;

    return payload;
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
