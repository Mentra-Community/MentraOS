/**
 * Audio cloud uplink — island-owned. Subscribes to the glasses' `mic_lc3` BLE frames
 * and forwards each one to the v2 cloud session (`cloud.sendAudioFrame`), gated on the
 * cloud being connected AND having active audio subscriptions so we don't burn the
 * UDP/encrypt path when nothing upstream is listening.
 *
 * This is the device→cloud audio data-plane for the v2 runtime. It used to live in the
 * host's MantleManager `mic_lc3` handler (the "cloud fork"); moved here so ANY host —
 * including a bare OEM that never runs the v1 SocketComms plane — gets cloud
 * transcription/translation, not just the first-party Mentra app.
 *
 * The v1 legs of the old handler (UDP / SocketComms WebSocket + the on-device PCM fan-out
 * + the debug-store mic-activity flag) stay in MantleManager — they are Mentra-app v1
 * concerns and get deleted at v1 retirement. Only this v2 cloud fork moved.
 *
 * Started by `toolkit.start()`. Idempotent.
 */
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
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
