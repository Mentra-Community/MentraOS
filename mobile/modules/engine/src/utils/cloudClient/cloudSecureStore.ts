/**
 * MMKV-backed KeyValueStore for @mentra/cloud-client — moved into engine so
 * engine owns the cloud-v2 credential storage (the v2 refresh token, so a
 * relaunch does not force a new login). A dedicated MMKV instance keeps
 * cloud-v2 credentials out of the app's general store. Re-exported through the
 * host's `@/utils/cloudClient/MmkvSecureStore` shim.
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
    // react-native-mmkv v4's instance method is `remove`, not `delete`.
    store.remove(key)
  },
}
