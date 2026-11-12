import {storage} from "@/utils/storage"

const STORAGE_KEY = "mentra_live_pairing_mode_popup_shown"

/** `(deviceId, windowId)` pairs already announced, mapped to the time their window ends. */
type ShownWindows = Record<string, number>

const windowKey = (deviceId: string, windowId: number) => `${deviceId}:${windowId}`

function load(now: number): ShownWindows {
  const res = storage.load<ShownWindows>(STORAGE_KEY)
  const stored = res.is_ok() && res.value && typeof res.value === "object" ? res.value : {}
  // Expired windows can never be shown again, so they never need to be remembered.
  return Object.fromEntries(Object.entries(stored).filter(([, endsAtMs]) => Number(endsAtMs) > now))
}

/** True when the pairing-mode popup was already shown for this device's pairing window. */
export function wasPairingModePopupShown(deviceId: string, windowId: number, now = Date.now()): boolean {
  return windowKey(deviceId, windowId) in load(now)
}

/** Remember the popup for this window until `endsAtMs`. A new `windowId` is a new window. */
export function markPairingModePopupShown(deviceId: string, windowId: number, endsAtMs: number, now = Date.now()) {
  const shown = load(now)
  shown[windowKey(deviceId, windowId)] = endsAtMs
  void storage.save(STORAGE_KEY, shown)
}
