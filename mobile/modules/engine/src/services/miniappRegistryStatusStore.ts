/**
 * Where the miniapp updater keeps Core's last registry status answer, under `miniapp_registry_status:v1`.
 *
 * Logout clears the default MMKV instance. An archived URL must stay archived across a sign-out, as the installed
 * miniapps and their metadata stay, so the answer lives in an instance of its own that logout doesn't touch.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"

import {REGISTRY_STATUS_KEY, type RegistryStatusStore} from "./miniappUrlUpdates"

export const MINIAPP_REGISTRY_STORE_ID = "mentra-miniapp-registry"

let store: MMKV | undefined

function open(): MMKV {
  return (store ??= createMMKV({id: MINIAPP_REGISTRY_STORE_ID}))
}

export const registryStatusStore: RegistryStatusStore = {
  get: () => open().getString(REGISTRY_STATUS_KEY),
  set: (value) => open().set(REGISTRY_STATUS_KEY, value),
}
