/**
 * MicStateCoordinator
 *
 * Unions cloud-driven and local-miniapp-driven microphone requirements.
 *
 * The cloud sends mic state changes via SocketComms (e.g., "pcm", "transcription").
 * Local miniapps subscribe to audio_chunk / transcription streams.
 * This coordinator merges both sets of requirements and pushes the union to
 * CoreModule so the mic runs whenever at least one consumer needs it.
 */

import CoreModule from "@mentra/bluetooth-sdk"

const LOG_TAG = "MIC_COORDINATOR"

class MicStateCoordinator {
  private static instance: MicStateCoordinator | null = null

  // Cloud requirements (set by SocketComms on mic_state_change)
  private cloudWantsPcm = false
  private cloudWantsLc3 = false
  private cloudWantsTranscript = false
  private cloudBypassVad = false

  // Local miniapp requirements (set when miniapps subscribe to audio streams)
  private localWantsPcm = false
  private localWantsLc3 = false

  private constructor() {}

  public static getInstance(): MicStateCoordinator {
    if (!MicStateCoordinator.instance) {
      MicStateCoordinator.instance = new MicStateCoordinator()
    }
    return MicStateCoordinator.instance
  }

  /**
   * Update cloud-side requirements. Called by SocketComms when the cloud
   * sends a mic_state_change message.
   */
  public setCloudRequirements(req: {pcm: boolean; lc3: boolean; transcript: boolean; bypass_vad: boolean}): void {
    this.cloudWantsPcm = req.pcm
    this.cloudWantsLc3 = req.lc3
    this.cloudWantsTranscript = req.transcript
    this.cloudBypassVad = req.bypass_vad
    // console.log(
    //   `${LOG_TAG}: cloud requirements updated — pcm=${req.pcm} lc3=${req.lc3} transcript=${req.transcript} bypass_vad=${req.bypass_vad}`,
    // )
    this.applyUnion()
  }

  /**
   * Update local miniapp requirements. Called by LocalMiniappRuntime when
   * the aggregated set of local subscriptions changes.
   */
  public setLocalRequirements(req: {pcm: boolean; lc3: boolean}): void {
    this.localWantsPcm = req.pcm
    this.localWantsLc3 = req.lc3
    console.log(`${LOG_TAG}: local requirements updated — pcm=${req.pcm} lc3=${req.lc3}`)
    this.applyUnion()
  }

  /**
   * Compute the union of cloud and local requirements and push to CoreModule.
   *
   * Wire-format note: the cloud only ever receives LC3 over the binary
   * WebSocket. Its `requiredData=["pcm"]` is a logical "I need audio"
   * request — we always answer it with LC3. So neither cloudWantsPcm nor
   * cloudWantsLc3 ever flips `should_send_pcm` on; both map to
   * `should_send_lc3`. `should_send_pcm` is strictly for on-device PCM
   * consumers (local miniapps' audio_chunk listeners and Sherpa STT).
   */
  private applyUnion(): void {
    const shouldSendPcm = this.localWantsPcm
    const shouldSendLc3 = this.cloudWantsPcm || this.cloudWantsLc3 || this.localWantsLc3
    const shouldSendTranscript = this.cloudWantsTranscript
    const bypassVad = this.cloudBypassVad

    // console.log(
    //   `${LOG_TAG}: applying union — pcm=${shouldSendPcm} lc3=${shouldSendLc3} transcript=${shouldSendTranscript} bypass_vad=${bypassVad}`,
    // )

    CoreModule.update("core", {
      should_send_pcm: shouldSendPcm,
      should_send_lc3: shouldSendLc3,
      should_send_transcript: shouldSendTranscript,
      bypass_vad: bypassVad,
    })
  }

  /**
   * Reset all requirements to off. Called during cleanup.
   */
  public reset(): void {
    this.cloudWantsPcm = false
    this.cloudWantsLc3 = false
    this.cloudWantsTranscript = false
    this.cloudBypassVad = false
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
