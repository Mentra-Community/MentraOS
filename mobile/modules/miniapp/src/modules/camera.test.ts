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
  thumbnail: {
    key: "photo/p1abc/thumbnail",
    url: "miniapp://com.example.app/.mentra/files/mywpiww1-def.jpg",
    width: 512,
    height: 384,
    mimeType: "image/jpeg",
  },
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
    const capture = new CameraModule(session).capture({size: "high", preview: true})
    expect(requestCalls[0]).toMatchObject({type: MiniappRequestType.PHOTO_CAPTURE, photoId: capture.photoId, size: "high", preview: true})
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

  test("without preview: true no preview is asked for, and the capture has none", async () => {
    const {session, requestCalls} = mockSession(PHOTO)
    const capture = new CameraModule(session).capture({size: "high"})
    expect(requestCalls[0]).not.toHaveProperty("preview")
    expect("preview" in capture).toBe(false)
    await expect(capture.photo()).resolves.toEqual(PHOTO)
  })

  test("a capture the host refuses rejects every stage", async () => {
    const session = {
      _hasManifestPermission: () => true,
      sendRequest: () => Promise.reject(new Error("CAMERA_BUSY")),
    } as unknown as MiniappSession
    const capture = new CameraModule(session).capture({preview: true})
    await expect(capture.captured).rejects.toThrow("CAMERA_BUSY")
    await expect(capture.preview).rejects.toThrow("CAMERA_BUSY")
    await expect(capture.photo()).rejects.toThrow("CAMERA_BUSY")
  })
})

describe("CameraModule camera session", () => {
  function eventSession() {
    const requests: Array<Record<string, unknown>> = []
    const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
    const session = {
      _hasManifestPermission: () => true,
      sendRequest: (payload: Record<string, unknown>) => {
        requests.push(payload)
        return Promise.resolve(undefined)
      },
      on: (event: string, handler: (event: Record<string, unknown>) => void) => {
        const set = listeners.get(event) ?? new Set()
        set.add(handler)
        listeners.set(event, set)
        return () => set.delete(handler)
      },
    } as unknown as MiniappSession
    const emit = (event: string, payload: Record<string, unknown>) => listeners.get(event)?.forEach((handler) => handler(payload))
    const heard = () => [...listeners.values()].reduce((count, set) => count + set.size, 0)
    return {session, requests, emit, heard}
  }

  test("opens a session with its settings; a tap is taken in its turn with only its own options", async () => {
    const {session, requests} = eventSession()
    const camera = new CameraModule(session).open({size: "medium", sound: false, preview: true})
    const open = requests[0]
    expect(open).toMatchObject({type: MiniappRequestType.CAMERA_OPEN, size: "medium", sound: false, preview: true})
    const cameraId = open.cameraId as string
    expect(cameraId).toBeTruthy()
    const tap = await camera.capture({sound: true})
    expect(requests.at(-1)).toEqual({type: MiniappRequestType.CAMERA_SESSION_CAPTURE, cameraId, photoId: tap.photoId, sound: true})
    await tap.preview
    expect(requests.at(-1)).toEqual({type: MiniappRequestType.PHOTO_CAPTURE_STAGE, photoId: tap.photoId, stage: "preview"})
    await camera.close()
    expect(requests.at(-1)).toEqual({type: MiniappRequestType.CAMERA_CLOSE, cameraId})
  })

  test("continuous: hands out its photos as captures with its own options, and stops while the session stays", async () => {
    const {session, requests, emit, heard} = eventSession()
    const camera = new CameraModule(session).open({size: "medium", sound: true})
    const cameraId = requests[0].cameraId as string
    const run = camera.continuous({sound: false})
    await Promise.resolve()
    await Promise.resolve()
    const start = requests.at(-1)!
    expect(start).toEqual({type: MiniappRequestType.CAMERA_CONTINUOUS_START, cameraId, runId: start.runId, sound: false})
    const runId = start.runId as string
    const photos: Array<{photoId: string}> = []
    run.onPhoto((capture) => photos.push(capture))
    emit("continuousPhoto", {runId, photoId: "p1"})
    emit("continuousPhoto", {runId: "another run", photoId: "p2"})
    expect(photos.map((photo) => photo.photoId)).toEqual(["p1"])
    expect("preview" in photos[0]).toBe(false)
    await run.stop()
    expect(requests.at(-1)).toEqual({type: MiniappRequestType.CAMERA_CONTINUOUS_STOP, cameraId, runId})
    expect(heard()).toBe(0)
    // The session goes on: a tap still goes through it.
    await camera.capture()
    expect(requests.at(-1)).toMatchObject({type: MiniappRequestType.CAMERA_SESSION_CAPTURE, cameraId})
    await camera.close()
  })

  test("a new trigger or closing stops hearing the previous trigger", async () => {
    const {session, heard} = eventSession()
    const camera = new CameraModule(session).open()
    camera.continuous()
    expect(heard()).toBe(1)
    camera.continuous()
    expect(heard()).toBe(1)
    await camera.close()
    expect(heard()).toBe(0)
  })
})
