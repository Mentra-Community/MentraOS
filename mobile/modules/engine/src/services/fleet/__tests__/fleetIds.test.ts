/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {FleetDeviceBindingSchema, FleetRecordSchema} from "@mentra/cloud-protocol"
import {DEFAULT_MMKV_ID, fakeCreateMMKV, mmkvInstances, resetFakeMmkv} from "./fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))

const {deviceIdFromAndroidId, newId, phoneDeviceId, provisionalBindingId, resetPhoneDeviceIdForTests} = await import(
  "../fleetIds"
)
type StablePhoneSource = import("../fleetIds").StablePhoneSource
// The app's real logout path: `storage.clearAll()` empties the default MMKV instance.
const {storage} = await import("../../../utils/storage/storage")

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function fleetInstance() {
  return mmkvInstances.get("mentra-fleet")
}

beforeEach(() => {
  resetFakeMmkv()
  resetPhoneDeviceIdForTests()
})

/** A new process of the same install: what a restart forgets. */
const restart = () => resetPhoneDeviceIdForTests()
/** A reinstall: the app's MMKV files are gone, and so is the process. */
function reinstall() {
  resetFakeMmkv()
  restart()
}

describe("phoneDeviceId", () => {
  test("is a random 128-bit base32 value that stays the same on every call", () => {
    const id = phoneDeviceId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    // 26 characters carry 130 bits; the 2 spare leading bits are zero, so the value is 128 bits wide.
    expect("01234567").toContain(id[0])
    expect(phoneDeviceId()).toBe(id)
    expect(phoneDeviceId()).toBe(id)
  })

  test("is kept in the mentra-fleet instance and nowhere else", () => {
    const id = phoneDeviceId()
    expect([...(fleetInstance()?.values.values() ?? [])]).toContain(id)
    expect(mmkvInstances.get(DEFAULT_MMKV_ID)?.values.size ?? 0).toBe(0)
  })

  test("survives the default instance's clearAll(), which is what logout runs", () => {
    const id = phoneDeviceId()
    // A fake default store with real content, emptied the way LogoutUtils does it.
    storage.save("some_user_setting", {a: 1})
    expect(mmkvInstances.get(DEFAULT_MMKV_ID)?.values.size).toBe(1)
    storage.clearAll()
    expect(mmkvInstances.get(DEFAULT_MMKV_ID)?.values.size).toBe(0)

    expect(phoneDeviceId()).toBe(id)
  })

  test("is different on a different install where there is no stable source", () => {
    const first = phoneDeviceId(() => null)
    reinstall()
    expect(phoneDeviceId(() => null)).not.toBe(first)
  })

  test("stays the same across restarts of an install with no stable source", () => {
    const first = phoneDeviceId(() => null)
    restart()
    expect(phoneDeviceId(() => null)).toBe(first)
  })

  test("replaces a stored value that is not a device ID", () => {
    fakeCreateMMKV({id: "mentra-fleet"}).set("phone_device_id", "not an id!")
    const id = phoneDeviceId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(phoneDeviceId()).toBe(id)
  })

  test("is a valid Fleet identifier", () => {
    const parsed = FleetRecordSchema.safeParse({
      schemaVersion: 1,
      recordId: newId(),
      phoneDeviceId: phoneDeviceId(),
      collectorSessionId: newId(),
      sequence: 0,
      observedAt: "2026-10-13T12:00:00.000Z",
      capabilities: [],
      kind: "coverage_gap",
      payload: {reason: "queue_dropped", from: "2026-10-13T12:00:00.000Z", to: "2026-10-13T12:00:00.000Z"},
    })
    expect(parsed.success).toBe(true)
  })
})

