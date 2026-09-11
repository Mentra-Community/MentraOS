/**
 * Audio cloud uplink — engine-owned. Subscribes to the glasses' `mic_lc3` BLE frames
 * and forwards each one to the v2 cloud session (`cloud.sendAudioFrame`), gated on the
 * cloud being connected AND having active audio subscriptions so we don't burn the
 * UDP/encrypt path when nothing upstream is listening.
 *
 * This is the device→cloud audio data-plane for the v2 runtime. It used to live in the
 * host's MantleManager `mic_lc3` handler (the "cloud fork"); moved here so ANY host —
 * including a bare OEM that never runs the v1 SocketComms plane — gets cloud
 * transcription/translation, not just the first-party Mentra app.
 *
 * The old v1 UDP/SocketComms upload legs were removed; MantleManager only keeps
 * host-side debug mic-activity tracking and on-device PCM fan-out.
 *
 * Started by `engine.start()`. Idempotent.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {cloudClientService} from "./CloudClientService"

let sub: {remove: () => void} | null = null
const suppressionSources = new Set<string>()

/**
 * Keep the glasses LC3 transport alive while dropping mic audio before cloud
 * STT. Sources are reference-counted by id so overlapping playback cannot
 * reopen the uplink until every active source has released.
 *
 * Suppression is global to the uplink: one source silences STT for every app.
 * That is why no platform path arms it any more (spoken TTS used to, which made
 * every assistant reply punch a hole in Live Translation and Captions). The
 * mechanism stays because it is the right primitive for an explicit,
 * caller-scoped mute; see OS-1741 for the per-app opt-in that will use it.
 */
export function setAudioCloudUplinkSuppressed(sourceId: string, suppressed: boolean): void {
  if (suppressed) suppressionSources.add(sourceId)
  else suppressionSources.delete(sourceId)
}

export function startAudioCloudUplink(): void {
  if (sub) return
  sub = BluetoothSdk.addListener("mic_lc3", (event) => {
    if (
      suppressionSources.size === 0 &&
      cloudClientService.isConnected() &&
      cloudClientService.hasAudioSubscriptions()
    ) {
      cloudClientService.sendAudioFrame(new Uint8Array(event.lc3))
    }
  })
}

export function stopAudioCloudUplink(): void {
  sub?.remove()
  sub = null
  suppressionSources.clear()
}
