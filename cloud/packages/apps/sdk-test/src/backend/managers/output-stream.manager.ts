import type {AudioOutputStream} from "@mentra/sdk"
import type {UserSession} from "../UserSession"

export type OutputStreamOwner = "realtime" | "tone"

/**
 * Owns a single shared AudioOutputStream per user.
 * Realtime and tone must explicitly claim/release ownership.
 */
export class OutputStreamManager {
  private stream: AudioOutputStream | null = null
  private owner: OutputStreamOwner | null = null

  constructor(private userSession: UserSession) {}

  get currentOwner(): OutputStreamOwner | null {
    return this.owner
  }

  isOwnedBy(owner: OutputStreamOwner): boolean {
    return this.owner === owner
  }

  getActiveStream(): AudioOutputStream | null {
    if (this.stream && this.stream.state === "streaming") {
      return this.stream
    }
    return null
  }

  async claim(owner: OutputStreamOwner): Promise<AudioOutputStream> {
    if (this.owner && this.owner !== owner) {
      const error = new Error(`AUDIO_OUTPUT_BUSY: Stream is currently owned by ${this.owner}`) as Error & {code?: string}
      error.code = "AUDIO_OUTPUT_BUSY"
      throw error
    }

    const existing = this.getActiveStream()
    if (existing) {
      this.owner = owner
      return existing
    }

    const session = this.userSession.appSession
    if (!session) {
      throw new Error("No active glasses session")
    }

    const stream = await session.audio.createOutputStream({
      format: "pcm16",
      sampleRate: 24000,
      channels: 1,
      bitrate: 64,
      trackId: 1,
      stopOtherAudio: true,
    })

    this.stream = stream
    this.owner = owner

    stream.on("close", () => {
      if (this.stream === stream) {
        this.stream = null
        this.owner = null
      }
    })

    return stream
  }

  async release(owner: OutputStreamOwner, endStream: boolean = true): Promise<void> {
    if (this.owner !== owner) return

    this.owner = null

    if (!endStream) return

    const stream = this.getActiveStream()
    this.stream = null
    if (!stream) return

    try {
      await stream.end()
    } catch {
      // Stream already ended
    }
  }

  async dispose(): Promise<void> {
    this.owner = null
    const stream = this.getActiveStream()
    this.stream = null
    if (!stream) return

    try {
      await stream.end()
    } catch {
      // Stream already ended
    }
  }
}
