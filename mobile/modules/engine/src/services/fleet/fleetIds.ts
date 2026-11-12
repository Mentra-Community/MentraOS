/**
 * Identifiers for the Fleet reporter: the phone's own device ID, record and session IDs, and the provisional
 * binding that stands in for glasses without a serial number.
 *
 * The phone's device ID and the bindings are kept in the `mentra-fleet` MMKV instance, which logout's
 * `storage.clearAll()` does not touch, so a phone keeps one identity across accounts and sign-outs. Uninstalling the
 * app empties that instance, so the device ID also lasts where a reinstall does not reach (`StablePhoneSource`):
 * Fleet identifies phones, not installs.
 */
import {getFleetStore} from "./fleetStorage"
import {sha256HexOfText} from "./utf8"

/** Crockford's base32, the ULID alphabet: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A 128-bit value in 26 characters: 130 bits, the 2 spare leading bits zero. */
const RANDOM_128_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

const PHONE_DEVICE_ID_KEY = "phone_device_id"
/** The device ID last given to or read from the stable source: tells an older install's ID from a copied one. */
const PHONE_DEVICE_ID_KEPT_KEY = "phone_device_id_kept"
const BINDING_KEY_PREFIX = "binding:"
const MAX_ULID_TIME = 2 ** 48 - 1

/** Big-endian bytes as base32, left-padded with zero bits to a whole number of characters. */
function encodeBase32(bytes: Uint8Array): string {
  const out: string[] = []
  let accumulator = 0
  let accumulatorBits = 0
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    accumulator |= bytes[index] << accumulatorBits
    accumulatorBits += 8
    while (accumulatorBits >= 5) {
      out.push(ALPHABET[accumulator & 31])
      accumulator >>>= 5
      accumulatorBits -= 5
    }
  }
  if (accumulatorBits > 0) out.push(ALPHABET[accumulator & 31])
  return out.reverse().join("")
}

function randomBytes(length: number): Uint8Array {
  const source = globalThis.crypto
  if (typeof source?.getRandomValues !== "function") throw new Error("Fleet ids need crypto.getRandomValues")
  const bytes = new Uint8Array(length)
  source.getRandomValues(bytes)
  return bytes
}

function random128BitId(): string {
  return encodeBase32(randomBytes(16))
}

const isDeviceId = (value: unknown): value is string => typeof value === "string" && RANDOM_128_ID.test(value)

/** Where a phone's device ID outlives a reinstall. Either method may throw. */
export interface StablePhoneSource {
  /** The phone's device ID as this source has it; null when it has none. */
  read(): string | null
  /** Keeps `id` as the phone's device ID; false when it cannot. */
  keep(id: string): boolean
}

/** The Keychain service of the iOS item; its own, so no credential operation reaches it. */
export const FLEET_KEYCHAIN_SERVICE = "com.mentra.fleet"
const KEYCHAIN_DEVICE_ID_KEY = "phone_device_id"
/** Domain-separates the Android device ID, so the hash of `ANDROID_ID` means nothing elsewhere. */
const ANDROID_ID_CONTEXT = "mentra-fleet-phone-device-id:v1\n"

/** A device ID derived from Android's `ANDROID_ID`: 128 bits of SHA-256, so the ID never reveals `ANDROID_ID`. */
export function deviceIdFromAndroidId(androidId: string): string {
  const hex = sha256HexOfText(ANDROID_ID_CONTEXT + androidId).slice(0, 32)
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 16; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return encodeBase32(bytes)
}

function keychainOptions(store: typeof import("expo-secure-store")) {
  return {keychainService: FLEET_KEYCHAIN_SERVICE, keychainAccessible: store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY}
}

/**
 * The app's stable source, by platform, or null where there is none (the device ID is then per install):
 * - iOS: a Keychain item, readable after the first unlock and never restored to another phone from a backup
 *   (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). Keychain items outlive uninstalling the app, though iOS does
 *   not promise it; erasing the phone removes them.
 * - Android: derived from `ANDROID_ID`, which the system keeps per app signing key, user and device across
 *   reinstalls, and changes on a factory reset. Builds signed with different keys get different IDs. Nothing is
 *   stored, so `keep` has nothing to do.
 * The native modules are loaded on first use, so importing the engine never touches them.
 */
