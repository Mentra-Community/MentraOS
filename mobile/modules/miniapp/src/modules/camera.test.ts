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
    const ack: CameraFovResult = {
      type: "settings_ack",
      requestId: "fov-1",
      setting: "camera_fov",
      status: "ready",
      ready: true,
      timestamp: 123,
      fov: 102,
      roiPosition: 1,
      hardwareApplied: true,
    }
    const {session, requestCalls} = mockSession(ack)
    const camera = new CameraModule(session)

    await expect(camera.setFov({fov: 102, roiPosition: "bottom"})).resolves.toEqual(ack)
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.CAMERA_FOV,
        horizontal: 102,
        fov: 102,
        vertical: undefined,
        roiPosition: "bottom",
      },
    ])
  })
})
