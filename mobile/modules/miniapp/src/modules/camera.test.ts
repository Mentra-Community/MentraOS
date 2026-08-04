/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {CameraModule, type CameraFovResult, type PhotoTaken} from "./camera"

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

  test("takePhoto returns delivered photo metadata with requestId", async () => {
    const result: PhotoTaken = {
      requestId: "photo-1",
      photoUrl: "https://example.com/photo.jpg",
      mimeType: "image/jpeg",
      size: 1234,
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
      },
    ])
  })

  test("takePhoto forwards text mode", async () => {
    const {session, requestCalls} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({mode: "text"})

    expect(requestCalls[0]).toMatchObject({mode: "text"})
  })

  test("takePhoto forwards a forced BLE transfer", async () => {
    const {session, requestCalls} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({transferMethod: "ble"})

    expect(requestCalls[0]).toMatchObject({transferMethod: "ble"})
  })

  test("takePhoto forwards a direct transfer without BLE fallback", async () => {
    const {session, requestCalls} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({transferMethod: "direct"})

    expect(requestCalls[0]).toMatchObject({transferMethod: "direct"})
  })

  test("takePhoto preserves a runtime null transfer method for host validation", async () => {
    const {session, requestCalls} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({transferMethod: null} as any)

    expect(requestCalls[0]).toMatchObject({transferMethod: null})
  })

  test("takePhoto preserves a runtime empty transfer method for host validation", async () => {
    const {session, requestCalls} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({transferMethod: ""} as any)

    expect(requestCalls[0]).toMatchObject({transferMethod: ""})
  })

  test("takePhoto forwards zsl and mfnr", async () => {
    const {session, requestCalls} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({zsl: true, mfnr: false})

    expect(requestCalls[0]).toMatchObject({zsl: true, mfnr: false})
  })

  test("takePhoto forwards timeoutMs as the sendRequest options argument", async () => {
    const {session, requestOptions} = mockSession({})
    const camera = new CameraModule(session)

    await camera.takePhoto({timeoutMs: 1_200})

    expect(requestOptions).toEqual([{timeoutMs: 1_200}])
  })

  test("takePhoto omits the options argument when timeoutMs is unset", async () => {
    const {session, requestOptions} = mockSession({})
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
