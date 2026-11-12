/**
 * @fileoverview The platform pieces of a credential vault: expo-secure-store for the secure store, and MMKV for
 * the move record and the pre-move copies.
 *
 * expo-secure-store keeps a value in the iOS Keychain, and on Android encrypts it with an AES-256-GCM key held in
 * the Android Keystore before storing the ciphertext in the app's private SharedPreferences. Items are readable
 * after the first unlock since boot (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), so a screen-off or
 * background launch for Bluetooth can still sign in to Core, and they never leave this device in a backup.
 */
import {createMMKV, type MMKV} from "react-native-mmkv"

import {
  createCredentialVault,
  type CredentialVault,
  type LegacyCredentials,
  type MoveRecordStore,
  type SecureItemStore,
} from "./credentialVault"

/** The Keychain service (iOS) and Keystore alias (Android) of every Mentra credential item. */
export const CREDENTIAL_KEYCHAIN_SERVICE = "com.mentra.credentials"

/** The MMKV instance holding only the vaults' move records. Logout's `clearAll()` of the default instance spares it. */
export const CREDENTIAL_MOVE_RECORD_MMKV_ID = "mentra-credentials"

type ExpoSecureStore = typeof import("expo-secure-store")

let secureStoreModule: ExpoSecureStore | null = null

/** Loaded on first use, so importing the engine never touches the native module. */
function expoSecureStore(): ExpoSecureStore {
  secureStoreModule ??= require("expo-secure-store") as ExpoSecureStore
  return secureStoreModule
}

function itemOptions(store: ExpoSecureStore) {
  return {
    keychainService: CREDENTIAL_KEYCHAIN_SERVICE,
    // iOS only; Android Keystore keys without user authentication are usable while the screen is locked.
    keychainAccessible: store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  }
}

export const platformSecureItems: SecureItemStore = {
  getItem(key) {
    const store = expoSecureStore()
    return store.getItemAsync(key, itemOptions(store))
  },
  setItem(key, value) {
    const store = expoSecureStore()
    return store.setItemAsync(key, value, itemOptions(store))
  },
  deleteItem(key) {
    const store = expoSecureStore()
    return store.deleteItemAsync(key, itemOptions(store))
  },
}

let moveRecordStore: MMKV | null = null

export function credentialMoveRecord(): MoveRecordStore {
  moveRecordStore ??= createMMKV({id: CREDENTIAL_MOVE_RECORD_MMKV_ID})
  return moveRecordStore
}

type LegacyMmkv = Pick<MMKV, "getString" | "set" | "remove" | "getAllKeys" | "trim">

/** react-native-mmkv's id for the default instance, which is also its file name. */
const DEFAULT_MMKV_ID = "mmkv.default"

/** Where react-native-mmkv keeps an instance: `Documents/mmkv/<id>` on iOS, `files/mmkv/<id>` on Android. */
function mmkvFileSize(id: string): number | null {
  const {File, Paths} = require("expo-file-system") as typeof import("expo-file-system")
  const file = new File(Paths.document, "mmkv", id)
  return file.exists ? file.size : null
}

/** Never build a filler this large in memory; such a file is not one of ours. */
const MAX_SCRUB_BYTES = 16 * 1024 * 1024
const SCRUB_KEY = "mentra.credentials.scrub"

/**
 * Overwrites what an MMKV file still holds of removed values.
 *
 * MMKV appends: removing a key appends a tombstone, and a full write-back moves the live values to the front without
 * clearing what they leave behind, so a removed token's bytes stay in the file. Writing a value longer than the
 * whole file makes MMKV write back first (the value cannot fit), then write the value over everything past the live
 * values. Removing it and trimming leaves the live values and filler.
 */
function scrubRemovedValues(store: LegacyMmkv, fileSize: number): void {
  store.set(SCRUB_KEY, "0".repeat(fileSize + 1))
  store.remove(SCRUB_KEY)
  store.trim()
}

export interface MmkvLegacyCredentialsOptions {
  /** The MMKV instance id; the default instance when omitted. */
  id?: string
  /** The credential keys, or every key when the instance holds nothing else. */
  keys: readonly string[] | "every key"
  /** `json`: written with the app's `storage.save`, which JSON-encodes. `raw`: the string itself. */
  encoding: "json" | "raw"
  /** Credentials of retired sign-in providers: deleted whenever found, never read. */
  isRetiredKey?: (key: string) => boolean
  /** Tests inject a fake instance and file size. */
  open?: () => LegacyMmkv
  fileSize?: () => number | null
}

/**
 * Decodes one `storage.save` value. Strings come back as themselves. Anything else (a JSON object such as a saved
 * session) is kept as its JSON text, which is what its owner stores in the vault.
 */
function decodeJsonValue(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "string" ? value : raw
  } catch {
    return raw
  }
}

export function mmkvLegacyCredentials(options: MmkvLegacyCredentialsOptions): LegacyCredentials {
  let instance: LegacyMmkv | null = null
  const open = (): LegacyMmkv => {
    instance ??= options.open?.() ?? createMMKV(options.id === undefined ? undefined : {id: options.id})
    return instance
  }
  // The scrub's filler is never a credential, even when a crash left it behind.
  const keys = (): readonly string[] =>
    options.keys === "every key"
      ? open()
          .getAllKeys()
          .filter((key) => key !== SCRUB_KEY)
      : options.keys
  const decode = (raw: string | undefined): string | null => {
    if (raw === undefined || raw === "") return null
    return options.encoding === "json" ? decodeJsonValue(raw) : raw
  }

  return {
    readAll() {
      const copies: Record<string, string> = {}
      for (const key of keys()) {
        const value = decode(open().getString(key))
        if (value !== null) copies[key] = value
      }
      return copies
    },
    get(key) {
      return decode(open().getString(key))
    },
    set(key, value) {
      open().set(key, options.encoding === "json" ? JSON.stringify(value) : value)
    },
    remove(key) {
      open().remove(key)
    },
    hasRetired() {
      const isRetired = options.isRetiredKey
      if (!isRetired) return false
      return open()
        .getAllKeys()
        .some((key) => isRetired(key))
    },
    eraseAll() {
      const store = open()
      for (const key of keys()) store.remove(key)
      store.remove(SCRUB_KEY)
      const isRetired = options.isRetiredKey
      if (!isRetired) return
      for (const key of store.getAllKeys()) {
        if (isRetired(key)) store.remove(key)
      }
    },
    scrub() {
      const fileSize = options.fileSize ? options.fileSize() : mmkvFileSize(options.id ?? DEFAULT_MMKV_ID)
      if (fileSize === null) return false
      if (fileSize > MAX_SCRUB_BYTES) return false
      scrubRemovedValues(open(), fileSize)
      return true
    },
  }
}

/** A vault in the platform secure store whose credentials used to live in MMKV. */
export function createPlatformCredentialVault(name: string, legacy: LegacyCredentials): CredentialVault {
  return createCredentialVault({name, secure: platformSecureItems, moveRecord: credentialMoveRecord, legacy})
}
