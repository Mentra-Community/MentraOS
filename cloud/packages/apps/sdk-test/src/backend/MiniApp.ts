/**
 * SdkTestApp — MentraOS AppServer for testing SDK features end-to-end.
 *
 * Exercises: session lifecycle, transcription, audio, photos, errors, version check.
 */

import {AppServer, AppSession} from "@mentra/sdk"
import {UserSession} from "./UserSession"

export interface SdkTestAppConfig {
  packageName: string
  apiKey: string
  port: number
  cookieSecret?: string
}

export class SdkTestApp extends AppServer {
  constructor(config: SdkTestAppConfig) {
    super({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port,
      cookieSecret: config.cookieSecret,
    })
  }

  /** Called when a user launches the app on their glasses */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    const userSession = UserSession.getOrCreate(userId)
    userSession.setAppSession(session)

    // Show connection on glasses
    session.layouts.showTextWall(`SDK Test connected\n${userId}`)
  }

  /** Called when a user closes the app or disconnects */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    UserSession.remove(userId)
  }
}
