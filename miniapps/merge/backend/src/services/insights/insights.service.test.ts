import {describe, expect, test} from "bun:test"

import {buildPrompt, InsightsService, mergeInstructions, type InsightRequest} from "./insights.service"

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

describe("Gemini model failover", () => {
  const request: InsightRequest = {
    analysis: {
      chunkText: "Where is Copenhagen located?",
      isFinal: true,
    },
  }

  test("uses a fallback model after a retryable primary failure", async () => {
    const requestedModels: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      requestedModels.push(String(input))
      if (requestedModels.length === 1) {
        return new Response("primary unavailable", {status: 503})
      }
      return geminiResponse({
        type: "insight",
        text: "Copenhagen is the capital of Denmark.",
      })
    }) as typeof fetch
    const service = new InsightsService({
      apiKey: "test-key",
      fetch: fetcher,
      primaryModel: "gemini-primary",
      fallbackModels: ["gemini-fallback"],
    })

    const result = await service.createInsight(request)

    expect(requestedModels).toHaveLength(2)
    expect(requestedModels[0]).toContain("models/gemini-primary:generateContent")
    expect(requestedModels[1]).toContain("models/gemini-fallback:generateContent")
    expect(result.type).toBe("insight")
    expect(result.profiling?.model).toBe("gemini-fallback")
  })

  test("does not retry credential failures with another model", async () => {
    let requestCount = 0
    const fetcher = (async () => {
      requestCount += 1
      return new Response("invalid API key", {status: 403})
    }) as typeof fetch
    const service = new InsightsService({
      apiKey: "test-key",
      fetch: fetcher,
      primaryModel: "gemini-primary",
      fallbackModels: ["gemini-fallback"],
    })

    await expect(service.createInsight(request)).rejects.toMatchObject({
      name: "InsightServiceError",
      status: 503,
    })
    expect(requestCount).toBe(1)
  })

  test("falls back when the primary returns invalid JSON", async () => {
    let requestCount = 0
    const fetcher = (async () => {
      requestCount += 1
      if (requestCount === 1) return new Response("not json")
      return geminiResponse({type: "silent", reasoning: "No useful addition"})
    }) as typeof fetch
    const service = new InsightsService({
      apiKey: "test-key",
      fetch: fetcher,
      primaryModel: "gemini-primary",
      fallbackModels: ["gemini-fallback"],
    })

    const result = await service.createInsight(request)

    expect(requestCount).toBe(2)
    expect(result.type).toBe("silent")
    expect(result.profiling?.model).toBe("gemini-fallback")
  })
})

function geminiResponse(output: Record<string, unknown>): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [{text: JSON.stringify(output)}],
        },
      },
    ],
  })
}
