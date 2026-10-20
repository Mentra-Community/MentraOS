import * as feature from "./securePairingFeature"
import {advertisedSecurePairingCapable, parseOptionalBoolean} from "./securePairingFeature"

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

describe("Mentra Live pairing app flags", () => {
  it("exposes no app flag: the glasses' advertisement decides the pairing flow", () => {
    expect(feature).not.toHaveProperty("isMentraLiveSecurePairingEnabled")
  })

  it("no longer exposes the retired ownership transfer flag", () => {
    expect(feature).not.toHaveProperty("isMentraLiveOwnershipTransferEnabled")
    expect(feature).not.toHaveProperty("isMentraLiveOwnershipTransferSupported")
  })
})
