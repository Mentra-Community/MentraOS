/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test";
import {
  HardwareRequirementLevel,
  HardwareType,
} from "@mentra/sdk";

import {vuzixZ100} from "../../../config/capabilities/vuzix-z100";
import {AppI} from "../../../models/app.model";
import {HardwareCompatibilityService} from "../HardwareCompatibilityService";

function appWithRequirements(
  hardwareRequirements: AppI["hardwareRequirements"],
): AppI {
  return {hardwareRequirements} as AppI;
}

describe("HardwareCompatibilityService", () => {
  test("accepts a microphone requirement when glasses use the phone microphone fallback", () => {
    expect(vuzixZ100.hasMicrophone).toBe(false);

    const result = HardwareCompatibilityService.checkCompatibility(
      appWithRequirements([
        {
          type: HardwareType.MICROPHONE,
          level: HardwareRequirementLevel.REQUIRED,
        },
      ]),
      vuzixZ100,
    );

    expect(result).toEqual({
      isCompatible: true,
      missingRequired: [],
      missingOptional: [],
      warnings: [],
    });
  });

  test("continues to reject unavailable physical hardware", () => {
    const result = HardwareCompatibilityService.checkCompatibility(
      appWithRequirements([
        {
          type: HardwareType.MICROPHONE,
          level: HardwareRequirementLevel.REQUIRED,
        },
        {
          type: HardwareType.SPEAKER,
          level: HardwareRequirementLevel.REQUIRED,
        },
      ]),
      vuzixZ100,
    );

    expect(result.isCompatible).toBe(false);
    expect(result.missingRequired).toEqual([
      {
        type: HardwareType.SPEAKER,
        level: HardwareRequirementLevel.REQUIRED,
      },
    ]);
  });
});
