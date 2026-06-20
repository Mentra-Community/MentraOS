/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const mockUpdateBluetoothSettings = mock(() => Promise.resolve())

mock.module("../../../../bluetooth-sdk/build/_internal", () => ({
  __esModule: true,
  default: {
    updateBluetoothSettings: mockUpdateBluetoothSettings,
  },
}))

// Import AFTER the mock is registered
const MicStateCoordinator = require("../MicStateCoordinator").default

describe("MicStateCoordinator", () => {
  beforeEach(() => {
    MicStateCoordinator.reset()
    mockUpdateBluetoothSettings.mockClear()
  })

  test("cloud-only PCM requirement", () => {
    MicStateCoordinator.setCloudRequirements({pcm: true, lc3: false, transcript: false})
    expect(mockUpdateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: true,
      }),
    )
  })

  test("local-only LC3 requirement", () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    expect(mockUpdateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        should_send_lc3: true,
      }),
    )
  })

  test("union of cloud + local", () => {
    MicStateCoordinator.setCloudRequirements({
      pcm: true,
      lc3: false,
      transcript: true,
    })
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: true,
        should_send_transcript: true,
      }),
    )
  })

  test("both off means all false", () => {
    MicStateCoordinator.setCloudRequirements({pcm: false, lc3: false, transcript: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: false,
      }),
    )
  })

  test("local unsubscribe doesn't kill cloud mic", () => {
    MicStateCoordinator.setCloudRequirements({pcm: false, lc3: true, transcript: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_lc3: true,
      }),
    )
  })
})
