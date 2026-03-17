import {getBridge} from "./bridge"
import type {
  TranscriptionOptions,
  AudioOptions,
  MovementOptions,
  SubscriptionHandler,
  TranscriptionPayload,
  AudioPayload,
  MovementPayload,
} from "./types"

/**
 * Events module for subscribing to MentraOS events
 */
export class Events {
  /**
   * Request transcription events from the smartglasses
   * @param options - Transcription options (online/local, fallback)
   * @param handler - Callback function to handle transcription text
   */
  requestTranscriptions(options: TranscriptionOptions, handler: SubscriptionHandler<string>): void {
    const bridge = getBridge()

    // Subscribe to transcription events
    bridge.subscribe("transcription", (payload: TranscriptionPayload) => {
      handler(payload.message)
    })

    // Send subscription request to native
    bridge.send({
      type: "sub_transcription",
      payload: options,
    })
  }

  /**
   * Request audio stream events from the smartglasses
   * @param options - Audio options (sample rate, channels)
   * @param handler - Callback function to handle audio data
   */
  requestAudio(options: AudioOptions, handler: SubscriptionHandler<AudioPayload>): void {
    const bridge = getBridge()

    // Subscribe to audio events
    bridge.subscribe("audio", handler)

    // Send subscription request to native
    bridge.send({
      type: "sub_audio",
      payload: options,
    })
  }

  /**
   * Request movement/IMU events from the smartglasses
   * @param options - Movement options (frequency)
   * @param handler - Callback function to handle movement data
   */
  requestMovement(options: MovementOptions, handler: SubscriptionHandler<MovementPayload>): void {
    const bridge = getBridge()

    // Subscribe to movement events
    bridge.subscribe("movement", handler)

    // Send subscription request to native
    bridge.send({
      type: "sub_movement",
      payload: options,
    })
  }

  /**
   * Unsubscribe from transcription events
   */
  stopTranscriptions(): void {
    const bridge = getBridge()
    bridge.unsubscribe("transcription")
    bridge.send({
      type: "unsub_transcription",
    })
  }

  /**
   * Unsubscribe from audio events
   */
  stopAudio(): void {
    const bridge = getBridge()
    bridge.unsubscribe("audio")
    bridge.send({
      type: "unsub_audio",
    })
  }

  /**
   * Unsubscribe from movement events
   */
  stopMovement(): void {
    const bridge = getBridge()
    bridge.unsubscribe("movement")
    bridge.send({
      type: "unsub_movement",
    })
  }
}

// Global events instance
let eventsInstance: Events | null = null

/**
 * Get the global Events instance
 */
export function getEvents(): Events {
  if (!eventsInstance) {
    eventsInstance = new Events()
  }
  return eventsInstance
}
