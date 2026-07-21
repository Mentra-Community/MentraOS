import {describe, expect, mock, test} from "bun:test"

import {insightToSpeechText, speakInsightText} from "./speech"

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

  test("leaves numeric slashes for natural date and fraction speech", () => {
    expect(insightToSpeechText("Meet on 7/21 after using 3/4 cup; choose and/or.")).toBe(
      "Meet on 7/21 after using 3/4 cup; choose and slash or.",
    )
  })

  test("stops prior audio when an insight has no speakable content", async () => {
    const speaker = {
      speak: mock(() => Promise.resolve()),
      stop: mock(() => undefined),
    }

    await speakInsightText(speaker, "<break /> [] {}")

    expect(speaker.stop).toHaveBeenCalledTimes(1)
    expect(speaker.speak).not.toHaveBeenCalled()
  })
})
