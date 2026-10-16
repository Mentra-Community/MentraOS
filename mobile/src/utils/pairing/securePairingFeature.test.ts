import * as feature from "./securePairingFeature"
import {
  advertisedSecurePairingCapable,
  isMentraLiveSecurePairingEnabled,
  parseOptionalBoolean,
} from "./securePairingFeature"

describe("legacy Mentra Live capability flags", () => {
  it("keeps boolean flags and reads Expo Router strings", () => {
    expect(parseOptionalBoolean(false)).toBe(false)
    expect(parseOptionalBoolean("false")).toBe(false)
    expect(parseOptionalBoolean(true)).toBe(true)
    expect(parseOptionalBoolean("true")).toBe(true)
    expect(parseOptionalBoolean(undefined)).toBeUndefined()
    expect(parseOptionalBoolean("")).toBeUndefined()
  })

  it("prefers the device payload over a missing or string route flag", () => {
    expect(advertisedSecurePairingCapable(undefined, false)).toBe(false)
    expect(advertisedSecurePairingCapable("false", undefined)).toBe(false)
    expect(advertisedSecurePairingCapable("true", false)).toBe(false)
    expect(advertisedSecurePairingCapable(undefined, undefined)).toBeUndefined()
    expect(advertisedSecurePairingCapable("true", undefined)).toBe(true)
  })
})

describe("Mentra Live secure pairing flag", () => {
  const originalSecure = process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING

  afterEach(() => {
    if (originalSecure === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = originalSecure
  })

  it("is on only for exactly true", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    expect(isMentraLiveSecurePairingEnabled()).toBe(false)
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "TRUE"
    expect(isMentraLiveSecurePairingEnabled()).toBe(false)
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "true"
    expect(isMentraLiveSecurePairingEnabled()).toBe(true)
  })

  it("no longer exposes the retired ownership transfer flag", () => {
    expect(feature).not.toHaveProperty("isMentraLiveOwnershipTransferEnabled")
    expect(feature).not.toHaveProperty("isMentraLiveOwnershipTransferSupported")
  })
})
