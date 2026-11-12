/**
 * The `KeyValueStore` @mentra/cloud-client persists its Cloud V2 refresh tokens in (one per deployment), so a
 * relaunch does not force a new login. The engine owns it.
 *
 * The tokens live in the platform secure store (Keychain / Keystore-backed). Earlier builds kept them in the
 * dedicated `mentra-cloud-v2` MMKV instance, which held nothing else; the vault moves them out once.
 */
import {createPlatformCredentialVault, mmkvLegacyCredentials} from "../credentials/platform"

/** The MMKV instance earlier builds kept the refresh tokens in. */
const LEGACY_MMKV_ID = "mentra-cloud-v2"

export const cloudSecureStore = createPlatformCredentialVault(
  "cloud",
  mmkvLegacyCredentials({id: LEGACY_MMKV_ID, keys: "every key", encoding: "raw"}),
)
