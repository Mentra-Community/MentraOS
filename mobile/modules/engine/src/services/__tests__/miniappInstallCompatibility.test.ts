/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {evenRealitiesG1, mentraLive} from "../../types"
import {checkMiniappInstallCompatibility} from "../miniappInstallCompatibility"

const policy = {
  hostVersion: "2.13.0",
  supportedSdkRange: "^0.3.0",
  hardwareCapabilities: evenRealitiesG1,
}

describe("miniapp install compatibility", () => {
  test("rejects a camera-required release for Even Realities G1", () => {
    const result = checkMiniappInstallCompatibility(
      {hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}]},
      policy,
    )
    expect(result.compatible).toBe(false)
    if (!result.compatible) {
      expect(result.blocker).toBe("hardware")
      expect(result.reason).toContain("camera")
    }
  })

  test("accepts that camera-required release for Mentra Live", () => {
    expect(
      checkMiniappInstallCompatibility(
        {hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}]},
        {...policy, hardwareCapabilities: mentraLive},
      ),
    ).toEqual({compatible: true})
  })

  test("allows missing optional hardware", () => {
    expect(
      checkMiniappInstallCompatibility({hardwareRequirements: [{type: "CAMERA", level: "OPTIONAL"}]}, policy)
        .compatible,
    ).toBe(true)
  })

  test("reports host and SDK blockers separately", () => {
    expect(checkMiniappInstallCompatibility({minHostVersion: "3.0.0"}, policy)).toMatchObject({
      compatible: false,
      blocker: "host",
    })
    expect(checkMiniappInstallCompatibility({sdkVersion: "0.4.0"}, policy)).toMatchObject({
      compatible: false,
      blocker: "sdk",
    })
  })
})