describe("newId", () => {
  let now: ReturnType<typeof spyOn<DateConstructor, "now">> | undefined
  let random: {mockRestore(): void} | undefined
  afterEach(() => {
    now?.mockRestore()
    random?.mockRestore()
    now = undefined
    random = undefined
  })

  function fixRandom(bytes: number[]) {
    random = spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((target: Uint8Array) => {
      target.set(bytes.slice(0, target.length))
      return target
    }) as typeof crypto.getRandomValues)
  }

  test("is a 26-character ULID", () => {
    expect(newId()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  })

  test("encodes the millisecond time in its first 10 characters (the ULID spec's example)", () => {
    now = spyOn(Date, "now").mockReturnValue(1469918176385)
    fixRandom(new Array(10).fill(0))
    expect(newId()).toBe("01ARYZ6S410000000000000000")
    fixRandom(new Array(10).fill(255))
    expect(newId()).toBe("01ARYZ6S41ZZZZZZZZZZZZZZZZ")
  })

  test("encodes 80 random bits in its last 16 characters", () => {
    now = spyOn(Date, "now").mockReturnValue(1469918176385)
    // "TSV4RRFFQ69G5FAV" is the random part of the ULID spec's example; decode it to bytes independently.
    const randomPart = "TSV4RRFFQ69G5FAV"
    let bits = ""
    for (const char of randomPart) bits += CROCKFORD.indexOf(char).toString(2).padStart(5, "0")
    const bytes = bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2))
    fixRandom(bytes)
    expect(newId()).toBe("01ARYZ6S41TSV4RRFFQ69G5FAV")
  })

  test("sorts by time and is unique", () => {
    now = spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    const earlier = newId()
    now.mockReturnValue(1_700_000_000_001)
    const later = newId()
    expect(earlier < later).toBe(true)
    now.mockRestore()
    now = undefined

    const ids = new Set<string>()
    for (let index = 0; index < 2000; index += 1) ids.add(newId())
    expect(ids.size).toBe(2000)
  })

  test("is a valid Fleet identifier", () => {
    expect(newId()).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
  })
})

