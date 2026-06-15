/**
 * AudioManager — spoken output + UI cue sounds via the glasses speaker.
 *
 * Replaces the cloud app's bespoke TTS-over-HTTP plumbing (which derived a
 * cloud /api/tts URL and played it on a track). The local SDK exposes
 * `speaker.speak(text)` directly: the phone uses an offline TTS model when
 * available, else falls back to cloud TTS — all handled host-side.
 *
 * Also owns the two UI cue sounds the cloud app played via playAudio of
 * server-hosted MP3s. Here those MP3s are bundled as data URLs (see
 * lib/sounds.ts) and played through speaker.play():
 *   - the activation cue (start) on wake-word detection
 *   - the processing loop (popping) while a query is in flight
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import {PROCESSING_SOUND_URL, START_SOUND_URL} from "../lib/sounds"

export class AudioManager {
  private processingSoundLooping = false

  constructor(private readonly session: MiniappSession) {}

  private get hasSpeaker(): boolean {
    return Boolean(this.session.capabilities?.hasSpeaker)
  }

  /** Speak text aloud. Resolves when playback completes (or no-ops without a speaker). */
  async speak(text: string): Promise<void> {
    if (!this.hasSpeaker) return
    if (!text.trim()) return
    try {
      await this.session.speaker.speak(text, {stopOtherAudio: true})
    } catch (error) {
      console.warn("speaker.speak failed:", error)
    }
  }

  /**
   * Play the short activation cue the instant the wake word fires, so the
   * wearer hears that we're listening. Fire-and-forget.
   */
  playStartSound(): void {
    if (!this.hasSpeaker) {
      console.log("🔇 start cue skipped — no speaker (display-only glasses)")
      return
    }
    console.log("🔔 playing activation cue")
    this.session.speaker.play({audioUrl: START_SOUND_URL}).catch((err) => {
      console.debug("Start sound failed:", err)
    })
  }

  /**
   * Begin looping the processing sound until stopProcessingSound() is called.
   * No-ops without a speaker. The loop replays the clip back-to-back since
   * play() resolves when each playback completes (mirrors the cloud loop).
   */
  startProcessingSound(): void {
    if (!this.hasSpeaker) {
      console.log("🔇 processing loop skipped — no speaker (display-only glasses)")
      return
    }
    if (this.processingSoundLooping) return
    console.log("🔁 starting processing loop")
    this.processingSoundLooping = true
    void this.loopProcessingSound()
  }

  private async loopProcessingSound(): Promise<void> {
    while (this.processingSoundLooping) {
      try {
        await this.session.speaker.play({audioUrl: PROCESSING_SOUND_URL})
      } catch {
        break
      }
    }
  }

  /** Stop the processing-sound loop. */
  stopProcessingSound(): void {
    this.processingSoundLooping = false
  }

  /** Stop any audio this miniapp is currently playing. */
  stop(): void {
    this.processingSoundLooping = false
    try {
      this.session.speaker.stop()
    } catch {
      /* ignore */
    }
  }
}
