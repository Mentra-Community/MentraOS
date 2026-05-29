/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

// Mock module deps BEFORE importing the coordinator.
const requestPhotoNative = mock(async (..._args: unknown[]) => undefined)

mock.module("@mentra/bluetooth-sdk", () => ({
  default: {requestPhoto: requestPhotoNative},
}))

const requestPhotoApi = mock(async () => ({
  requestId: "rq-test-1",
  uploadUrl: "https://cloud.test/api/v2/client/photo/upload/rq-test-1",
  uploadToken: "fake.upload.token",
}))
const pollUntilReady = mock(
  async (
    _requestId: string,
    _signal?: AbortSignal,
  ): Promise<
    | {kind: "ready"; result: {photoUrl: string; mimeType: string; size: number}}
    | {kind: "error"; code: string; message: string}
  > =>
    ({
      kind: "ready" as const,
      result: {photoUrl: "https://r2.test/signed", mimeType: "image/jpeg", size: 4321},
    }),
)
const freePhoto = mock(async (_requestId: string) => undefined)

mock.module("./v2PhotoApi", () => ({
  requestPhoto: requestPhotoApi,
  pollUntilReady,
  freePhoto,
}))

// island runtime hooks: glasses status getter (controllable per test).
let glassesSnapshot: {
  connected: boolean
  capabilities?: {hasCamera?: boolean}
} = {connected: true, capabilities: {hasCamera: true}}

mock.module("@mentra/island", () => ({
  getRuntimeHooks: () => ({
    glassesStatus: {get: () => glassesSnapshot},
  }),
  ISLAND_SETTINGS_KEYS: {backendUrl: "backend_url", coreToken: "core_token"},
}))

beforeEach(() => {
  requestPhotoNative.mockClear()
  requestPhotoApi.mockClear()
  pollUntilReady.mockClear()
  freePhoto.mockClear()
  glassesSnapshot = {connected: true, capabilities: {hasCamera: true}}
  // Restore default mock behaviors that prior tests may have changed.
  requestPhotoNative.mockImplementation(async () => undefined)
  requestPhotoApi.mockResolvedValue({
    requestId: "rq-test-1",
    uploadUrl: "https://cloud.test/api/v2/client/photo/upload/rq-test-1",
    uploadToken: "fake.upload.token",
  })
  pollUntilReady.mockResolvedValue({
    kind: "ready",
    result: {photoUrl: "https://r2.test/signed", mimeType: "image/jpeg", size: 4321},
  })
})

const {PhonePhotoCoordinator, PhotoError} = await import("./PhonePhotoCoordinator")

