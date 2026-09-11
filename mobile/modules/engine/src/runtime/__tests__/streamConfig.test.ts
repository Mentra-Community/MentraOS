/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {normalizeStreamAudioConfig, normalizeStreamVideoConfig} from "../streamConfig"

describe("stream config normalizers", () => {
  test("preserves local miniapp video fps", () => {
    expect(
      normalizeStreamVideoConfig({
        width: 1280,
        height: 720,
        bitrate: 1_000_000,
        fps: 24,
        ignored: true,
      }),
    ).toEqual({
      width: 1280,
      height: 720,
      bitrate: 1_000_000,
      fps: 24,
    })
  })

  test("keeps cloud frameRate compatibility at the runtime boundary", () => {
    expect(normalizeStreamVideoConfig({frameRate: 15, fps: 24})).toEqual({fps: 15})
  })

  test("keeps only supported audio fields", () => {
    expect(
      normalizeStreamAudioConfig({
        bitrate: 64_000,
        sampleRate: 16_000,
        echoCancellation: true,
        noiseSuppression: false,
        ignored: true,
      }),
    ).toEqual({
      bitrate: 64_000,
      sampleRate: 16_000,
      echoCancellation: true,
      noiseSuppression: false,
    })
  })
})
