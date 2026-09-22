import {describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {assertFirmwareState, parseFirmwareProfile, type FirmwareObservation} from "./firmware-profile"

const sha = "a".repeat(64)
const fixture = {
  usb: "1048576X",
  cid: "1".repeat(32),
  bluetooth: "CC:E7:DE:E0:03:BE",
  serials: ["ML396102B", "0123456789ABCDEF"],
}
const manifest = {
  apps: {
    "com.mentra.asg_client": {versionCode: 123, apkUrl: "https://example.com/asg.apk", apkSize: 12345, sha256: sha},
  },
  bes_firmware: {version: "26.9.21.1", url: "https://example.com/bes.bin", sha256: "b".repeat(64)},
  mtk_full_ota: {end_firmware: "20260915.0", url: "https://example.com/mtk.zip", size: 56789, sha256: "c".repeat(64)},
  mtk_patches: [{start_firmware: "20260113", end_firmware: "20260709"}],
}
function parse(value: unknown = manifest) {
  const bytes = Buffer.from(JSON.stringify(value))
  return parseFirmwareProfile(bytes, {
    url: "https://example.com/frozen.json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  })
}
const now = Date.parse("2026-09-22T01:00:00Z")
const state = (): FirmwareObservation => ({
  at: new Date(now - 1000).toISOString(),
  evidence: "verification/hardware.json",
  usb: fixture.usb,
  cid: fixture.cid,
  bluetooth: fixture.bluetooth,
  serial: "ML396102B",
  bootId: "d8564fd1-d6ec-4ecb-9f48-b91d7ed41aeb",
  bootCompleted: true,
  firmware: "MentraLive_20260915.0",
  asgVersion: 123,
  activeApkSha256: sha,
  bes: {
    version: "26.9.21.1",
    at: new Date(now - 500).toISOString(),
    bootId: "d8564fd1-d6ec-4ecb-9f48-b91d7ed41aeb",
    evidence: "hardware/fresh-bes.log",
  },
  updateIdle: true,
  appConnected: true,
})
const failed = (observed: Partial<FirmwareObservation>) =>
  assertFirmwareState(parse(), fixture, observed, now)
    .filter((row) => row.status === "failed")
    .map((row) => row.id)

describe("manifest-derived firmware target", () => {
  test("uses the full OTA destination and active APK hash, not intermediate patch or update-file hashes", () => {
    const target = parse()
    expect(target.mtk.version).toBe("MentraLive_20260915.0")
    expect(target.bes.artifact.size).toBeUndefined()
    expect(failed(state())).toEqual([])
  })
  test("rejects a changed manifest before accepting its target", () => {
    expect(() =>
      parseFirmwareProfile(Buffer.from(JSON.stringify(manifest)), {
        url: "https://example.com/frozen.json",
        sha256: sha,
      }),
    ).toThrow("frozen selection")
  })
  test("rejects unpinned targets, invalid sizes and credential-bearing URLs", () => {
    for (const patch of [
      {sha256: ""},
      {apkSize: -1},
      {apkSize: true},
      {versionCode: true},
      {apkUrl: "https://user:secret@example.com/app.apk"},
    ]) {
      expect(() =>
        parse({...manifest, apps: {"com.mentra.asg_client": {...manifest.apps["com.mentra.asg_client"], ...patch}}}),
      ).toThrow()
    }
    expect(() => parse({...manifest, mtk_full_ota: undefined})).toThrow()
  })
  test("rejects full images the app cannot use for recovery", () => {
    for (const patch of [{size: undefined}, {size: 1073741825}, {start_firmware: "20260113"}])
      expect(() => parse({...manifest, mtk_full_ota: {...manifest.mtk_full_ota, ...patch}})).toThrow("MTK full OTA")
  })
})

describe("independent return-state assertions", () => {
  test("allows an explicitly recorded legacy serial only with matching USB and CID", () => {
    const observed = {...state(), serial: "0123456789ABCDEF"}
    expect(failed(observed)).toEqual([])
    expect(failed({...observed, cid: "2".repeat(32)})).toContain("identity.cid")
    expect(failed({...observed, usb: "different"})).toContain("identity.usb")
  })
  test("rejects missing, stale, future and unsupported evidence", () => {
    expect(failed({}).length).toBe(14)
    expect(failed({...state(), at: new Date(now - 31000).toISOString()})).toContain("observation.fresh")
    expect(failed({...state(), at: new Date(now + 1000).toISOString()})).toContain("observation.fresh")
    expect(failed({...state(), evidence: ""}).length).toBe(12)
  })
  test("requires a fresh BES response from the same boot", () => {
    const observed = state()
    for (const patch of [{at: new Date(now - 31000).toISOString()}, {bootId: "previous-boot"}])
      expect(failed({...observed, bes: {...observed.bes, ...patch}})).toContain("firmware.bes.fresh")
    expect(failed({...observed, bes: {...observed.bes, evidence: ""}})).toContain("firmware.bes.version")
  })
  test("does not pass completion with a wrong APK, ongoing update or disconnected app", () => {
    const result = failed({...state(), activeApkSha256: "d".repeat(64), updateIdle: false, appConnected: false})
    expect(result).toEqual(["firmware.asg.active-apk", "update.idle", "app.connected"])
  })
})