describe("PhonePhotoCoordinator", () => {
  describe("prechecks", () => {
    test("rejects with GLASSES_NOT_CONNECTED when glasses are disconnected", async () => {
      glassesSnapshot = {connected: false}
      const coord = new PhonePhotoCoordinator()
      await expect(coord.takePhoto("com.a", {})).rejects.toBeInstanceOf(PhotoError)
      try {
        await coord.takePhoto("com.a", {})
      } catch (err) {
        expect((err as InstanceType<typeof PhotoError>).code).toBe("GLASSES_NOT_CONNECTED")
      }
      // Should NOT have called cloud or BLE.
      expect(requestPhotoApi).not.toHaveBeenCalled()
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("hasCamera precheck is intentionally NOT enforced here (glasses-side handler is the source of truth)", async () => {
      // We don't pre-check hasCamera in the coordinator — see PhonePhotoCoordinator.takePhoto's
      // header comment for the rationale. A cameraless glasses receiving the BLE photo
      // command would respond with a typed photo_response error within ~1s.
      glassesSnapshot = {connected: true, capabilities: {hasCamera: false}}
      const coord = new PhonePhotoCoordinator()
      // Doesn't throw — proceeds into the cloud + BLE flow.
      await expect(coord.takePhoto("com.a", {})).resolves.toEqual(
        expect.objectContaining({photoUrl: "https://r2.test/signed"}),
      )
    })

    test("proceeds when capabilities is absent (best-effort — don't block on missing data)", async () => {
      glassesSnapshot = {connected: true}
      const coord = new PhonePhotoCoordinator()
      await expect(coord.takePhoto("com.a", {})).resolves.toEqual(
        expect.objectContaining({photoUrl: "https://r2.test/signed"}),
      )
    })
  })

  describe("happy path", () => {
    test("requests slot, drives BLE, returns PhotoTaken on long-poll resolve", async () => {
      const coord = new PhonePhotoCoordinator()
      const result = await coord.takePhoto("com.a", {size: "medium"})
      expect(result.photoUrl).toBe("https://r2.test/signed")
      expect(result.mimeType).toBe("image/jpeg")
      expect(result.size).toBe(4321)
      expect(result.requestId).toBe("rq-test-1")

      // BLE call shape.
      expect(requestPhotoNative).toHaveBeenCalledTimes(1)
      const arg = requestPhotoNative.mock.calls[0]![0] as {
        requestId: string
        appId: string
        size: string
        webhookUrl: string
        authToken: string
      }
      expect(arg.requestId).toBe("rq-test-1")
      expect(arg.appId).toBe("com.a")
      expect(arg.size).toBe("medium")
      expect(arg.webhookUrl).toBe(
        "https://cloud.test/api/v2/client/photo/upload/rq-test-1",
      )
      expect(arg.authToken).toBe("fake.upload.token")
    })

    test("owns(requestId) true mid-flight, false after completion", async () => {
      const coord = new PhonePhotoCoordinator()
      let observedDuring = false
      pollUntilReady.mockImplementationOnce(async (_id) => {
        // While polling, the coordinator should claim ownership.
        observedDuring = coord.owns("rq-test-1")
        return {
          kind: "ready",
          result: {photoUrl: "https://r2.test/signed", mimeType: "image/jpeg", size: 1},
        }
      })
      await coord.takePhoto("com.a", {})
      expect(observedDuring).toBe(true)
      expect(coord.owns("rq-test-1")).toBe(false)
    })
  })

  describe("error paths", () => {
    test("cloud /request failure surfaces as PhotoError(PHOTO_REQUEST_FAILED)", async () => {
      requestPhotoApi.mockRejectedValueOnce(new Error("cloud down"))
      const coord = new PhonePhotoCoordinator()
      try {
        await coord.takePhoto("com.a", {})
        throw new Error("expected throw")
      } catch (err) {
        expect(err).toBeInstanceOf(PhotoError)
        expect((err as InstanceType<typeof PhotoError>).code).toBe("PHOTO_REQUEST_FAILED")
      }
      expect(requestPhotoNative).not.toHaveBeenCalled()
    })

    test("BLE photoRequest failure surfaces as PhotoError(BLE_SEND_FAILED), releases the slot, and tries to free cloud-side", async () => {
      requestPhotoNative.mockRejectedValueOnce(new Error("BLE down"))
      const coord = new PhonePhotoCoordinator()
      try {
        await coord.takePhoto("com.a", {})
        throw new Error("expected throw")
      } catch (err) {
        expect((err as InstanceType<typeof PhotoError>).code).toBe("BLE_SEND_FAILED")
      }
      expect(coord.owns("rq-test-1")).toBe(false)
      expect(freePhoto).toHaveBeenCalledWith("rq-test-1")
    })

    test("long-poll error surfaces with the typed code from cloud", async () => {
      pollUntilReady.mockResolvedValueOnce({
        kind: "error",
        code: "timeout",
        message: "Upload did not arrive",
      })
      const coord = new PhonePhotoCoordinator()
      try {
        await coord.takePhoto("com.a", {})
        throw new Error("expected throw")
      } catch (err) {
        expect((err as InstanceType<typeof PhotoError>).code).toBe("timeout")
      }
    })

    test("handlePhotoError mid-flight rejects with the glasses-reported code", async () => {
      // Make the poll hang so we can race it against handlePhotoError.
      let resolvePoll: (v: never) => void = () => {}
      pollUntilReady.mockImplementationOnce(
        () => new Promise<never>((_resolve, _reject) => { /* never resolves */ }),
      )
      const coord = new PhonePhotoCoordinator()
      const p = coord.takePhoto("com.a", {})
      // Wait a tick so the coordinator registers activeRequests.
      await new Promise((r) => setTimeout(r, 5))
      coord.handlePhotoError("rq-test-1", "BATTERY_LOW", "Battery too low")
      try {
        await p
        throw new Error("expected throw")
      } catch (err) {
        expect((err as InstanceType<typeof PhotoError>).code).toBe("BATTERY_LOW")
      }
      // The handler should have freed the slot cloud-side.
      expect(freePhoto).toHaveBeenCalledWith("rq-test-1")
      // suppress unused
      void resolvePoll
    })

    test("handlePhotoError for an unknown requestId is a silent no-op", () => {
      const coord = new PhonePhotoCoordinator()
      expect(() => coord.handlePhotoError("does-not-exist", "X", "y")).not.toThrow()
    })

    test("handlePhotoError racing the BLE send still rejects the takePhoto Promise (no silent drop)", async () => {
      // Simulate the worst race: photoRequest resolves synchronously, then
      // handlePhotoError fires on the very next tick — BEFORE the long-poll
      // even gets a chance to settle. The coordinator must still surface
      // the typed error to the caller.
      const coord = new PhonePhotoCoordinator()
      pollUntilReady.mockImplementationOnce(
        () => new Promise(() => {/* never settles */}),
      )
      requestPhotoNative.mockImplementationOnce(async () => {
        // The BLE send resolves; on the next microtask, glasses report an error.
        queueMicrotask(() => coord.handlePhotoError("rq-test-1", "CAMERA_BUSY", "Busy"))
      })
      const p = coord.takePhoto("com.a", {})
      try {
        await p
        throw new Error("expected throw")
      } catch (err) {
        expect((err as InstanceType<typeof PhotoError>).code).toBe("CAMERA_BUSY")
      }
    })
  })

  describe("concurrency", () => {
    test("two takePhoto calls each get their own requestId, no cross-talk", async () => {
      requestPhotoApi
        .mockResolvedValueOnce({
          requestId: "rq-A",
          uploadUrl: "https://cloud.test/api/v2/client/photo/upload/rq-A",
          uploadToken: "tA",
        })
        .mockResolvedValueOnce({
          requestId: "rq-B",
          uploadUrl: "https://cloud.test/api/v2/client/photo/upload/rq-B",
          uploadToken: "tB",
        })
      pollUntilReady
        .mockResolvedValueOnce({
          kind: "ready",
          result: {photoUrl: "https://r2/A", mimeType: "image/jpeg", size: 1},
        })
        .mockResolvedValueOnce({
          kind: "ready",
          result: {photoUrl: "https://r2/B", mimeType: "image/jpeg", size: 2},
        })

      const coord = new PhonePhotoCoordinator()
      const [a, b] = await Promise.all([
        coord.takePhoto("com.a", {}),
        coord.takePhoto("com.b", {}),
      ])
      expect(a.requestId).toBe("rq-A")
      expect(b.requestId).toBe("rq-B")
      expect(a.photoUrl).toBe("https://r2/A")
      expect(b.photoUrl).toBe("https://r2/B")
      expect(requestPhotoNative).toHaveBeenCalledTimes(2)
    })
  })
})

afterEach(() => {
  // Reset glasses snapshot for next test's beforeEach.
  glassesSnapshot = {connected: true, capabilities: {hasCamera: true}}
})
