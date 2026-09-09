import {describe, expect, test} from "bun:test"

import {resolveOtaReleaseVersion} from "../otaReleaseVersion"

describe("resolveOtaReleaseVersion", () => {
  test("uses the packaged stable identity when production promotes exact beta OTA bytes", () => {
    expect(
      resolveOtaReleaseVersion({
        manifestReleaseVersion: "3.1.0-beta.57",
        manifestUrl: "https://example.com/ota.json",
        packagedManifestUrl: "https://example.com/ota.json",
        packagedReleaseIdentity: "3.1.0",
      }),
    ).toBe("3.1.0")
  })

  test("uses the manifest identity for a different host or developer pin", () => {
    expect(
      resolveOtaReleaseVersion({
        manifestReleaseVersion: "3.2.0-beta.4",
        manifestUrl: "https://example.com/override.json",
        packagedManifestUrl: "https://example.com/packaged.json",
        packagedReleaseIdentity: "3.1.0",
      }),
    ).toBe("3.2.0-beta.4")
  })

  test("does not expose an invalid release label", () => {
    expect(
      resolveOtaReleaseVersion({
        manifestReleaseVersion: "asg.40",
        manifestUrl: "https://example.com/ota.json",
      }),
    ).toBeNull()
  })
})
