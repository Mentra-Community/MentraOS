/**
 * Pairing projection — the inbound native events pairing reads, relayed into the engine stores:
 * the identity echo (`save_setting`, which promotes a pending selection to `paired`), the Mentra
 * Live pairing state, and the audio setup the Bluetooth SDK decides.
 *
 * The device-event router starts it with the full runtime; the pairing flow starts it alone for a
 * Bluetooth-only host that never calls `engine.start()`. Idempotent.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore} from "../stores/settings"
import {retirePendingSelectionOnPromotion} from "./PairingIdentity"

let subs: Array<{remove: () => void}> = []

export function startPairingProjection(): void {
  if (subs.length) return

  // Hardware-originated setting changes (user changes a setting ON the glasses, or native promotes
  // the identity at pairing success) → store. The inbound complement to GlassesSettingsSync.
  subs.push(
    BluetoothSdk.addListener("save_setting", async (event) => {
      const settings = useSettingsStore.getState()
      // Damp the relay: native re-echoes some settings unconditionally (e.g.
      // the identity block at every handleDeviceReady) — a same-value echo
      // must not become a store write (persistence churn + change-push noise).
      if (settings.getSetting(event.key) !== event.value) {
        await settings.setSetting(event.key, event.value)
      }
      // Two-phase identity: a promoted default retires the pending selection
      // marker. The rule lives with PairingIdentity (a no-op for other keys).
      await retirePendingSelectionOnPromotion(event.key, event.value)
    }),
  )

  // Mentra Live pairing state is owned by the Bluetooth SDK (`normal`, `pairing_mode`,
  // `pairing_rejected`). The engine only mirrors it into the glasses store so the app renders
  // from one source: the pairing-mode popup, and the Pair Again card.
  subs.push(
    BluetoothSdk.addListener("pairing_state_changed", (event) => {
      useGlassesStore.getState().setGlassesInfo({pairingState: event.state})
    }),
  )

  // Whether the user has to do anything for glasses audio is decided by the Bluetooth SDK. The
  // engine mirrors it; the pairing flow and Home render Pair Audio from it.
  subs.push(
    BluetoothSdk.addListener("audio_setup_changed", (event) => {
      useGlassesStore.getState().setGlassesInfo({audioSetup: event.state})
    }),
  )
}

export function stopPairingProjection(): void {
  for (const sub of subs) sub.remove()
  subs = []
}
