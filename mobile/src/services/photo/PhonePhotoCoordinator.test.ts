/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

const requestPhotoNative = mock(async (..._args: unknown[]) => undefined)
const warmUpCameraNative = mock(async (..._args: unknown[]) => undefined)

mock.module("@mentra/bluetooth-sdk", () => ({
  default: {requestPhoto: requestPhotoNative, warmUpCamera: warmUpCameraNative},
}))

const startManagedPhoto = mock(async () => ({
  requestId: "rq-cloud-uuid-0001",
  uploadUrl: "https://cloud.test/api/v2/client/photo/upload/rq-cloud-uuid-0001",
  readUrl: "https://cloud.test/read/rq-cloud-uuid-0001",
}))

const awaitManagedPhotoReady = mock(async (requestId: string) => ({
  requestId,
  readUrl: "https://r2.test/signed",
}))

mock.module("@/services/cloudClient", () => ({
  cloudClient: {
    startManagedPhoto,
    awaitManagedPhotoReady,
  },
}))

let glassesSnapshot: {connected: boolean} = {connected: true}

mock.module("@mentra/island", () => ({
  getRuntimeHooks: () => ({
    glassesStatus: {get: () => glassesSnapshot},
  }),
}))

beforeEach(() => {
  requestPhotoNative.mockClear()
  warmUpCameraNative.mockClear()
  startManagedPhoto.mockClear()
  awaitManagedPhotoReady.mockClear()
  glassesSnapshot = {connected: true}
  requestPhotoNative.mockImplementation(async () => undefined)
  warmUpCameraNative.mockImplementation(async () => undefined)
  startManagedPhoto.mockResolvedValue({
    requestId: "rq-cloud-uuid-0001",
    uploadUrl: "https://cloud.test/api/v2/client/photo/upload/rq-cloud-uuid-0001",
    readUrl: "https://cloud.test/read/rq-cloud-uuid-0001",
  })
  awaitManagedPhotoReady.mockImplementation(async (requestId: string) => ({
    requestId,
    readUrl: "https://r2.test/signed",
  }))
})

const {PhonePhotoCoordinator, PhotoError} = await import("./PhonePhotoCoordinator")

describe("PhonePhotoCoordinator", () => {
  test("sends a short BLE requestId while keeping the cloud UUID internally", async () => {
    const coord = new PhonePhotoCoordinator()
    let bleIdDuringFlight = ""
    awaitManagedPhotoReady.mockImplementationOnce(async () => {
      bleIdDuringFlight = (requestPhotoNative.mock.calls[0]![0] as {requestId: string}).requestId
      expect(bleIdDuringFlight).toHaveLength(4)
      expect(coord.resolveCloudRequestId(bleIdDuringFlight)).toBe("rq-cloud-uuid-0001")
      return {requestId: "rq-cloud-uuid-0001", readUrl: "https://r2.test/signed"}
    })

    const result = await coord.takePhoto("com.a", {size: "medium"})
    expect(result.requestId).toBe("rq-cloud-uuid-0001")
    expect(requestPhotoNative).toHaveBeenCalledTimes(1)
    expect((requestPhotoNative.mock.calls[0]![0] as {requestId: string}).requestId).toBe(bleIdDuringFlight)
    expect(coord.owns(bleIdDuringFlight)).toBe(false)
  })

  test("owns() accepts short BLE ids while a capture is in flight", async () => {
    const coord = new PhonePhotoCoordinator()
    awaitManagedPhotoReady.mockImplementationOnce(() => new Promise(() => {}))
    void coord.takePhoto("com.a", {})
    await new Promise((r) => setTimeout(r, 5))
    const bleId = (requestPhotoNative.mock.calls[0]![0] as {requestId: string}).requestId
    expect(coord.owns(bleId)).toBe(true)
    expect(coord.resolveCloudRequestId(bleId)).toBe("rq-cloud-uuid-0001")
  })

  test("passes saveToGallery through to the native take_photo command", async () => {
    const coord = new PhonePhotoCoordinator()
    await coord.takePhoto("com.a", {saveToGallery: true})

    expect(requestPhotoNative).toHaveBeenCalledTimes(1)
    expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({save: true})
  })

  test("passes exposureTimeNs through to the native take_photo command", async () => {
    const coord = new PhonePhotoCoordinator()
    await coord.takePhoto("com.a", {exposureTimeNs: 12_000_000})

    expect(requestPhotoNative).toHaveBeenCalledTimes(1)
    expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({
      exposureTimeNs: 12_000_000,
    })
  })

  test("defaults exposureTimeNs to null (auto-exposure) when omitted", async () => {
    const coord = new PhonePhotoCoordinator()
    await coord.takePhoto("com.a", {})

    expect(requestPhotoNative).toHaveBeenCalledTimes(1)
    expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({
      exposureTimeNs: null,
    })
  })

  test("normalizes legacy size 'full' to 'max' for the native take_photo command", async () => {
    const coord = new PhonePhotoCoordinator()
    await coord.takePhoto("com.a", {size: "full"})

    expect(requestPhotoNative).toHaveBeenCalledTimes(1)
    expect(requestPhotoNative.mock.calls[0]![0]).toMatchObject({size: "max"})
  })

  test("warmUpCamera sends BLE warm-up when glasses are connected", async () => {
    const coord = new PhonePhotoCoordinator()
    await coord.warmUpCamera("com.a", {size: "medium", exposureTimeNs: 1_000_000, durationMs: 5000})
    expect(warmUpCameraNative).toHaveBeenCalledTimes(1)
    expect(warmUpCameraNative.mock.calls[0]![0]).toMatchObject({
      size: "medium",
      exposureTimeNs: 1_000_000,
      durationMs: 5000,
    })
  })

  test("rejects with GLASSES_NOT_CONNECTED when glasses are disconnected", async () => {
    glassesSnapshot = {connected: false}
    const coord = new PhonePhotoCoordinator()
    await expect(coord.takePhoto("com.a", {})).rejects.toBeInstanceOf(PhotoError)
    expect(startManagedPhoto).not.toHaveBeenCalled()
    expect(requestPhotoNative).not.toHaveBeenCalled()
  })
})

afterEach(() => {
  glassesSnapshot = {connected: true}
})
