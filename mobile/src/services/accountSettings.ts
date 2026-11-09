/**
 * Settings kept per account, on this phone.
 *
 * The settings store reads and writes one flat set in the default MMKV instance, as it always has: the set of the
 * account signed in now. Signing out closes that set: the account's settings are copied into this store, under the
 * account's id, and leave the flat set, which keeps only the phone-wide settings (`PHONE_WIDE_SETTING_KEYS`) and the
 * migration markers. Signing in opens the account's set: its settings are copied back, or the defaults stand for an
 * account this phone hasn't seen. Another account therefore inherits nothing, and the same account gets its settings
 * back exactly.
 *
 * Nothing moves at the first start with this code, which is what keeps an upgrade invisible. Until this store records
 * an open account, the flat set is taken to belong to whoever is signed in: the first account the app learns of
 * adopts it as is, however late its id arrives. Only a phone known to be signed out drops the account settings it
 * holds, as signing out did before.
 *
 * Kept in its own MMKV instance, which logout's clearing of the default instance doesn't reach.
 */
import {PHONE_WIDE_SETTING_KEYS, SETTINGS, SIGN_OUT_ERASED_SETTING_KEYS, engine} from "@mentra/engine"
import {createMMKV, type MMKV} from "react-native-mmkv"

import {MIGRATION_VERSION_KEY} from "@/services/Migrations"
import {storage} from "@/utils/storage"

const ACCOUNT_SETTINGS_STORE_ID = "mentra-account-settings"
/** The account whose set is open in the flat settings: its id, "" when signed out, absent before the first record. */
const OPEN_ACCOUNT_KEY = "open-account"

let store: MMKV | undefined
const accounts = (): MMKV => (store ??= createMMKV({id: ACCOUNT_SETTINGS_STORE_ID}))

const entryPrefix = (accountId: string) => `account:${accountId}\n`

/** The persisted setting a storage key holds, an indexed setting's subkey (`preferred_mic:Mentra Live`) included. */
function storedSetting(storageKey: string) {
  const setting = SETTINGS[storageKey.split(":")[0]]
  return setting?.persist ? setting : undefined
}

function isAccountSetting(storageKey: string): boolean {
  const setting = storedSetting(storageKey)
  return !!setting && !PHONE_WIDE_SETTING_KEYS.has(setting.key) && !SIGN_OUT_ERASED_SETTING_KEYS.has(setting.key)
}

/** What the flat storage keeps at sign-out: phone-wide settings, and the markers that stop migrations rerunning. */
function isPhoneWide(storageKey: string): boolean {
  const setting = storedSetting(storageKey)
  if (setting) return PHONE_WIDE_SETTING_KEYS.has(setting.key)
  return (
    storageKey === MIGRATION_VERSION_KEY ||
    storageKey.startsWith("migration:") ||
    storageKey === "settings.lastBuildEnv"
  )
}

function openAccount(): string | undefined {
  return accounts().getString(OPEN_ACCOUNT_KEY)
}

function deleteSet(accountId: string): void {
  const prefix = entryPrefix(accountId)
  for (const key of accounts().getAllKeys()) if (key.startsWith(prefix)) accounts().remove(key)
}

function saveSet(accountId: string): void {
  deleteSet(accountId)
  const prefix = entryPrefix(accountId)
  for (const key of storage.getAllKeys()) {
    if (!isAccountSetting(key)) continue
    const value = storage.load<unknown>(key)
    if (value.is_ok()) accounts().set(prefix + key, JSON.stringify(value.value))
  }
}

function keepOnlyInFlatSettings(keep: (storageKey: string) => boolean): void {
  const removed = storage.getAllKeys().filter((key) => !keep(key))
  if (removed.length === 0) return
  const res = storage.removeMultiple(removed)
  if (res.is_error()) console.error("ACCOUNT_SETTINGS: could not clear the previous account's settings", res.error)
}

/** Open the set of the account now signed in. Call it as soon as the account's id is known, before reading settings. */
export function openAccountSettings(accountId: string): void {
  if (!accountId) return
  const open = openAccount()
  if (open === accountId) return
  if (open === undefined) {
    // The first start with this code, signed in: the flat settings are this account's.
    accounts().set(OPEN_ACCOUNT_KEY, accountId)
    return
  }
  // A sign-out that never finished leaves another account's set open: close it first.
  if (open) saveSet(open)
  keepOnlyInFlatSettings((key) => !isAccountSetting(key))
  const prefix = entryPrefix(accountId)
  for (const key of accounts().getAllKeys()) {
    if (!key.startsWith(prefix)) continue
    const storageKey = key.slice(prefix.length)
    // A set saved before a setting became phone-wide (the paired glasses) must not overwrite the phone's value.
    if (!isAccountSetting(storageKey)) continue
    const raw = accounts().getString(key)
    if (raw === undefined) continue
    try {
      storage.save(storageKey, JSON.parse(raw))
    } catch (error) {
      console.error(`ACCOUNT_SETTINGS: could not restore ${storageKey}`, error)
    }
  }
  accounts().set(OPEN_ACCOUNT_KEY, accountId)
  engine.settings.reloadLocal()
}

/**
 * Close the open account's set at sign-out: keep it for the account's next sign-in, or delete it with the account.
 * Clears the rest of the default MMKV instance as signing out always has, apart from the phone-wide settings and the
 * migration markers.
 */
export function closeAccountSettings({deleteAccount = false}: {deleteAccount?: boolean} = {}): void {
  const open = openAccount()
  if (open) {
    if (deleteAccount) deleteSet(open)
    else saveSet(open)
  }
  keepOnlyInFlatSettings(isPhoneWide)
  accounts().set(OPEN_ACCOUNT_KEY, "")
  engine.settings.reloadLocal()
}

/**
 * The first start with this code on a phone known to be signed out: drop the account settings the flat set holds,
 * which no account owns. Only a definite "no session" may call this; an unknown one leaves the set for the account.
 */
export function settleSignedOutAccountSettings(): void {
  if (openAccount() !== undefined) return
  keepOnlyInFlatSettings((key) => !isAccountSetting(key))
  accounts().set(OPEN_ACCOUNT_KEY, "")
  engine.settings.reloadLocal()
}
