import NativeBluetoothSdk from "../_private/BluetoothSdkModule"

jest.mock("../_private/BluetoothSdkModule", () => ({
  __esModule: true,
  default: {setGalleryServerEnabled: jest.fn()},
}))

// The app-wide Jest setup mocks this package; exercise its real public adapter here.
const {BluetoothSdk} = jest.requireActual<typeof import("../index")>("../index")

describe("public gallery server bridge", () => {
  const nativeCall = jest.mocked(NativeBluetoothSdk.setGalleryServerEnabled)

  beforeEach(() => nativeCall.mockReset())

  it.each([true, false])("forwards enabled=%s and preserves the native acknowledgement", async (enabled) => {
    const ack = {
      requestId: "gallery-request",
      setting: "gallery_server" as const,
      status: "applied" as const,
      timestamp: 123,
      enabled,
      listening: enabled,
      ...(enabled ? {url: "http://10.1.2.3:8089"} : {}),
    }
    nativeCall.mockResolvedValue(ack)

    await expect(BluetoothSdk.setGalleryServerEnabled(enabled)).resolves.toEqual(ack)
    expect(nativeCall).toHaveBeenCalledWith(enabled)
  })

  it("preserves native rejection instead of reporting an enabled server", async () => {
    const error = new Error("settings_unavailable")
    nativeCall.mockRejectedValue(error)
    await expect(BluetoothSdk.setGalleryServerEnabled(true)).rejects.toBe(error)
  })
})
