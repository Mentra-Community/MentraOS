/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {CameraModule, type CameraFovResult} from "./camera"

function mockSession(result: CameraFovResult) {
  const requestCalls: object[] = []
  const session = {
    _hasManifestPermission: () => true,
    sendOneShot: () => {
      throw new Error("setFov should use sendRequest")
    },
    sendRequest: (payload: object) => {
      requestCalls.push(payload)
      return Promise.resolve(result)
    },
  } as unknown as MiniappSession

  return {session, requestCalls}
}

describe("CameraModule", () => {
  test("setFov resolves from a request/response ack", async () => {
    const result: CameraFovResult = {
      requestId: "fov-1",
      fov: 102,
      roiPosition: "bottom",
      ready: true,
      hardwareApplied: true,
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
})
