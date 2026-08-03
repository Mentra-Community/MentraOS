/**
 * PairingIdentity — the pairing-identity lifecycle, reified. The two-phase
 * identity rules (see the pending/default group in stores/settings.ts) exist
 * as a three-state machine over the identity settings keys:
 *
 *   none ──markPendingSelection()──▶ pending ──native promotion──▶ paired
 *                                       ▲                            │
 *                                       └───────boot demotion────────┘
 *
 * - `none`    — no model ever selected: hosts route to model selection.
 * - `pending` — a model was CHOSEN (the one JS-owned identity write, made at
 *               scan entry) but pairing never completed: hosts render
 *               finish-pairing affordances.
 * - `paired`  — the native layer promoted the identity at pairing success
 *               (handleDeviceReady) and echoed it down via save_setting:
 *               hosts render the device card / connect surfaces.
 *
 * Projection law, mirroring native currentDefaultDevice() on both platforms:
 * `paired` requires default_wearable AND device_name; device_address is
 * optional. Two read-time alignments with the demotion's own write rules:
 * - The simulated device is its own identity (its name mirrors the model at
 *   connectSimulated, and the boot demotion never touches it), so a simulated
 *   default_wearable projects as `paired` even without a device_name echo.
 * - A non-simulated default_wearable WITHOUT a device_name is the orphan
 *   population `demoteOrphanedDefaultWearable` repairs into pending_wearable
 *   at boot; the projection already reads it as `pending` (a fresher
 *   pending_wearable wins, matching the demotion's latest-selection-wins
 *   backfill).
 *
 * JS-initiated identity writes live here and only here — the scan screen
 * (markPendingSelection), the device-event router (promotion retires the
 * pending marker), and the boot demotion (demoteDefaultToPending) invoke
 * these methods instead of writing the raw keys. The router's generic
 * save_setting persistence is the inbound native→JS echo leg, not a
 * JS-initiated write, and stays with the router.
 */
import {result as Res, type AsyncResult} from "typesafe-ts"

import {useSettingsStore, SETTINGS} from "../stores/settings"
import {DeviceTypes} from "../types"

export type IdentitySnapshot =
  | {kind: "none"}
  | {kind: "pending"; model: string}
  | {kind: "paired"; model: string; name: string; address?: string}

// Identity keys hold model/name strings; anything else (legacy null, a stray
// non-string) reads as absent, matching native currentDefaultDevice()'s
// blank checks.
function readIdentityString(key: string): string {
  const value = useSettingsStore.getState().getSetting(key)
  return typeof value === "string" ? value : ""
}

/** Project the identity settings keys into the lifecycle snapshot. */
export function projectPairingIdentity(): IdentitySnapshot {
  const model = readIdentityString(SETTINGS.default_wearable.key)
  const name = readIdentityString(SETTINGS.device_name.key)

  if (model && name) {
    const address = readIdentityString(SETTINGS.device_address.key)
    return address ? {kind: "paired", model, name, address} : {kind: "paired", model, name}
  }
  if (model && model.includes(DeviceTypes.SIMULATED)) {
    return {kind: "paired", model, name: model}
  }
  const pending = readIdentityString(SETTINGS.pending_wearable.key)
  if (pending) return {kind: "pending", model: pending}
  if (model) return {kind: "pending", model}
  return {kind: "none"}
}

/**
 * Subscribe to identity changes, deduped on the projected snapshot (same
 * style as glasses.onStatus): the settings store updates on many keys; the
 * callback fires only when the identity snapshot actually changes.
 */
export function subscribePairingIdentity(cb: (identity: IdentitySnapshot) => void): () => void {
  let last = JSON.stringify(projectPairingIdentity())
  return useSettingsStore.subscribe(() => {
    const snap = projectPairingIdentity()
    const key = JSON.stringify(snap)
    if (key === last) return
    last = key
    cb(snap)
  })
}

/**
 * Selection: mark the model the user chose as the PENDING wearable (written
 * at scan entry). Promotion to `paired` only ever happens natively at pairing
 * success. The marker persists so an abandoned selection still renders its
 * finish-pairing card after an app restart.
 */
export function markPendingSelection(model: string): AsyncResult<void, Error> {
  // Guard the public write-path: an empty/whitespace model would persist a
  // pending identity that renders a blank finish-pairing card.
  const trimmed = typeof model === "string" ? model.trim() : ""
  if (!trimmed) {
    console.warn(`PairingIdentity: ignoring pending selection with empty model (got ${JSON.stringify(model)})`)
    return Res.try_async(async () => {})
  }
  console.log(`PairingIdentity: pending selection -> "${trimmed}"`)
  const result = useSettingsStore.getState().setSetting(SETTINGS.pending_wearable.key, trimmed)
  // setSetting resolves to a Result (never rejects); a persist failure would
  // silently drop the finish-pairing affordance on restart — surface it.
  void Promise.resolve(result).then((r) => {
    if (r.is_error()) console.warn("PairingIdentity: pending selection failed to persist:", r.error)
  })
  return result
}

/**
 * Promotion retires the selection: when the native layer promotes the default
 * wearable at pairing success and its save_setting echo lands, the pending
 * marker has served its purpose. Invoked by DeviceEventRouter for every echo;
 * a no-op for other keys, empty promotions, and an already-clear marker.
 */
export async function retirePendingSelectionOnPromotion(echoedKey: string, echoedValue: unknown): Promise<void> {
  if (echoedKey !== SETTINGS.default_wearable.key || !echoedValue) return
  const settings = useSettingsStore.getState()
  const pending = settings.getSetting(SETTINGS.pending_wearable.key)
  if (pending) {
    console.log(`PairingIdentity: promotion "${String(echoedValue)}" retires pending "${pending}"`)
    await settings.setSetting(SETTINGS.pending_wearable.key, "")
  }
}

/**
 * Demotion: turn an orphaned default identity back into a pending selection.
 * The guards (hydration, the native default-device read, link-layer state)
 * live with the boot repair in demoteOrphanedDefaultWearable — this is only
 * the identity write set: backfill the pending marker unless a fresher
 * selection already holds it (the user's LATEST selection wins), then clear
 * the promoted identity triplet.
 */
export async function demoteDefaultToPending(model: string): Promise<void> {
  const settings = useSettingsStore.getState()
  // readIdentityString, not raw getSetting: a truthy non-string legacy value
  // must read as absent here too, or the orphaned model is never backfilled
  // while the projection reads the same junk as no pending at all.
  const fresher = readIdentityString(SETTINGS.pending_wearable.key)
  console.log(
    fresher
      ? `PairingIdentity: demote "${model}" — fresher pending "${fresher}" kept`
      : `PairingIdentity: demote "${model}" -> pending`,
  )
  if (!fresher) {
    await settings.setSetting(SETTINGS.pending_wearable.key, model)
  }
  await settings.setSetting(SETTINGS.default_wearable.key, "")
  await settings.setSetting(SETTINGS.device_name.key, "")
  await settings.setSetting(SETTINGS.device_address.key, "")
}
