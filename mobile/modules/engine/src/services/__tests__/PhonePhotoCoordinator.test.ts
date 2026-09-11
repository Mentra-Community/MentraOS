/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// Mock module dependencies BEFORE importing the coordinator.

// --- BLE native bridge (@mentra/bluetooth-sdk/internal) -------------------
// requestPhoto resolves at terminal photo_response success with the delivered
// fileUri (destination {kind: "phone"}).
const DELIVERY = {
  type: "photo_response" as const,
  state: "success" as const,
  requestId: "0001",
  uploadUrl: "",
  timestamp: 0,
  fileUri: "file:///data/MentraLive_Images/PHONE_0001.jpg",
  mimeType: "image/jpeg",
  byteCount: 4321,
  savedToCameraRoll: false,
}
const requestPhotoNative = mock(async (_req: unknown) => DELIVERY)
const warmUpCameraNative = mock(async (_req: unknown): Promise<undefined> => undefined)
const stopCameraWarmUpNative = mock(async (_requestId: string): Promise<undefined> => undefined)

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {
    requestPhoto: requestPhotoNative,
    warmUpCamera: warmUpCameraNative,
    stopCameraWarmUp: stopCameraWarmUpNative,
  },
}))

// --- expo-file-system (delivered JPEG read + delete) -----------------------
// The coordinator reads the SDK-delivered file into a data URL and deletes it.
const FILE_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA=="
const EXPECTED_DATA_URL = `data:image/jpeg;base64,${FILE_BASE64}`
const openedFiles: string[] = []
const fileBase64 = mock(async (): Promise<string> => FILE_BASE64)
const fileDelete = mock((): void => undefined)
let fileSize: number | null = 4321
class MockFile {
  constructor(public readonly uri: string) {
    openedFiles.push(uri)
  }
  get size(): number | null {
    return fileSize
  }
  base64(): Promise<string> {
    return fileBase64()
  }
  delete(): void {
    fileDelete()
  }
}
mock.module("expo-file-system", () => ({File: MockFile}))

// --- no network, ever -------------------------------------------------------
// Local-miniapp photos must never touch the cloud or the runtime: any fetch is
// a test failure. (CloudClientService is deliberately not imported by the
// coordinator any more, so there is nothing to mock there.)
const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
  throw new Error("local-miniapp photos must not make network requests")
})
globalThis.fetch = fetchMock as unknown as typeof fetch

// --- glasses store + readiness ---------------------------------------------
// The coordinator's connected precheck reads the engine glasses store via
// isGlassesConnected. Mock both (the real store transitively drags
// react-native, which bun can't parse); the store state is mutable so each
// test can flip the connection.
let glassesState: {connection: {state: string}; capabilities?: {hasCamera?: boolean}} = {
  connection: {state: "connected"},
}
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {getState: () => glassesState},
}))
mock.module("../GlassesReadiness", () => ({
  isGlassesConnected: (connection: {state?: string} | undefined) => connection?.state === "connected",
}))

const {CAPTURE_PIPELINE_TIMEOUT_MS, NATIVE_PHONE_DELIVERY_TIMEOUT_MS, PhonePhotoCoordinator, PhotoError} = await import(
  "../PhonePhotoCoordinator"
)

beforeEach(() => {
  requestPhotoNative.mockClear()
  warmUpCameraNative.mockClear()
  stopCameraWarmUpNative.mockClear()
  fetchMock.mockClear()
  fileBase64.mockClear()
  fileDelete.mockClear()
  openedFiles.length = 0
  fileSize = 4321
  glassesState = {connection: {state: "connected"}}
  // Restore default mock behaviors that prior tests may have changed.
  requestPhotoNative.mockImplementation(async () => DELIVERY)
  warmUpCameraNative.mockImplementation(async () => undefined)
  fileBase64.mockImplementation(async () => FILE_BASE64)
  fileDelete.mockImplementation(() => undefined)
})

/** Await a rejection and return it as a PhotoError, failing if it resolves. */
async function expectPhotoError(p: Promise<unknown>): Promise<InstanceType<typeof PhotoError>> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(PhotoError)
    return err as InstanceType<typeof PhotoError>
  }
  throw new Error("expected the promise to reject")
}

function nativeArg(index = 0): Record<string, unknown> {
  return requestPhotoNative.mock.calls[index]![0] as Record<string, unknown>
}

