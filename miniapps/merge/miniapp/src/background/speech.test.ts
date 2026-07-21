import {describe, expect, test} from "bun:test"

import {insightToSpeechText} from "./speech"

describe("insightToSpeechText", () => {
  test("removes SSML and bracket markup before speaking", () => {
    expect(insightToSpeechText('Use <say-as interpret-as="characters">API</say-as> [keys] (now).')).toBe(
      "Use API keys now .",
    )
  })

  test("turns common symbols into pronounceable words", () => {
    expect(insightToSpeechText("C++ & R&D = 100% #1")).toBe("C plus plus and R and D equals 100 percent hash 1")
  })

  test("keeps markdown link labels without reading URLs", () => {
    expect(insightToSpeechText("See [Mentra docs](https://mentra.glass/docs)")).toBe("See Mentra docs")
  })

  test("speaks encoded and literal comparison operators", () => {
    expect(insightToSpeechText("3 &lt; 5, a > b, and x <= y")).toBe(
      "3 less than 5, a greater than b, and x less than or equal to y",
    )
  })
})
