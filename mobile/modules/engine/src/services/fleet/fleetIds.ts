/**
 * Identifiers for the Fleet reporter: the phone's own device ID, record and session IDs, and the provisional
 * binding that stands in for glasses without a serial number.
 *
 * The phone's device ID and the bindings are kept in the `mentra-fleet` MMKV instance, which logout's
 * `storage.clearAll()` does not touch, so a phone keeps one identity across accounts and sign-outs.
 */
import {getFleetStore} from "./fleetStorage"
import {sha256HexOfText} from "./utf8"

/** Crockford's base32, the ULID alphabet: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A 128-bit value in 26 characters: 130 bits, the 2 spare leading bits zero. */
const RANDOM_128_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

const PHONE_DEVICE_ID_KEY = "phone_device_id"
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

/**
 * This phone's device ID: 128 random bits as base32, created on first use and kept in `mentra-fleet`. It is the
 * same across accounts, sign-outs and Cores; a reinstall makes a new one.
 */
export function phoneDeviceId(): string {
  const store = getFleetStore()
  const existing = store.getString(PHONE_DEVICE_ID_KEY)
  if (existing !== undefined && RANDOM_128_ID.test(existing)) return existing
  const created = random128BitId()
  store.set(PHONE_DEVICE_ID_KEY, created)
  return created
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
