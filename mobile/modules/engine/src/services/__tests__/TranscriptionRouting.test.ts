/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {summarizeTranscriptionRoutes, transcriptionDeliveryRoute} from "../TranscriptionRouting"

describe("transcription routing", () => {
  test("keeps cloud enabled for mixed subscribers and starts local for forced subscribers", () => {
    const forced = new Set(["local-app"])
    expect(
      summarizeTranscriptionRoutes(["cloud-app", "local-app"], (app) => ({
        cloud: !forced.has(app),
        forceLocal: forced.has(app),
      })),
    ).toEqual({hasCloudSubscriber: true, hasForceLocalSubscriber: true})
  })

  test("does not subscribe cloud when every subscriber is forceLocal", () => {
    expect(summarizeTranscriptionRoutes(["one", "two"], () => ({cloud: false, forceLocal: true}))).toEqual({
      hasCloudSubscriber: false,
      hasForceLocalSubscriber: true,
    })
  })

  test("one subscriber can require both cloud and forceLocal routes", () => {
    expect(summarizeTranscriptionRoutes(["mixed-app"], () => ({cloud: true, forceLocal: true}))).toEqual({
      hasCloudSubscriber: true,
      hasForceLocalSubscriber: true,
    })
  })

  test("isolates cloud and local events while connected", () => {
    expect(transcriptionDeliveryRoute("cloud", {cloud: true, forceLocal: true}, true)).toBe("default")
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: true}, true)).toBe("forceLocal")
    expect(transcriptionDeliveryRoute("cloud", {cloud: false, forceLocal: true}, true)).toBeNull()
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: false}, true)).toBeNull()
  })

  test("delivers local fallback to every subscriber while cloud is disconnected", () => {
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: true}, false)).toBe("all")
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: false}, false)).toBe("default")
    expect(transcriptionDeliveryRoute("local", {cloud: false, forceLocal: true}, false)).toBe("forceLocal")
  })
})
