import {describe, expect, test} from "bun:test"

import {getFlagEmoji, getLanguageName} from "./languages"

describe("language lookup", () => {
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
