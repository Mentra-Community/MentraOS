import {describe, expect, test} from "bun:test"

import {HardwareRequirementLevel, HardwareType} from "../../../types"
import {vuzixZ100} from "../../../types/capabilities/vuzix-z100"
import {HardwareCompatibility} from "../hardware"

describe("HardwareCompatibility", () => {
  test("accepts a microphone requirement when glasses use the phone microphone fallback", () => {
    expect(vuzixZ100.hasMicrophone).toBe(false)

    const result = HardwareCompatibility.checkCompatibility(
      [{type: HardwareType.MICROPHONE, level: HardwareRequirementLevel.REQUIRED}],
      vuzixZ100,
    )

    expect(result).toEqual({
      isCompatible: true,
      missingRequired: [],
      missingOptional: [],
      warnings: [],
    })
  })

  test("continues to reject unavailable physical hardware", () => {
    const result = HardwareCompatibility.checkCompatibility(
      [
        {type: HardwareType.MICROPHONE, level: HardwareRequirementLevel.REQUIRED},
        {type: HardwareType.SPEAKER, level: HardwareRequirementLevel.REQUIRED},
      ],
      vuzixZ100,
    )

    expect(result.isCompatible).toBe(false)
    expect(result.missingRequired).toEqual([{type: HardwareType.SPEAKER, level: HardwareRequirementLevel.REQUIRED}])
  })
})
