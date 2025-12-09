/**
 * Captions App - Exportable AppServer Class
 *
 * This class wraps the MentraOS AppServer and can be:
 * - Run standalone (via src/index.ts)
 * - Imported and controlled programmatically from other code
 */

import {AppServer, AppSession} from "@mentra/sdk"

export class CaptionsApp extends AppServer {
  /**
   * Handle new session connections
   * @param session - The app session instance
   * @param sessionId - Unique identifier for this session
   * @param userId - The user ID for this session
   */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    session.logger.info(`New session: ${sessionId} for user ${userId}`)

    // Display "Hello, World!" on the glasses
    session.layouts.showTextWall("Hello, World!")

    // Log when the session is disconnected
    session.events.onDisconnected(() => {
      session.logger.info(`Session ${sessionId} disconnected.`)
    })
  }
}
