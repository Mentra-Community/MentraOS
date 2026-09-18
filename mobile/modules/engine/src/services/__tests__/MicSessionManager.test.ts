/// <reference types="bun-types" />

import {afterAll, beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"

import "./reactNativeTestMock"
import {bluetoothSdk} from "./bluetoothSdkTestMock"

const setMicSourcePin = mock((_source: string | null) => Promise.resolve())
bluetoothSdk.setMicSourcePin = setMicSourcePin

// Import AFTER the SDK mock is registered.
const micSessionManager = require("../MicSessionManager").default
const {MIC_SOURCE_CONFLICT} = require("../MicSessionManager")

/**
 * The coordinator is patched on the instance rather than through `mock.module`.
 *
 * bun's module registry is process-wide and last-factory-wins, so mocking `../MicStateCoordinator`
 * here would hand every other suite in the run a stub instead of the real coordinator.
 */
const micStateCoordinator = require("../MicStateCoordinator").default
const realCoordinator = {
  setSessionRequirement: micStateCoordinator.setSessionRequirement,
  setSessionMicTuning: micStateCoordinator.setSessionMicTuning,
}
const setSessionRequirement = mock((_pcm: boolean) => {})
const setSessionMicTuning = mock((_profile: unknown) => {})

beforeAll(() => {
  micStateCoordinator.setSessionRequirement = setSessionRequirement
  micStateCoordinator.setSessionMicTuning = setSessionMicTuning
})

afterAll(() => {
  micSessionManager.releaseAll()
  Object.assign(micStateCoordinator, realCoordinator)
})

describe("MicSessionManager", () => {
  beforeEach(() => {
    micSessionManager.setCallGainSweepEnabled(false)
    micSessionManager.releaseAll()
    micSessionManager.setPlatformCaps({glassesPcmUplink: true})
    setMicSourcePin.mockClear()
    setSessionRequirement.mockClear()
    setSessionMicTuning.mockClear()
  })

  test("a voice call pins the glasses, claims PCM and lowers the gain", () => {
    micSessionManager.acquire({owner: "com.mentra.call", source: "glasses", useCase: "voice_call"})
    expect(setMicSourcePin).toHaveBeenCalledWith("glasses")
    expect(setSessionRequirement).toHaveBeenLastCalledWith(true)
    expect(setSessionMicTuning).toHaveBeenLastCalledWith({gain: 14})
  })

  test("releasing the last session unpins and hands the tuning back", () => {
    const session = micSessionManager.acquire({
      owner: "com.mentra.call",
      source: "glasses",
      useCase: "voice_call",
    })
    setMicSourcePin.mockClear()
    session.release()
    expect(setMicSourcePin).toHaveBeenCalledWith(null)
    expect(setSessionRequirement).toHaveBeenLastCalledWith(false)
    expect(setSessionMicTuning).toHaveBeenLastCalledWith(null)
  })

  test("release is idempotent", () => {
    const session = micSessionManager.acquire({owner: "com.a", source: "glasses", useCase: "transcription"})
    session.release()
    setSessionRequirement.mockClear()
    session.release()
    expect(setSessionRequirement).not.toHaveBeenCalled()
  })

  test("a stale release cannot drop a newer session's microphone", () => {
    const first = micSessionManager.acquire({owner: "com.a", source: "glasses", useCase: "transcription"})
    const second = micSessionManager.acquire({owner: "com.b", source: "glasses", useCase: "transcription"})
    first.release()
    expect(setSessionRequirement).toHaveBeenLastCalledWith(true)
    second.release()
    expect(setSessionRequirement).toHaveBeenLastCalledWith(false)
  })

  test("a second source is refused rather than silently mixed", () => {
    micSessionManager.acquire({owner: "com.a", source: "glasses", useCase: "transcription"})
    expect(() =>
      micSessionManager.acquire({owner: "engine:mic-probe", source: "phone", useCase: "diagnostic"}),
    ).toThrow(MIC_SOURCE_CONFLICT)
  })

  test("a phone session never pins", () => {
    micSessionManager.acquire({owner: "engine:mic-probe", source: "phone", useCase: "diagnostic"})
    expect(setMicSourcePin).not.toHaveBeenCalled()
    expect(setSessionRequirement).toHaveBeenLastCalledWith(true)
  })

  test("releaseOwner drops every lease a crashed miniapp held", () => {
    micSessionManager.acquire({owner: "com.mentra.call", source: "glasses", useCase: "voice_call"})
    micSessionManager.acquire({owner: "com.mentra.call", source: "glasses", useCase: "transcription"})
    expect(micSessionManager.releaseOwner("com.mentra.call")).toBe(true)
    expect(micSessionManager.hasGlassesSession("com.mentra.call")).toBe(false)
    expect(setSessionRequirement).toHaveBeenLastCalledWith(false)
    expect(setSessionMicTuning).toHaveBeenLastCalledWith(null)
  })

  test("hasGlassesSession answers per owner", () => {
    micSessionManager.acquire({owner: "com.a", source: "glasses", useCase: "transcription"})
    expect(micSessionManager.hasGlassesSession("com.a")).toBe(true)
    expect(micSessionManager.hasGlassesSession("com.b")).toBe(false)
  })

  test("without a glasses PCM uplink the lease holds but claims nothing", () => {
    micSessionManager.setPlatformCaps({glassesPcmUplink: false})
    micSessionManager.acquire({owner: "com.mentra.call", source: "glasses", useCase: "voice_call"})
    // Ownership is what the meeting gate reads, so it still answers yes on iOS.
    expect(micSessionManager.hasGlassesSession("com.mentra.call")).toBe(true)
    expect(setMicSourcePin).not.toHaveBeenCalled()
    expect(setSessionRequirement).toHaveBeenLastCalledWith(false)
    expect(setSessionMicTuning).toHaveBeenLastCalledWith(null)
  })

  test("an enabled gain sweep starts a voice call at 15, not the policy 14", () => {
    micSessionManager.setCallGainSweepEnabled(true)
    micSessionManager.acquire({owner: "com.mentra.call", source: "glasses", useCase: "voice_call"})
    expect(setSessionMicTuning).toHaveBeenLastCalledWith({gain: 15})
    micSessionManager.setCallGainSweepEnabled(false)
  })
})
