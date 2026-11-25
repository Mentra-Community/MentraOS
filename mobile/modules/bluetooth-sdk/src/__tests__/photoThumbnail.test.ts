import type {BluetoothSdkInternalModule} from "../_private/BluetoothSdkModule"

const mockNative: Record<string, jest.Mock | undefined> = {}
const mockWifi: {file: {uri: string; bytes: number} | null} = {file: null}

jest.mock("expo", () => ({
  NativeModule: class {},
  requireNativeModule: () => mockNative,
  requireOptionalNativeModule: () => null,
}))
jest.mock("../glasses-wifi/files", () => ({
  fetchGlassesFileOverWifi: async () => mockWifi.file,
}))

// The native makePhotoThumbnail: the module wraps the native object's in place, so it is kept here.
let nativeThumbnail: jest.Mock

const thumbnail = {fileUri: "file:///cache/p1.thumb.jpg", width: 512, height: 384, mimeType: "image/jpeg", size: 30_000}

function load(deferredPhotosVersion: number): BluetoothSdkInternalModule {
  for (const key of Object.keys(mockNative)) delete mockNative[key]
  // What the module binds when it loads.
  for (const name of [
    "getBluetoothStatus",
    "getDefaultDevice",
    "setMicState",
    "displayText",
    "connectDefault",
    "stopScan",
    "uploadPhoto",
    "warmUpCamera",
  ]) {
    mockNative[name] = jest.fn()
  }
  mockNative.addListener = jest.fn(() => ({remove: jest.fn()}))
  mockNative.getGlassesStatus = jest.fn(async () => ({deferredPhotosVersion}))
  mockNative.capturePhoto = jest.fn(async (params: {requestId: string}) => params.requestId)
  mockNative.releasePhotoCapture = jest.fn(async () => undefined)
  mockNative.photoCaptureStage = jest.fn(async (_requestId: string, stage: string) =>
    stage === "photo"
      ? {
          state: "success",
          requestId: "p1",
          photoUrl: "file:///cache/p1.jpg",
          contentType: "image/jpeg",
          fileSizeBytes: 2_000_000,
          thumbnail,
        }
      : null,
  )
  nativeThumbnail = jest.fn(async (fileUri: string) => ({...thumbnail, fileUri: `${fileUri}.thumb.jpg`}))
  mockNative.makePhotoThumbnail = nativeThumbnail
  let loaded: BluetoothSdkInternalModule | undefined
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof import("../_private/BluetoothSdkModule")>(
      "../_private/BluetoothSdkModule",
    ).default
  })
  return loaded!
}

describe("a photo's thumbnail", () => {
  beforeEach(() => {
    mockWifi.file = null
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it("comes with a photo over Bluetooth, as the native capture made it", async () => {
    const sdk = load(2)
    const photo = await sdk.capturePhoto({requestId: "p1", size: "medium"}).photo()
    expect(photo).toEqual({
      requestId: "p1",
      fileUri: "file:///cache/p1.jpg",
      mimeType: "image/jpeg",
      size: 2_000_000,
      thumbnail,
    })
    expect(nativeThumbnail).not.toHaveBeenCalled()
  })

  it("is made for a photo over the glasses Wi-Fi link", async () => {
    mockWifi.file = {uri: "file:///cache/glasses-file-p1", bytes: 1_500_000}
    const sdk = load(2)
    const photo = await sdk.capturePhoto({requestId: "p1", size: "medium"}).photo()
    expect(nativeThumbnail).toHaveBeenCalledWith("file:///cache/glasses-file-p1")
    expect(photo.thumbnail).toEqual({...thumbnail, fileUri: "file:///cache/glasses-file-p1.thumb.jpg"})
    expect(photo.fileUri).toBe("file:///cache/glasses-file-p1")
  })

  it("is left out when it can't be made, and the photo still arrives", async () => {
    mockWifi.file = {uri: "file:///cache/glasses-file-p1", bytes: 1_500_000}
    const sdk = load(2)
    nativeThumbnail.mockRejectedValueOnce(new Error("decode failed"))
    const photo = await sdk.capturePhoto({requestId: "p1", size: "medium"}).photo()
    expect(photo).toEqual({
      requestId: "p1",
      fileUri: "file:///cache/glasses-file-p1",
      mimeType: "image/jpeg",
      size: 1_500_000,
    })
  })

  it("is null from makePhotoThumbnail for a file that isn't an image", async () => {
    const sdk = load(2)
    nativeThumbnail.mockResolvedValueOnce(null)
    await expect(sdk.makePhotoThumbnail("file:///cache/notes.txt")).resolves.toBeNull()
  })
})
