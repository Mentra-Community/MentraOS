/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {CameraModule, type CameraFovResult, type CloudPhotoTaken, type PhotoTaken} from "./camera"

function mockSession<T>(result: T) {
  const requestCalls: object[] = []
  const requestOptions: (object | undefined)[] = []
  const session = {
    _hasManifestPermission: () => true,
    sendOneShot: () => {
      throw new Error("setFov should use sendRequest")
    },
    sendRequest: (payload: object, options?: object) => {
      requestCalls.push(payload)
      requestOptions.push(options)
      return Promise.resolve(result)
    },
  } as unknown as MiniappSession

  return {session, requestCalls, requestOptions}
}

/** What a Mentra App with local photos answers. */
const PHOTO: PhotoTaken = {
  requestId: "p1abc",
  key: "photo/p1abc",
  mimeType: "image/jpeg",
  size: 1234,
  expiresAt: 1_800_000_000_000,
}

describe("CameraModule", () => {
  test("setFov resolves from a request/response ack", async () => {
    const result: CameraFovResult = {
      requestId: "fov-1",
      fov: 102,
      roiPosition: "bottom",
      timestamp: 123,
    }
    const {session, requestCalls} = mockSession(result)
    const camera = new CameraModule(session)

    await expect(camera.setFov({fov: 102, roiPosition: "bottom"})).resolves.toEqual(result)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.CAMERA_FOV,
        fov: 102,
        roiPosition: "bottom",
      },
    ])
  })

  test("takePhoto asks for the photo on the phone and returns where the miniapp finds it", async () => {
    const result: PhotoTaken = {
      requestId: "p1abc",
      key: "photo/p1abc",
      url: "miniapp://com.example.app/.mentra/files/mywpiww0-abc.jpg",
      mimeType: "image/jpeg",
      size: 1234,
      expiresAt: 1_800_000_000_000,
    }
    const {session, requestCalls} = mockSession(result)
    const camera = new CameraModule(session)

    await expect(camera.takePhoto({size: "max", compress: "none"})).resolves.toEqual(result)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.PHOTO,
        size: "max",
        mode: "photo",
        compress: "none",
        sound: true,
        saveToGallery: false,
        exposureTimeNs: undefined,
        zsl: undefined,
        mfnr: undefined,
        delivery: "local",
      },
    ])
  })

  test("takeCloudPhoto keeps the cloud upload: no local delivery, and the transfer method it names", async () => {
    const result: CloudPhotoTaken = {
      requestId: "rq-1",
      photoUrl: "https://example.com/photo.jpg",
      mimeType: "image/jpeg",
      size: -1,
    }
    const {session, requestCalls, requestOptions} = mockSession(result)
    const camera = new CameraModule(session)

    await expect(camera.takeCloudPhoto({size: "max", sound: false, timeoutMs: 60_000})).resolves.toEqual(result)
    expect("delivery" in requestCalls[0]!).toBe(false)
    expect("transferMethod" in requestCalls[0]!).toBe(false)
    expect(requestCalls[0]).toMatchObject({type: MiniappRequestType.PHOTO, size: "max", sound: false})
    expect(requestOptions).toEqual([{timeoutMs: 60_000}])

    await camera.takeCloudPhoto({transferMethod: "ble"})
    expect(requestCalls[1]).toMatchObject({transferMethod: "ble"})
  })

  test("takePhoto rejects the cloud URL of a Mentra App from before local photos", async () => {
    const {session} = mockSession({
      requestId: "rq-1",
      photoUrl: "https://example.com/p.jpg",
      mimeType: "image/jpeg",
      size: -1,
    })
    await expect(new CameraModule(session).takePhoto()).rejects.toThrow("Update the Mentra App")
  })

  test("takePhoto forwards text mode", async () => {
    const {session, requestCalls} = mockSession(PHOTO)
    const camera = new CameraModule(session)

    await camera.takePhoto({mode: "text"})

    expect(requestCalls[0]).toMatchObject({mode: "text"})
  })

  test("takePhoto names no transfer method: a photo for the phone always comes over Bluetooth", async () => {
    const {session, requestCalls} = mockSession(PHOTO)
    const camera = new CameraModule(session)

    await camera.takePhoto({transferMethod: "direct"} as any)

    expect("transferMethod" in requestCalls[0]!).toBe(false)
  })

  test("takePhoto forwards zsl and mfnr", async () => {
    const {session, requestCalls} = mockSession(PHOTO)
    const camera = new CameraModule(session)

    await camera.takePhoto({zsl: true, mfnr: false})

    expect(requestCalls[0]).toMatchObject({zsl: true, mfnr: false})
  })

  test("takePhoto forwards timeoutMs as the sendRequest options argument", async () => {
    const {session, requestOptions} = mockSession(PHOTO)
    const camera = new CameraModule(session)

    await camera.takePhoto({timeoutMs: 1_200})

    expect(requestOptions).toEqual([{timeoutMs: 1_200}])
  })

  test("takePhoto omits the options argument when timeoutMs is unset", async () => {
    const {session, requestOptions} = mockSession(PHOTO)
    const camera = new CameraModule(session)

    await camera.takePhoto({})

    expect(requestOptions).toEqual([undefined])
  })

  test("warmUp forwards size and default duration", async () => {
    const {session, requestCalls} = mockSession(undefined)
    const camera = new CameraModule(session)

    await camera.warmUp({size: "high", durationMs: 20_000})

    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.CAMERA_WARM_UP,
        size: "high",
        mode: "photo",
        exposureTimeNs: undefined,
        durationMs: 20_000,
      },
    ])
  })

  test("warmUp passes text mode without forcing public max quality", async () => {
    const {session, requestCalls} = mockSession(undefined)
    const camera = new CameraModule(session)

    await camera.warmUp({size: "low", mode: "text"})

    expect(requestCalls[0]).toMatchObject({size: "low", mode: "text"})
  })

  test("warmUp forwards zsl and mfnr when provided", async () => {
    const {session, requestCalls} = mockSession(undefined)
    const camera = new CameraModule(session)

    await camera.warmUp({zsl: true, mfnr: false})

    expect(requestCalls[0]).toMatchObject({zsl: true, mfnr: false})
  })
})

test("takePhoto preserves compression and rejects invalid values before dispatch", async () => {
  const {session, requestCalls} = mockSession(PHOTO)
  const camera = new CameraModule(session)
  for (const compress of ["none", "low", "medium", "high"] as const) {
    await camera.takePhoto({compress})
    expect(requestCalls.at(-1)).toMatchObject({compress})
  }
  await camera.takePhoto()
  expect(requestCalls.at(-1)).toMatchObject({compress: "none"})
  for (const compress of ["heavy", "", "HIGH", null, 1]) {
    await expect(camera.takePhoto({compress} as never)).rejects.toThrow("Invalid photo compression")
  }
  expect(requestCalls).toHaveLength(5)
})