describe("PhonePhotoCoordinator", () => {
  test("pipeline watchdog sits above the Bluetooth SDK's phone-delivery deadline", () => {
    expect(NATIVE_PHONE_DELIVERY_TIMEOUT_MS).toBe(60_000)
    expect(CAPTURE_PIPELINE_TIMEOUT_MS).toBeGreaterThan(NATIVE_PHONE_DELIVERY_TIMEOUT_MS)
    // ...and below the miniapp SDK's default takePhoto deadline (90 s, camera.ts).
    expect(CAPTURE_PIPELINE_TIMEOUT_MS).toBeLessThan(90_000)
  })

  describe("prechecks", () => {
    test("rejects with GLASSES_NOT_CONNECTED when glasses are disconnected", async () => {
      glassesState = {connection: {state: "disconnected"}}
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("GLASSES_NOT_CONNECTED")
      expect(err.stage).toBe("command")
      // Should NOT have touched BLE or the file system.
      expect(requestPhotoNative).not.toHaveBeenCalled()
      expect(openedFiles).toHaveLength(0)
    })

    test("hasCamera is intentionally NOT pre-checked (glasses-side handler is the source of truth)", async () => {
      // See takePhoto's header comment: a cameraless device answers the BLE
      // photo command with a typed photo_response error within ~1s, which
      // handlePhotoError routes back. The coordinator must not block on store
      // capability data.
      glassesState = {connection: {state: "connected"}, capabilities: {hasCamera: false}}
      const coord = new PhonePhotoCoordinator()
      await expect(coord.takePhoto("com.a", {})).resolves.toEqual(expect.objectContaining({mimeType: "image/jpeg"}))
    })
  })

  describe("happy path (BLE-only, no cloud)", () => {
    test("drives BLE with destination {kind: 'phone'} and returns the photo inline", async () => {
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {size: "medium"})

      // NO cloud presign, NO runtime publish — no network request at all.
      expect(fetchMock).not.toHaveBeenCalled()

      // BLE call shape: wire v2 sends a short 4-hex correlation id plus the
      // owning appId; delivery is the phone destination with no webhook fields.
      expect(requestPhotoNative).toHaveBeenCalledTimes(1)
      const arg = nativeArg()
      expect(arg.requestId).toMatch(/^[0-9a-f]{4}$/)
      expect(arg.appId).toBe("com.a")
      expect(arg.size).toBe("medium")
      expect(arg.mode).toBe("photo")
      expect(arg.destination).toEqual({kind: "phone"})
      expect(arg.sound).toBe(true)
      expect(arg.exposureTimeNs).toBeNull()
      // The webhook-era flats must be absent: destination + flat fields throw
      // inside the SDK's normalizer.
      expect("webhookUrl" in arg).toBe(false)
      expect("authToken" in arg).toBe(false)
      expect("transferMethod" in arg).toBe(false)
      expect("save" in arg).toBe(false)
      expect("compress" in arg).toBe(false)

      // Completion reads the delivered file once, hands the miniapp the bytes
      // inline (photoUrl carries the same data URL), and deletes the file.
      expect(openedFiles).toEqual([DELIVERY.fileUri])
      expect(fileBase64).toHaveBeenCalledTimes(1)
      expect(fileDelete).toHaveBeenCalledTimes(1)
      expect(result.dataUrl).toBe(EXPECTED_DATA_URL)
      expect(result.photoUrl).toBe(EXPECTED_DATA_URL)
      expect(result.mimeType).toBe("image/jpeg")
      expect(result.size).toBe(4321)
      expect(result.requestId).toMatch(/^photo_/)
    })

    test("maps saveToGallery to the phone arm's keepOnGlasses", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {saveToGallery: true, sound: false})
      expect(nativeArg()).toMatchObject({destination: {kind: "phone", keepOnGlasses: true}, sound: false})
      expect("save" in nativeArg()).toBe(false)
    })

    test("passes saveToCameraRoll onto the phone destination", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {saveToCameraRoll: true})
      expect(nativeArg()).toMatchObject({destination: {kind: "phone", saveToCameraRoll: true}})
    })

    test("ignores a miniapp transferMethod: delivery is always BLE phone delivery", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {transferMethod: "direct"})
      const arg = nativeArg()
      expect(arg.destination).toEqual({kind: "phone"})
      expect("transferMethod" in arg).toBe(false)
    })

    test("drops compress on the phone arm (transport codec governs)", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {compress: "high"})
      expect("compress" in nativeArg()).toBe(false)
    })

    test("rejects an unknown runtime transfer method before starting the photo pipeline", async () => {
      const coord = new PhonePhotoCoordinator()
      const promise = coord.takePhoto("com.a", {transferMethod: "wifi"} as any)

      await expect(promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: 'Invalid transferMethod "wifi". Expected "auto", "direct", or "ble".',
      })
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("rejects a runtime null transfer method before starting the photo pipeline", async () => {
      const coord = new PhonePhotoCoordinator()
      const promise = coord.takePhoto("com.a", {transferMethod: null} as any)

      await expect(promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: 'Invalid transferMethod null. Expected "auto", "direct", or "ble".',
      })
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("rejects a runtime empty transfer method before starting the photo pipeline", async () => {
      const coord = new PhonePhotoCoordinator()
      const promise = coord.takePhoto("com.a", {transferMethod: ""} as any)

      await expect(promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: 'Invalid transferMethod "". Expected "auto", "direct", or "ble".',
      })
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("passes exposureTimeNs through to the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {exposureTimeNs: 12_000_000})
      expect(nativeArg()).toMatchObject({exposureTimeNs: 12_000_000})
    })

    test("passes text mode through without touching the requested size", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {mode: "text", size: "low"})
      expect(nativeArg()).toMatchObject({mode: "text", size: "low"})
    })

    test("passes zsl and mfnr through to the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {zsl: true, mfnr: false})
      expect(nativeArg()).toMatchObject({zsl: true, mfnr: false})
    })

    test("omits zsl and mfnr when unset", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {})
      expect(nativeArg()).not.toHaveProperty("zsl")
      expect(nativeArg()).not.toHaveProperty("mfnr")
    })

    test("normalizes legacy size 'full' to 'max' for the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      // Legacy wire values may still arrive from older callers at runtime.
      await coord.takePhoto("com.a", {size: "full"})
      expect(nativeArg()).toMatchObject({size: "max"})
    })

    test("falls back to image/jpeg and the delivery byteCount when the file size is unknown", async () => {
      requestPhotoNative.mockResolvedValueOnce({...DELIVERY, mimeType: undefined} as unknown as typeof DELIVERY)
      fileSize = null
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {})
      expect(result.mimeType).toBe("image/jpeg")
      expect(result.dataUrl).toBe(EXPECTED_DATA_URL)
      expect(result.size).toBe(DELIVERY.byteCount)
    })

    test("reports an unknown size when neither the file nor the delivery carries one", async () => {
      requestPhotoNative.mockResolvedValueOnce({...DELIVERY, byteCount: undefined} as unknown as typeof DELIVERY)
      fileSize = null
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {})
      expect(result.size).toBe(-1)
    })

    test("owns(requestId) true mid-flight, false after completion", async () => {
      const coord = new PhonePhotoCoordinator()
      let observedDuring = false
      let observedId = ""
      fileBase64.mockImplementationOnce(async () => {
        // While reading the delivered file, the coordinator should still claim ownership.
        observedId = nativeArg().requestId as string
        observedDuring = coord.owns(observedId)
        return FILE_BASE64
      })
      await coord.takePhoto("com.a", {})
      expect(observedDuring).toBe(true)
      expect(coord.owns(observedId)).toBe(false)
    })

    test("sends a short BLE requestId while keeping the full phone-minted id internally", async () => {
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {size: "medium"})
      const bleId = nativeArg().requestId as string
      expect(bleId).toHaveLength(4)
      expect(result.requestId).toMatch(/^photo_/)
      // Mapping is cleaned up after completion.
      expect(coord.owns(bleId)).toBe(false)
      expect(coord.resolveRequestId(bleId)).toBe(bleId) // mapping gone → passthrough
    })

    test("owns() accepts short BLE ids while a capture is in flight", async () => {
      const coord = new PhonePhotoCoordinator()
      requestPhotoNative.mockImplementationOnce(() => new Promise<never>(() => {}))
      void coord.takePhoto("com.a", {}).catch(() => {})
      await new Promise((r) => setTimeout(r, 5))
      const bleId = nativeArg().requestId as string
      expect(coord.owns(bleId)).toBe(true)
      expect(coord.resolveRequestId(bleId)).toMatch(/^photo_/)
      // Settle the hanging request so it can't leak into the next test.
      coord.handlePhotoError(bleId, "TEST_TEARDOWN", "teardown")
    })
  })

  describe("error paths", () => {
    test("native rejection surfaces as a typed PhotoError and releases the slot", async () => {
      requestPhotoNative.mockRejectedValueOnce(new Error("BLE down"))
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("PHOTO_FAILED")
      expect(err.stage).toBe("capture")
      expect(err.transport).toBe("ble")
      expect(openedFiles).toHaveLength(0)
      expect(coord.getDiagnosticSnapshot()).toMatchObject({activeCaptureCount: 0})
    })

    test("native rejection keeps a typed code from the glasses error when present", async () => {
      requestPhotoNative.mockRejectedValueOnce(Object.assign(new Error("Camera busy"), {code: "CAMERA_BUSY"}))
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("CAMERA_BUSY")
    })

    test("a success delivery without a fileUri rejects instead of reading anything", async () => {
      requestPhotoNative.mockResolvedValueOnce({...DELIVERY, fileUri: undefined} as unknown as typeof DELIVERY)
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("PHOTO_DELIVERY_INCOMPLETE")
      expect(openedFiles).toHaveLength(0)
    })

    test("an unreadable delivered file rejects with PHOTO_DELIVERY_FAILED at the deliver stage", async () => {
      fileBase64.mockImplementationOnce(async () => {
        throw new Error("ENOENT")
      })
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("PHOTO_DELIVERY_FAILED")
      expect(err.stage).toBe("deliver")
      expect(err.transport).toBe("local-file")
      expect(err.message).toContain("ENOENT")
      expect(fileDelete).not.toHaveBeenCalled()
    })

    test("a failed cleanup of the delivered file does not fail the photo", async () => {
      fileDelete.mockImplementationOnce(() => {
        throw new Error("EACCES")
      })
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {})
      expect(result.dataUrl).toBe(EXPECTED_DATA_URL)
    })

    test("handlePhotoError mid-flight short-circuits the capture with the glasses-reported code", async () => {
      // Make the native pipeline hang so we can race it against handlePhotoError.
      requestPhotoNative.mockImplementationOnce(() => new Promise<never>(() => {}))
      const coord = new PhonePhotoCoordinator()
      const p = coord.takePhoto("com.a", {})
      // Wait a tick so the coordinator registers activeRequests.
      await new Promise((r) => setTimeout(r, 5))
      const bleId = nativeArg().requestId as string
      expect(coord.owns(bleId)).toBe(true)
      coord.handlePhotoError(bleId, "BATTERY_LOW", "Battery too low")
      const err = await expectPhotoError(p)
      expect(err.code).toBe("BATTERY_LOW")
      expect(err.stage).toBe("capture")
      expect(coord.owns(bleId)).toBe(false)
    })

    test("handlePhotoError for an unknown requestId is a silent no-op", () => {
      const coord = new PhonePhotoCoordinator()
      expect(() => coord.handlePhotoError("does-not-exist", "X", "y")).not.toThrow()
    })

    test("handlePhotoError racing the native completion still rejects the takePhoto Promise (no silent drop)", async () => {
      // Worst race: glasses report an error through the gated listener on the
      // very next microtask — BEFORE the native promise settles.
      const coord = new PhonePhotoCoordinator()
      requestPhotoNative.mockImplementationOnce(async (req: unknown) => {
        const bleId = (req as {requestId: string}).requestId
        queueMicrotask(() => coord.handlePhotoError(bleId, "CAMERA_BUSY", "Busy"))
        return new Promise<never>(() => {})
      })
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("CAMERA_BUSY")
    })

    test("a late native completion after handlePhotoError does not read the file", async () => {
      const coord = new PhonePhotoCoordinator()
      let deliver!: (evt: typeof DELIVERY) => void
      requestPhotoNative.mockImplementationOnce(() => new Promise((resolve) => (deliver = resolve)))
      const p = coord.takePhoto("com.a", {})
      await new Promise((r) => setTimeout(r, 5))
      const bleId = nativeArg().requestId as string
      coord.handlePhotoError(bleId, "BATTERY_LOW", "Battery too low")
      await expectPhotoError(p)
      deliver(DELIVERY)
      await new Promise((r) => setTimeout(r, 5))
      expect(openedFiles).toHaveLength(0)
    })
  })

  describe("concurrency", () => {
    test("two takePhoto calls each get their own requestId, no cross-talk", async () => {
      const coord = new PhonePhotoCoordinator()
      const [a, b] = await Promise.all([coord.takePhoto("com.a", {}), coord.takePhoto("com.b", {})])
      expect(a.requestId).not.toBe(b.requestId)
      expect(a.dataUrl).toBe(EXPECTED_DATA_URL)
      expect(b.dataUrl).toBe(EXPECTED_DATA_URL)
      expect(requestPhotoNative).toHaveBeenCalledTimes(2)
      expect(openedFiles).toHaveLength(2)
    })
  })

  describe("warmUpCamera", () => {
    test("sends the warm-up command with defaults when connected", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {})
      expect(warmUpCameraNative).toHaveBeenCalledTimes(1)
      expect(warmUpCameraNative.mock.calls[0]![0]).toEqual({
        requestId: expect.any(String),
        size: "medium",
        mode: "photo",
        exposureTimeNs: null,
        durationMs: 15000,
      })
      await coord.stopWarmUpForApp("com.a")
    })

    test("passes size/exposure/duration through to the native warm-up command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {size: "high", exposureTimeNs: 5_000_000, durationMs: 20_000})
      expect(warmUpCameraNative.mock.calls[0]![0]).toEqual({
        requestId: expect.any(String),
        size: "high",
        mode: "photo",
        exposureTimeNs: 5_000_000,
        durationMs: 20_000,
      })
      await coord.stopWarmUpForApp("com.a")
    })

    test("text mode warms with mode=text without forcing public max quality", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {size: "low", mode: "text"})
      expect(warmUpCameraNative.mock.calls[0]![0]).toEqual({
        requestId: expect.any(String),
        size: "low",
        mode: "text",
        exposureTimeNs: null,
        durationMs: 15000,
      })
      await coord.stopWarmUpForApp("com.a")
    })

    test("passes zsl and mfnr through to the native warm-up command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {zsl: true, mfnr: false})
      expect(warmUpCameraNative.mock.calls[0]![0]).toMatchObject({zsl: true, mfnr: false})
      await coord.stopWarmUpForApp("com.a")
    })

    test("omits zsl and mfnr when unset", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {})
      expect(warmUpCameraNative.mock.calls[0]![0]).not.toHaveProperty("zsl")
      expect(warmUpCameraNative.mock.calls[0]![0]).not.toHaveProperty("mfnr")
      await coord.stopWarmUpForApp("com.a")
    })

    test("throws GLASSES_NOT_CONNECTED when glasses are disconnected", async () => {
      glassesState = {connection: {state: "disconnected"}}
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.warmUpCamera("com.a", {}))
      expect(err.code).toBe("GLASSES_NOT_CONNECTED")
      expect(warmUpCameraNative).not.toHaveBeenCalled()
    })

    test("native warm-up failure surfaces as PhotoError(WARM_UP_FAILED)", async () => {
      warmUpCameraNative.mockRejectedValueOnce(new Error("BLE down"))
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.warmUpCamera("com.a", {}))
      expect(err.code).toBe("WARM_UP_FAILED")
      expect(err.stage).toBe("command")
      expect(err.transport).toBe("ble")
    })

    test("caps warm-up leases at 60 seconds", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {durationMs: 120_000})
      expect(warmUpCameraNative.mock.calls[0]![0]).toMatchObject({durationMs: 60_000})
      await coord.stopWarmUpForApp("com.a")
    })

    test("unregister-style cleanup cancels an opening request by its phone-owned ID", async () => {
      let rejectWarmUp!: (error: Error) => void
      warmUpCameraNative.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectWarmUp = reject)))
      const coord = new PhonePhotoCoordinator()
      const warming = coord.warmUpCamera("com.a", {})
      await Promise.resolve()

      const requestId = (warmUpCameraNative.mock.calls[0]![0] as {requestId: string}).requestId
      await coord.stopWarmUpForApp("com.a")
      expect(stopCameraWarmUpNative).toHaveBeenCalledWith(requestId)

      rejectWarmUp(new Error("cancelled"))
      const err = await expectPhotoError(warming)
      expect(err.code).toBe("WARM_UP_FAILED")
    })

    test("replacing an app lease stops the previous request first", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {})
      const firstId = (warmUpCameraNative.mock.calls[0]![0] as {requestId: string}).requestId

      await coord.warmUpCamera("com.a", {size: "high"})
      expect(stopCameraWarmUpNative).toHaveBeenCalledWith(firstId)
      expect(warmUpCameraNative).toHaveBeenCalledTimes(2)
      await coord.stopWarmUpForApp("com.a")
    })

    test("retains a warm-up lease when native cancellation fails", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.warmUpCamera("com.a", {})
      const requestId = (warmUpCameraNative.mock.calls[0]![0] as {requestId: string}).requestId
      stopCameraWarmUpNative.mockRejectedValueOnce(new Error("BLE down"))

      await expect(coord.stopWarmUpForApp("com.a")).rejects.toThrow("BLE down")
      await coord.stopWarmUpForApp("com.a")

      expect(stopCameraWarmUpNative.mock.calls).toEqual([[requestId], [requestId]])
    })
  })
})
