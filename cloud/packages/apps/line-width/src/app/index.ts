import path from "path"

import {AppServer, AppSession} from "@mentra/sdk"

import {UserSession} from "./session/UserSession"

/**
 * LineWidthApp - Debug application for testing text width on G1 glasses
 *
 * This app combines:
 * 1. Manual text testing (presets, custom text)
 * 2. Random text stress testing
 * 3. Live transcription with diarization
 *
 * Uses the same session architecture as captions app for transcription support.
 */
export class LineWidthApp extends AppServer {
  constructor(config: {packageName: string; apiKey: string; port: number; publicDir?: string}) {
    super({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port,
      publicDir: path.join(__dirname, "./public"),
    })
  }

  /**
   * Called by AppServer when a new session is created
   */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n📐 New Line Width session for user ${userId}, session ${sessionId}\n`)

    const userSession = new UserSession(session)

    try {
      await userSession.initialize()
      console.log(`✅ Session initialized for user ${userId}`)
    } catch (error) {
      console.error("❌ Error initializing session:", error)
      // UserSession.initialize() handles its own fallback subscription
    }
  }

  /**
   * Called by AppServer when a session is stopped
   */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} stopped: ${reason}`)
    UserSession.getUserSession(userId)?.dispose()
  }

  /**
   * Get an active session by user ID
   */
  getSession(userId: string): AppSession | undefined {
    return UserSession.getUserSession(userId)?.appSession
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): Map<string, AppSession> {
    const sessions = new Map<string, AppSession>()
    for (const [userId, userSession] of UserSession.userSessions) {
      sessions.set(userId, userSession.appSession)
    }
    return sessions
  }

  /**
   * Send text to a user's glasses for testing
   */
  async sendTestText(userId: string, text: string): Promise<boolean> {
    const userSession = UserSession.getUserSession(userId)
    if (!userSession) {
      console.log(`[LineWidthApp] No active session for user ${userId}`)
      return false
    }

    try {
      await userSession.appSession.layouts.showTextWall(text)
      console.log(`[LineWidthApp] Sent text to ${userId}: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`)
      return true
    } catch (error) {
      console.error(`[LineWidthApp] Error sending text to ${userId}:`, error)
      return false
    }
  }
}

// Also export as LiveCaptionsApp for backwards compatibility
export {LineWidthApp as LiveCaptionsApp}
