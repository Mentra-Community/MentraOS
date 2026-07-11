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

export function startAudioCloudUplink(): void {
  if (sub) return
  sub = BluetoothSdk.addListener("mic_lc3", (event) => {
    if (cloudClientService.isConnected() && cloudClientService.hasAudioSubscriptions()) {
      cloudClientService.sendAudioFrame(new Uint8Array(event.lc3))
    }
  })
}

export function stopAudioCloudUplink(): void {
  sub?.remove()
  sub = null
}
