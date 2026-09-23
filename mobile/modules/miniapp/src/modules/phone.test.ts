import {describe, expect, mock, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {PhoneModule} from "./phone"

describe("phone Wi-Fi requests", () => {
  test.each([true, false, null])("preserves radio state %s", async (enabled) => {
    const sendRequest = mock(async () => enabled)
    const phone = new PhoneModule({sendRequest} as unknown as MiniappSession)
    expect(await phone.isWifiEnabled()).toBe(enabled)
    expect(sendRequest).toHaveBeenCalledWith({type: MiniappRequestType.PHONE_IS_WIFI_ENABLED})
  })

  test("waits for the host prompt without the ordinary request deadline", async () => {
    const sendRequest = mock(async () => ({enabled: false, cancelled: true}))
    const phone = new PhoneModule({sendRequest} as unknown as MiniappSession)
    expect(await phone.requestWifiEnable("Wi-Fi carries glasses video")).toEqual({enabled: false, cancelled: true})
    expect(sendRequest).toHaveBeenCalledWith(
      {type: MiniappRequestType.PHONE_REQUEST_WIFI_ENABLE, reason: "Wi-Fi carries glasses video"},
      {timeoutMs: 0},
    )
  })

  test("propagates old-host errors for callers to handle", async () => {
    const sendRequest = mock(async () => {
      throw {code: "NOT_IMPLEMENTED"}
    })
    const phone = new PhoneModule({sendRequest} as unknown as MiniappSession)
    await expect(phone.requestWifiEnable()).rejects.toEqual({code: "NOT_IMPLEMENTED"})
  })
})
