/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {invokeScanQrSeam, ScanQrNotConfiguredError} from "../scanQrSeam"

describe("invokeScanQrSeam", () => {
  test("throws NOT_IMPLEMENTED when the host overlay is not registered", async () => {
    await expect(invokeScanQrSeam(undefined, {title: "Scan"})).rejects.toMatchObject({
      name: "ScanQrNotConfiguredError",
      code: "NOT_IMPLEMENTED",
      message: "QR scanning is not configured on this host. Reload the Mentra App and try again.",
    })
    expect(new ScanQrNotConfiguredError()).toBeInstanceOf(Error)
  })

  test("forwards string title and hint to the host seam", async () => {
    const calls: Array<{title?: string; hint?: string}> = []
    const result = await invokeScanQrSeam(async options => {
      calls.push(options ?? {})
      return {data: "https://meet.google.com/abc-defg-hij"}
    }, {title: "Scan meeting QR", hint: "Point the camera", extra: 1})
    expect(calls).toEqual([{title: "Scan meeting QR", hint: "Point the camera"}])
    expect(result).toEqual({data: "https://meet.google.com/abc-defg-hij"})
  })

  test("drops non-string title and hint", async () => {
    const calls: Array<{title?: string; hint?: string}> = []
    await invokeScanQrSeam(async options => {
      calls.push(options ?? {})
      return {cancelled: true}
    }, {title: 12, hint: null})
    expect(calls).toEqual([{}])
  })
})
