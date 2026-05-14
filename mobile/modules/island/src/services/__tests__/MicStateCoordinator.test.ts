// Override the global Bluetooth SDK mock so we can capture `update` calls.
const mockUpdate = jest.fn()
jest.doMock("@mentra/bluetooth-sdk", () => ({
  __esModule: true,
  default: {
    update: mockUpdate,
    getBluetoothStatus: jest.fn(() => Promise.resolve("disabled")),
    requestBluetoothPermissions: jest.fn(() => Promise.resolve(true)),
  },
}))

// Import AFTER the mock is registered

const MicStateCoordinator = require("../MicStateCoordinator").default

describe("MicStateCoordinator", () => {
  beforeEach(() => {
    MicStateCoordinator.reset()
    mockUpdate.mockClear()
  })

  test("cloud-only PCM requirement", () => {
    MicStateCoordinator.setCloudRequirements({pcm: true, lc3: false, transcript: false, bypass_vad: false})
    expect(mockUpdate).toHaveBeenCalledWith(
      "core",
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: true,
      }),
    )
  })

  test("local-only LC3 requirement", () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    expect(mockUpdate).toHaveBeenCalledWith(
      "core",
      expect.objectContaining({
        should_send_lc3: true,
      }),
    )
  })

  test("union of cloud + local", () => {
    MicStateCoordinator.setCloudRequirements({pcm: true, lc3: false, transcript: true, bypass_vad: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    const lastCall = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1]
    expect(lastCall[1]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: true,
        should_send_transcript: true,
      }),
    )
  })

  test("both off means all false", () => {
    MicStateCoordinator.setCloudRequirements({pcm: false, lc3: false, transcript: false, bypass_vad: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1]
    expect(lastCall[1]).toEqual(
      expect.objectContaining({
        should_send_pcm: false,
        should_send_lc3: false,
      }),
    )
  })

  test("local unsubscribe doesn't kill cloud mic", () => {
    MicStateCoordinator.setCloudRequirements({pcm: false, lc3: true, transcript: true, bypass_vad: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1]
    expect(lastCall[1]).toEqual(
      expect.objectContaining({
        should_send_lc3: true,
      }),
    )
  })
})
