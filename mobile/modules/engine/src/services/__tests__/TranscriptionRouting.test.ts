/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {shouldDeliverTranscription, summarizeTranscriptionRoutes} from "../TranscriptionRouting"

describe("transcription routing", () => {
  test("keeps cloud enabled for mixed subscribers and starts local for forced subscribers", () => {
    const forced = new Set(["local-app"])
    expect(summarizeTranscriptionRoutes(["cloud-app", "local-app"], (app) => forced.has(app))).toEqual({
      hasCloudSubscriber: true,
      hasForceLocalSubscriber: true,
    })
  })

  test("does not subscribe cloud when every subscriber is forceLocal", () => {
    expect(summarizeTranscriptionRoutes(["one", "two"], () => true)).toEqual({
      hasCloudSubscriber: false,
      hasForceLocalSubscriber: true,
    })
  })

  test("isolates cloud and local events while connected", () => {
    expect(shouldDeliverTranscription("cloud", false, true)).toBe(true)
    expect(shouldDeliverTranscription("cloud", true, true)).toBe(false)
    expect(shouldDeliverTranscription("local", false, true)).toBe(false)
    expect(shouldDeliverTranscription("local", true, true)).toBe(true)
  })

  test("delivers local fallback to every subscriber while cloud is disconnected", () => {
    expect(shouldDeliverTranscription("local", false, false)).toBe(true)
    expect(shouldDeliverTranscription("local", true, false)).toBe(true)
  })
})
