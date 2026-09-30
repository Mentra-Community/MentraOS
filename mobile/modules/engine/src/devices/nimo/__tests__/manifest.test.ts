import {describe, expect, test} from "bun:test"
import {nimoCompatibility, parseNimoVersion} from "../firmwareVersion"
import {parseNimoManifest} from "../manifest"

const fullVersion = "FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug"
const fixture = () => ({
  schemaVersion: 1,
  releaseId: "vendor-bench-fixture",
  hardwareId: "00000201",
  target: {fullVersion, packedVersion: "0.1.1.1", peerVersion: "0001"},
  compatible: [{fullVersion, packedVersion: "0.1.1.1"}],
  upgradeFrom: ["0.1.0.14"],
  artifact: {url: "https://example.invalid/firmware.bin", sha256: "a".repeat(64), size: 1857523},
})

describe("NIMO firmware identity and release policy", () => {
  test("uses all four version components and keeps OTA peer words separate", () => {
    expect(parseNimoVersion("0.1.0.14")).toEqual([0, 1, 0, 14])
    expect(parseNimoVersion("0.1.1")).toBeNull()
    expect(parseNimoVersion("0.1.1.4096")).toBeNull()
    expect(parseNimoVersion("0.01.1.1")).toBeNull()
    const manifest = parseNimoManifest(fixture())
    expect(manifest.target.peerVersion).toBe("0001")
    expect(nimoCompatibility({fullVersion, packedVersion: "0.1.1.1"}, manifest.compatible, manifest.upgradeFrom)).toBe(
      "compatible",
    )
    expect(
      nimoCompatibility(
        {fullVersion: "FW-VERSION-v0.1.0.14-vendor-build", packedVersion: "0.1.0.14"},
        manifest.compatible,
        manifest.upgradeFrom,
      ),
    ).toBe("upgrade-required")
  })

  test("unknown newer builds and disagreeing inventories are never automatic downgrade offers", () => {
    const manifest = parseNimoManifest(fixture())
    for (const observed of [
      {fullVersion: "FW-VERSION-v0.1.2.0-unverified", packedVersion: "0.1.2.0"},
      {fullVersion, packedVersion: "0.1.0.14"},
      {fullVersion: "unknown", packedVersion: "0.1.0.14"},
      {fullVersion: "FW-VERSION-v0.1.1.1-other-build", packedVersion: "0.1.1.1"},
    ])
      expect(nimoCompatibility(observed, manifest.compatible, manifest.upgradeFrom)).toBe("unknown")
  })

  test("rejects unsupported sources, mismatched identities, and implicit reflash", () => {
    expect(() => parseNimoManifest({...fixture(), schemaVersion: 2})).toThrow()
    expect(() => parseNimoManifest({...fixture(), compatible: []})).toThrow()
    expect(() => parseNimoManifest({...fixture(), upgradeFrom: ["0.1.1.1"]})).toThrow()
    expect(() => parseNimoManifest({...fixture(), upgradeFrom: ["0.1.2.0"]})).toThrow()
    expect(() => parseNimoManifest({...fixture(), target: {...fixture().target, packedVersion: "0.1.0.14"}})).toThrow()
    for (const artifact of [
      {...fixture().artifact, url: "http://example.invalid/file"},
      {...fixture().artifact, sha256: ""},
      {...fixture().artifact, size: -1},
    ])
      expect(() => parseNimoManifest({...fixture(), artifact})).toThrow()
  })
})
