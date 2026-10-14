import {Platform} from "react-native"

import {
  advertisedSecurePairingCapable,
  isMentraLiveOwnershipTransferEnabled,
  isMentraLiveOwnershipTransferSupported,
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

describe("Mentra Live ownership transfer flag", () => {
  const originalSecure = process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
  const originalTransfer = process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER

  afterEach(() => {
    if (originalSecure === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = originalSecure
    if (originalTransfer === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = originalTransfer
  })

  it("stays off unless secure pairing and ownership transfer are both exactly true", () => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER
    expect(isMentraLiveOwnershipTransferEnabled()).toBe(false)

    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = "true"
    expect(isMentraLiveOwnershipTransferEnabled()).toBe(false)

    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "true"
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = "TRUE"
    expect(isMentraLiveOwnershipTransferEnabled()).toBe(false)

    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = "true"
    expect(isMentraLiveOwnershipTransferEnabled()).toBe(true)
  })
})

describe("Mentra Live ownership transfer platform gate", () => {
  const originalSecure = process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
  const originalTransfer = process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER

  beforeEach(() => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "true"
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = "true"
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalSecure === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = originalSecure
    if (originalTransfer === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = originalTransfer
  })

  it("is supported on Android and iOS when the flag is on", () => {
    jest.replaceProperty(Platform, "OS", "android")
    expect(isMentraLiveOwnershipTransferSupported()).toBe(true)

    jest.replaceProperty(Platform, "OS", "ios")
    expect(isMentraLiveOwnershipTransferEnabled()).toBe(true)
    expect(isMentraLiveOwnershipTransferSupported()).toBe(true)

    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = "false"
    expect(isMentraLiveOwnershipTransferSupported()).toBe(false)
  })
})
