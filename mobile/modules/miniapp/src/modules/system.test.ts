/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {SystemModule} from "./system"

function mockSession<T>(result: T) {
  const requestCalls: object[] = []
  const requestOptions: (object | undefined)[] = []
  const session = {
    sendRequest: (payload: object, options?: object) => {
      requestCalls.push(payload)
      requestOptions.push(options)
      return Promise.resolve(result)
    },
  } as unknown as MiniappSession

  return {session, requestCalls, requestOptions}
}

describe("SystemModule.scanQr", () => {
  test("sends miniapp_scan_qr with no host timeout", async () => {
    const {session, requestCalls, requestOptions} = mockSession({data: "https://meet.google.com/abc-defg-hij"})
    const system = new SystemModule(session)

    await expect(system.scanQr({title: "Scan meeting QR", hint: "Point the camera"})).resolves.toEqual({
      data: "https://meet.google.com/abc-defg-hij",
    })
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.SCAN_QR,
        title: "Scan meeting QR",
        hint: "Point the camera",
      },
    ])
    expect(requestOptions).toEqual([{timeoutMs: 0}])
  })

  test("treats a missing result as cancelled", async () => {
    const {session} = mockSession(undefined)
    const system = new SystemModule(session)
    await expect(system.scanQr()).resolves.toEqual({cancelled: true})
  })
})
