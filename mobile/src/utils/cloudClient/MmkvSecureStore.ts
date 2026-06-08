/**
 * @fileoverview MMKV-backed KeyValueStore for @mentra/cloud-client.
 *
 * Holds the v2 refresh token so a relaunch does not force a new login. A
 * dedicated MMKV instance keeps cloud-v2 credentials out of the app's general
 * store.
 *
 * NOTE: MMKV is not hardware-backed. Before production handling of the
 * long-lived refresh token, swap this for a Keychain/Keystore-backed store
 * (react-native-keychain). It is fine for dev / simulator e2e.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"
import type {KeyValueStore} from "@mentra/cloud-client"

const store: MMKV = createMMKV({id: "mentra-cloud-v2"})

export const cloudSecureStore: KeyValueStore = {
  async get(key: string): Promise<string | null> {
    return store.getString(key) ?? null
  },
  async set(key: string, value: string): Promise<void> {
    store.set(key, value)
  },
  async delete(key: string): Promise<void> {
    store.delete(key)
  },
}
