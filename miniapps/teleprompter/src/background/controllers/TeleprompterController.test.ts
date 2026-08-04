import {describe, expect, test} from "bun:test"

import {serializeDisplayLines} from "./TeleprompterController"

describe("serializeDisplayLines", () => {
  test("preserves blank rows without consecutive newlines", () => {
    const text = serializeDisplayLines(["Welcome to your teleprompter.", "", "Paste your script here.", ""])

    expect(text).toBe("Welcome to your teleprompter.\n\u200B\nPaste your script here.\n\u200B")
    expect(text).not.toContain("\n\n")
    expect(text.split("\n")[1].trim()).toBe("\u200B")
  })

  test("does not alter visible text", () => {
    expect(serializeDisplayLines(["First line", "Second line"])).toBe("First line\nSecond line")
  })
})
