/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const mockUpdateBluetoothSettings = mock(() => Promise.resolve())

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {
    updateBluetoothSettings: mockUpdateBluetoothSettings,
  },
}))

// Import AFTER the mock is registered
const MicStateCoordinator = require("../MicStateCoordinator").default

/** Mic-requirement writes are debounced (300ms, merged) — wait out the window. */
const flushMicWrite = () => new Promise((r) => setTimeout(r, 320))

describe("MicStateCoordinator", () => {
  beforeEach(async () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false, vadEnabled: true})
    // Drain the baseline write before clearing the mock.
    await flushMicWrite()
    mockUpdateBluetoothSettings.mockClear()
  })

  test("local PCM requirement", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: false})
    await flushMicWrite()
    expect(mockUpdateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        should_send_pcm: true,
        should_send_lc3: false,
        should_send_transcript: false,
        voice_activity_detection_enabled: false,
      }),
    )
  })

  test("local LC3 requirement", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    await flushMicWrite()
    expect(mockUpdateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: true,
        should_send_transcript: false,
        voice_activity_detection_enabled: true,
      }),
    )
  })

  test("local PCM and LC3 can be enabled together", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: true})
    await flushMicWrite()
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: true,
        should_send_lc3: true,
        should_send_transcript: false,
        voice_activity_detection_enabled: false,
      }),
    )
  })

  test("both off means all false", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    await flushMicWrite()
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: false,
        should_send_transcript: false,
        voice_activity_detection_enabled: true,
      }),
    )
  })

  test("local unsubscribe turns mic requirements off (debounce merges the burst)", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    await flushMicWrite()
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: false,
        should_send_transcript: false,
        voice_activity_detection_enabled: true,
      }),
    )
  })

  test("restores a disabled user VAD preference after PCM ends", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: false, vadEnabled: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    await flushMicWrite()

    expect(mockUpdateBluetoothSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({voice_activity_detection_enabled: false}),
    )
  })

  test("keeps VAD disabled when persisted settings replay during raw PCM", () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: false, vadEnabled: true})

    expect(
      MicStateCoordinator.applyRuntimeOverrides({
        brightness: 50,
        voice_activity_detection_enabled: true,
      }),
    ).toEqual({
      brightness: 50,
      voice_activity_detection_enabled: false,
    })
  })

  test("restores a VAD preference changed while raw PCM is active", async () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: false, vadEnabled: true})
    MicStateCoordinator.applyRuntimeOverrides({voice_activity_detection_enabled: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    await flushMicWrite()

    expect(mockUpdateBluetoothSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({voice_activity_detection_enabled: false}),
    )
  })

  test("evaluates queued settings against the current PCM state at flush time", () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: false, vadEnabled: true})
    const queuedPatch = {voice_activity_detection_enabled: true}
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})

    expect(MicStateCoordinator.applyRuntimeOverrides(queuedPatch)).toEqual({
      voice_activity_detection_enabled: true,
    })
  })
})
