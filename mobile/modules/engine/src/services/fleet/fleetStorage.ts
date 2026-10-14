/**
 * The Mentra App's Fleet storage: one named MMKV instance, `mentra-fleet`.
 *
 * Logout runs `storage.clearAll()` on the default instance. The Fleet queue, the phone's device ID and the
 * provisional glasses bindings must outlive it (the queue holds one account's records until they reach that
 * account's Core), so they live in an instance of their own that logout does not touch.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"
import type {FleetKeyValueStore} from "./fleetQueue"

export const FLEET_STORE_ID = "mentra-fleet"

let fleetStore: MMKV | undefined

/** The `mentra-fleet` instance, opened on first use. */
export function getFleetStore(): FleetKeyValueStore {
  return (fleetStore ??= createMMKV({id: FLEET_STORE_ID}))
}
