import path from "path";

import { AppServer, AppSession } from "@mentra/sdk";

import { UserSession } from "./session/UserSession";

/**
 * LiveCaptionsApp - Main application class that extends AppServer
 *
 * This is a minimal entry point that delegates all logic to the UserSession
 * and its managers (TranscriptsManager, SettingsManager, DisplayManager).
 */
export class LiveCaptionsApp extends AppServer {
  constructor(config: { packageName: string; apiKey: string; port: number; publicDir?: string }) {
    super({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port,
      publicDir: path.join(__dirname, "./public"),
    });
  }

  /**
   * Called by AppServer when a new session is created
   */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n\n🗣️🗣️🗣️ New session for user ${userId}, session ${sessionId}\n\n`);

    const userSession = new UserSession(session);

    try {
      await userSession.initialize();
      console.log(`✅ Session initialized for user ${userId}`);
    } catch (error) {
      console.error("❌ Error initializing session:", error);
      // UserSession.initialize() handles its own fallback subscription
    }
  }

  /**
   * Called by AppServer when a session is stopped
   *
   * IMPORTANT: We use getUserSessionIfMatches() to verify the sessionId matches.
   * This prevents cross-cloud contamination where an old cloud's onStop (after grace period)
   * could dispose a session that has already been replaced by a new cloud connection.
   *
   * See: cloud/issues/006-captions-and-apps-stopping/005-sdk-reconnect-empty-subscriptions-bug.md
   */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} stopped: ${reason}`);

    // Only dispose if sessionId matches current session - prevents stale onStop from old cloud
    const userSession = UserSession.getUserSessionIfMatches(userId, sessionId);
    if (userSession) {
      userSession.dispose();
    } else {
      console.log(`[onStop] Ignoring stale onStop for ${userId} - session ${sessionId} no longer active`);
    }
  }
}