export function platformStablePhoneSource(): StablePhoneSource | null {
  const {Platform} = require("react-native") as typeof import("react-native")
  if (Platform.OS === "android") {
    return {
      read() {
        const androidId = (require("expo-application") as typeof import("expo-application")).getAndroidId()
        return androidId ? deviceIdFromAndroidId(androidId) : null
      },
      keep: () => true,
    }
  }
  if (Platform.OS !== "ios") return null
  return {
    read() {
      const store = require("expo-secure-store") as typeof import("expo-secure-store")
      const value = store.getItem(KEYCHAIN_DEVICE_ID_KEY, keychainOptions(store))
      return isDeviceId(value) ? value : null
    },
    keep(id) {
      const store = require("expo-secure-store") as typeof import("expo-secure-store")
      store.setItem(KEYCHAIN_DEVICE_ID_KEY, id, keychainOptions(store))
      return true
    },
  }
}

/** This process's device ID: every record of a run, from any writer, carries the same one. */
let processDeviceId: string | null = null

/**
 * This phone's device ID: 128 bits as base32, the same across accounts, sign-outs, Cores and reinstalls.
 *
 * It is resolved once per process and then never changes until the app restarts, so a collector session never
 * carries two IDs. Resolving reads the stable source (`StablePhoneSource`) every launch rather than trusting the
 * cache in `mentra-fleet`, because a backup restored onto another phone copies that cache:
 * - the source's ID wins;
 * - when the source has none, an ID the cache holds that was never given to a source (an install from before this
 *   version) is kept and given to it, so a phone that already reported keeps its ID; an ID that was given to a
 *   source before is a copy from another phone, or one the source lost, so a new one is made;
 * - a source that cannot be read (an iOS Keychain before the first unlock) leaves the cached ID, or a new one, for
 *   this process, and the next launch resolves again.
 * Without a source the ID is per install, as before.
 */
export function phoneDeviceId(source: () => StablePhoneSource | null = platformStablePhoneSource): string {
  processDeviceId ??= resolvePhoneDeviceId(source)
  return processDeviceId
}

/** Forgets this process's device ID, as a restart does. */
export function resetPhoneDeviceIdForTests(): void {
  processDeviceId = null
}

function resolvePhoneDeviceId(sourceOf: () => StablePhoneSource | null): string {
  const store = getFleetStore()
  const stored = store.getString(PHONE_DEVICE_ID_KEY)
  const cached = isDeviceId(stored) ? stored : null
  let id = cached ?? random128BitId()
  try {
    const source = sourceOf()
    if (source !== null) {
      const lasting = source.read()
      if (lasting !== null && isDeviceId(lasting)) {
        id = lasting
        store.set(PHONE_DEVICE_ID_KEPT_KEY, id)
      } else {
        const keptBefore = cached !== null && store.getString(PHONE_DEVICE_ID_KEPT_KEY) === cached
        if (keptBefore) id = random128BitId()
        if (source.keep(id)) store.set(PHONE_DEVICE_ID_KEPT_KEY, id)
      }
    }
  } catch {
    // This process keeps `id`; the next launch reads the source again.
  }
  if (id !== cached) store.set(PHONE_DEVICE_ID_KEY, id)
  return id
}

/** A ULID: 48 bits of millisecond time, then 80 random bits, as 26 sortable base32 characters. */
export function newId(): string {
  const now = Date.now()
  let remaining = Number.isFinite(now) ? Math.min(Math.max(Math.floor(now), 0), MAX_ULID_TIME) : 0
  const time = new Uint8Array(6)
  for (let index = 5; index >= 0; index -= 1) {
    time[index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  return encodeBase32(time) + encodeBase32(randomBytes(10))
}

/**
 * The binding ID for glasses that report no usable serial number: one random ID per phone and pair of glasses,
 * created on first use and kept in `mentra-fleet`.
 *
 * It is random, not derived from the peripheral address, so the ID reveals nothing about the address. The address
 * is only hashed into the local lookup key, and compared without case.
 */
export function provisionalBindingId(model: string, peripheralId: string | null): string {
  const store = getFleetStore()
  const identity = JSON.stringify([model.trim(), (peripheralId ?? "").trim().toLowerCase()])
  const key = `${BINDING_KEY_PREFIX}${sha256HexOfText(identity)}`
  const existing = store.getString(key)
  if (existing !== undefined && RANDOM_128_ID.test(existing)) return existing
  const created = random128BitId()
  store.set(key, created)
  return created
}
