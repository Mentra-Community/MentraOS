/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

const glassesState = {
  connection: {state: "connected" as const, fullyBooted: true},
  deviceModel: "Mentra Live",
  serialNumber: "SERIAL-123",
  firmwareVersion: "1.2.3",
  androidVersion: "14",
  mtkFirmwareVersion: "mtk-1",
  besFirmwareVersion: "bes-1",
  appVersion: "live-2",
  buildNumber: "200",
  bluetoothMacAddress: "AA:BB:CC:DD:EE:FF",
  leftMacAddress: "11:22:33:44:55:66",
  wifi: {state: "connected", ssid: "Private Wi-Fi", localIp: "192.0.2.10"},
  hotspot: {state: "enabled", ssid: "secret", password: "password", localIp: "192.0.2.1"},
}

mock.module("expo-constants", () => ({
  default: {
    nativeAppVersion: "2.4.0",
    nativeBuildVersion: "240",
    expoConfig: {version: "2.4.0"},
  },
}))
mock.module("expo-device", () => ({modelName: "iPhone 17 Pro"}))
mock.module("react-native", () => ({Platform: {OS: "ios", Version: "26.0"}}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => glassesState, subscribe: mock(() => () => {})},
}))
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setInterval: mock(() => 1),
    clearInterval: mock(() => {}),
    setTimeout: mock(() => 1),
    clearTimeout: mock(() => {}),
  },
}))
mock.module("../CloudClientService", () => ({
  cloudClientService: {core: {supportProfile: {update: mock(async () => ({status: "accepted"}))}}},
}))

const {buildSnapshot, retryDelayForSupportProfileResult, snapshotFingerprint} = await import("../SupportProfileSync")

describe("SupportProfileSync", () => {
  test("projects only the support allowlist and excludes network/device addresses", () => {
    const snapshot = buildSnapshot(new Date("2026-08-11T12:00:00.000Z"))
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.device).toMatchObject({
      hardwareId: "SERIAL-123",
      model: "Mentra Live",
      firmwareVersion: "1.2.3",
    })
    expect(snapshot.host.phoneModel).toBe("iPhone 17 Pro")
    expect(serialized).not.toContain("AA:BB")
    expect(serialized).not.toContain("Private Wi-Fi")
    expect(serialized).not.toContain("192.0.2")
    expect(serialized).not.toContain("password")
  })

  test("only accepted writes are delivered and rate limits honor the server window", () => {
    expect(retryDelayForSupportProfileResult({status: "accepted"})).toBeNull()
    expect(retryDelayForSupportProfileResult({status: "deduplicated"})).toBeNull()
    expect(retryDelayForSupportProfileResult({status: "stale"})).toBe(30_000)
    expect(retryDelayForSupportProfileResult({status: "rate_limited", retryAfterMs: 42_000})).toBe(42_000)
  })

  test("does not treat observation time as a meaningful transition", () => {
    const first = buildSnapshot(new Date("2026-08-11T12:00:00.000Z"))
    const heartbeat = buildSnapshot(new Date("2026-08-11T18:00:00.000Z"))
    expect(snapshotFingerprint(heartbeat)).toBe(snapshotFingerprint(first))
  })
})
