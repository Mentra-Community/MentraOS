import type { UserSession } from "../UserSession"

/**
 * AudioManager — text-to-speech and audio control for a single user.
 */
export class AudioManager {
  constructor(private userSession: UserSession) {}

  /** Speak text aloud on the glasses */
  async speak(text: string): Promise<void> {
    const session = this.userSession.appSession
    if (!session) throw new Error("No active glasses session")
    await session.audio.speak(text)
  }

  /** Stop any currently playing audio */
  async stopAudio(): Promise<void> {
    const session = this.userSession.appSession
    if (!session) throw new Error("No active glasses session")
    await session.audio.stopAudio()
  }
}
