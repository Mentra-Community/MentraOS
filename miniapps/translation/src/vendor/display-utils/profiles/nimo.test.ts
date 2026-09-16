import {describe, expect, test} from "bun:test"

import * as profiles from "./index"
import {TextMeasurer} from "../measurer/TextMeasurer"
import {TextWrapper} from "../wrapper/TextWrapper"
import * as selection from "../../../background/controllers/TranslationController"

describe("translation NIMO display profile", () => {
  test("does not select NIMO for unrelated names containing nimo", () => {
    for (const model of ["Animotion", "Nimology", "ANIMO", "NIMO2", " NIMOBUS "]) {
      expect(selection.getProfileForModel(model)).toBe(profiles.G1_PROFILE)
    }
  })

  test("maps every advertised NIMO model without changing the G1 fallback", () => {
    for (const model of ["NIMO", "Nimo", "nimo", "Nimo-7188", "NIMO Smart Glasses", " \tnImO \n"]) {
      expect(selection.getProfileForModel(model).id).toBe("nimo")
    }
    expect(selection.getProfileForModel("Even Realities G1")).toBe(profiles.G1_PROFILE)
    expect(selection.getProfileForModel(undefined)).toBe(profiles.G1_PROFILE)
    expect(selection.getProfileForModel("unknown")).toBe(profiles.G1_PROFILE)
  })

  test("measures calibrated font-0 widths and wraps at the NIMO canvas boundary", () => {
    const profile = profiles.NIMO_PROFILE
    expect(profile).toMatchObject({displayWidthPx: 500, displayHeightPx: 220, maxLines: 11, lineHeightPx: 20})
    const measurer = new TextMeasurer(profile)
    const wrapper = new TextWrapper(measurer, {breakMode: "character-no-hyphen"})
    expect(measurer.measureText("Wi 09!")).toBe(48)
    expect(measurer.measureText("你好")).toBe(32)
    for (const text of ["A".repeat(63), "你".repeat(32), "Hello 世界 ".repeat(30)]) {
      const result = wrapper.wrap(text)
      expect(result.lines.length).toBeGreaterThan(1)
      expect(result.lineMetrics.every((line) => line.widthPx <= 500)).toBe(true)
    }
    expect(wrapper.wrap("A".repeat(63)).lines).toEqual(["A".repeat(62), "A"])
    expect(wrapper.wrap("你".repeat(32)).lines).toEqual(["你".repeat(31), "你"])
    expect(new TextMeasurer(profiles.G1_PROFILE).measureText("Wi 09!")).not.toBe(48)
    expect(profiles.G1_PROFILE.displayWidthPx).toBe(576)
  })
})
