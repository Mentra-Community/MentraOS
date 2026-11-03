import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {WakeWordEvent} from "@mentra/bluetooth-sdk"

import {ModelRetry} from "./ModelRetry"
import offlineSpeechModelService from "./OfflineSpeechModelService"
import wakeWordModelManager from "./WakeWordModelManager"

const PHRASE = "Hey Mentra"

/**
 * On-device "Hey Mentra" detection on demand. While any miniapp subscribes to
 * `wake_word`, the detector runs with the Speech-page wake-word model
 * (downloaded first if missing); when none does, it is turned off, which
 * releases the model. Events describe only the wake-word model. Audio and
 * inference never cross into JavaScript.
 */
export class WakeWordService {
  private subscribed = false
  private generation = 0
  private chain: Promise<void> = Promise.resolve()
  private readonly retry = new ModelRetry()
  private emit?: (event: WakeWordEvent) => void
  private status: WakeWordEvent = {kind: "loading", phrase: PHRASE, timestamp: Date.now()}

  /** The detector's current state, for a miniapp that just subscribed. */
  currentStatus(): WakeWordEvent {
    return {...this.status}
  }

  /**
   * A native wake-word event. Returns the event to forward to subscribers, or
   * null when nobody should see it (detection is off).
   */
  onNativeEvent(event: WakeWordEvent): WakeWordEvent | null {
    if (!this.subscribed) return null
    if (event.kind === "detected") return event
    this.status = event
    if (event.kind === "error") this.scheduleRetry(this.generation)
    else if (event.kind === "ready") this.retry.reset()
    return event
  }

  setSubscribed(active: boolean, emit: (event: WakeWordEvent) => void): void {
    this.emit = emit
    if (this.subscribed === active) return
    this.subscribed = active
    const generation = ++this.generation
    this.retry.reset()
    if (active) this.publish({kind: "loading", phrase: PHRASE, timestamp: Date.now()})
    this.enqueue(generation, active)
  }

  private enqueue(generation: number, active: boolean): void {
    this.chain = this.chain.catch(() => undefined).then(() => (active ? this.start(generation) : this.stop()))
  }

  private async start(generation: number): Promise<void> {
    const current = () => generation === this.generation && this.subscribed
    if (!current()) return
    if (!(await wakeWordModelManager.isModelAvailable())) {
      this.publish({kind: "loading", phrase: PHRASE, timestamp: Date.now(), message: "Downloading the wake-word model"})
      try {
        await offlineSpeechModelService.downloadWakeWordModel((percent) => {
          if (current()) {
            this.publish({
              kind: "loading",
              phrase: PHRASE,
              timestamp: Date.now(),
              message: `Downloading the wake-word model (${percent}%)`,
            })
          }
        })
      } catch (error) {
        if (current()) this.fail(generation, `Could not download the wake-word model: ${errorMessage(error)}`)
        return
      }
    }
    if (!current()) return
    try {
      // Resolves once the model is loaded and native has sent "ready".
      await BluetoothSdk.setWakeWordDetection(true, wakeWordModelManager.getModelPath())
    } catch (error) {
      // A failed load rejects without a native "error" event; report it here.
      if (current()) this.fail(generation, `Could not start wake-word detection: ${errorMessage(error)}`)
    }
  }

  private async stop(): Promise<void> {
    try {
      await BluetoothSdk.setWakeWordDetection(false)
    } catch (error) {
      console.warn("WAKE_WORD: teardown failed", error)
    }
  }

  private fail(generation: number, message: string): void {
    this.publish({kind: "error", phrase: PHRASE, timestamp: Date.now(), message})
    this.scheduleRetry(generation)
  }

  /** Retry on the shared model schedule while a miniapp still wants the wake word. */
  private scheduleRetry(generation: number): void {
    const delay = this.retry.schedule(() => {
      if (generation !== this.generation || !this.subscribed) return
      this.enqueue(generation, true)
    })
    console.log(`WAKE_WORD: retrying in ${Math.round(delay / 1000)}s`)
  }

  private publish(event: WakeWordEvent): void {
    this.status = event
    if (this.subscribed) this.emit?.(event)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const wakeWordService = new WakeWordService()