describe("provisionalBindingId", () => {
  test("is stable for one phone and one pair of glasses", () => {
    const id = provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")
    expect(provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")).toBe(id)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test("differs per pair of glasses and per model", () => {
    const first = provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")
    const second = provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:00")
    const otherModel = provisionalBindingId("Even G2", "AA:BB:CC:DD:EE:FF")
    expect(new Set([first, second, otherModel]).size).toBe(3)
  })

  test("treats the same address in another case as the same glasses", () => {
    expect(provisionalBindingId("Mentra Live", "aa:bb:cc:dd:ee:ff")).toBe(
      provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF"),
    )
  })

  test("is stable when the peripheral is unknown, and distinct from a known peripheral", () => {
    const unknown = provisionalBindingId("Mentra Live", null)
    expect(provisionalBindingId("Mentra Live", null)).toBe(unknown)
    expect(provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")).not.toBe(unknown)
    expect(provisionalBindingId("Even G2", null)).not.toBe(unknown)
  })

  test("is random rather than derived from the peripheral, so it reveals nothing about it", () => {
    const peripheral = "AA:BB:CC:DD:EE:FF"
    const id = provisionalBindingId("Mentra Live", peripheral)
    expect(id).not.toContain("AABBCCDDEEFF")
    // A second install sees the same glasses and gets another ID.
    resetFakeMmkv()
    expect(provisionalBindingId("Mentra Live", peripheral)).not.toBe(id)
  })

  test("survives the default instance's clearAll(), which is what logout runs", () => {
    const id = provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")
    storage.save("some_user_setting", {a: 1})
    storage.clearAll()
    expect(mmkvInstances.get(DEFAULT_MMKV_ID)?.values.size).toBe(0)
    expect(provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")).toBe(id)
  })

  test("is kept in mentra-fleet, and the raw peripheral address is not written anywhere", () => {
    const id = provisionalBindingId("Mentra Live", "AA:BB:CC:DD:EE:FF")
    const stored = [...(fleetInstance()?.values.entries() ?? [])]
    expect(stored.map(([, value]) => value)).toContain(id)
    for (const [key, value] of stored) {
      expect(key.toLowerCase()).not.toContain("aa:bb:cc:dd:ee:ff")
      expect(value.toLowerCase()).not.toContain("aa:bb:cc:dd:ee:ff")
    }
  })

  test("is a valid provisional device binding", () => {
    const binding = {kind: "provisional", bindingId: provisionalBindingId("Mentra Live", null), product: "Mentra Live"}
    expect(FleetDeviceBindingSchema.safeParse(binding).success).toBe(true)
  })
})

/** A stable source like the iOS Keychain: it holds what it was given, across reinstalls. */
function keychain(initial: string | null = null) {
  const state = {value: initial, reads: 0, failing: false}
  const source: StablePhoneSource = {
    read() {
      state.reads += 1
      if (state.failing) throw new Error("errSecInteractionNotAllowed")
      return state.value
    },
    keep(id) {
      if (state.failing) throw new Error("errSecInteractionNotAllowed")
      state.value = id
      return true
    },
  }
  return {state, source: () => source}
}

const OLDER_INSTALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const KEYCHAIN_ID = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"
const DEVICE_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

describe("phoneDeviceId identifies the phone, not the install", () => {
  test("a reinstall gets the device ID back from the Keychain", () => {
    const {source} = keychain()
    const first = phoneDeviceId(source)
    reinstall()
    expect(phoneDeviceId(source)).toBe(first)
  })

  test("an install from before this version keeps its ID, and gives it to the Keychain", () => {
    fakeCreateMMKV({id: "mentra-fleet"}).set("phone_device_id", OLDER_INSTALL_ID)
    const {state, source} = keychain()
    expect(phoneDeviceId(source)).toBe(OLDER_INSTALL_ID)
    expect(state.value).toBe(OLDER_INSTALL_ID)
    restart()
    expect(phoneDeviceId(source)).toBe(OLDER_INSTALL_ID)
  })

  test("the Keychain's ID wins over the one the cache holds", () => {
    const {source} = keychain(KEYCHAIN_ID)
    fakeCreateMMKV({id: "mentra-fleet"}).set("phone_device_id", OLDER_INSTALL_ID)
    expect(phoneDeviceId(source)).toBe(KEYCHAIN_ID)
  })

  test("a backup restored onto another phone does not make the two phones one", () => {
    const first = keychain()
    const id = phoneDeviceId(first.source)
    // The new phone gets the app's files from the backup, but not the first phone's Keychain item.
    const second = keychain()
    restart()
    const copied = phoneDeviceId(second.source)
    expect(copied).not.toBe(id)
    expect(second.state.value).toBe(copied)
    // A new phone that has its own Keychain item takes that one.
    const third = keychain(KEYCHAIN_ID)
    restart()
    expect(phoneDeviceId(third.source)).toBe(KEYCHAIN_ID)
  })

  test("the source is read once per process, so every record of a run carries one ID", () => {
    const {state, source} = keychain()
    const id = phoneDeviceId(source)
    for (let index = 0; index < 5; index += 1) expect(phoneDeviceId(source)).toBe(id)
    expect(state.reads).toBe(1)
    restart()
    expect(phoneDeviceId(source)).toBe(id)
    expect(state.reads).toBe(2)
  })

  test("a Keychain that cannot be read keeps one ID for the whole process, and the next launch takes the Keychain's", () => {
    const {state, source} = keychain(KEYCHAIN_ID)
    state.failing = true
    const early = phoneDeviceId(source)
    expect(early).toMatch(DEVICE_ID)
    expect(early).not.toBe(KEYCHAIN_ID)
    state.failing = false
    expect(phoneDeviceId(source)).toBe(early)
    restart()
    expect(phoneDeviceId(source)).toBe(KEYCHAIN_ID)
  })

  test("a source that cannot be read keeps the cached ID", () => {
    const {source} = keychain()
    const id = phoneDeviceId(source)
    const failing = keychain()
    failing.state.failing = true
    restart()
    expect(phoneDeviceId(failing.source)).toBe(id)
  })

  test("Android's ID is derived from ANDROID_ID: the same across reinstalls and backups, valid, and not ANDROID_ID itself", () => {
    const android = (androidId: string) => (): StablePhoneSource => ({
      read: () => deviceIdFromAndroidId(androidId),
      keep: () => true,
    })
    const first = phoneDeviceId(android("9a8b7c6d5e4f3a2b"))
    reinstall()
    expect(phoneDeviceId(android("9a8b7c6d5e4f3a2b"))).toBe(first)
    expect(first).toMatch(DEVICE_ID)
    expect(first.toLowerCase()).not.toContain("9a8b7c6d5e4f3a2b")
    // A backup restored onto another phone: the copied cache gives way to that phone's own ID.
    restart()
    const other = phoneDeviceId(android("0000000000000001"))
    expect(other).toBe(deviceIdFromAndroidId("0000000000000001"))
    expect(other).not.toBe(first)
  })
})
