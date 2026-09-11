import {describe, expect, test} from "bun:test"

import {resolveOtaManifestPolicy, selectModernOtaManifestPin} from "../otaManifestPolicy"

describe("OTA manifest policy", () => {
  test("uses explicit modern pins in developer, host, then Engine order", () => {
    const pins = {
      developerOverride: "https://updates.example.com/developer.json",
      hostReleasePin: "https://updates.example.com/host.json",
      engineReleasePin: "https://updates.example.com/engine.json",
    }

    expect(selectModernOtaManifestPin(pins)).toBe(pins.developerOverride)
    expect(selectModernOtaManifestPin({...pins, developerOverride: null})).toBe(pins.hostReleasePin)
    expect(selectModernOtaManifestPin({...pins, developerOverride: null, hostReleasePin: null})).toBe(
      pins.engineReleasePin,
    )
  })

  test("fails closed for an unpinned modern build and ignores device or mutable fleet state", () => {
    expect(
      resolveOtaManifestPolicy({
        glassesBuildNumber: "39",
        glassesUrl: "https://updates.example.com/glasses-reported.json",
      }),
    ).toBeNull()
  })

  test("retains the explicit pre-39 legacy protocol path", () => {
    expect(
      resolveOtaManifestPolicy({
        glassesBuildNumber: "38",
        glassesUrl: "https://updates.example.com/legacy-device.json",
        developerOverride: "https://updates.example.com/ignored.json",
      }),
    ).toBe("https://updates.example.com/legacy-device.json")

    expect(resolveOtaManifestPolicy({glassesBuildNumber: "36"})).toBe(
      "https://ota.mentraglass.com/prod_live_version.json",
    )
  })
})
