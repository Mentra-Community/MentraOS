const mockSetMicRequirements = jest.fn()

// Import AFTER the mock is registered

const {configureRuntime} = require("../../runtime/config")
const MicStateCoordinator = require("../MicStateCoordinator").default

describe("MicStateCoordinator", () => {
  beforeEach(() => {
    configureRuntime({setMicRequirements: mockSetMicRequirements})
    MicStateCoordinator.reset()
    mockSetMicRequirements.mockClear()
  })

  test("cloud-only PCM requirement", () => {
    MicStateCoordinator.setCloudRequirements({pcm: true, lc3: false, transcript: false})
    expect(mockSetMicRequirements).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldSendPcm: false,
        shouldSendLc3: true,
      }),
    )
  })

  test("local-only LC3 requirement", () => {
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    expect(mockSetMicRequirements).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldSendLc3: true,
      }),
    )
  })

  test("union of cloud + local", () => {
    MicStateCoordinator.setCloudRequirements({
      pcm: true,
      lc3: false,
      transcript: true,
      voiceActivityDetectionEnabled: false,
    })
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    const lastCall = mockSetMicRequirements.mock.calls[mockSetMicRequirements.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        shouldSendPcm: false,
        shouldSendLc3: true,
        shouldSendTranscript: true,
        voiceActivityDetectionEnabled: false,
      }),
    )
  })

  test("both off means all false", () => {
    MicStateCoordinator.setCloudRequirements({pcm: false, lc3: false, transcript: false})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockSetMicRequirements.mock.calls[mockSetMicRequirements.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        shouldSendPcm: false,
        shouldSendLc3: false,
      }),
    )
  })

  test("local unsubscribe doesn't kill cloud mic", () => {
    MicStateCoordinator.setCloudRequirements({pcm: false, lc3: true, transcript: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: true})
    MicStateCoordinator.setLocalRequirements({pcm: false, lc3: false})
    const lastCall = mockSetMicRequirements.mock.calls[mockSetMicRequirements.mock.calls.length - 1]
    expect(lastCall[0]).toEqual(
      expect.objectContaining({
        shouldSendLc3: true,
      }),
    )
  })
})
