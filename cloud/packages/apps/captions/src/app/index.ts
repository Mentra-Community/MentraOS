import path from "path"

import {AppServer, AppSession} from "@mentra/sdk"

import {UserSession} from "./session/UserSession"

/**
 * LiveCaptionsApp - Main application class that extends AppServer
 *
 * This is a minimal entry point that delegates all logic to the UserSession
 * and its managers (TranscriptsManager, SettingsManager, DisplayManager).
 */
export class LiveCaptionsApp extends AppServer {
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
    console.log(`\n\n🗣️🗣️🗣️ New session for user ${userId}, session ${sessionId}\n\n`)

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
}
