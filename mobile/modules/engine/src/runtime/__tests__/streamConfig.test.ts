/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {
  normalizeCaptureAudio,
  normalizeStreamAudioConfig,
  normalizeStreamVideoConfig,
  resolveCaptureAudio,
} from "../streamConfig"

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

  test("captureAudio defaults true and honors explicit false", () => {
    expect(normalizeCaptureAudio(undefined)).toBe(true)
    expect(normalizeCaptureAudio("yes")).toBe(true)
    expect(normalizeCaptureAudio(true)).toBe(true)
    expect(normalizeCaptureAudio(false)).toBe(false)
    expect(normalizeCaptureAudio(undefined, false)).toBe(false)
  })

  test("resolveCaptureAudio follows the resolved mic and never fail-opens to glasses", () => {
    expect(resolveCaptureAudio(undefined, "glasses")).toBe(true)
    expect(resolveCaptureAudio(true, "glasses")).toBe(true)
    expect(resolveCaptureAudio(false, "glasses")).toBe(false)
    expect(resolveCaptureAudio(undefined, "phone")).toBe(false)
    expect(resolveCaptureAudio(true, "phone")).toBe(false)
    expect(resolveCaptureAudio(false, "phone")).toBe(false)
  })
})
