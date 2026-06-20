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

  test("local PCM requirement", () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: false})
    expect(mockUpdateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        should_send_pcm: true,
        should_send_lc3: false,
        should_send_transcript: false,
      }),
    )
  })

  test("local LC3 requirement", () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    expect(mockUpdateBluetoothSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: true,
        should_send_transcript: false,
      }),
    )
  })

  test("local PCM and LC3 can be enabled together", () => {
    MicStateCoordinator.setLocalRequirements({pcm: true, lc3: true})
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: true,
        should_send_lc3: true,
        should_send_transcript: false,
      }),
    )
  })

  test("both off means all false", () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: false,
        should_send_transcript: false,
      }),
    )
  })

  test("local unsubscribe turns mic requirements off", () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockUpdateBluetoothSettings.mock.calls[mockUpdateBluetoothSettings.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: false,
        should_send_transcript: false,
      }),
    )
  })
})
