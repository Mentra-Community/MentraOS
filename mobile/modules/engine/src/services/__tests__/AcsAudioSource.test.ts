import {describe, expect, test} from "bun:test"

import {resolveAudioSource} from "../acsAudioSource"

describe("resolveAudioSource", () => {
  test("explicit glasses", () => {
    expect(
      resolveAudioSource({
        preferred: "glasses",
        currentMic: "phone",
        micRanking: ["phone"],
        glassesConnected: false,
      }),
    ).toEqual({source: "glasses", reason: "explicit"})
  })

  test("explicit phone", () => {
    expect(
      resolveAudioSource({
        preferred: "phone",
        currentMic: "glasses",
        micRanking: ["glasses"],
        glassesConnected: true,
      }),
    ).toEqual({source: "phone", reason: "explicit"})
  })

  test("explicit bluetooth maps to phone", () => {
    expect(
      resolveAudioSource({
        preferred: "bluetooth",
        currentMic: "glasses",
        micRanking: ["glasses"],
        glassesConnected: true,
      }),
    ).toEqual({source: "phone", reason: "explicit"})
  })

  test("auto uses currentMic phone", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: "phone",
        micRanking: ["glasses"],
        glassesConnected: true,
      }),
    ).toEqual({source: "phone", reason: "current-mic"})
  })

  test("auto uses currentMic glasses", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: "glasses",
        micRanking: ["phone"],
        glassesConnected: true,
      }),
    ).toEqual({source: "glasses", reason: "current-mic"})
  })

  test("auto uses currentMic bluetooth", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: "bluetooth",
        micRanking: ["glasses"],
        glassesConnected: true,
      }),
    ).toEqual({source: "phone", reason: "current-mic"})
  })

  test("auto uses currentMic bluetoothClassic", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: "bluetoothClassic",
        micRanking: ["glasses"],
        glassesConnected: true,
      }),
    ).toEqual({source: "phone", reason: "current-mic"})
  })

  test("auto falls through to micRanking glasses", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: null,
        micRanking: ["glasses", "phone"],
        glassesConnected: false,
      }),
    ).toEqual({source: "glasses", reason: "ranking"})
  })

  test("auto falls through to micRanking phone", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: null,
        micRanking: ["phone"],
        glassesConnected: true,
      }),
    ).toEqual({source: "phone", reason: "ranking"})
  })

  test("auto empty ranking with glasses connected falls back to glasses", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: null,
        micRanking: [],
        glassesConnected: true,
      }),
    ).toEqual({source: "glasses", reason: "fallback-glasses-connected"})
  })

  test("auto empty ranking without glasses falls back to phone", () => {
    expect(
      resolveAudioSource({
        preferred: "auto",
        currentMic: null,
        micRanking: [],
        glassesConnected: false,
      }),
    ).toEqual({source: "phone", reason: "fallback-no-glasses"})
  })

  test("unknown preferred setting behaves like auto", () => {
    expect(
      resolveAudioSource({
        preferred: "mystery",
        currentMic: null,
        micRanking: [],
        glassesConnected: true,
      }),
    ).toEqual({source: "glasses", reason: "fallback-glasses-connected"})
  })

  test("undefined preferred treated as auto via empty string", () => {
    expect(
      resolveAudioSource({
        preferred: "",
        currentMic: "glasses",
        micRanking: [],
        glassesConnected: false,
      }),
    ).toEqual({source: "glasses", reason: "current-mic"})
  })
})
