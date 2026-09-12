/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {Pcm16LevelMeter, pcmDataView, summarizePcm16} from "../pcm16"

function pcm16(...samples: number[]): ArrayBuffer {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
  return bytes.buffer
}

describe("pcmDataView", () => {
  test("wraps ArrayBuffer, typed-array views and plain arrays; rejects the rest", () => {
    expect(pcmDataView(pcm16(1))).toBeInstanceOf(DataView)
    expect(pcmDataView(new Uint8Array(pcm16(1)))).toBeInstanceOf(DataView)
    expect(pcmDataView([1, 0])).toBeInstanceOf(DataView)
    expect(pcmDataView(null)).toBeNull()
    expect(pcmDataView("pcm")).toBeNull()
  })
})

describe("Pcm16LevelMeter", () => {
  test("matches summarizePcm16 over the same frames and resets on take()", () => {
    const frames = [pcm16(0, 100, -100), new Uint8Array(pcm16(400))]
    const meter = new Pcm16LevelMeter()
    for (const frame of frames) meter.add(frame)

    expect(meter.take()).toEqual(summarizePcm16(frames))
    expect(meter.take()).toEqual({meanAbs: 0, peak: 0, samples: 0})
  })

  test("ignores frames it cannot read without poisoning the window", () => {
    const meter = new Pcm16LevelMeter()
    meter.add(undefined)
    meter.add(pcm16(50))
    expect(meter.take()).toEqual({meanAbs: 50, peak: 50, samples: 1})
  })
})
