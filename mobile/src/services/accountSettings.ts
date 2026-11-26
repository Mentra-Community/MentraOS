/**
 * What an account keeps on this phone across sign-out: its settings and the rest of its app state.
 *
 * The settings store, and every other store of the app that keeps account state (the home screen's miniapp order,
 * hidden and auto-running miniapps, the gallery's index, saved Wi-Fi networks and so on), read and write one flat set
 * in the default MMKV instance, as they always have: the set of the account signed in now. Signing out closes that
 * set: the account's keys are copied into this store, under the account's id, and leave the flat set. Signing in
 * opens the account's set: its keys are copied back, or the defaults stand for an account this phone hasn't seen.
 * Another account therefore inherits nothing, and the same account gets everything back exactly.
 *
 * Every key of the flat set is one of three kinds (`keyKind`):
 * - **phone**: the phone's, whoever is signed in, so it stays where it is: phone-wide settings
 *   (`PHONE_WIDE_SETTING_KEYS`), migration markers, the deployment's default miniapps, and the miniapp keys that
 *   already belong to one account or to the phone (`isMiniappKeyKeptAtSignOut`: each account's partitioned miniapp
 *   data and saved files' records, development selections, installed versions). Only deleting the account erases
 *   its miniapp data (`deleteMiniappDataOfAccount`).
 * - **signed-in**: the credentials and identity of the session itself, erased at sign-out and never kept: they come
 *   back from the next sign-in.
 * - **account**: everything else, kept per account as above.
 *
 * Nothing moves at the first start with this code, which is what keeps an upgrade invisible. Until this store records
 * an open account, the flat set is taken to belong to whoever is signed in: the first account the app learns of
 * adopts it as is, however late its id arrives. Only a phone known to be signed out drops the account keys it
 * holds, as signing out did before.
 *
 * Kept in its own MMKV instance, which logout's clearing of the default instance doesn't reach.
 */
import {
  PHONE_WIDE_SETTING_KEYS,
  SETTINGS,
  SIGN_OUT_ERASED_SETTING_KEYS,
  deleteMiniappDataOfAccount,
  engine,
  isMiniappKeyKeptAtSignOut,
} from "@mentra/engine"
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

/** The deployment's default miniapps, as Core last listed them: the deployment's, whoever is signed in. */
const DEPLOYMENT_KEYS = new Set(["deployment_default_miniapps:v1", "deployment_default_miniapp_listings:v1"])

/**
 * The session's own credentials and identity, erased at sign-out: the account profile, a sign-up in progress, the
 * account a miniapp's data belongs to (asked of Core again at sign-in), the deployment chosen for this sign-in, and
 * the auth keys of builds before the account service.
 */
const SIGNED_IN_KEYS = new Set([
  "mentra.account.userProfile",
  "mentra.account.pendingSignupEmail",
  "mentra.localMiniapp.userId",
  "mentra.deployment.active.v1",
])

type KeyKind = "phone" | "signed-in" | "account"

/** Which kind a key of the flat set is (see the file comment). */
export function keyKind(storageKey: string): KeyKind {
  const setting = storedSetting(storageKey)
  if (setting) {
    if (PHONE_WIDE_SETTING_KEYS.has(setting.key)) return "phone"
    if (SIGN_OUT_ERASED_SETTING_KEYS.has(setting.key)) return "signed-in"
    return "account"
  }
  if (
    storageKey === MIGRATION_VERSION_KEY ||
    storageKey.startsWith("migration:") ||
    storageKey === "settings.lastBuildEnv" ||
    DEPLOYMENT_KEYS.has(storageKey) ||
    isMiniappKeyKeptAtSignOut(storageKey)
  ) {
    return "phone"
  }
  if (SIGNED_IN_KEYS.has(storageKey) || storageKey.startsWith("supabase.auth.")) return "signed-in"
  return "account"
}

const isAccountKey = (storageKey: string) => keyKind(storageKey) === "account"

/** Whether signing out leaves a key of the default MMKV instance in place. */
export function isKeptInPlaceAtSignOut(storageKey: string): boolean {
  return keyKind(storageKey) === "phone"
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
    if (!isAccountKey(key)) continue
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
  keepOnlyInFlatSettings((key) => !isAccountKey(key))
  const prefix = entryPrefix(accountId)
  for (const key of accounts().getAllKeys()) {
    if (!key.startsWith(prefix)) continue
    const storageKey = key.slice(prefix.length)
    // A set saved before a key became the phone's (the paired glasses) must not overwrite the phone's value.
    if (!isAccountKey(storageKey)) continue
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
 * Close the open account's set at sign-out: keep it for the account's next sign-in, or delete it with the account,
 * its miniapps' data included. Leaves only the phone's keys in the default MMKV instance.
 */
export function closeAccountSettings({deleteAccount = false}: {deleteAccount?: boolean} = {}): void {
  const open = openAccount()
  if (open) {
    if (deleteAccount) deleteSet(open)
    else saveSet(open)
  }
  if (deleteAccount) deleteMiniappDataOfAccount()
  keepOnlyInFlatSettings(isKeptInPlaceAtSignOut)
  accounts().set(OPEN_ACCOUNT_KEY, "")
  engine.settings.reloadLocal()
}

/**
 * The first start with this code on a phone known to be signed out: drop the account keys the flat set holds,
 * which no account owns. Only a definite "no session" may call this; an unknown one leaves the set for the account.
 */
export function settleSignedOutAccountSettings(): void {
  if (openAccount() !== undefined) return
  keepOnlyInFlatSettings((key) => !isAccountKey(key))
  accounts().set(OPEN_ACCOUNT_KEY, "")
  engine.settings.reloadLocal()
}
