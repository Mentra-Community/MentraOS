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
