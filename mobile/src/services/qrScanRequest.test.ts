import {afterEach, describe, expect, test} from "bun:test"

import {completeQrScan, getQrScanRequest, requestPhoneQrScan, subscribeQrScan} from "./qrScanRequest"

describe("qrScanRequest", () => {
  afterEach(() => {
    completeQrScan({cancelled: true})
  })

  test("exposes a stable snapshot for the pending overlay", async () => {
    const seen: Array<number | null> = []
    const unsubscribe = subscribeQrScan(() => {
      seen.push(getQrScanRequest()?.id ?? null)
    })

    const pending = requestPhoneQrScan({title: "Scan meeting QR"})
    const first = getQrScanRequest()
    const second = getQrScanRequest()
    expect(first).toEqual({id: expect.any(Number), options: {title: "Scan meeting QR"}})
    expect(second).toBe(first)

    completeQrScan({data: "https://meet.google.com/abc-defg-hij"})
    await expect(pending).resolves.toEqual({data: "https://meet.google.com/abc-defg-hij"})
    expect(getQrScanRequest()).toBeNull()
    expect(seen).toEqual([first!.id, null])
    unsubscribe()
  })

  test("a second request cancels the first without dropping the new overlay", async () => {
    const first = requestPhoneQrScan({title: "one"})
    const second = requestPhoneQrScan({title: "two"})
    expect(getQrScanRequest()?.options).toEqual({title: "two"})

    await expect(first).resolves.toEqual({cancelled: true})
    completeQrScan({cancelled: true})
    await expect(second).resolves.toEqual({cancelled: true})
  })

  test("completeQrScan is a no-op when nothing is pending", () => {
    expect(() => completeQrScan({data: "late"})).not.toThrow()
    expect(getQrScanRequest()).toBeNull()
  })

  test("a stale overlay completion does not settle the replacement request", async () => {
    const first = requestPhoneQrScan({title: "one"})
    const firstId = getQrScanRequest()!.id
    const second = requestPhoneQrScan({title: "two"})
    const secondId = getQrScanRequest()!.id

    await expect(first).resolves.toEqual({cancelled: true})
    completeQrScan({data: "https://stale.example/qr"}, firstId)
    expect(getQrScanRequest()?.id).toBe(secondId)

    completeQrScan({data: "https://fresh.example/qr"}, secondId)
    await expect(second).resolves.toEqual({data: "https://fresh.example/qr"})
    expect(getQrScanRequest()).toBeNull()
  })

  test("a throwing subscriber cannot leave scanQr pending", async () => {
    const unsubscribe = subscribeQrScan(() => {
      throw new Error("overlay exploded")
    })
    try {
      const pending = requestPhoneQrScan({title: "scan"})
      expect(() => completeQrScan({data: "ok"})).not.toThrow()
      await expect(pending).resolves.toEqual({data: "ok"})
    } finally {
      unsubscribe()
    }
  })
})
