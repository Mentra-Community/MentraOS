import {describe, expect, test} from "bun:test"

import {TARGET_LANGUAGES, getFlagEmoji, getLanguageName} from "./languages"

describe("language lookup", () => {
  test("offers the complete Soniox translation language set", () => {
    expect(TARGET_LANGUAGES).toHaveLength(60)
    expect(TARGET_LANGUAGES.map(({code}) => code)).toEqual(
      expect.arrayContaining(["af", "bn", "he", "ru", "sw", "th", "uk", "ur", "cy"]),
    )
    expect(TARGET_LANGUAGES.every(({flag}) => flag && flag !== "🏳️")).toBe(true)
  })

  test("resolves bare codes", () => {
    expect(getLanguageName("es")).toBe("Spanish")
    expect(getFlagEmoji("es")).toBe("🇪🇸")
  })

  test("resolves BCP-47 tags by primary subtag (not the white-flag fallback)", () => {
    expect(getLanguageName("es-ES")).toBe("Spanish")
    expect(getFlagEmoji("es-ES")).toBe("🇪🇸")
    expect(getLanguageName("en-US")).toBe("English")
    expect(getFlagEmoji("en-US")).toBe("🇺🇸")
    expect(getFlagEmoji("PT-BR")).toBe("🇵🇹")
  })

  test("unknown codes fall back to the raw code and white flag", () => {
    expect(getLanguageName("xx-YY")).toBe("xx-YY")
    expect(getFlagEmoji("xx-YY")).toBe("🏳️")
  })
})
