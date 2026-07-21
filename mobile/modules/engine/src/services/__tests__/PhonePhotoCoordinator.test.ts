/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// Mock module dependencies BEFORE importing the coordinator.

// --- BLE native bridge (@mentra/bluetooth-sdk/internal) -------------------
const requestPhotoNative = mock(async (_req: unknown): Promise<undefined> => undefined)
const warmUpCameraNative = mock(async (_req: unknown): Promise<undefined> => undefined)
const stopCameraWarmUpNative = mock(async (_requestId: string): Promise<undefined> => undefined)

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {
    requestPhoto: requestPhotoNative,
    warmUpCamera: warmUpCameraNative,
    stopCameraWarmUp: stopCameraWarmUpNative,
  },
}))

// --- cloud-v2 managed-photo service (CloudClientService singleton) --------
const PRESIGN = {
  requestId: "rq-test-1",
  uploadUrl: "https://cloud.test/api/v2/runtime/photo/upload/rq-test-1",
  readUrl: "https://cloud.test/api/v2/runtime/photo/read/rq-test-1",
}
const startManagedPhoto = mock(async (_opts: {size?: string}) => PRESIGN)
const awaitManagedPhotoReady = mock(
  async (_requestId: string): Promise<{readUrl?: string}> => ({readUrl: "https://r2.test/signed"}),
)

mock.module("../CloudClientService", () => ({
  cloudClientService: {startManagedPhoto, awaitManagedPhotoReady},
}))

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

const {CAPTURE_PIPELINE_TIMEOUT_MS, PhonePhotoCoordinator, PhotoError} = await import("../PhonePhotoCoordinator")

