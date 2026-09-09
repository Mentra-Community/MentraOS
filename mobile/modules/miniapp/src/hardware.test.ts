/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {HardwareRequirementLevel, HardwareType, type HardwareRequirement} from "./hardware"

describe("miniapp manifest hardware contract", () => {
  test("preserves the public hardware values", () => {
    expect(Object.values(HardwareType)).toEqual([
      "CAMERA",
      "DISPLAY",
      "MICROPHONE",
      "SPEAKER",
      "IMU",
      "BUTTON",
      "LIGHT",
      "WIFI",
      "EXIST",
    ])
    expect(Object.values(HardwareRequirementLevel)).toEqual(["REQUIRED", "OPTIONAL"])
  })

  test("types a complete manifest requirement", () => {
    const requirement: HardwareRequirement = {
      type: HardwareType.CAMERA,
      level: HardwareRequirementLevel.REQUIRED,
      description: "Captures photos",
    }
    expect(requirement).toEqual({type: "CAMERA", level: "REQUIRED", description: "Captures photos"})
  })
})
