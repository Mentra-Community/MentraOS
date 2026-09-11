import {describe, expect, test} from "bun:test"

import type {StreamStatusEvent} from "@mentra/bluetooth-sdk/internal"

import {slimStreamStatusEvent} from "../slimStreamStatus"

const event: StreamStatusEvent = {
  type: "stream_status",
  kind: "lifecycle",
  status: "streaming",
  streamId: "phone-1",
  timestamp: 1_700_000_000_000,
  stats: {bitrate: 912_345, fps: 19.8, droppedFrames: 2, duration: 31},
}

describe("slimStreamStatusEvent", () => {
  test("drops stats when FPS telemetry is off without mutating the incoming event", () => {
    const slim = slimStreamStatusEvent(event, {enableFpsTelemetry: false})
    expect(slim.stats).toBeUndefined()
    expect(slim).toMatchObject({
      type: "stream_status",
      kind: "lifecycle",
      status: "streaming",
      streamId: "phone-1",
    })
    expect(event.stats).toEqual({bitrate: 912_345, fps: 19.8, droppedFrames: 2, duration: 31})
  })

  test("keeps stats when FPS telemetry is on", () => {
    const slim = slimStreamStatusEvent(event, {enableFpsTelemetry: true})
    expect(slim.stats).toEqual(event.stats)
  })
})
