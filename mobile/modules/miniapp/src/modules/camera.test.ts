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

  test("warmUp holds the camera warm until released, once", async () => {
    const {session, requestCalls} = mockSession(undefined)
    const camera = new CameraModule(session)

    const warm = await camera.warmUp({size: "high"})
    await warm.release()
    await warm.release()

    const warmUpId = (requestCalls[0] as {warmUpId: string}).warmUpId
    expect(warmUpId).toBeTruthy()
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.CAMERA_WARM_UP,
        hold: true,
        warmUpId,
        size: "high",
        mode: "photo",
        exposureTimeNs: undefined,
        zsl: undefined,
        mfnr: undefined,
      },
      {type: MiniappRequestType.CAMERA_WARM_UP_RELEASE, warmUpId},
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

describe("CameraModule.capture", () => {
  test("starts the capture, then asks for each stage by the photo's ID, and releases it", async () => {
    const {session, requestCalls} = mockSession(PHOTO)
    const capture = new CameraModule(session).capture({size: "high"})
    expect(requestCalls[0]).toMatchObject({type: MiniappRequestType.PHOTO_CAPTURE, photoId: capture.photoId, size: "high"})
    await capture.captured
    await capture.preview
    await expect(capture.photo()).resolves.toEqual(PHOTO)
    await capture.photo()
    await capture.release()
    expect(requestCalls.slice(1)).toEqual([
      {type: MiniappRequestType.PHOTO_CAPTURE_STAGE, photoId: capture.photoId, stage: "captured"},
      {type: MiniappRequestType.PHOTO_CAPTURE_STAGE, photoId: capture.photoId, stage: "preview"},
      // photo() asks once; later calls return the same photo.
      {type: MiniappRequestType.PHOTO_CAPTURE_STAGE, photoId: capture.photoId, stage: "photo"},
      {type: MiniappRequestType.PHOTO_RELEASE, photoId: capture.photoId},
    ])
  })

  test("a capture the host refuses rejects every stage", async () => {
    const session = {
      _hasManifestPermission: () => true,
      sendRequest: () => Promise.reject(new Error("CAMERA_BUSY")),
    } as unknown as MiniappSession
    const capture = new CameraModule(session).capture()
    await expect(capture.captured).rejects.toThrow("CAMERA_BUSY")
    await expect(capture.preview).rejects.toThrow("CAMERA_BUSY")
    await expect(capture.photo()).rejects.toThrow("CAMERA_BUSY")
  })
})

describe("CameraModule continuous capture", () => {
  test("starts a run, hands out its photos as captures, follows its state, and stops it", async () => {
    const requests: Array<Record<string, unknown>> = []
    const listeners = new Map<string, (event: Record<string, unknown>) => void>()
    const session = {
      _hasManifestPermission: () => true,
      sendRequest: (payload: Record<string, unknown>) => {
        requests.push(payload)
        return Promise.resolve(undefined)
      },
      on: (event: string, handler: (event: Record<string, unknown>) => void) => {
        listeners.set(event, handler)
        return () => listeners.delete(event)
      },
    } as unknown as MiniappSession
    const run = new CameraModule(session).captureContinuous({size: "medium", sound: false, maxPending: 4})
    const start = requests[0]
    expect(start).toMatchObject({type: MiniappRequestType.CAMERA_CONTINUOUS_START, maxPending: 4})
    const runId = start.runId as string
    const photos: string[] = []
    const states: string[] = []
    run.onPhoto((capture) => photos.push(capture.photoId))
    run.onState((state) => states.push(state))
    // The first state is heard even when it is the starting "paused".
    listeners.get("continuousState")?.({runId, state: "paused"})
    listeners.get("continuousState")?.({runId, state: "capturing"})
    listeners.get("continuousPhoto")?.({runId, photoId: "p1"})
    listeners.get("continuousPhoto")?.({runId: "another run", photoId: "p2"})
    expect(photos).toEqual(["p1"])
    expect(states).toEqual(["paused", "capturing"])
    expect(run.state).toBe("capturing")
    const asked = await run.capture({sound: true})
    expect(requests.at(-1)).toMatchObject({type: MiniappRequestType.CAMERA_CONTINUOUS_CAPTURE, runId, photoId: asked.photoId})
    await run.stop()
    expect(requests.at(-1)).toEqual({type: MiniappRequestType.CAMERA_CONTINUOUS_STOP, runId})
    expect(listeners.size).toBe(0)
  })
})
