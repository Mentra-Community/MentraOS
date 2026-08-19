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
})
