import path from "path"

import {AppServer, AppSession} from "@mentra/sdk"

import {UserSession} from "./session/UserSession"

/**
 * PhotoTestApp - Continuously takes photos and displays them in webview
 */
export class PhotoTestApp extends AppServer {
  constructor(config: {packageName: string; apiKey: string; port: number}) {
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
    console.log(`\n📸 New session for user ${userId}, session ${sessionId}\n`)

    const userSession = new UserSession(session, userId, sessionId)

    try {
      await userSession.initialize()
      console.log(`✅ Session initialized for user ${userId}`)
    } catch (error) {
      console.error("❌ Error initializing session:", error)
    }
  }

  /**
   * Called by AppServer when a session is stopped
   */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} stopped: ${reason}`)

    const userSession = UserSession.getUserSessionIfMatches(userId, sessionId)
    if (userSession) {
      userSession.dispose()
    } else {
      console.log(`[onStop] Ignoring stale onStop for ${userId} - session ${sessionId} no longer active`)
    }
  }
}
