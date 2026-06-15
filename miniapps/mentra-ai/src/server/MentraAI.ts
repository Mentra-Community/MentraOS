/**
 * MentraAI — Main MentraOS AppServer for the AI assistant.
 *
 * Handles the glasses lifecycle (onSession/onStop) and wires up
 * all the managers, event listeners, and query processing.
 */

import { AppServer, AppSession } from "@mentra/sdk";
import { sessions } from "./manager/SessionManager";
import { broadcastChatEvent } from "./api/chat";
import { connectDB } from "./db/connection";

export interface MentraAIConfig {
  packageName: string;
  apiKey: string;
  port: number;
  cookieSecret?: string;
}

export class MentraAI extends AppServer {
  constructor(config: MentraAIConfig) {
    super({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port,
      cookieSecret: config.cookieSecret,
    });
  }

  /**
   * Called when a user launches the app on their glasses
   */
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    console.log(`🚀 Mentra AI session started for ${userId} | model: ${session.capabilities?.modelName ?? 'unknown (capabilities not yet loaded)'} | hasCamera: ${session.capabilities?.hasCamera} | hasDisplay: ${session.capabilities?.hasDisplay} | hasSpeaker: ${session.capabilities?.hasSpeaker}`);

    // Check if this is a reconnect (grace period was active)
    const wasReconnect = sessions.cancelRemoval(userId);

    // Get or create user
    const user = sessions.getOrCreate(userId);

    // Initialize async components (database, settings) — skip on reconnect (already initialized)
    if (!wasReconnect) {
      await user.initialize();
    }

    // Wire up glasses session (re-wires transcription + input listeners)
    user.setAppSession(session);

    // Set up transcription callback for query processing
    user.transcription.setOnQueryReady(async (query, speakerId, prePhoto, isVisual) => {
      await user.queryProcessor.processQuery(query, speakerId, prePhoto, isVisual);
    });

    // Wire up location updates
    session.events.onLocation((locationData) => {
      user.location.updateCoordinates(locationData.lat, locationData.lng);
    });

    // Wire up phone notifications
    session.events.onPhoneNotifications((notifications) => {
      if (Array.isArray(notifications)) {
        user.notifications.addNotifications(notifications);
      } else if (notifications) {
        user.notifications.addNotification(notifications);
      }
    });

    // Wire up timezone from SDK settings
    const userTimezone = session.settings.getMentraOS<string>('userTimezone');
    if (userTimezone) {
      user.location.setTimezone(userTimezone);
      console.log(`🕐 Set timezone: ${userTimezone}`);
    }

    // Listen for timezone changes
    session.settings.onMentraosChange<string>('userTimezone', (newTimezone) => {
      if (newTimezone) {
        user.location.setTimezone(newTimezone);
        console.log(`🕐 Updated timezone: ${newTimezone}`);
      }
    });

    // Track device model — arrives async via DEVICE_STATE_UPDATE
    session.device.state.modelName.onChange((newModel) => {
      if (newModel) {
        user.glassesModel = newModel;
        console.log(`📱 Device model: ${newModel} for ${userId} (camera: ${user.isCameraGlasses})`);
      }
    });

    // DEBUG: Check if modelName.value populates after 10s
    setTimeout(() => {
      const delayedModel = session.device.state.modelName.value;
      console.log(`🧪 [DEBUG] modelName.value after 10s: ${delayedModel ?? 'STILL NULL'} for ${userId}`);
    }, 10000);

    // Play welcome message — skip on reconnect (user already knows the app is running)
    if (!wasReconnect) {
      this.playWelcome(session, sessionId);
    }

    // Notify frontend that glasses session is active
    const hasDisplay = session.capabilities?.hasDisplay ?? false;
    if (wasReconnect) {
      broadcastChatEvent(userId, {
        type: "session_reconnected",
        glassesType: hasDisplay ? "display" : "camera",
        timestamp: new Date().toISOString(),
      });
      console.log(`🔄 Mentra AI reconnected for ${userId}`);
    } else {
      broadcastChatEvent(userId, {
        type: "session_started",
        glassesType: hasDisplay ? "display" : "camera",
        timestamp: new Date().toISOString(),
      });
      console.log(`✅ Mentra AI ready for ${userId}`);
    }
  }

  /**
   * Play the welcome message on supported glasses.
   *
   * HUD glasses get a text-wall greeting. Camera-only glasses get nothing
   * for now — the previous welcome-audio path was disabled (the inner
   * playAudio call was commented out) because it conflicted with the
   * camera shutter sound on Mentra Live.
   */
  private playWelcome(session: AppSession, sessionId: string): void {
    const hasDisplay = session.capabilities?.hasDisplay ?? false;

    if (hasDisplay) {
      session.layouts.showTextWall(
        "Mentra AI\n\nWelcome to Mentra AI.\nSay \"Hey Mentra\" followed by your question.",
        { durationMs: 3000 }
      );
    }
  }

  /**
   * Called when a user closes the app or disconnects.
   * Uses a grace period — keeps the User alive for 60s so a quick
   * reconnect preserves conversation history and all state.
   */
  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    console.log(`👋 Mentra AI session disconnected for ${userId}: ${reason}`);

    // Notify frontend — session is reconnecting, NOT ended (keep messages)
    broadcastChatEvent(userId, {
      type: "session_reconnecting",
      reason,
      timestamp: new Date().toISOString(),
    });

    try {
      // Soft remove: detach glasses, start 60s grace period timer
      // Do NOT clearPendingEvents — preserve them for potential reconnect
      sessions.softRemove(userId);
    } catch (err) {
      console.error(`Error during session soft remove for ${userId}:`, err);
    }
  }
}

/**
 * Create and configure the Mentra AI server
 */
export async function createMentraAIServer(config: MentraAIConfig): Promise<MentraAI> {
  // Connect to MongoDB
  await connectDB();

  // Create server
  const server = new MentraAI(config);

  return server;
}
