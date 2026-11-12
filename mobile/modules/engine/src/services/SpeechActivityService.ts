import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

/**
 * Phone-side voice activity (Silero, native) on demand: on while any miniapp
 * subscribes to `vad`, off otherwise, which releases the model. Transitions
 * arrive as the native `speech_activity` event (see DeviceEventRouter). Native
 * uses its default silence gap; each event carries `silentForMs` so a miniapp
 * applies its own end-of-turn rule.
 */
export class SpeechActivityService {
  private enabled = false
  private chain: Promise<void> = Promise.resolve()

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        // A newer toggle supersedes this one.
        if (this.enabled !== enabled) return
        try {
          await BluetoothSdk.setSpeechActivityDetection(enabled)
        } catch (error) {
          console.warn(`SPEECH_ACTIVITY: could not turn ${enabled ? "on" : "off"} voice detection`, error)
        }
      })
  }
}

export const speechActivityService = new SpeechActivityService()
