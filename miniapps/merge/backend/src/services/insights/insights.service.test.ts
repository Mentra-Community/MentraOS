import {describe, expect, test} from "bun:test"

import {buildPrompt, mergeInstructions, type InsightRequest} from "./insights.service"

describe("insight expansion prompts", () => {
  const request: InsightRequest = {
    frequency: "medium",
    settings: {answerLanguage: "English"},
    interaction: {
      type: "expand",
      insight: {
        id: "insight-1",
        text: "Saturn's rings are mostly water ice.",
        agentType: "Initial",
        sources: [],
      },
      requestedAt: 123,
    },
    analysis: {
      trigger: "expand",
      chunkText: "Saturn's rings are mostly water ice.",
      isFinal: true,
      isInterim: false,
      canDefer: false,
    },
    history: {
      activeInsight: {
        text: "Saturn's rings are mostly water ice.",
        ageMs: 250,
      },
    },
  }

  test("tells the model to elaborate instead of repeating the insight", () => {
    const instructions = mergeInstructions("medium", "English", true)

    expect(instructions).toContain("explicitly tapped for more detail")
    expect(instructions).toContain("Do not merely restate the original")
    expect(instructions).toContain("under 180 characters")
  })

  test("includes the selected insight and interaction in the model prompt", () => {
    const prompt = JSON.parse(buildPrompt(request)) as Record<string, unknown>

    expect(prompt.analysisTrigger).toBe("expand")
    expect(prompt.interaction).toEqual(request.interaction)
    expect(prompt.currentInsightOnDisplay).toEqual(request.history?.activeInsight)
  })

  test("keeps the selective rules for unsolicited insights", () => {
    const instructions = mergeInstructions("medium", "English")

    expect(instructions).toContain("Usually remain silent")
    expect(instructions).toContain("ideally under 80 characters")
    expect(instructions).not.toContain("explicitly swiped for more detail")
  })
})
