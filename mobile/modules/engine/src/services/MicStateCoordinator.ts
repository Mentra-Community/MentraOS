/**
 * MicStateCoordinator
 *
 * Owns local-miniapp-driven microphone requirements.
 *
 * Local miniapps subscribe to audio_chunk / transcription streams.
 * This coordinator pushes the aggregate local requirement set to BluetoothSdk
 * so the mic runs whenever at least one local consumer needs it.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {createDebouncedPatchFlusher} from "../utils/debouncedPatch"

const LOG_TAG = "MIC_COORDINATOR"

/** Mic-requirement flips are debounced (300ms) and merged into one BLE write
 *  (wire v2 keeps BLE JSON small and infrequent). */
const flushMicRequirementsPatch = createDebouncedPatchFlusher<Record<string, unknown>>((patch) => {
  try {
    void Promise.resolve(BluetoothSdk.updateBluetoothSettings(patch)).catch((err) => {
      console.error(`${LOG_TAG}: failed to apply mic requirements:`, err)
    })
  } catch (err) {
    console.error(`${LOG_TAG}: failed to apply mic requirements:`, err)
  }
}, 300)

class MicStateCoordinator {
  private static instance: MicStateCoordinator | null = null

  // Local miniapp requirements (set when miniapps subscribe to audio streams)
  private localWantsPcm = false
  private localWantsLc3 = false
  private configuredVad = true

  private constructor() {}

  public static getInstance(): MicStateCoordinator {
    if (!MicStateCoordinator.instance) {
      MicStateCoordinator.instance = new MicStateCoordinator()
    }
    return MicStateCoordinator.instance
  }

  /**
   * Update local miniapp requirements. Called by LocalMiniappRuntime when
   * the aggregated set of local subscriptions changes.
   */
  public setLocalRequirements(req: {pcm: boolean; lc3: boolean; vadEnabled?: boolean}): void {
    this.localWantsPcm = req.pcm
    this.localWantsLc3 = req.lc3
    if (typeof req.vadEnabled === "boolean") this.configuredVad = req.vadEnabled
    console.log(`${LOG_TAG}: local requirements updated — pcm=${req.pcm} lc3=${req.lc3}`)
    this.applyUnion()
  }

  /**
   * Push local requirements to BluetoothSdk. `should_send_pcm` is strictly for
   * on-device PCM consumers; cloud audio uses LC3 through AudioCloudUplink.
   */
  private applyUnion(): void {
    const shouldSendPcm = this.localWantsPcm
    const shouldSendLc3 = this.localWantsLc3

    // console.log(
    //   `${LOG_TAG}: applying requirements — pcm=${shouldSendPcm} lc3=${shouldSendLc3}`,
    // )

    // The mic control plane is a direct btsdk call now (was a host setMicRequirements
    // hook) so a bare OEM streams audio without wiring it.
    flushMicRequirementsPatch({
      should_send_pcm: shouldSendPcm,
      should_send_lc3: shouldSendLc3,
      should_send_transcript: false,
      // Hardware VAD intentionally suppresses silence. Raw-audio consumers
      // such as Recorder need a continuous PCM timeline, so suspend VAD for
      // the duration of the PCM subscription and restore the user's setting
      // as soon as the last raw consumer unsubscribes.
      voice_activity_detection_enabled: shouldSendPcm ? false : this.configuredVad,
    })
  }

  /**
   * Reset all requirements to off. Called during cleanup.
   */
  public reset(): void {
    this.localWantsPcm = false
    this.localWantsLc3 = false
    this.applyUnion()
  }

  public cleanup(): void {
    console.log(`${LOG_TAG}: cleanup()`)
    this.reset()
    MicStateCoordinator.instance = null
  }
}

const micStateCoordinator = MicStateCoordinator.getInstance()
export default micStateCoordinator
