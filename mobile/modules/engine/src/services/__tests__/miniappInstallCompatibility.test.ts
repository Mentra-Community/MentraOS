/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {DeviceTypes, evenRealitiesG1, getModelCapabilities, mentraLive} from "../../types"
import {
  checkMiniappInstallCompatibility,
  checkMiniappRunsOnPhone,
  missingRequiredHardware,
} from "../miniappInstallCompatibility"

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

describe("what the phone can run", () => {
  const phone = {hostVersion: "2.13.0", supportedSdkRange: "^0.3.0"}

  test("hardware never refuses a release: it describes the glasses, not the phone", () => {
    expect(
      checkMiniappRunsOnPhone({hardwareRequirements: [{type: "CAMERA", level: "REQUIRED"}]} as never, phone),
    ).toEqual({compatible: true})
  })

  test("a Mentra App or SDK that is too old still refuses", () => {
    expect(checkMiniappRunsOnPhone({minHostVersion: "3.0.0"}, phone)).toMatchObject({
      compatible: false,
      blocker: "host",
    })
    expect(checkMiniappRunsOnPhone({sdkVersion: "0.4.0"}, phone)).toMatchObject({compatible: false, blocker: "sdk"})
  })
})

describe("required hardware the glasses lack", () => {
  const noGlasses = getModelCapabilities(DeviceTypes.NONE)
  const camera = {type: "CAMERA", level: "REQUIRED"}
  const display = {type: "DISPLAY", level: "REQUIRED"}

  test("lists what these glasses lack", () => {
    expect(missingRequiredHardware([camera, display], evenRealitiesG1)).toEqual(["CAMERA"])
    expect(missingRequiredHardware([camera], mentraLive)).toEqual([])
  })

  test("with no glasses paired, all required hardware is missing", () => {
    expect(missingRequiredHardware([camera, display], noGlasses)).toEqual(["CAMERA", "DISPLAY"])
  })

  test("leaves out optional hardware, and requirements it can't read", () => {
    expect(missingRequiredHardware([{type: "CAMERA", level: "OPTIONAL"}], noGlasses)).toEqual([])
    expect(missingRequiredHardware("camera", noGlasses)).toEqual([])
    expect(missingRequiredHardware(undefined, noGlasses)).toEqual([])
  })
})
