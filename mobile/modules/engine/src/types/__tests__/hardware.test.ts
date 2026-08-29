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
})
