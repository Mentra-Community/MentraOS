import {describe, expect, test} from "bun:test"

import {DeviceTypes} from "../enums"
import {getModelCapabilities, nimo} from "../hardware"

describe("NIMO capabilities", () => {
  test("remain available after retiring the legacy cloud type package", () => {
    expect(DeviceTypes.NIMO).toBe("NIMO")
    expect(getModelCapabilities(DeviceTypes.NIMO)).toBe(nimo)
    expect(nimo.hasDisplay).toBe(true)
    expect(nimo.hasMicrophone).toBe(true)
  })

  test("advertise the dynamic canvas coordinate space and conservative scene policy", () => {
    expect(nimo.display).toMatchObject({
      resolution: {width: 500, height: 220},
      width: 500,
      height: 220,
      canPosition: true,
      canDisplayBitmap: true,
      maxTextLines: 11,
      maxTextElements: 32,
      maxImageElements: 4,
      maxImagePx: {width: 200, height: 200},
      shapes: ["rect"],
      intensityLevels: 4,
      partialUpdate: false,
    })
  })

  test.each(["NIMO", "Nimo", "nimo", "Nimo-7188", " NIMO Smart Glasses "])(
    "resolve capabilities for the native model name %s",
    (model) => {
      expect(getModelCapabilities(model as DeviceTypes)).toBe(nimo)
    },
  )

  test("do not treat unrelated names containing nimo as NIMO glasses", () => {
    for (const model of ["Animotion", "Nimology", "ANIMO", "NIMO2", " NIMOBUS "]) {
      expect(getModelCapabilities(model as DeviceTypes).hasDisplay).toBe(false)
    }
    expect(getModelCapabilities(" \tnImO \n" as DeviceTypes)).toBe(nimo)
  })
})