beforeEach(() => {
  requestPhotoNative.mockClear()
  warmUpCameraNative.mockClear()
  stopCameraWarmUpNative.mockClear()
  startManagedPhoto.mockClear()
  awaitManagedPhotoReady.mockClear()
  glassesState = {connection: {state: "connected"}}
  // Restore default mock behaviors that prior tests may have changed.
  requestPhotoNative.mockImplementation(async () => undefined)
  warmUpCameraNative.mockImplementation(async () => undefined)
  startManagedPhoto.mockResolvedValue(PRESIGN)
  awaitManagedPhotoReady.mockResolvedValue({readUrl: "https://r2.test/signed"})
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

describe("PhonePhotoCoordinator", () => {
  test("pipeline watchdog does not preempt the managed-photo ready-push timeout", () => {
    expect(CAPTURE_PIPELINE_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  describe("prechecks", () => {
    test("rejects with GLASSES_NOT_CONNECTED when glasses are disconnected", async () => {
      glassesState = {connection: {state: "disconnected"}}
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("GLASSES_NOT_CONNECTED")
      expect(err.stage).toBe("command")
      // Should NOT have called cloud or BLE.
      expect(startManagedPhoto).not.toHaveBeenCalled()
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("hasCamera is intentionally NOT pre-checked (glasses-side handler is the source of truth)", async () => {
      // See takePhoto's header comment: a cameraless device answers the BLE
      // photo command with a typed photo_response error within ~1s, which
      // handlePhotoError routes back. The coordinator must not block on store
      // capability data.
      glassesState = {connection: {state: "connected"}, capabilities: {hasCamera: false}}
      const coord = new PhonePhotoCoordinator()
      await expect(coord.takePhoto("com.a", {})).resolves.toEqual(
        expect.objectContaining({photoUrl: "https://r2.test/signed"}),
      )
    })
  })

  describe("happy path", () => {
    test("presigns, drives BLE, resolves with the photo.ready push readUrl", async () => {
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {size: "medium"})
      expect(result.photoUrl).toBe("https://r2.test/signed")
      expect(result.mimeType).toBe("image/jpeg")
      expect(result.requestId).toBe("rq-test-1")

      expect(startManagedPhoto).toHaveBeenCalledWith({size: "medium"})
      expect(awaitManagedPhotoReady).toHaveBeenCalledWith("rq-test-1")

      // BLE call shape: wire v2 sends a short 4-hex correlation id (not the
      // cloud UUID) plus the owning appId.
      expect(requestPhotoNative).toHaveBeenCalledTimes(1)
      const arg = requestPhotoNative.mock.calls[0]![0] as {
        requestId: string
        appId: string
        size: string
        mode: string
        webhookUrl: string
        authToken: string | null
        compress: string
        save: boolean
        sound: boolean
        exposureTimeNs: number | null
      }
      expect(arg.requestId).toMatch(/^[0-9a-f]{4}$/)
      expect(arg.appId).toBe("com.a")
      expect(arg.size).toBe("medium")
      expect(arg.mode).toBe("photo")
      expect(arg.webhookUrl).toBe(PRESIGN.uploadUrl)
      expect(arg.authToken).toBeNull()
      expect(arg.compress).toBe("none")
      expect(arg.save).toBe(false)
      expect(arg.sound).toBe(true)
      expect(arg.exposureTimeNs).toBeNull()
      // Public presigned upload URL → transfer method stays on native "auto".
      expect("transferMethod" in arg).toBe(false)
    })

    test("falls back to the presigned readUrl when the ready push carries none", async () => {
      awaitManagedPhotoReady.mockResolvedValueOnce({})
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {})
      expect(result.photoUrl).toBe(PRESIGN.readUrl)
    })

    test("forces BLE transfer when the upload URL is loopback, overriding direct", async () => {
      startManagedPhoto.mockResolvedValueOnce({
        requestId: "rq-loop",
        uploadUrl: "http://127.0.0.1:8089/photo/upload/rq-loop",
        readUrl: "http://127.0.0.1:8089/photo/read/rq-loop",
      })
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {transferMethod: "direct"})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({transferMethod: "ble"})
    })

    test("passes a miniapp's forced BLE transfer to the native request", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {transferMethod: "ble"})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({transferMethod: "ble"})
    })

    test("passes a miniapp's direct transfer to the native request", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {transferMethod: "direct"})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({transferMethod: "direct"})
    })

    test("rejects an unknown runtime transfer method before starting the photo pipeline", async () => {
      const coord = new PhonePhotoCoordinator()
      const promise = coord.takePhoto("com.a", {transferMethod: "wifi"} as any)

      await expect(promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: 'Invalid transferMethod "wifi". Expected "auto", "direct", or "ble".',
      })
      expect(startManagedPhoto).not.toHaveBeenCalled()
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("rejects a runtime null transfer method before starting the photo pipeline", async () => {
      const coord = new PhonePhotoCoordinator()
      const promise = coord.takePhoto("com.a", {transferMethod: null} as any)

      await expect(promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: 'Invalid transferMethod null. Expected "auto", "direct", or "ble".',
      })
      expect(startManagedPhoto).not.toHaveBeenCalled()
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("rejects a runtime empty transfer method before starting the photo pipeline", async () => {
      const coord = new PhonePhotoCoordinator()
      const promise = coord.takePhoto("com.a", {transferMethod: ""} as any)

      await expect(promise).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: 'Invalid transferMethod "". Expected "auto", "direct", or "ble".',
      })
      expect(startManagedPhoto).not.toHaveBeenCalled()
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("passes saveToGallery and sound through to the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {saveToGallery: true, sound: false})
      expect(requestPhotoNative).toHaveBeenCalledTimes(1)
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({save: true, sound: false})
    })

    test("passes exposureTimeNs through to the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {exposureTimeNs: 12_000_000})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({exposureTimeNs: 12_000_000})
    })

    test("passes text mode through without forcing public max quality", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {mode: "text", size: "low"})
      expect(startManagedPhoto).toHaveBeenCalledWith({size: "max"})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({mode: "text", size: "low"})
    })

    test("passes zsl and mfnr through to the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {zsl: true, mfnr: false})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({zsl: true, mfnr: false})
    })

    test("omits zsl and mfnr when unset", async () => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {})
      expect(requestPhotoNative.mock.calls[0]![0]).not.toHaveProperty("zsl")
      expect(requestPhotoNative.mock.calls[0]![0]).not.toHaveProperty("mfnr")
    })

    test("normalizes legacy size 'full' to 'max' for the native take_photo command", async () => {
      const coord = new PhonePhotoCoordinator()
      // Legacy wire values may still arrive from older callers at runtime.
      await coord.takePhoto("com.a", {size: "full"})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({size: "max"})
      expect(startManagedPhoto).toHaveBeenCalledWith({size: "full"})
    })

    test.each(["low", "high", "max"] as const)("presign accepts canonical size %s without HTTP 400", async (size) => {
      const coord = new PhonePhotoCoordinator()
      await coord.takePhoto("com.a", {size})
      expect(startManagedPhoto).toHaveBeenCalledWith({size})
      expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({size})
    })

    test("owns(requestId) true mid-flight, false after completion", async () => {
      const coord = new PhonePhotoCoordinator()
      let observedDuring = false
      awaitManagedPhotoReady.mockImplementationOnce(async () => {
        // While awaiting the ready push, the coordinator should claim ownership.
        observedDuring = coord.owns("rq-test-1")
        return {readUrl: "https://r2.test/signed"}
      })
      await coord.takePhoto("com.a", {})
      expect(observedDuring).toBe(true)
      expect(coord.owns("rq-test-1")).toBe(false)
    })

    test("sends a short BLE requestId while keeping the cloud UUID internally", async () => {
      const coord = new PhonePhotoCoordinator()
      let bleIdDuringFlight = ""
      awaitManagedPhotoReady.mockImplementationOnce(async () => {
        bleIdDuringFlight = (requestPhotoNative.mock.calls[0]![0] as {requestId: string}).requestId
        expect(bleIdDuringFlight).toHaveLength(4)
        expect(coord.resolveCloudRequestId(bleIdDuringFlight)).toBe("rq-test-1")
        return {readUrl: "https://r2.test/signed"}
      })

      const result = await coord.takePhoto("com.a", {size: "medium"})
      expect(result.requestId).toBe("rq-test-1")
      expect(requestPhotoNative).toHaveBeenCalledTimes(1)
      expect((requestPhotoNative.mock.calls[0]![0] as {requestId: string}).requestId).toBe(bleIdDuringFlight)
      // Mapping is cleaned up after completion.
      expect(coord.owns(bleIdDuringFlight)).toBe(false)
    })

    test("owns() accepts short BLE ids while a capture is in flight", async () => {
      const coord = new PhonePhotoCoordinator()
      awaitManagedPhotoReady.mockImplementationOnce(() => new Promise<never>(() => {}))
      void coord.takePhoto("com.a", {}).catch(() => {})
      await new Promise((r) => setTimeout(r, 5))
      const bleId = (requestPhotoNative.mock.calls[0]![0] as {requestId: string}).requestId
      expect(coord.owns(bleId)).toBe(true)
      expect(coord.resolveCloudRequestId(bleId)).toBe("rq-test-1")
      // Settle the hanging request so it can't leak into the next test.
      coord.handlePhotoError(bleId, "TEST_TEARDOWN", "teardown")
    })
  })

  describe("error paths", () => {
    test("presign failure surfaces as PhotoError(PHOTO_REQUEST_FAILED) and skips BLE", async () => {
      startManagedPhoto.mockRejectedValueOnce(new Error("cloud down"))
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("PHOTO_REQUEST_FAILED")
      expect(err.stage).toBe("presign")
      expect(err.transport).toBe("cloud-rest")
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("BluetoothSdk.requestPhoto rejection surfaces as PhotoError(BLE_SEND_FAILED) and releases the slot", async () => {
      // Hang the ready push so the BLE rejection deterministically wins.
      awaitManagedPhotoReady.mockImplementationOnce(() => new Promise<never>(() => {}))
      requestPhotoNative.mockRejectedValueOnce(new Error("BLE down"))
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("BLE_SEND_FAILED")
      expect(err.stage).toBe("command")
      expect(err.transport).toBe("ble")
      expect(coord.owns("rq-test-1")).toBe(false)
    })

    test("ready-push failure surfaces as PhotoError(POLL_FAILED)", async () => {
      awaitManagedPhotoReady.mockRejectedValueOnce(new Error("push channel died"))
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("POLL_FAILED")
      expect(err.stage).toBe("push")
      expect(err.transport).toBe("ws")
    })

    test("ready-push failure keeps a typed code from the cloud error when present", async () => {
      awaitManagedPhotoReady.mockRejectedValueOnce(
        Object.assign(new Error("Upload did not arrive"), {code: "PHOTO_TIMEOUT"}),
      )
      const coord = new PhonePhotoCoordinator()
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("PHOTO_TIMEOUT")
    })

    test("handlePhotoError mid-flight short-circuits the ready push with the glasses-reported code", async () => {
      // Make the ready push hang so we can race it against handlePhotoError.
      awaitManagedPhotoReady.mockImplementationOnce(() => new Promise<never>(() => {}))
      const coord = new PhonePhotoCoordinator()
      const p = coord.takePhoto("com.a", {})
      // Wait a tick so the coordinator registers activeRequests.
      await new Promise((r) => setTimeout(r, 5))
      expect(coord.owns("rq-test-1")).toBe(true)
      coord.handlePhotoError("rq-test-1", "BATTERY_LOW", "Battery too low")
      const err = await expectPhotoError(p)
      expect(err.code).toBe("BATTERY_LOW")
      expect(err.stage).toBe("capture")
      expect(coord.owns("rq-test-1")).toBe(false)
    })

    test("handlePhotoError for an unknown requestId is a silent no-op", () => {
      const coord = new PhonePhotoCoordinator()
      expect(() => coord.handlePhotoError("does-not-exist", "X", "y")).not.toThrow()
    })

    test("handlePhotoError racing the BLE send still rejects the takePhoto Promise (no silent drop)", async () => {
      // Worst race: the BLE send resolves, then glasses report an error on the
      // very next microtask — BEFORE the ready push gets a chance to settle.
      const coord = new PhonePhotoCoordinator()
      awaitManagedPhotoReady.mockImplementationOnce(() => new Promise<never>(() => {}))
      requestPhotoNative.mockImplementationOnce(async () => {
        queueMicrotask(() => coord.handlePhotoError("rq-test-1", "CAMERA_BUSY", "Busy"))
        return undefined
      })
      const err = await expectPhotoError(coord.takePhoto("com.a", {}))
      expect(err.code).toBe("CAMERA_BUSY")
    })
  })

  describe("concurrency", () => {
    test("two takePhoto calls each get their own requestId, no cross-talk", async () => {
      startManagedPhoto
        .mockResolvedValueOnce({
          requestId: "rq-A",
          uploadUrl: "https://cloud.test/api/v2/runtime/photo/upload/rq-A",
          readUrl: "https://cloud.test/api/v2/runtime/photo/read/rq-A",
        })
        .mockResolvedValueOnce({
          requestId: "rq-B",
          uploadUrl: "https://cloud.test/api/v2/runtime/photo/upload/rq-B",
          readUrl: "https://cloud.test/api/v2/runtime/photo/read/rq-B",
        })
      awaitManagedPhotoReady.mockImplementation(async (requestId: string) => ({
        readUrl: `https://r2.test/${requestId}`,
      }))

      const coord = new PhonePhotoCoordinator()
      const [a, b] = await Promise.all([coord.takePhoto("com.a", {}), coord.takePhoto("com.b", {})])
      expect(a.requestId).toBe("rq-A")
      expect(b.requestId).toBe("rq-B")
      expect(a.photoUrl).toBe("https://r2.test/rq-A")
      expect(b.photoUrl).toBe("https://r2.test/rq-B")
      expect(requestPhotoNative).toHaveBeenCalledTimes(2)
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
